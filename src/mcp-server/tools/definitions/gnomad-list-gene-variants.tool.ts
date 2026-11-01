/**
 * @fileoverview gnomad_list_gene_variants — every variant in a gene / transcript
 * / region with allele frequencies, predicted consequences, and per-callset QC
 * filters, filterable by consequence class, a max-AF threshold, and QC status
 * (pass_only, applied after qc_filtered is counted). Sets larger than the inline
 * preview spill to a DataCanvas table (gene_variants) for gnomad_dataframe_describe
 * and gnomad_dataframe_query; returns canvas_id + table_name plus the preview.
 * Degrades to a capped inline preview when the canvas is disabled.
 * @module mcp-server/tools/definitions/gnomad-list-gene-variants.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { getGnomadService } from '@/services/gnomad/gnomad-service.js';
import type { GeneVariantRow } from '@/services/gnomad/types.js';
import { rowSchema, stagedLine, stageRows } from '../canvas-staging.js';
import {
  datasetField,
  optionalGeneField,
  REGION_REGEX,
  referenceGenomeField,
  resolveGenomeTarget,
} from '../shared-schemas.js';

/** Stable canvas table name for this tool's spill. */
const TABLE_NAME = 'gene_variants';
/**
 * Inline preview budget in JSON characters of the preview rows, canvas on or
 * off. Each row lands on both surfaces (structuredContent and the format()
 * line), measured at ~1.68 serialized bytes per JSON character on real PCSK9
 * rows, so 14,000 keeps a response near 23 KB. Being counted in characters, the
 * budget holds that size as rows widen: a wider row previews fewer rows.
 */
const PREVIEW_CHARS = 14_000;

/** gene_variants column types, declared from GeneVariantRow in its field order. */
const TABLE_SCHEMA = rowSchema<GeneVariantRow>({
  variant_id: { type: 'VARCHAR', nullable: false },
  af: { type: 'DOUBLE', nullable: true },
  ac: { type: 'BIGINT', nullable: false },
  an: { type: 'BIGINT', nullable: false },
  consequence: { type: 'VARCHAR', nullable: true },
  consequence_class: { type: 'VARCHAR', nullable: false },
  homozygote_count: { type: 'BIGINT', nullable: false },
  source: { type: 'VARCHAR', nullable: false },
  flags: { type: 'VARCHAR', nullable: false },
  exome_filters: { type: 'VARCHAR', nullable: true },
  genome_filters: { type: 'VARCHAR', nullable: true },
  qc_status: { type: 'VARCHAR', nullable: false },
  transcript_id: { type: 'VARCHAR', nullable: true },
  consequence_transcript: { type: 'VARCHAR', nullable: true },
});

/** A callset's QC filters column, as the service builds it. */
const callsetFiltersField = (callset: 'exome' | 'genome') =>
  z
    .string()
    .nullable()
    .describe(
      `QC filters gnomAD applied to the ${callset} call, pipe-joined (e.g. AC0|AS_VQSR; the set varies by dataset, RF on gnomad_r2_1). Empty when the ${callset} call passed QC; null when the ${callset} callset does not carry the variant or gnomAD returned no filter list.`,
    );

const GeneVariantRowSchema = z
  .object({
    variant_id: z.string().describe('chrom-pos-ref-alt variant ID.'),
    af: z
      .number()
      .nullable()
      .describe(
        'Allele frequency, ac/an from the same source — the value max_af filters on; null when an is 0.',
      ),
    ac: z
      .number()
      .describe(
        "Allele count — gnomAD's joint exome + genome count on gnomad_r4, the sum across carried callsets on datasets without joint data.",
      ),
    an: z
      .number()
      .describe(
        "Allele number. On gnomad_r4, gnomAD's joint AN over every callable sample in both callsets, including a callset that does not carry the variant; on gnomad_r3, gnomad_r2_1, and exac (no joint data), the sum across carried callsets.",
      ),
    consequence: z
      .string()
      .nullable()
      .describe(
        "VEP consequence term, as gnomAD's tables show it: the most severe in the gene on a gene target, the named transcript's term on a transcript target, the most severe across transcripts on a region target. It can sit on a non-primary isoform — see consequence_transcript. Null when none.",
      ),
    consequence_class: z
      .enum(['lof', 'missense', 'synonymous', 'other'])
      .describe(
        "gnomAD's category of consequence (the terms each holds are listed on the consequence_class filter): lof is pLoF, missense covers missense and inframe indels, start_lost, and stop_lost; other includes a null consequence.",
      ),
    homozygote_count: z.number().describe('Homozygote count, from the same source as ac and an.'),
    source: z.string().describe('Carried callset(s), pipe-joined (e.g. exome|genome).'),
    flags: z.string().describe('Quality flags, pipe-joined (empty when none).'),
    exome_filters: callsetFiltersField('exome'),
    genome_filters: callsetFiltersField('genome'),
    qc_status: z
      .enum(['pass', 'filtered'])
      .describe(
        "gnomAD's QC verdict, by its browser's rule: pass when at least one callset carrying the variant passed QC (an empty filters column); filtered when none did — gnomAD's browser hides these by default, and AC0 among the filters means no high-quality carrier.",
      ),
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
        "On a gene target, where transcript_id sits as gnomAD's gene table marks it (†): mane_select when it is the gene's MANE Select transcript; canonical when the gene has no MANE Select (none on gnomad_r2_1 or exac) and it is the canonical transcript; other when the consequence is on another transcript, so it may be milder or absent on the primary one — gnomad_get_variant's primary_transcript gives that term. Null on transcript and region targets, and for a gene with neither a MANE Select nor a canonical transcript.",
      ),
  })
  .describe('One gene-variant row — also the canvas table column set.');

export const gnomadListGeneVariants = tool('gnomad_list_gene_variants', {
  title: 'gnomad-genetics-mcp-server: list gene variants',
  description:
    "List every gnomAD variant in a gene, transcript, or region with allele frequencies, predicted consequences, and QC status, optionally filtered to one consequence class (lof, missense, synonymous, other) and/or a maximum allele frequency. Every row carries its exome and genome QC filters and a qc_status; qc_filtered counts the matching variants that failed QC in every callset carrying them (often AC0, no high-quality carrier, at AF 0), which gnomAD's browser hides by default — read them as low-confidence, not observed variants, or pass pass_only to drop them. A result too large to inline is staged on a DataCanvas table named gene_variants, returned as canvas_id and table_name beside an inline preview — call gnomad_dataframe_describe for its columns, then gnomad_dataframe_query to rank by AF, count by consequence, or group across every row rather than the preview. A result that fits inline stages no table unless canvas_id is supplied. When the canvas is disabled (CANVAS_PROVIDER_TYPE=none) the tool returns a capped inline preview and the SQL path is unavailable. Supply exactly one of gene, transcript_id, or region. Echoes the effective dataset and build.\nData source: gnomAD (Broad Institute) — https://gnomad.broadinstitute.org/",
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    gene: optionalGeneField,
    transcript_id: z
      .string()
      .trim()
      .optional()
      .describe(
        'Ensembl transcript ID (e.g. ENST00000302118). Mutually exclusive with gene and region; blank means omitted.',
      ),
    region: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(REGION_REGEX, 'Region must be chrom-start-stop, e.g. 13-32315474-32400266.')
          .describe(
            'Genomic region chrom-start-stop (1-based inclusive, e.g. 13-32315474-32400266) on chromosome 1–22, X, or Y, optional chr prefix.',
          ),
      ])
      .optional()
      .describe(
        'Genomic region chrom-start-stop (1-based inclusive, e.g. 13-32315474-32400266): chromosome 1–22, X, or Y with an optional chr prefix (mitochondrial regions are not served), a span (stop − start) under 2,500,000 bp, and at most ~30,000 variants. Mutually exclusive with gene and transcript_id.',
      ),
    consequence_class: z
      .enum(['lof', 'missense', 'synonymous', 'other'])
      .optional()
      .describe(
        "Keep only variants in this gnomAD consequence category, read from each row's consequence: lof (pLoF) is transcript_ablation, splice_acceptor_variant, splice_donor_variant, stop_gained, frameshift_variant; missense (missense / inframe indel) is missense_variant, stop_lost, start_lost, inframe_insertion, inframe_deletion; synonymous is synonymous_variant; other is every other term and a null consequence. Omit to return all classes.",
      ),
    max_af: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        'Keep only variants with allele frequency ≤ this value (0–1). Variants with null AF are always kept.',
      ),
    pass_only: z
      .boolean()
      .optional()
      .describe(
        "Keep only variants that passed gnomAD QC in at least one callset carrying them (qc_status pass), as gnomAD's browser shows by default. Applied after consequence_class and max_af; qc_filtered still counts the dropped rows. Omit to list every matching variant with its QC columns — a single-position region then never reads as absent because of QC.",
      ),
    canvas_id: CanvasIdSchema.optional().describe(
      'Optional canvas ID from a prior call, to reuse the same canvas. When supplied, this call always writes its result to the gene_variants table on that canvas, replacing (not appending to) the previous one — even when the result fits inline; a result with no variants removes the table. Omit to stage on a fresh canvas only when the result is too large to inline.',
    ),
    dataset: datasetField,
    reference_genome: referenceGenomeField,
  }),
  output: z.object({
    preview: z
      .array(GeneVariantRowSchema)
      .describe(
        'Inline preview rows — the immediate answer; every matching variant unless spilled.',
      ),
    canvas_id: z
      .string()
      .describe(
        'Canvas holding table_name (or the canvas_id you supplied) — pass it to gnomad_dataframe_describe, then gnomad_dataframe_query. Empty when this call used no canvas: the result fit inline and no canvas_id was supplied, or the canvas is disabled.',
      ),
    table_name: z
      .string()
      .describe(
        'Canvas table this call staged (gene_variants), holding every matching variant — inspect it with gnomad_dataframe_describe, then query it with gnomad_dataframe_query. Empty when this call staged no table.',
      ),
    spilled: z
      .boolean()
      .describe(
        'True when the result exceeded the inline preview budget, so the preview holds only the first rows and table_name holds them all.',
      ),
    total: z
      .number()
      .describe(
        'Total matching variants, including any beyond the preview — counted after pass_only drops QC-failed rows when it is set, so it then excludes the qc_filtered rows.',
      ),
    qc_filtered: z
      .number()
      .describe(
        'Matching variants that failed gnomAD QC in every callset carrying them (qc_status filtered), counted over every match — not just the preview — before pass_only drops them.',
      ),
    dataset: z.string().describe('Effective gnomAD dataset.'),
    reference_genome: z.string().describe('Effective reference build.'),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no variants matched, when matching variants failed gnomAD QC (the qc_filtered count, and what pass_only dropped), when the canvas is disabled and the preview is capped, and — when a table was staged — its name with the next steps: gnomad_dataframe_describe, then gnomad_dataframe_query.',
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
        'Omit reference_genome to let it derive, or pass the build matching the dataset (v4/v3=GRCh38, v2.1/ExAC=GRCh37).',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_region',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The region names a chromosome outside 1–22, X, Y, or breaks the coordinate bounds.',
      recovery:
        'Pass region as chrom-start-stop on chromosome 1–22, X, or Y (optional chr prefix, e.g. chr13-32315474-32400266), with start at least 1, stop below 1,000,000,000, and start ≤ stop.',
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

    const matched = await svc.listGeneVariants(
      target,
      { consequenceClass: input.consequence_class, maxAf: input.max_af },
      dsCtx,
      ctx,
    );
    // Counted over every match before pass_only, so the count survives the drop.
    const qcFiltered = matched.filter((row) => row.qc_status === 'filtered').length;
    const rows = input.pass_only ? matched.filter((row) => row.qc_status === 'pass') : matched;

    /**
     * ctx.enrich.notice is last-wins, so every part is collected here and
     * written once, in order: no-match or QC → capped preview → staged table.
     */
    const notices: string[] = [];
    const scope = targetScope(target.kind, target.value, input);
    if (matched.length === 0) {
      notices.push(
        `No variants in ${scope}. Broaden the filters, or verify the ${target.kind} exists in this dataset.`,
      );
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

    const { capped, staged } = await stageRows({
      rows,
      canvasId: input.canvas_id,
      tableName: TABLE_NAME,
      schema: TABLE_SCHEMA,
      previewChars: PREVIEW_CHARS,
      ctx,
    });
    if (capped) {
      notices.push(
        `Canvas is disabled (set CANVAS_PROVIDER_TYPE=duckdb) — showing ${staged.preview.length} of ${rows.length} variants. Enable the canvas to query the full set with gnomad_dataframe_query.`,
      );
    }
    if (staged.table_name) {
      notices.push(
        `Staged ${staged.total} variant(s) in table "${staged.table_name}" (canvas_id ${staged.canvas_id}). Call gnomad_dataframe_describe for its columns, then gnomad_dataframe_query to run SQL over every staged row.`,
      );
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return {
      ...staged,
      qc_filtered: qcFiltered,
      dataset: dsCtx.dataset,
      reference_genome: dsCtx.reference_genome,
    };
  },

  format: (result) => {
    const lines = [
      `## Gene variants — ${result.total} total`,
      `**Dataset:** ${result.dataset} (${result.reference_genome}) | **Spilled:** ${result.spilled ? 'yes' : 'no'} | **QC filtered:** ${result.qc_filtered}`,
      stagedLine(result),
      '',
      `Showing ${result.preview.length} preview row(s):`,
    ];
    for (const r of result.preview) {
      const af = r.af != null ? `${r.af} (${r.af.toExponential(3)})` : 'n/a';
      // A null filters column (callset not carrying the variant) is left out; '' is a pass.
      const callsetQc = (
        [
          ['exome', r.exome_filters],
          ['genome', r.genome_filters],
        ] as const
      )
        .filter(([, filters]) => filters != null)
        .map(([name, filters]) => `${name} ${filters ? escapeMarkdownInline(filters) : 'passed'}`);
      // Left out only when both are null (no transcript, no marker); a gene row without a transcript is still marked.
      const transcript =
        r.transcript_id == null && r.consequence_transcript == null
          ? ''
          : ` | transcript ${escapeMarkdownInline(r.transcript_id ?? 'none')}${r.consequence_transcript ? ` (${r.consequence_transcript})` : ''}`;
      lines.push(
        `- **${escapeMarkdownInline(r.variant_id)}** | ${r.consequence_class}${r.consequence ? ` (${escapeMarkdownInline(r.consequence)})` : ''} | AF ${af} | AC ${r.ac}/${r.an} | hom ${r.homozygote_count} | ${escapeMarkdownInline(r.source || 'none')}${r.flags ? ` | flags ${escapeMarkdownInline(r.flags)}` : ''} | QC ${r.qc_status}${callsetQc.length ? ` (${callsetQc.join(', ')})` : ''}${transcript}`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/** The target and its filters, as the no-match and QC notices name them. */
function targetScope(
  kind: string,
  value: string,
  input: { consequence_class?: string | undefined; max_af?: number | undefined },
): string {
  const filters: string[] = [];
  if (input.consequence_class) filters.push(`consequence_class=${input.consequence_class}`);
  if (input.max_af != null) filters.push(`max_af=${input.max_af}`);
  const filterText = filters.length ? ` matching ${filters.join(', ')}` : '';
  return `${kind} "${value}"${filterText}`;
}
