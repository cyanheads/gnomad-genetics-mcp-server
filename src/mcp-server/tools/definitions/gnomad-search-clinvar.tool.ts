/**
 * @fileoverview gnomad_search_clinvar — gene-level ClinVar detail beyond the
 * per-variant join gnomAD provides: pathogenic / likely-pathogenic variant
 * lists, review status (star rating), and submission counts via NCBI
 * E-utilities. Spills to a DataCanvas table (clinvar_variants) for SQL.
 * @module mcp-server/tools/definitions/gnomad-search-clinvar.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { spillover } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas-accessor.js';
import { getClinVarService } from '@/services/clinvar/clinvar-service.js';
import type { ClinVarRow } from '@/services/clinvar/types.js';
import { geneField } from '../shared-schemas.js';

const TABLE_NAME = 'clinvar_variants';
const INLINE_PREVIEW_CAP = 100;

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
  })
  .describe('One ClinVar variant row — also the canvas table column set.');

export const gnomadSearchClinvar = tool('gnomad_search_clinvar', {
  title: 'gnomad-genetics-mcp-server: search clinvar',
  description:
    'Search ClinVar (NCBI E-utilities) for a gene and return its classified variants — clinical significance, review status with a 0–4 star rating, associated conditions, molecular consequences, and submission counts — turning the variant-level significance gnomAD joins into a gene-panel curation view. Optionally filter by clinical_significance (e.g. pathogenic) and a minimum star rating. The full set is staged on a DataCanvas table named clinvar_variants with an inline preview; query it with gnomad_dataframe_query to rank or count across the complete set. Keyless, but honors NCBI_API_KEY for a higher rate limit. When the canvas is disabled the tool returns a capped inline preview with spilled=false. Credit: ClinVar, NCBI.',
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
      .optional()
      .describe(
        'Filter by ClinVar clinical significance term (e.g. pathogenic, likely_pathogenic, benign).',
      ),
    min_review_stars: z
      .number()
      .int()
      .min(0)
      .max(4)
      .optional()
      .describe('Keep only variants with at least this gold-star review rating (0–4).'),
    canvas_id: z
      .string()
      .optional()
      .describe(
        "Optional canvas ID from a prior call, to reuse the same canvas. Reusing it REPLACES (overwrites) the clinvar_variants table with this call's results — it does not append. Omit to start a fresh canvas; the response returns a new one.",
      ),
  }),
  output: z.object({
    preview: z.array(ClinVarRowSchema).describe('Inline preview rows — the immediate answer.'),
    canvas_id: z
      .string()
      .describe(
        'Canvas ID — pass to gnomad_dataframe_query. Empty string when canvas is disabled.',
      ),
    table_name: z
      .string()
      .describe('Canvas table holding the full set (clinvar_variants); empty when not spilled.'),
    spilled: z
      .boolean()
      .describe('True when the full result was staged on the canvas beyond the preview.'),
    total: z
      .number()
      .describe(
        'Total matching ClinVar records (staged row count when spilled, else preview length).',
      ),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no ClinVar records matched, or when the canvas is disabled and the preview is capped.',
      ),
  },
  errors: [
    {
      reason: 'ncbi_unreachable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'NCBI E-utilities is unreachable or rate-limited.',
      recovery:
        'NCBI is degraded or throttling; wait a few seconds and retry, or set NCBI_API_KEY for a higher rate limit.',
    },
  ],

  async handler(input, ctx) {
    // ClinVar's [gene] index resolves HGNC symbols only, so an Ensembl gene ID
    // always yields zero records. Name the real cause instead of running a
    // guaranteed-empty NCBI query and returning the misdirecting generic
    // "verify the gene symbol" notice.
    if (ENSEMBL_GENE_ID.test(input.gene)) {
      ctx.enrich.notice(
        `ClinVar search needs an HGNC symbol; Ensembl gene IDs (ENSG…) are not indexed by ClinVar. Resolve "${input.gene}" to its symbol (e.g. via ensembl_lookup_gene) and retry.`,
      );
      return { preview: [], canvas_id: '', table_name: '', spilled: false, total: 0 };
    }

    const rows = await getClinVarService().searchGene(
      input.gene,
      { clinicalSignificance: input.clinical_significance, minReviewStars: input.min_review_stars },
      ctx,
    );

    const canvas = getCanvas();
    if (!canvas) {
      const preview = rows.slice(0, INLINE_PREVIEW_CAP);
      if (rows.length === 0) {
        ctx.enrich.notice(noMatchNotice(input));
      } else if (rows.length > INLINE_PREVIEW_CAP) {
        ctx.enrich.notice(
          `Canvas is disabled (set CANVAS_PROVIDER_TYPE=duckdb) — showing ${INLINE_PREVIEW_CAP} of ${rows.length} records. Enable the canvas to query the full set with gnomad_dataframe_query.`,
        );
      }
      return { preview, canvas_id: '', table_name: '', spilled: false, total: rows.length };
    }

    const instance = await canvas.acquire(input.canvas_id, ctx);
    const result = await spillover<ClinVarRow>({
      canvas: instance,
      source: rows,
      previewChars: 60_000,
      tableName: TABLE_NAME,
      signal: ctx.signal,
    });

    if (rows.length === 0) ctx.enrich.notice(noMatchNotice(input));

    return {
      preview: result.previewRows,
      canvas_id: instance.canvasId,
      table_name: result.spilled ? result.handle.tableName : '',
      spilled: result.spilled,
      total: result.spilled ? result.handle.rowCount : result.previewRows.length,
    };
  },

  format: (result) => {
    const lines = [
      `## ClinVar — ${result.total} record(s)`,
      `**Spilled:** ${result.spilled ? 'yes' : 'no'}`,
      result.spilled
        ? `**Staged:** canvas_id \`${result.canvas_id}\`, table \`${result.table_name}\` — query with gnomad_dataframe_query.`
        : result.canvas_id
          ? '**Staged:** result fit inline; no canvas table created.'
          : '**Canvas disabled** — inline preview only.',
      '',
      `Showing ${result.preview.length} preview row(s):`,
    ];
    for (const r of result.preview) {
      lines.push(
        `### ${r.title || r.accession}`,
        `**VariationID:** ${r.clinvar_variation_id} | **Accession:** ${r.accession} | **Type:** ${r.obj_type}`,
        `**Significance:** ${r.clinical_significance ?? 'Not available'} (${r.gold_stars}★) | **Review:** ${r.review_status ?? 'Not available'} | **Last evaluated:** ${r.last_evaluated ?? 'Not available'}`,
        `**Consequences:** ${r.molecular_consequences || 'Not available'} | **Protein change:** ${r.protein_change || 'Not available'} | **Submissions:** ${r.submission_count}`,
        `**Conditions:** ${r.conditions || 'Not available'}`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

function noMatchNotice(input: {
  gene: string;
  clinical_significance?: string | undefined;
  min_review_stars?: number | undefined;
}): string {
  const filters: string[] = [];
  if (input.clinical_significance)
    filters.push(`clinical_significance=${input.clinical_significance}`);
  if (input.min_review_stars != null) filters.push(`min_review_stars=${input.min_review_stars}`);
  const filterText = filters.length ? ` matching ${filters.join(', ')}` : '';
  return `No ClinVar records for "${input.gene}"${filterText}. Broaden the filters or verify the gene symbol.`;
}
