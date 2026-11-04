/**
 * @fileoverview gnomad_search_clinvar — gene-level ClinVar detail beyond the
 * per-variant join gnomAD provides: pathogenic / likely-pathogenic variant
 * lists, germline review status (star rating), somatic oncogenicity and
 * clinical-impact classifications, submission counts, and gnomAD-compatible
 * identifiers via NCBI E-utilities, in offset/limit windows over the ClinVar
 * match list, echoing the gene and filters searched. A GRCh38 variant ID the
 * canonical SPDI cannot give exactly (indels) is filled, best-effort, from
 * gnomAD's ClinVar mapping for the gene within the call's 45 s budget. With
 * the canvas on, a window larger than the inline preview spills to a DataCanvas
 * table (clinvar_variants) for gnomad_dataframe_describe and
 * gnomad_dataframe_query; with it off, every row of the window is inline and
 * the descriptions name no dataframe tool, since none is registered.
 * @module mcp-server/tools/definitions/gnomad-search-clinvar.tool
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { isCanvasEnabled } from '@/config/server-config.js';
import {
  CLINVAR_OFFSET_MAX,
  CLINVAR_WINDOW_CAP,
  CLINVAR_WINDOW_DEFAULT,
  clinvarGeneSymbol,
  getClinVarService,
  normalizeSignificance,
} from '@/services/clinvar/clinvar-service.js';
import type { ClinVarRow, ClinVarSearchResult } from '@/services/clinvar/types.js';
import { getGnomadService } from '@/services/gnomad/gnomad-service.js';
import { ENSEMBL_GENE_ID } from '@/services/gnomad/identifier-normalization.js';
import { rowSchema, stagedLine, stageRows } from '../canvas-staging.js';
import { type CountLimit, clampLimit, limitSchema } from '../count-limit.js';
import { geneField } from '../shared-schemas.js';

const TABLE_NAME = 'clinvar_variants';
/**
 * Inline preview budget in JSON characters of the preview rows while the
 * canvas is on; with it off, every row of the window is inline. Each row lands
 * on both surfaces (structuredContent and the multi-line format() block). The
 * somatic fields add JSON characters but no content[] line on a row without a
 * somatic classification, so the heaviest real BRCA1 rows still measure ~1.98
 * serialized bytes per JSON character: a full 500-record window previews 7 rows
 * (10,481 characters) in a 20.8 KB response, notice included, so 11,000 keeps
 * a response under 22 KB.
 */
const PREVIEW_CHARS = 11_000;

const LIMIT: CountLimit = {
  tool: 'gnomad_search_clinvar',
  default: CLINVAR_WINDOW_DEFAULT,
  cap: CLINVAR_WINDOW_CAP,
};

/**
 * Read once, when the definition evaluates: the dataframe tools are registered
 * only while the canvas is on, so the descriptions name them only then.
 */
const CANVAS_ON = isCanvasEnabled();

const STAGING_DESCRIPTION = CANVAS_ON
  ? 'A window too large to inline is staged on a DataCanvas table named clinvar_variants, returned as canvas_id and table_name beside an inline preview — call gnomad_dataframe_describe for its columns, then gnomad_dataframe_query to rank or count across the window. A window that fits inline stages no table unless canvas_id is supplied.'
  : 'Every row of the window is returned inline.';
const CANVAS_OFF_FIELD = 'Always empty: DataCanvas is off on this server.';

/** The row filters a window applied, as the output echoes them. */
const FiltersSchema = z
  .object({
    clinical_significance: z
      .string()
      .nullable()
      .describe(
        'The clinical_significance filter as applied — quotes dropped, underscores read as spaces, trimmed, lowercased; null when omitted or blank.',
      ),
    min_review_stars: z
      .number()
      .nullable()
      .describe('The min_review_stars floor; null when omitted.'),
  })
  .describe('Row filters applied to this window; offset and limit are not filters.');
type Filters = z.infer<typeof FiltersSchema>;

/** clinvar_variants column types, declared from ClinVarRow in its field order. */
const TABLE_SCHEMA = rowSchema<ClinVarRow>({
  clinvar_variation_id: { type: 'VARCHAR', nullable: false },
  accession: { type: 'VARCHAR', nullable: false },
  title: { type: 'VARCHAR', nullable: false },
  obj_type: { type: 'VARCHAR', nullable: false },
  clinical_significance: { type: 'VARCHAR', nullable: true },
  review_status: { type: 'VARCHAR', nullable: true },
  gold_stars: { type: 'BIGINT', nullable: false },
  last_evaluated: { type: 'VARCHAR', nullable: true },
  molecular_consequences: { type: 'VARCHAR', nullable: false },
  protein_change: { type: 'VARCHAR', nullable: false },
  conditions: { type: 'VARCHAR', nullable: false },
  oncogenicity_classification: { type: 'VARCHAR', nullable: true },
  oncogenicity_review_status: { type: 'VARCHAR', nullable: true },
  oncogenicity_last_evaluated: { type: 'VARCHAR', nullable: true },
  oncogenicity_conditions: { type: 'VARCHAR', nullable: false },
  clinical_impact_classification: { type: 'VARCHAR', nullable: true },
  clinical_impact_review_status: { type: 'VARCHAR', nullable: true },
  clinical_impact_last_evaluated: { type: 'VARCHAR', nullable: true },
  clinical_impact_conditions: { type: 'VARCHAR', nullable: false },
  submission_count: { type: 'BIGINT', nullable: false },
  canonical_spdi: { type: 'VARCHAR', nullable: true },
  rsids: { type: 'VARCHAR', nullable: false },
  grch38_variant_id: { type: 'VARCHAR', nullable: true },
});

const ClinVarRowSchema = z
  .object({
    clinvar_variation_id: z.string().describe('ClinVar VariationID (uid).'),
    accession: z.string().describe('ClinVar accession (e.g. VCV004855003).'),
    title: z.string().describe('Variant title (HGVS expression).'),
    obj_type: z.string().describe('Variant object type (e.g. single nucleotide variant).'),
    clinical_significance: z
      .string()
      .nullable()
      .describe(
        'Germline classification (e.g. Pathogenic); null when none, as on a record ClinVar classifies only for somatic use (see oncogenicity_classification and clinical_impact_classification).',
      ),
    review_status: z
      .string()
      .nullable()
      .describe('Review status of the germline classification; null when none.'),
    gold_stars: z
      .number()
      .describe('0–4 star rating derived from the germline review status; 0 when there is none.'),
    last_evaluated: z
      .string()
      .nullable()
      .describe('Date the germline classification was last evaluated; null when unknown.'),
    molecular_consequences: z.string().describe('Molecular consequences, semicolon-joined.'),
    protein_change: z.string().describe('Protein change(s), comma-joined as ClinVar reports them.'),
    conditions: z
      .string()
      .describe('Conditions the germline classification names, semicolon-joined; empty when none.'),
    oncogenicity_classification: z
      .string()
      .nullable()
      .describe(
        'Somatic oncogenicity classification (e.g. Likely oncogenic, Oncogenic); null when none.',
      ),
    oncogenicity_review_status: z
      .string()
      .nullable()
      .describe(
        'Review status of the oncogenicity classification; null when none. No star rating is derived from it.',
      ),
    oncogenicity_last_evaluated: z
      .string()
      .nullable()
      .describe('Date the oncogenicity classification was last evaluated; null when unknown.'),
    oncogenicity_conditions: z
      .string()
      .describe(
        'Tumor types the oncogenicity classification applies to, semicolon-joined; empty when none.',
      ),
    clinical_impact_classification: z
      .string()
      .nullable()
      .describe(
        'Somatic clinical-impact classification, an AMP/ASCO/CAP tier (e.g. Tier I - Strong); null when none.',
      ),
    clinical_impact_review_status: z
      .string()
      .nullable()
      .describe(
        'Review status of the clinical-impact classification; null when none. No star rating is derived from it.',
      ),
    clinical_impact_last_evaluated: z
      .string()
      .nullable()
      .describe('Date the clinical-impact classification was last evaluated; null when unknown.'),
    clinical_impact_conditions: z
      .string()
      .describe(
        'Tumor types the clinical-impact classification applies to, semicolon-joined; empty when none.',
      ),
    submission_count: z.number().describe('Number of submitted (SCV) records.'),
    canonical_spdi: z
      .string()
      .nullable()
      .describe(
        'Canonical SPDI of the variant (GRCh38, e.g. NC_000001.11:55039973:G:T); null for multi-allele records, CNVs, and records without one.',
      ),
    rsids: z
      .string()
      .describe(
        'dbSNP rsIDs (e.g. rs11591147), semicolon-joined; empty when none. One rsID can match several gnomAD variants, so prefer grch38_variant_id for gnomad_get_variant.',
      ),
    grch38_variant_id: z
      .string()
      .nullable()
      .describe(
        "gnomAD variant ID (chrom-pos-ref-alt, GRCh38) for gnomad_get_variant with a GRCh38 dataset (gnomad_r4, gnomad_r3, or one of their subsets). Derived from the canonical SPDI for SNVs, MNVs, and delins; for deletions, insertions, and duplications, taken from gnomAD's ClinVar mapping by VariationID. Most of those indel IDs are absent from gnomAD's callsets, so gnomad_get_variant answers variant_not_found: absence evidence to pair with gnomad_get_coverage. Null for mitochondrial variants, multi-allele, copy-number, and imprecise structural records, and for records newer than gnomAD's ClinVar release, which lags NCBI's.",
      ),
  })
  .describe('One ClinVar variant row — also the canvas table column set.');

export const gnomadSearchClinvar = tool('gnomad_search_clinvar', {
  title: 'gnomad-genetics-mcp-server: search clinvar',
  description: `Search ClinVar (NCBI E-utilities) for a gene and return its classified variants — the germline clinical significance with its review status, 0–4 star rating, and conditions; any somatic oncogenicity or clinical-impact classification with its own review status and tumor types; molecular consequences, submission counts, and gnomAD-compatible identifiers (canonical SPDI, rsIDs, and a GRCh38 variant ID for gnomad_get_variant, derived from the SPDI or filled from gnomAD's own ClinVar mapping) — turning the variant-level significance gnomAD joins into a gene-panel curation view. Optionally filter by germline clinical_significance (e.g. pathogenic) and a minimum germline star rating. Each call returns one window of up to limit ClinVar records (default ${LIMIT.default}): total_found is the ClinVar count for the search terms (the match count for a mapped significance term alone, a candidate count once min_review_stars or any other term applies), and next_offset continues through the rest via offset. ${STAGING_DESCRIPTION} Keyless, but honors NCBI_API_KEY for a higher rate limit. Credit: ClinVar, NCBI.`,
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    // Tool-specific override of the shared geneField: ClinVar indexes HGNC
    // symbols only. .describe() clones the field, so the shared fragment other
    // tools reuse (which legitimately accept ENSG IDs) is left untouched.
    gene: geneField.describe(
      'Gene HGNC symbol (e.g. PCSK9). ClinVar indexes HGNC symbols only — Ensembl gene IDs (ENSG…) are not resolved here, unlike the other gnomAD tools; resolve one to its symbol via ensembl_lookup_gene.',
    ),
    clinical_significance: z
      .string()
      .trim()
      .optional()
      .describe(
        "Filter by ClinVar germline classification, case-insensitive, matched as whole words; underscores read as spaces. Somatic oncogenicity and clinical-impact classifications are never matched. pathogenic (Pathogenic and Likely pathogenic, combined and low-penetrance forms included), likely pathogenic, uncertain significance, vus (Uncertain significance plus VUS-high, VUS-mid, and VUS-low), likely benign, benign (Benign and Likely benign), and conflicting search ClinVar's germline classification index, so on their own their windows hold matching records only. Any other term (e.g. risk factor) narrows a text search, and its windows can return fewer rows than limit. Blank means no filter.",
      ),
    min_review_stars: z
      .number()
      .int()
      .min(0)
      .max(4)
      .optional()
      .describe(
        "Keep only variants whose germline classification has at least this gold-star rating (0–4). ClinVar's review-status search also matches the review status of a somatic classification, and those records are dropped after the fetch, so a window can return fewer rows than limit.",
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .max(CLINVAR_OFFSET_MAX)
      .default(0)
      .describe(
        'Zero-based position of the first ClinVar record in this window. Pass next_offset from the previous call to continue.',
      ),
    limit: limitSchema(
      LIMIT,
      'ClinVar records to fetch in this window. A mapped clinical_significance term alone narrows the search to matching records, so its windows are full; min_review_stars and any other significance term are also applied after the fetch, so their windows can return fewer rows.',
    ),
    canvas_id: CanvasIdSchema.optional().describe(
      CANVAS_ON
        ? 'Optional canvas ID from a prior call, to reuse the same canvas. When supplied, each search writes its window to the clinvar_variants table on that canvas, replacing (not appending to) the previous one — even when the window fits inline; a window with no rows removes the table. An Ensembl gene ID searches nothing and leaves the canvas as it was. Omit to stage on a fresh canvas only when the window is too large to inline.'
        : 'Ignored: DataCanvas is off on this server, so every row of the window is returned inline.',
    ),
  }),
  output: z.object({
    gene: z.string().describe('The gene searched, as given.'),
    filters: FiltersSchema,
    preview: z
      .array(ClinVarRowSchema)
      .describe(
        "Inline preview rows — the immediate answer; the window's every row unless spilled.",
      ),
    canvas_id: z
      .string()
      .describe(
        CANVAS_ON
          ? 'Canvas holding table_name (or the canvas_id you supplied) — pass it to gnomad_dataframe_describe, then gnomad_dataframe_query. Empty when this call used no canvas: the window fit inline and no canvas_id was supplied, the gene was an Ensembl ID (nothing was searched), or the canvas is disabled.'
          : CANVAS_OFF_FIELD,
      ),
    table_name: z
      .string()
      .describe(
        CANVAS_ON
          ? "Canvas table this call staged (clinvar_variants), holding this window's rows — inspect it with gnomad_dataframe_describe, then query it with gnomad_dataframe_query. Empty when this call staged no table."
          : CANVAS_OFF_FIELD,
      ),
    spilled: z
      .boolean()
      .describe(
        CANVAS_ON
          ? "True when this window's rows exceeded the inline preview budget, so the preview holds only the first rows and table_name holds them all."
          : 'Always false: DataCanvas is off on this server, so preview holds every row of the window.',
      ),
    total: z
      .number()
      .describe('Rows in this window that passed the filters, including any beyond the preview.'),
    total_found: z
      .number()
      .describe(
        'ClinVar records matching the gene and filter terms across every window, counted by the search before the post-fetch filters: the match count for a mapped significance term alone, a candidate count once min_review_stars or any other term applies.',
      ),
    truncated: z
      .boolean()
      .describe('True when ClinVar records remain past this window; continue with next_offset.'),
    next_offset: z
      .number()
      .nullable()
      .describe('offset for the next window; null when this window reaches the end.'),
    unavailable_ids: z
      .array(z.string())
      .describe(
        'VariationIDs in this window that ClinVar returned no summary for, so they have no row; empty when none.',
      ),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        CANVAS_ON
          ? "Guidance on a clamped limit, completeness (the offset that continues the list, or an offset past the end), no-match results, the staged table with its next steps (gnomad_dataframe_describe, then gnomad_dataframe_query), gnomAD's ClinVar mapping when it could not fill missing grch38_variant_id values, and which identifier to pass to gnomad_get_variant."
          : "Guidance on a clamped limit, completeness (the offset that continues the list, or an offset past the end), no-match results, gnomAD's ClinVar mapping when it could not fill missing grch38_variant_id values, and which identifier to pass to gnomad_get_variant.",
      ),
  },
  enrichmentTrailer: { notice: { render: escapeMarkdownInline } },
  errors: [
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'NCBI E-utilities is unreachable, failing, or rate-limiting after retries.',
      recovery:
        'NCBI is degraded or throttling; wait a few seconds and retry, or set NCBI_API_KEY for a higher rate limit.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'NCBI attempts timed out or the shared 45 s search-and-summary budget expired.',
      recovery:
        'NCBI did not answer in time; wait a few seconds and retry, or pass a smaller limit so the window needs fewer summary requests.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_access',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'NCBI E-utilities refused the request (access denied).',
      recovery:
        'Do not retry: NCBI is refusing requests from this server. Tell the user ClinVar search is blocked upstream and point them to https://www.ncbi.nlm.nih.gov/clinvar/.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'invalid_upstream_response',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'NCBI E-utilities kept answering with a response that failed validation.',
      recovery:
        'Wait a few seconds and retry; NCBI returned a response this server could not validate.',
      retryable: true,
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    // The NCBI search and gnomAD's ClinVar mapping share one call budget from here.
    const startedAt = Date.now();
    const echo = {
      gene: input.gene,
      filters: {
        clinical_significance: normalizeSignificance(input.clinical_significance) ?? null,
        min_review_stars: input.min_review_stars ?? null,
      },
    };
    /**
     * ClinVar's [gene] index resolves HGNC symbols only, so an Ensembl gene ID,
     * versioned or not, always yields zero records. Name the real cause instead
     * of running a guaranteed-empty NCBI query and returning the misdirecting
     * generic "verify the gene symbol" notice. The check rewrites nothing, so
     * GNOMAD_NORMALIZE_IDS does not gate it. Nothing was searched, so the canvas
     * is not touched either — a supplied canvas_id and its table stay as they were.
     */
    if (ENSEMBL_GENE_ID.test(input.gene)) {
      ctx.enrich.notice(
        `ClinVar search needs an HGNC symbol; Ensembl gene IDs (ENSG…) are not indexed by ClinVar. Resolve "${input.gene}" to its symbol (e.g. via ensembl_lookup_gene) and retry.`,
      );
      return {
        ...echo,
        preview: [],
        canvas_id: '',
        table_name: '',
        spilled: false,
        total: 0,
        total_found: 0,
        truncated: false,
        next_offset: null,
        unavailable_ids: [],
      };
    }

    const { applied: limit, notice: clamped } = clampLimit(ctx, LIMIT, input.limit);
    const search = await getClinVarService().searchGene(
      input.gene,
      {
        clinicalSignificance: input.clinical_significance,
        minReviewStars: input.min_review_stars,
        offset: input.offset,
        limit,
      },
      ctx,
    );
    // Filled before staging, so the preview, content[], and the staged table agree.
    const { rows, notice: mapping } = await fillVariantIds(search.rows, input.gene, ctx, startedAt);

    /**
     * ctx.enrich.notice is last-wins, so every part is collected here and
     * written once, in order: clamped limit → completeness → staged table →
     * ID mapping → identifiers.
     */
    const notices: string[] = [];
    if (clamped) notices.push(clamped);
    const completeness = windowNotice({ ...echo, offset: input.offset, limit }, search);
    if (completeness) notices.push(completeness);

    const staged = await stageRows({
      rows,
      canvasId: input.canvas_id,
      tableName: TABLE_NAME,
      schema: TABLE_SCHEMA,
      previewChars: PREVIEW_CHARS,
      ctx,
    });
    if (staged.table_name) {
      notices.push(
        `Staged this window's ${staged.total} record(s) in table "${staged.table_name}" (canvas_id ${staged.canvas_id}). Call gnomad_dataframe_describe for its columns, then gnomad_dataframe_query to run SQL over the staged window.`,
      );
    }

    if (mapping) notices.push(mapping);
    const identifiers = identifierNotice(rows);
    if (identifiers) notices.push(identifiers);
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return {
      ...echo,
      ...staged,
      total_found: search.totalFound,
      truncated: search.truncated,
      next_offset: search.nextOffset,
      unavailable_ids: search.unavailableIds,
    };
  },

  format: (result) => {
    const lines = [
      `## ClinVar — ${result.total} record(s)`,
      `**Gene:** ${escapeMarkdownInline(result.gene)} | **Filters:** ${filterList(result.filters, escapeMarkdownInline) ?? 'none'}`,
      `**Total found:** ${result.total_found} | **Truncated:** ${result.truncated ? 'yes' : 'no'} | **Next offset:** ${result.next_offset ?? 'none'}`,
      `**Unavailable IDs:** ${result.unavailable_ids.length ? result.unavailable_ids.join(', ') : 'none'}`,
      `**Spilled:** ${result.spilled ? 'yes' : 'no'}`,
      stagedLine(result),
      '',
      `Showing ${result.preview.length} preview row(s):`,
    ];
    for (const r of result.preview) {
      lines.push(
        `**Variant:** ${escapeMarkdownInline(r.title || r.accession)}`,
        `**VariationID:** ${escapeMarkdownInline(r.clinvar_variation_id)} | **Accession:** ${escapeMarkdownInline(r.accession)} | **Type:** ${escapeMarkdownInline(r.obj_type)}`,
        `**GRCh38 variant ID:** ${escapeMarkdownInline(r.grch38_variant_id ?? 'Not available')} | **rsIDs:** ${escapeMarkdownInline(r.rsids || 'none')} | **Canonical SPDI:** ${escapeMarkdownInline(r.canonical_spdi ?? 'Not available')}`,
        `**Significance:** ${escapeMarkdownInline(r.clinical_significance ?? 'Not available')} (${r.gold_stars}★) | **Review:** ${escapeMarkdownInline(r.review_status ?? 'Not available')} | **Last evaluated:** ${escapeMarkdownInline(r.last_evaluated ?? 'Not available')}`,
        `**Consequences:** ${escapeMarkdownInline(r.molecular_consequences || 'Not available')} | **Protein change:** ${escapeMarkdownInline(r.protein_change || 'Not available')} | **Submissions:** ${r.submission_count}`,
        `**Conditions:** ${escapeMarkdownInline(r.conditions || 'Not available')}`,
      );
      const oncogenicity = somaticLine('Oncogenicity', {
        classification: r.oncogenicity_classification,
        review: r.oncogenicity_review_status,
        lastEvaluated: r.oncogenicity_last_evaluated,
        conditions: r.oncogenicity_conditions,
      });
      if (oncogenicity) lines.push(oncogenicity);
      const impact = somaticLine('Clinical impact', {
        classification: r.clinical_impact_classification,
        review: r.clinical_impact_review_status,
        lastEvaluated: r.clinical_impact_last_evaluated,
        conditions: r.clinical_impact_conditions,
      });
      if (impact) lines.push(impact);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/**
 * One somatic classification's content[] line, or undefined when the row
 * carries none of its four values — most rows, since ClinVar classifies few
 * records for somatic use — so a row without one gets no line.
 */
function somaticLine(
  label: string,
  block: {
    classification: string | null;
    conditions: string;
    lastEvaluated: string | null;
    review: string | null;
  },
): string | undefined {
  const { classification, review, lastEvaluated, conditions } = block;
  if (!classification && !review && !lastEvaluated && !conditions) return;
  return `**${label}:** ${escapeMarkdownInline(classification ?? 'Not available')} | **Review:** ${escapeMarkdownInline(review ?? 'Not available')} | **Last evaluated:** ${escapeMarkdownInline(lastEvaluated ?? 'Not available')} | **Conditions:** ${escapeMarkdownInline(conditions || 'Not available')}`;
}

/** One searched window: the echoed gene and filters, and the offset and applied limit. */
interface SearchWindow {
  filters: Filters;
  gene: string;
  limit: number;
  offset: number;
}

/**
 * `clinical_significance=…, min_review_stars=…` for the filters set, else
 * undefined. `render` escapes the caller's significance for content[].
 */
function filterList(filters: Filters, render: (text: string) => string = (text) => text) {
  const parts: string[] = [];
  if (filters.clinical_significance != null) {
    parts.push(`clinical_significance=${render(filters.clinical_significance)}`);
  }
  if (filters.min_review_stars != null) parts.push(`min_review_stars=${filters.min_review_stars}`);
  return parts.length ? parts.join(', ') : undefined;
}

/** ` matching clinical_significance=…, min_review_stars=…` for the filters applied, else ''. */
function filterText(input: SearchWindow): string {
  const filters = filterList(input.filters);
  return filters ? ` matching ${filters}` : '';
}

/**
 * Completeness guidance for one window: no candidates at all (whatever the
 * offset), how to continue a truncated list, an offset past the end. A window
 * with no rows that is not the whole list gets the window's position — the
 * continuation or the end of the list — never the no-records text.
 */
function windowNotice(input: SearchWindow, search: ClinVarSearchResult): string | undefined {
  const { offset, limit } = input;
  const { totalFound, nextOffset } = search;
  const range = `${offset + 1}–${Math.min(offset + limit, totalFound)} of ${totalFound}`;
  if (search.rows.length === 0) {
    if (totalFound === 0) {
      return `No ClinVar records for "${input.gene}"${filterText(input)}. Broaden the filters or verify the gene symbol.`;
    }
    if (offset >= totalFound) {
      return `offset ${offset} is past the end of the ${totalFound} ClinVar records for "${input.gene}"${filterText(input)}; use an offset below ${totalFound}.`;
    }
    if (offset > 0 || nextOffset != null) {
      const position =
        nextOffset != null ? `Continue with offset=${nextOffset}.` : 'This is the last window.';
      return `No records${filterText(input)} among ClinVar candidates ${range} for "${input.gene}". ${position}`;
    }
    return `No ClinVar records for "${input.gene}"${filterText(input)}. Broaden the filters.`;
  }
  if (nextOffset != null) {
    return `This window covers ClinVar candidates ${range} for "${input.gene}"${filterText(input)}; continue with offset=${nextOffset} for the next window.`;
  }
  return;
}

/**
 * Fill each null grch38_variant_id from gnomAD's ClinVar mapping by
 * VariationID, never replacing one derived from the SPDI. A window with no null
 * ID sends no request. The mapping is best-effort: a failure, a spent call
 * budget, or a gene gnomAD lacks leaves the nulls and returns a notice, while
 * caller cancellation rejects.
 */
async function fillVariantIds(
  rows: ClinVarRow[],
  gene: string,
  ctx: Context,
  startedAt: number,
): Promise<{ notice?: string; rows: ClinVarRow[] }> {
  const missing = rows.filter((r) => r.grch38_variant_id == null).length;
  if (missing === 0) return { rows };
  const symbol = clinvarGeneSymbol(gene);
  const mapping = await getGnomadService().clinvarVariantIds(symbol, ctx, { startedAt });
  switch (mapping.status) {
    case 'resolved':
      return {
        rows: rows.map((r) =>
          r.grch38_variant_id == null
            ? {
                ...r,
                grch38_variant_id: mapping.variantIds.get(r.clinvar_variation_id) ?? null,
              }
            : r,
        ),
      };
    case 'gene_not_found':
      return {
        rows,
        notice: `gnomAD has no GRCh38 gene "${symbol}" to map ClinVar records from, so ${missing} row(s) without an SPDI-derived grch38_variant_id keep it null.`,
      };
    case 'unavailable':
      return {
        rows,
        notice: `gnomAD's ClinVar mapping for "${symbol}" failed or ran out of time, so ${missing} row(s) without an SPDI-derived grch38_variant_id keep it null. A later call can fill them once gnomAD answers; when the call's time budget ran out, a smaller limit leaves the mapping more of that budget.`,
      };
  }
}

/** Pointer from the window's identifiers to gnomad_get_variant, preferring the GRCh38 ID. */
function identifierNotice(rows: ClinVarRow[]): string | undefined {
  if (rows.some((r) => r.grch38_variant_id)) {
    return 'To check population frequency, pass grch38_variant_id to gnomad_get_variant with a GRCh38 dataset (gnomad_r4, gnomad_r3, or one of their subsets); prefer it over rsids, since one rsID can match several gnomAD variants.';
  }
  if (rows.some((r) => r.rsids)) {
    return 'rsids can be passed to gnomad_get_variant, but one rsID can match several gnomAD variants; no row in this window has a grch38_variant_id.';
  }
  return;
}
