/**
 * @fileoverview gnomad_search_clinvar — gene-level ClinVar detail beyond the
 * per-variant join gnomAD provides: pathogenic / likely-pathogenic variant
 * lists, review status (star rating), submission counts, and gnomAD-compatible
 * identifiers via NCBI E-utilities, in offset/limit windows over the ClinVar
 * match list. A window larger than the inline preview spills to a DataCanvas
 * table (clinvar_variants) for gnomad_dataframe_describe and gnomad_dataframe_query.
 * @module mcp-server/tools/definitions/gnomad-search-clinvar.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  CLINVAR_WINDOW_MAX,
  getClinVarService,
  normalizeSignificance,
} from '@/services/clinvar/clinvar-service.js';
import type { ClinVarRow, ClinVarSearchResult } from '@/services/clinvar/types.js';
import { rowSchema, stagedLine, stageRows } from '../canvas-staging.js';
import { geneField } from '../shared-schemas.js';

const TABLE_NAME = 'clinvar_variants';
/**
 * Inline preview budget in JSON characters of the preview rows, canvas on or
 * off. Each row lands on both surfaces (structuredContent and the multi-line
 * format() block), measured at ~1.98 serialized bytes per JSON character on
 * real PCSK9 rows, and the composed notice runs ~600 characters on each
 * surface, so 11,000 keeps a response near 22 KB.
 */
const PREVIEW_CHARS = 11_000;

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
  submission_count: { type: 'BIGINT', nullable: false },
  canonical_spdi: { type: 'VARCHAR', nullable: true },
  rsids: { type: 'VARCHAR', nullable: false },
  grch38_variant_id: { type: 'VARCHAR', nullable: true },
});

/**
 * Ensembl gene ID shape (ENSG…). ClinVar's `[gene]` index resolves HGNC symbols
 * only, so an ENSG ID — valid on every other gnomAD tool — always returns zero
 * records here; detect it to name the real cause instead of a bare empty result.
 */
const ENSEMBL_GENE_ID = /^ENSG\d+$/i;

const ClinVarRowSchema = z
  .object({
    clinvar_variation_id: z.string().describe('ClinVar VariationID (uid).'),
    accession: z.string().describe('ClinVar accession (e.g. VCV004855003).'),
    title: z.string().describe('Variant title (HGVS expression).'),
    obj_type: z.string().describe('Variant object type (e.g. single nucleotide variant).'),
    clinical_significance: z
      .string()
      .nullable()
      .describe('Germline classification (e.g. Pathogenic); null when none.'),
    review_status: z.string().nullable().describe('ClinVar review-status text; null when none.'),
    gold_stars: z.number().describe('0–4 star review rating derived from review status.'),
    last_evaluated: z
      .string()
      .nullable()
      .describe('Date the classification was last evaluated; null when unknown.'),
    molecular_consequences: z.string().describe('Molecular consequences, semicolon-joined.'),
    protein_change: z.string().describe('Protein change(s), comma-joined as ClinVar reports them.'),
    conditions: z.string().describe('Associated conditions/traits, semicolon-joined.'),
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
        'gnomAD variant ID (chrom-pos-ref-alt, GRCh38) for gnomad_get_variant with the GRCh38 datasets (gnomad_r4, gnomad_r3). Set for SNVs, MNVs, and delins; null for deletions, insertions, duplications, mitochondrial variants, and multi-allele records.',
      ),
  })
  .describe('One ClinVar variant row — also the canvas table column set.');

export const gnomadSearchClinvar = tool('gnomad_search_clinvar', {
  title: 'gnomad-genetics-mcp-server: search clinvar',
  description:
    'Search ClinVar (NCBI E-utilities) for a gene and return its classified variants — clinical significance, review status with a 0–4 star rating, associated conditions, molecular consequences, submission counts, and gnomAD-compatible identifiers (canonical SPDI, rsIDs, GRCh38 variant ID for gnomad_get_variant) — turning the variant-level significance gnomAD joins into a gene-panel curation view. Optionally filter by clinical_significance (e.g. pathogenic) and a minimum star rating. Each call returns one window of up to 500 ClinVar records: total_found is the ClinVar candidate count for the search terms, taken before the significance and star filters narrow each window, and next_offset continues through the rest via offset. A window too large to inline is staged on a DataCanvas table named clinvar_variants, returned as canvas_id and table_name beside an inline preview — call gnomad_dataframe_describe for its columns, then gnomad_dataframe_query to rank or count across the window. A window that fits inline stages no table unless canvas_id is supplied. Keyless, but honors NCBI_API_KEY for a higher rate limit. When the canvas is disabled the tool returns a capped inline preview. Credit: ClinVar, NCBI.',
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
        'Filter by ClinVar clinical significance term (e.g. pathogenic, likely_pathogenic, uncertain significance), matched as whole words; underscores read as spaces. Blank means no filter.',
      ),
    min_review_stars: z
      .number()
      .int()
      .min(0)
      .max(4)
      .optional()
      .describe('Keep only variants with at least this gold-star review rating (0–4).'),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Zero-based position of the first ClinVar record in this window. Pass next_offset from the previous call to continue.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(CLINVAR_WINDOW_MAX)
      .default(CLINVAR_WINDOW_MAX)
      .describe(
        'ClinVar records to fetch in this window (1–500). Counted before the clinical_significance and min_review_stars filters, so a window can return fewer rows.',
      ),
    canvas_id: CanvasIdSchema.optional().describe(
      'Optional canvas ID from a prior call, to reuse the same canvas. When supplied, each search writes its window to the clinvar_variants table on that canvas, replacing (not appending to) the previous one — even when the window fits inline; a window with no rows removes the table. An Ensembl gene ID searches nothing and leaves the canvas as it was. Omit to stage on a fresh canvas only when the window is too large to inline.',
    ),
  }),
  output: z.object({
    preview: z
      .array(ClinVarRowSchema)
      .describe(
        "Inline preview rows — the immediate answer; the window's every row unless spilled.",
      ),
    canvas_id: z
      .string()
      .describe(
        'Canvas holding table_name (or the canvas_id you supplied) — pass it to gnomad_dataframe_describe, then gnomad_dataframe_query. Empty when this call used no canvas: the window fit inline and no canvas_id was supplied, the gene was an Ensembl ID (nothing was searched), or the canvas is disabled.',
      ),
    table_name: z
      .string()
      .describe(
        "Canvas table this call staged (clinvar_variants), holding this window's rows — inspect it with gnomad_dataframe_describe, then query it with gnomad_dataframe_query. Empty when this call staged no table.",
      ),
    spilled: z
      .boolean()
      .describe(
        "True when this window's rows exceeded the inline preview budget, so the preview holds only the first rows and table_name holds them all.",
      ),
    total: z
      .number()
      .describe('Rows in this window that passed the filters, including any beyond the preview.'),
    total_found: z
      .number()
      .describe(
        'ClinVar records matching the gene and filter terms across every window, counted before the post-fetch significance and star filters.',
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
        'Guidance on completeness (the offset that continues the list, or an offset past the end), no-match results, a capped preview when the canvas is disabled, the staged table with its next steps (gnomad_dataframe_describe, then gnomad_dataframe_query), and which identifier to pass to gnomad_get_variant.',
      ),
  },
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
  ],

  async handler(input, ctx) {
    /**
     * ClinVar's [gene] index resolves HGNC symbols only, so an Ensembl gene ID
     * always yields zero records. Name the real cause instead of running a
     * guaranteed-empty NCBI query and returning the misdirecting generic
     * "verify the gene symbol" notice. Nothing was searched, so the canvas is
     * not touched either — a supplied canvas_id and its table stay as they were.
     */
    if (ENSEMBL_GENE_ID.test(input.gene)) {
      ctx.enrich.notice(
        `ClinVar search needs an HGNC symbol; Ensembl gene IDs (ENSG…) are not indexed by ClinVar. Resolve "${input.gene}" to its symbol (e.g. via ensembl_lookup_gene) and retry.`,
      );
      return {
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

    const search = await getClinVarService().searchGene(
      input.gene,
      {
        clinicalSignificance: input.clinical_significance,
        minReviewStars: input.min_review_stars,
        offset: input.offset,
        limit: input.limit,
      },
      ctx,
    );
    const { rows } = search;

    /**
     * ctx.enrich.notice is last-wins, so every part is collected here and
     * written once, in order: completeness → capped preview → staged table →
     * identifiers.
     */
    const notices: string[] = [];
    const completeness = windowNotice(input, search);
    if (completeness) notices.push(completeness);

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
        `Canvas is disabled (set CANVAS_PROVIDER_TYPE=duckdb) — showing ${staged.preview.length} of ${rows.length} records in this window. Enable the canvas to query every row with gnomad_dataframe_query.`,
      );
    }
    if (staged.table_name) {
      notices.push(
        `Staged this window's ${staged.total} record(s) in table "${staged.table_name}" (canvas_id ${staged.canvas_id}). Call gnomad_dataframe_describe for its columns, then gnomad_dataframe_query to run SQL over the staged window.`,
      );
    }

    const identifiers = identifierNotice(rows);
    if (identifiers) notices.push(identifiers);
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return {
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
      `**Total found:** ${result.total_found} | **Truncated:** ${result.truncated ? 'yes' : 'no'} | **Next offset:** ${result.next_offset ?? 'none'}`,
      `**Unavailable IDs:** ${result.unavailable_ids.length ? result.unavailable_ids.join(', ') : 'none'}`,
      `**Spilled:** ${result.spilled ? 'yes' : 'no'}`,
      stagedLine(result),
      '',
      `Showing ${result.preview.length} preview row(s):`,
    ];
    for (const r of result.preview) {
      lines.push(
        `### ${r.title || r.accession}`,
        `**VariationID:** ${r.clinvar_variation_id} | **Accession:** ${r.accession} | **Type:** ${r.obj_type}`,
        `**GRCh38 variant ID:** ${r.grch38_variant_id ?? 'Not available'} | **rsIDs:** ${r.rsids || 'none'} | **Canonical SPDI:** ${r.canonical_spdi ?? 'Not available'}`,
        `**Significance:** ${r.clinical_significance ?? 'Not available'} (${r.gold_stars}★) | **Review:** ${r.review_status ?? 'Not available'} | **Last evaluated:** ${r.last_evaluated ?? 'Not available'}`,
        `**Consequences:** ${r.molecular_consequences || 'Not available'} | **Protein change:** ${r.protein_change || 'Not available'} | **Submissions:** ${r.submission_count}`,
        `**Conditions:** ${r.conditions || 'Not available'}`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

interface SearchInput {
  clinical_significance?: string | undefined;
  gene: string;
  limit: number;
  min_review_stars?: number | undefined;
  offset: number;
}

/** ` matching clinical_significance=…, min_review_stars=…` for the filters applied, else ''. */
function filterText(input: SearchInput): string {
  const filters: string[] = [];
  const significance = normalizeSignificance(input.clinical_significance);
  if (significance) filters.push(`clinical_significance=${significance}`);
  if (input.min_review_stars != null) filters.push(`min_review_stars=${input.min_review_stars}`);
  return filters.length ? ` matching ${filters.join(', ')}` : '';
}

/**
 * Completeness guidance for one window: no candidates at all (whatever the
 * offset), how to continue a truncated list, an offset past the end. A window
 * with no rows that is not the whole list gets the window's position — the
 * continuation or the end of the list — never the no-records text.
 */
function windowNotice(input: SearchInput, search: ClinVarSearchResult): string | undefined {
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

/** Pointer from the window's identifiers to gnomad_get_variant, preferring the GRCh38 ID. */
function identifierNotice(rows: ClinVarRow[]): string | undefined {
  if (rows.some((r) => r.grch38_variant_id)) {
    return 'To check population frequency, pass grch38_variant_id to gnomad_get_variant with a GRCh38 dataset (gnomad_r4 or gnomad_r3); prefer it over rsids, since one rsID can match several gnomAD variants.';
  }
  if (rows.some((r) => r.rsids)) {
    return 'rsids can be passed to gnomad_get_variant, but one rsID can match several gnomAD variants; no row in this window has a grch38_variant_id.';
  }
  return;
}
