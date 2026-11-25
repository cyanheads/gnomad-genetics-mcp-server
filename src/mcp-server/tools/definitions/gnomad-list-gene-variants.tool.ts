/**
 * @fileoverview gnomad_list_gene_variants — every variant in a gene / transcript
 * / region with allele frequencies, filtering allele frequencies, zygosity
 * counts, predicted consequences with their gene and LOFTEE's call, and per-callset QC
 * filters (plus HGVS, LOFTEE filter and flags, and rsIDs under annotations, and
 * per-ancestry ac/an/af columns under populations, which both also shape the
 * staged table), filterable by consequence class, LOFTEE
 * confidence, max-AF and max-FAF thresholds, and QC status
 * (pass_only, which also reads counts without joint data from the passing
 * callsets, and drops the failed rows after qc_filtered counts them), and
 * returned one offset/limit page of the filtered rows at a time. gnomAD lists a
 * target only whole, so every page re-fetches it. At offset 0 a result past the
 * inline budget also spills every row to a DataCanvas table (gene_variants) for
 * gnomad_dataframe_describe and gnomad_dataframe_query; a later page never
 * stages. Echoes the resolved target and the row filters.
 * @module mcp-server/tools/definitions/gnomad-list-gene-variants.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema, type ColumnSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { isCanvasEnabled } from '@/config/server-config.js';
import { getGnomadService, listRowFafField } from '@/services/gnomad/gnomad-service.js';
import {
  type AnnotatedGeneVariantRow,
  type GeneVariantRow,
  type GenomeTarget,
  type GroupColumn,
  LIST_ROW_GROUPS,
  type ListRowGroup,
} from '@/services/gnomad/types.js';
import { type RowColumns, rowSchema, stagedLine, stageRows } from '../canvas-staging.js';
import { type CountLimit, clampLimit, limitSchema } from '../count-limit.js';
import {
  datasetField,
  normalizedRegion,
  optionalGeneField,
  REGION_REGEX,
  referenceGenomeField,
  resolveGenomeTarget,
} from '../shared-schemas.js';

/** Stable canvas table name for this tool's spill. */
const TABLE_NAME = 'gene_variants';
/**
 * Staging budget in JSON characters of every row a call at offset 0 keeps: a
 * result within it stages no table unless canvas_id is supplied, and one past
 * it spills every row to gene_variants. Either way the rows returned inline are
 * the page, offset to offset + limit.
 */
const STAGING_CHARS = 14_000;

/**
 * Rows per page. At the cap a page of real TTN rows (gnomad_r4, November 2026)
 * is 1.36 MB of structuredContent and 0.74 MB of content[] in the default shape,
 * 1.65 MB and 0.89 MB with annotations, and 2.62 MB and 1.38 MB with
 * populations, whose 85.6 MB reply (45.0 MB in the default shape) peaks the
 * server process at about 1.7 GB RSS (0.9 GB in the default shape).
 */
const LIMIT: CountLimit = { tool: 'gnomad_list_gene_variants', default: 25, cap: 3_000 };

/** Read once as the definition evaluates: the descriptions name the dataframe tools only when they are registered. */
const CANVAS_ON = isCanvasEnabled();

/** What a column toggle's description says about the staged table, present only while a canvas can stage one. */
const IN_STAGED_TABLE = CANVAS_ON ? ' and in the staged gene_variants table' : '';

/** gene_variants column types, in the order the service builds a row. */
const TABLE_COLUMNS: RowColumns<GeneVariantRow> = {
  variant_id: { type: 'VARCHAR', nullable: false },
  af: { type: 'DOUBLE', nullable: true },
  ac: { type: 'BIGINT', nullable: false },
  an: { type: 'BIGINT', nullable: false },
  consequence: { type: 'VARCHAR', nullable: true },
  consequence_class: { type: 'VARCHAR', nullable: false },
  homozygote_count: { type: 'BIGINT', nullable: false },
  hemizygote_count: { type: 'BIGINT', nullable: true },
  faf95_max: { type: 'DOUBLE', nullable: true },
  faf95_max_group: { type: 'VARCHAR', nullable: true },
  source: { type: 'VARCHAR', nullable: false },
  flags: { type: 'VARCHAR', nullable: false },
  exome_filters: { type: 'VARCHAR', nullable: true },
  genome_filters: { type: 'VARCHAR', nullable: true },
  qc_status: { type: 'VARCHAR', nullable: false },
  gene_id: { type: 'VARCHAR', nullable: true },
  gene_symbol: { type: 'VARCHAR', nullable: true },
  transcript_id: { type: 'VARCHAR', nullable: true },
  consequence_transcript: { type: 'VARCHAR', nullable: true },
  lof: { type: 'VARCHAR', nullable: true },
};
const TABLE_SCHEMA = rowSchema<GeneVariantRow>(TABLE_COLUMNS);
/** The gene_variants table of an annotations call: every default column, then the opt-in five. */
const ANNOTATED_TABLE_SCHEMA = rowSchema<AnnotatedGeneVariantRow>({
  ...TABLE_COLUMNS,
  hgvsc: { type: 'VARCHAR', nullable: true },
  hgvsp: { type: 'VARCHAR', nullable: true },
  lof_filter: { type: 'VARCHAR', nullable: true },
  lof_flags: { type: 'VARCHAR', nullable: true },
  rsids: { type: 'VARCHAR', nullable: false },
});

/** Every group some dataset's list rows carry, alphabetical — each dataset's set (LIST_ROW_GROUPS) in the same order. */
const GROUPS = [...new Set(Object.values(LIST_ROW_GROUPS).flat())].sort() as ListRowGroup[];

/** The gene_variants columns a populations call appends for its dataset's groups, in the order the service builds them. */
const groupTableColumns = (groups: readonly ListRowGroup[]): ColumnSchema[] =>
  groups.flatMap((group) => [
    { name: `ac_${group}`, type: 'BIGINT', nullable: true },
    { name: `an_${group}`, type: 'BIGINT', nullable: true },
    { name: `af_${group}`, type: 'DOUBLE', nullable: true },
  ]);

/**
 * The per-group row fields, one description per column family; the source,
 * null, and group-set rules are stated once, on the populations input.
 */
const groupField = (quantity: string, group: ListRowGroup) =>
  z.number().nullable().optional().describe(`${quantity} in the ${group} group.`);

const GROUP_FIELDS = Object.fromEntries(
  GROUPS.flatMap((group) => [
    [`ac_${group}`, groupField('Allele count', group)],
    [`an_${group}`, groupField('Allele number', group)],
    [`af_${group}`, groupField('Allele frequency', group)],
  ]),
) as Record<GroupColumn, ReturnType<typeof groupField>>;

/** Each dataset's groups as the populations input names them. */
const GROUP_SETS = `${LIST_ROW_GROUPS.gnomad_r4.join(' ')} on gnomad_r4 and gnomad_r4_non_ukb; ${LIST_ROW_GROUPS.gnomad_r3.join(' ')} on gnomad_r3 and its subsets; ${LIST_ROW_GROUPS.gnomad_r2_1.join(' ')} on gnomad_r2_1 and its subsets; ${LIST_ROW_GROUPS.exac.join(' ')} on exac`;

/** An opt-in column's description: present only on a call with annotations. */
const annotationField = (description: string) =>
  `${description} Present only when annotations is true.`;

/** gnomAD's consequence categories: the filter, the row column, and the filter echo. */
const CONSEQUENCE_CLASSES = ['lof', 'missense', 'synonymous', 'other'] as const;

/** A callset's QC filters column, as the service builds it. */
const callsetFiltersField = (callset: 'exome' | 'genome') =>
  z
    .string()
    .nullable()
    .describe(
      `QC filters on the ${callset} call, pipe-joined (e.g. AC0|AS_VQSR; RF on gnomad_r2_1); empty when it passed, null when the ${callset} callset does not carry the variant or gnomAD gave no list.`,
    );

const GeneVariantRowSchema = z
  .object({
    variant_id: z.string().describe('chrom-pos-ref-alt variant ID.'),
    af: z
      .number()
      .nullable()
      .describe('Allele frequency, ac/an — the value max_af filters on; null when an is 0.'),
    ac: z
      .number()
      .describe(
        "Allele count: gnomAD's joint exome + genome count on gnomad_r4; on every other dataset, gnomad_r4_non_ukb and the other subsets included (no joint data), the sum across the callsets carrying the variant, a QC-failed one included unless pass_only is set.",
      ),
    an: z
      .number()
      .describe(
        "Allele number, from the same records as ac: on gnomad_r4 (not gnomad_r4_non_ukb), gnomAD's joint AN over every callable sample in both callsets, including a callset that does not carry the variant or failed QC.",
      ),
    consequence: z
      .string()
      .nullable()
      .describe(
        "VEP consequence term, as gnomAD's tables show it: the most severe in the gene on a gene target, the named transcript's term on a transcript target, the most severe across transcripts on a region target; null when none.",
      ),
    consequence_class: z
      .enum(CONSEQUENCE_CLASSES)
      .describe(
        "gnomAD's category of the consequence term; the consequence_class filter lists the terms each holds.",
      ),
    homozygote_count: z.number().describe('Homozygote count, from the same records as ac.'),
    hemizygote_count: z
      .number()
      .nullable()
      .describe(
        'Hemizygote count (0 off X/Y), from the same records as ac; null when none of them reports one.',
      ),
    faf95_max: z
      .number()
      .nullable()
      .describe(
        "gnomAD's filtering allele frequency (GroupMax FAF95): the lower bound of the 95% confidence interval of a genetic-ancestry group's AF, from the group with the highest bound, over non-bottlenecked groups. From the same records as ac: gnomAD's joint value on gnomad_r4 (gnomad_get_variant's faf95 there); elsewhere the highest a summed callset reports, gnomad_r4_non_ukb's and each gnomad_r2_1 subset's own. Null when gnomAD reports none, as for AC 0 and singleton variants, and on every row of gnomad_r3, its subsets, and exac, whose list rows carry no FAF.",
      ),
    faf95_max_group: z
      .string()
      .nullable()
      .describe(
        'Genetic-ancestry group faf95_max comes from (e.g. nfe); null when faf95_max is null or gnomAD names none.',
      ),
    source: z.string().describe('Carried callset(s), pipe-joined (e.g. exome|genome).'),
    flags: z.string().describe('Quality flags, pipe-joined (empty when none).'),
    exome_filters: callsetFiltersField('exome'),
    genome_filters: callsetFiltersField('genome'),
    qc_status: z.enum(['pass', 'filtered']).describe("gnomAD's QC verdict for the variant."),
    gene_id: z
      .string()
      .nullable()
      .describe(
        "Ensembl ID of transcript_id's gene: the target's on a gene or transcript target. On a region, a variant in overlapping genes is one row, under the gene of its most severe consequence; null there when transcript_id is.",
      ),
    gene_symbol: z
      .string()
      .nullable()
      .describe('HGNC symbol of gene_id; null when gene_id is or gnomAD gives none.'),
    transcript_id: z
      .string()
      .nullable()
      .describe(
        'Ensembl transcript ID (unversioned) the consequence is on; null when gnomAD names none, as for an intergenic variant.',
      ),
    consequence_transcript: z
      .enum(['mane_select', 'canonical', 'other'])
      .nullable()
      .describe(
        "On a gene target, where transcript_id sits as gnomAD's gene table marks it (†): mane_select, the gene's MANE Select transcript; canonical, the canonical transcript of a gene without a MANE Select (as on every GRCh37 dataset); other, another transcript — a minor isoform, so the consequence and lof may be milder or absent on the primary one, whose term gnomad_get_variant's primary_transcript gives. Null on transcript and region targets, and for a gene with neither a MANE Select nor a canonical transcript.",
      ),
    lof: z
      .string()
      .nullable()
      .describe(
        "LOFTEE's loss-of-function call on transcript_id — HC high-confidence, LC low-confidence, or OS other splice; null when LOFTEE made none. Distinct from consequence_class lof, which gnomAD reads from the consequence term, so a pLoF term LOFTEE did not call is still lof there.",
      ),
    hgvsc: z
      .string()
      .nullable()
      .optional()
      .describe(
        annotationField(
          'HGVS coding or transcript notation on transcript_id (e.g. c.137G>T, c.*9G>T); null when gnomAD gives none.',
        ),
      ),
    hgvsp: z
      .string()
      .nullable()
      .optional()
      .describe(
        annotationField(
          'HGVS protein notation on transcript_id (e.g. p.Arg46Leu); null when gnomAD gives none, as for a UTR or intronic change.',
        ),
      ),
    lof_filter: z
      .string()
      .nullable()
      .optional()
      .describe(
        annotationField(
          'The LOFTEE filter that made the call on transcript_id low-confidence (e.g. END_TRUNC); null when none.',
        ),
      ),
    lof_flags: z
      .string()
      .nullable()
      .optional()
      .describe(
        annotationField(
          "LOFTEE's flags on the call on transcript_id, as gnomAD writes them (e.g. PHYLOCSF_WEAK, NAGNAG_SITE) — they can qualify an HC call too; null when none.",
        ),
      ),
    rsids: z
      .string()
      .optional()
      .describe(
        annotationField(
          "dbSNP rsIDs, pipe-joined; empty when gnomAD lists none. gnomad_search_clinvar's table joins its rsids with semicolons.",
        ),
      ),
    ...GROUP_FIELDS,
  })
  .describe('One matching gene variant.');

const RowFiltersSchema = z
  .object({
    consequence_class: z
      .enum(CONSEQUENCE_CLASSES)
      .nullable()
      .describe('The consequence_class filter.'),
    lof_confidence: z.enum(['HC', 'LC']).nullable().describe('The lof_confidence filter.'),
    max_af: z.number().nullable().describe('The max_af filter.'),
    max_faf: z.number().nullable().describe('The max_faf filter.'),
    pass_only: z.literal(true).nullable().describe('true when pass_only was set; null when false.'),
  })
  .describe('The row filters this call applied, each null when omitted.');

type RowFilters = z.infer<typeof RowFiltersSchema>;

/** What the description says about staging, present only while the dataframe tools are registered. */
const STAGING_GUIDANCE = CANVAS_ON
  ? ' At offset 0, a result too large to inline is also staged as a DataCanvas table, gene_variants, holding every matching variant (canvas_id, table_name) — call gnomad_dataframe_describe for its columns, then gnomad_dataframe_query to rank, count, or group across every row rather than one page. A page past offset 0 never stages.'
  : '';

/** Description of the canvas fields with the canvas off, where they never carry a value. */
const CANVAS_OFF_FIELD = 'DataCanvas is off in this deployment, so this call stages nothing.';

export const gnomadListGeneVariants = tool('gnomad_list_gene_variants', {
  title: 'gnomad-genetics-mcp-server: list gene variants',
  description: `List every gnomAD variant in a gene, transcript, or region with allele frequencies, filtering allele frequencies, zygosity counts, predicted consequences with LOFTEE's loss-of-function call, and QC status, optionally filtered by consequence class, LOFTEE confidence, maximum allele frequency, and maximum filtering allele frequency (faf95_max) — the value to test against a disease threshold such as ACMG/AMP BA1 or BS1, which raw AF is not. Pass annotations: true to add each row's HGVS c. and p. notation, LOFTEE filter and flags, and rsIDs, and populations: true to add its allele count, number, and frequency in each genetic-ancestry group. qc_status follows gnomAD's browser: pass when at least one callset carrying the variant passed QC, filtered when none did (often AC0, no high-quality carrier, at AF 0). The browser hides filtered variants by default and qc_filtered counts them: read them as low-confidence, not observed variants, or pass pass_only to drop them. Each call returns one page: up to limit matching variants from offset, in gnomAD's genomic order, with total counting every match; pass next_offset as offset until it is null. gnomAD lists a target only whole, so each page re-fetches the whole target — page a large gene with filters and a large limit.${STAGING_GUIDANCE} Supply exactly one of gene, transcript_id, or region. Echoes the resolved target, the row filters, and the effective dataset and build.\nData source: gnomAD (Broad Institute) — https://gnomad.broadinstitute.org/`,
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    gene: optionalGeneField,
    transcript_id: z
      .string()
      .trim()
      .optional()
      .describe('Ensembl transcript ID (e.g. ENST00000302118).'),
    region: normalizedRegion(
      z.union([
        z.literal(''),
        z
          .string()
          .regex(REGION_REGEX, 'Region must be chrom-start-stop, e.g. 1-55039447-55064852.')
          .describe('Region as chrom-start-stop.'),
      ]),
    )
      .optional()
      .describe(
        'Genomic region chrom-start-stop (1-based inclusive, e.g. 1-55039447-55064852) on chromosome 1–22, X, or Y with an optional chr prefix, spanning (stop − start) under 2,500,000 bp and holding at most ~30,000 variants.',
      ),
    consequence_class: z
      .enum(CONSEQUENCE_CLASSES)
      .optional()
      .describe(
        "Keep only variants in this gnomAD consequence category, read from each row's consequence: lof (pLoF) is transcript_ablation, splice_acceptor_variant, splice_donor_variant, stop_gained, frameshift_variant; missense (missense / inframe indel) is missense_variant, stop_lost, start_lost, inframe_insertion, inframe_deletion; synonymous is synonymous_variant; other is every other term and a null consequence.",
      ),
    lof_confidence: z
      .enum(['HC', 'LC'])
      .optional()
      .describe(
        'Keep only variants whose lof equals this; a row with lof null or OS matches neither.',
      ),
    max_af: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        'Keep only variants with allele frequency ≤ this value (0–1). Variants with null AF are always kept.',
      ),
    max_faf: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        'Keep only variants whose faf95_max is ≤ this value (0–1). Variants with a null faf95_max are always kept, and a notice counts them.',
      ),
    pass_only: z
      .boolean()
      .optional()
      .describe(
        "Keep only qc_status pass variants, with the counts gnomAD's browser table shows by default: on every dataset but gnomad_r4 (gnomad_r4_non_ukb included), a row reads ac, an, af, homozygote_count, hemizygote_count, faf95_max, and the populations columns from its passing callsets only, and max_af and max_faf filter on those values; gnomad_r4 rows keep their joint counts. Omitted, QC-failed variants stay listed, so a single-position region never reads as absent because of QC.",
      ),
    annotations: z
      .boolean()
      .optional()
      .describe(
        `Add hgvsc, hgvsp, lof_filter, lof_flags, and rsids (pipe-joined), describing each row's transcript_id, after every default column, on the rows${IN_STAGED_TABLE}. A column toggle, not a filter: it keeps every row and filters does not echo it. It widens each row, and each page's re-fetch of the target from gnomAD, by about a quarter.`,
      ),
    populations: z
      .boolean()
      .optional()
      .describe(
        `Add ac_<group>, an_<group>, and af_<group> for each genetic-ancestry group of the dataset after every other column, on the rows${IN_STAGED_TABLE} — ${GROUP_SETS}. They read the records ac does — gnomAD's joint groups on gnomad_r4, elsewhere each group summed across those callsets — so a row's non-null ac_<group> sum to its ac and an_<group> to its an. A group none of those records lists is null; af_<group> is null when an_<group> is 0. A column toggle like annotations; it about doubles each row and each page's re-fetch of the target from gnomAD.`,
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Zero-based position, among the variants the filters keep, of the first one on this page; pass next_offset to continue.',
      ),
    limit: limitSchema(LIMIT, 'Matching variants on this page.'),
    canvas_id: CanvasIdSchema.optional().describe(
      CANVAS_ON
        ? 'canvas_id from a prior call. A call at offset 0 then writes its result to gene_variants on that canvas, replacing the previous table and its columns even when the result fits inline; a result with no variants removes it, and a page past offset 0 leaves it as it was. Omit to stage on a fresh canvas only when the result is too large to inline.'
        : `Ignored: ${CANVAS_OFF_FIELD}`,
    ),
    dataset: datasetField,
    reference_genome: referenceGenomeField,
  }),
  output: z.object({
    target: z
      .string()
      .describe(
        'The resolved target (gene symbol or Ensembl gene ID, transcript ID, or region), as normalized for the lookup.',
      ),
    target_kind: z
      .enum(['gene', 'transcript', 'region'])
      .describe('Which target type was queried.'),
    filters: RowFiltersSchema,
    preview: z.array(GeneVariantRowSchema).describe('The matching variants on this page.'),
    canvas_id: z
      .string()
      .describe(
        CANVAS_ON
          ? 'Canvas holding table_name, or the canvas_id supplied; empty when this call used no canvas (the result fit inline with no canvas_id, or the page started past offset 0).'
          : `Always empty: ${CANVAS_OFF_FIELD}`,
      ),
    table_name: z
      .string()
      .describe(
        CANVAS_ON
          ? 'Canvas table this call staged (gene_variants), holding every matching variant; empty when this call staged no table.'
          : `Always empty: ${CANVAS_OFF_FIELD}`,
      ),
    spilled: z
      .boolean()
      .describe(
        CANVAS_ON
          ? 'True when the matching variants were too large to inline, so table_name holds every one of them.'
          : `Always false: ${CANVAS_OFF_FIELD}`,
      ),
    total: z
      .number()
      .describe(
        'Matching variants across every page, counted after pass_only drops QC-failed rows when it is set.',
      ),
    truncated: z
      .boolean()
      .describe('True when matching variants remain past this page; continue with next_offset.'),
    next_offset: z
      .number()
      .nullable()
      .describe('offset for the next page; null when this page reaches the last matching variant.'),
    qc_filtered: z
      .number()
      .describe(
        'Matching variants with qc_status filtered, counted over every match — not just this page — before pass_only drops them.',
      ),
    dataset: z.string().describe('Effective gnomAD dataset.'),
    reference_genome: z.string().describe('Effective reference build.'),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        CANVAS_ON
          ? 'Guidance on a clamped limit, no matching variants, QC-failed matches (the qc_filtered count, and what pass_only dropped), max_faf (the kept variants it could not test for a null faf95_max, or a dataset without FAF on its rows), the next offset when no staged table holds the rest, an offset past the end, and the staged table.'
          : 'Guidance on a clamped limit, no matching variants, QC-failed matches (the qc_filtered count, and what pass_only dropped), max_faf (the kept variants it could not test for a null faf95_max, or a dataset without FAF on its rows), the next offset while variants remain, and an offset past the end.',
      ),
  },
  enrichmentTrailer: { notice: { render: escapeMarkdownInline } },
  errors: [
    {
      reason: 'invalid_target',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Not exactly one of gene, transcript_id, or region was supplied.',
      recovery:
        'Supply exactly one target: gene, transcript_id, or region (chrom-start-stop). Remove the extras.',
    },
    {
      reason: 'incoherent_build',
      code: JsonRpcErrorCode.ValidationError,
      when: 'reference_genome was supplied but does not match the dataset.',
      recovery:
        'Omit reference_genome to let it derive, or pass the build matching the dataset (gnomad_r4, gnomad_r3, and their subsets are GRCh38; gnomad_r2_1, its subsets, and exac are GRCh37).',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_region',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The region names a chromosome outside 1–22, X, Y, or breaks the coordinate bounds.',
      recovery:
        'Pass region as chrom-start-stop on chromosome 1–22, X, or Y (optional chr prefix, e.g. chr1-55039447-55064852), with start at least 1, stop below 1,000,000,000, and start ≤ stop.',
      thrownBy: 'service',
    },
    {
      reason: 'region_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The region spans 2,500,000 bp or more, or holds more variants (~30,000) than gnomAD lists at once.',
      recovery:
        'Narrow the region to a span (stop − start) under 2,500,000 bp holding at most ~30,000 variants, or split it into consecutive sub-regions and list each one.',
      thrownBy: 'service',
    },
    {
      reason: 'mitochondrial_unsupported',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The gene, transcript, or region is on the mitochondrial chromosome (M or MT).',
      recovery:
        'Mitochondrial variants are outside this server; look them up in the gnomAD browser at https://gnomad.broadinstitute.org/, or query a target on chromosomes 1–22, X, or Y.',
      thrownBy: 'service',
    },
    {
      reason: 'gene_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'gnomAD holds no gene matching the symbol or Ensembl ID in this build.',
      recovery:
        'Check the symbol spelling, or resolve a stable Ensembl gene ID in this build via ensembl_lookup_gene, then retry.',
      thrownBy: 'service',
    },
    {
      reason: 'transcript_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'gnomAD holds no transcript matching transcript_id in this build.',
      recovery:
        'Pass an Ensembl transcript ID in this build in its unversioned ENST form (e.g. ENST00000302118), resolved via ensembl_lookup_gene; RefSeq IDs such as NM_174936.4 are not served.',
      thrownBy: 'service',
    },
    {
      reason: 'graphql_error',
      code: JsonRpcErrorCode.ValidationError,
      when: 'gnomAD rejected the variant-list query with a GraphQL error.',
      recovery:
        'Check the gene, transcript_id, or region and the dataset before retrying: gnomAD rejected this query as sent, so the same request fails again.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'gnomAD stayed unavailable or throttled through every retry.',
      recovery:
        'gnomAD is degraded or throttling; wait a few seconds and retry. gnomAD is a community-funded API — keep request volume low.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'gnomAD attempts timed out or the shared 45 s call budget expired.',
      recovery:
        'gnomAD did not answer in time; wait a few seconds and retry, or list a smaller region instead of a large gene.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_access',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'gnomAD refused the request (access denied).',
      recovery:
        'Do not retry: gnomAD is refusing requests from this server. Tell the user the lookup is blocked upstream and point them to https://gnomad.broadinstitute.org/.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_upstream_response',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'gnomAD kept answering with a response that failed validation.',
      recovery:
        'Wait a few seconds and retry; gnomAD returned a response this server could not validate.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const svc = getGnomadService();
    const dsCtx = svc.resolveDatasetContext(input.dataset, input.reference_genome);
    const target = resolveGenomeTarget(
      { gene: input.gene, transcript_id: input.transcript_id, region: input.region || undefined },
      ctx,
    );
    const { applied: limit, notice: clamped } = clampLimit(ctx, LIMIT, input.limit);
    const filters: RowFilters = {
      consequence_class: input.consequence_class ?? null,
      lof_confidence: input.lof_confidence ?? null,
      max_af: input.max_af ?? null,
      max_faf: input.max_faf ?? null,
      pass_only: input.pass_only ? true : null,
    };
    const annotations = input.annotations === true;
    const populations = input.populations === true;

    // passOnly picks each row's counts in the service; the QC-failed rows are dropped below.
    const matched = await svc.listGeneVariants(
      target,
      {
        annotations,
        consequenceClass: input.consequence_class,
        lofConfidence: input.lof_confidence,
        maxAf: input.max_af,
        maxFaf: input.max_faf,
        passOnly: input.pass_only === true,
        populations,
      },
      dsCtx,
      ctx,
    );
    // Counted over every match before pass_only, so the count survives the drop.
    const qcFiltered = matched.filter((row) => row.qc_status === 'filtered').length;
    const rows = input.pass_only ? matched.filter((row) => row.qc_status === 'pass') : matched;

    /**
     * Only offset 0 stages. gnomAD lists the target whole, so a later page
     * re-fetches the same rows, and staging them again would rewrite the table
     * the first page staged, or acquire a fresh canvas for every page.
     */
    const staged =
      input.offset === 0
        ? await stageRows({
            rows,
            canvasId: input.canvas_id,
            tableName: TABLE_NAME,
            // Each call's own shape, so a reused canvas_id's table never keeps a previous call's columns.
            schema: [
              ...(annotations ? ANNOTATED_TABLE_SCHEMA : TABLE_SCHEMA),
              ...(populations ? groupTableColumns(LIST_ROW_GROUPS[dsCtx.parent]) : []),
            ],
            previewChars: STAGING_CHARS,
            ctx,
          })
        : undefined;
    const preview = rows.slice(input.offset, input.offset + limit);
    const end = input.offset + preview.length;
    const nextOffset = end < rows.length ? end : null;

    /**
     * ctx.enrich.notice is last-wins, so every part is collected here and
     * written once, in order: clamp → no-match or QC → max_faf → page position →
     * staged table.
     */
    const notices: string[] = [];
    if (clamped) notices.push(clamped);
    const scope = targetScope(target, filters);
    if (matched.length === 0) {
      notices.push(`No variants in ${scope}. Broaden the filters.`);
    } else if (rows.length === 0) {
      notices.push(
        `All ${qcFiltered} variant(s) in ${scope} failed gnomAD QC in every callset carrying them, so pass_only dropped them. Omit pass_only to list them with their exome_filters and genome_filters.`,
      );
    } else if (qcFiltered > 0) {
      notices.push(
        input.pass_only
          ? `pass_only dropped ${qcFiltered} of ${matched.length} matching variant(s) that failed gnomAD QC in every callset carrying them.`
          : `${qcFiltered} of ${matched.length} matching variant(s) failed gnomAD QC in every callset carrying them (qc_status "filtered"; gnomAD's browser hides these by default); exome_filters and genome_filters name the filters. ${qcFiltered === matched.length ? 'None passed, so pass_only: true would return no rows.' : 'Pass pass_only: true to drop them.'}`,
      );
    }
    if (input.max_faf != null) {
      if (listRowFafField(dsCtx) == null) {
        notices.push(
          `${dsCtx.dataset} list rows carry no filtering allele frequency (faf95_max is null on every row), so max_faf filtered no variant.`,
        );
      } else if (rows.length > 0) {
        const untested = rows.filter((row) => row.faf95_max == null).length;
        notices.push(
          `max_faf could not test ${untested} of the ${rows.length} variant(s) it kept: gnomAD reports no filtering allele frequency for them (faf95_max null), so judge them by af.`,
        );
      }
    }

    if (rows.length > 0 && input.offset >= rows.length) {
      notices.push(
        `offset ${input.offset} is past the end of the ${rows.length} matching variant(s); use an offset below ${rows.length}.`,
      );
    } else if (nextOffset != null && !staged?.table_name) {
      // A staged table already reaches every row, so only a page without one names the next offset.
      notices.push(
        `Showing variants ${input.offset + 1}–${end} of ${rows.length}; continue with offset=${nextOffset} for the next page.`,
      );
    }
    if (staged?.table_name) {
      notices.push(
        `Staged ${staged.total} variant(s) in table "${staged.table_name}" (canvas_id ${staged.canvas_id}). Call gnomad_dataframe_describe for its columns, then gnomad_dataframe_query to run SQL over every staged row.`,
      );
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return {
      target: target.value,
      target_kind: target.kind,
      filters,
      preview,
      canvas_id: staged?.canvas_id ?? '',
      table_name: staged?.table_name ?? '',
      spilled: staged?.spilled ?? false,
      total: rows.length,
      truncated: nextOffset != null,
      next_offset: nextOffset,
      qc_filtered: qcFiltered,
      dataset: dsCtx.dataset,
      reference_genome: dsCtx.reference_genome,
    };
  },

  format: (result) => {
    const lines = [
      `## Gene variants — ${result.total} total`,
      `**Target:** ${result.target_kind} ${escapeMarkdownInline(result.target)} | **Filters:** ${filterParts(result.filters).join(', ') || 'none'}`,
      `**Dataset:** ${result.dataset} (${result.reference_genome}) | **Spilled:** ${result.spilled ? 'yes' : 'no'} | **QC filtered:** ${result.qc_filtered}`,
      `**Truncated:** ${result.truncated ? 'yes' : 'no'} | **Next offset:** ${result.next_offset ?? 'none'}`,
      stagedLine(result),
      '',
      `Showing ${result.preview.length} preview row(s):`,
    ];
    for (const r of result.preview) {
      const af = r.af != null ? `${r.af} (${r.af.toExponential(3)})` : 'n/a';
      // A null FAF (none reported, or none on the dataset's rows) is left out, as a null hemi is.
      const faf =
        r.faf95_max != null
          ? ` | FAF95 ${r.faf95_max}${r.faf95_max_group != null ? ` (${escapeMarkdownInline(r.faf95_max_group)})` : ''}`
          : '';
      // A null filters column (callset not carrying the variant) is left out; '' is a pass.
      const callsetQc = (
        [
          ['exome', r.exome_filters],
          ['genome', r.genome_filters],
        ] as const
      )
        .filter(([, filters]) => filters != null)
        .map(([name, filters]) => `${name} ${filters ? escapeMarkdownInline(filters) : 'passed'}`);
      // Left out when both are null, as on a region row without a transcript; a symbol-less gene shows its ID alone.
      const symbol = r.gene_symbol != null ? escapeMarkdownInline(r.gene_symbol) : null;
      const geneId = r.gene_id != null ? escapeMarkdownInline(r.gene_id) : null;
      const gene =
        symbol || geneId
          ? ` | gene ${symbol && geneId ? `${symbol} (${geneId})` : (symbol ?? geneId)}`
          : '';
      // Left out only when both are null (no transcript, no marker); a gene row without a transcript is still marked.
      const transcript =
        r.transcript_id == null && r.consequence_transcript == null
          ? ''
          : ` | transcript ${escapeMarkdownInline(r.transcript_id ?? 'none')}${r.consequence_transcript ? ` (${r.consequence_transcript})` : ''}`;
      // lof, then the opt-in columns in column order; each null, empty, or absent one is left out.
      const transcriptCalls = (
        [
          ['LoF', r.lof],
          ['HGVSc', r.hgvsc],
          ['HGVSp', r.hgvsp],
          ['LoF filter', r.lof_filter],
          ['LoF flags', r.lof_flags],
          ['rsIDs', r.rsids],
        ] as const
      )
        .flatMap(([label, value]) => (value ? [` | ${label} ${escapeMarkdownInline(value)}`] : []))
        .join('');
      // Each group as ac/an (af), in column order; a null group is left out, a null af alone drops its parentheses.
      const groups = GROUPS.flatMap((group) => {
        const [ac, an, af] = [r[`ac_${group}`], r[`an_${group}`], r[`af_${group}`]];
        if (ac == null && an == null) return [];
        return [`${group} ${ac ?? 'n/a'}/${an ?? 'n/a'}${af != null ? ` (${af})` : ''}`];
      });
      lines.push(
        `- **${escapeMarkdownInline(r.variant_id)}** | ${r.consequence_class}${r.consequence ? ` (${escapeMarkdownInline(r.consequence)})` : ''} | AF ${af} | AC ${r.ac}/${r.an} | hom ${r.homozygote_count}${r.hemizygote_count != null ? ` | hemi ${r.hemizygote_count}` : ''}${faf} | ${escapeMarkdownInline(r.source || 'none')}${r.flags ? ` | flags ${escapeMarkdownInline(r.flags)}` : ''} | QC ${r.qc_status}${callsetQc.length ? ` (${callsetQc.join(', ')})` : ''}${gene}${transcript}${transcriptCalls}${groups.length ? ` | groups ${groups.join(', ')}` : ''}`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/** Each row filter set, as `name=value` in input order — the echo's rendering. */
function filterParts(filters: RowFilters): string[] {
  const parts: string[] = [];
  if (filters.consequence_class) parts.push(`consequence_class=${filters.consequence_class}`);
  if (filters.lof_confidence) parts.push(`lof_confidence=${filters.lof_confidence}`);
  if (filters.max_af != null) parts.push(`max_af=${filters.max_af}`);
  if (filters.max_faf != null) parts.push(`max_faf=${filters.max_faf}`);
  if (filters.pass_only) parts.push('pass_only=true');
  return parts;
}

/**
 * The target and the filters that chose its matching variants, as the no-match
 * and QC notices name them. pass_only is left out: those notices report what it
 * dropped from that set themselves.
 */
function targetScope(target: GenomeTarget, filters: RowFilters): string {
  const parts = filterParts({ ...filters, pass_only: null });
  return `${target.kind} "${target.value}"${parts.length ? ` matching ${parts.join(', ')}` : ''}`;
}
