/**
 * @fileoverview gnomad_list_gene_variants — every variant in a gene / transcript
 * / region with allele frequencies and predicted consequences, filterable by
 * consequence class and a max-AF threshold. Large sets spill to a DataCanvas
 * table (handle: gene_variants) for SQL via gnomad_dataframe_query; returns
 * canvas_id + table_name plus an inline preview. Degrades to a capped inline
 * preview when the canvas is disabled.
 * @module mcp-server/tools/definitions/gnomad-list-gene-variants.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { spillover } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas-accessor.js';
import { getGnomadService } from '@/services/gnomad/gnomad-service.js';
import type { GeneVariantRow } from '@/services/gnomad/types.js';
import {
  datasetField,
  geneField,
  REGION_REGEX,
  referenceGenomeField,
  resolveGenomeTarget,
} from '../shared-schemas.js';

/** Stable canvas table name for this tool's spill. */
const TABLE_NAME = 'gene_variants';
/** Inline preview cap when the canvas is disabled. */
const INLINE_PREVIEW_CAP = 100;

const GeneVariantRowSchema = z
  .object({
    variant_id: z.string().describe('chrom-pos-ref-alt variant ID.'),
    af: z
      .number()
      .nullable()
      .describe('Allele frequency (joint or upstream); null when uncomputable.'),
    ac: z.number().describe('Allele count (joint across carried callsets).'),
    an: z.number().describe('Allele number (max across callsets).'),
    consequence: z.string().nullable().describe('VEP consequence term; null when none.'),
    consequence_class: z
      .enum(['lof', 'missense', 'synonymous', 'other'])
      .describe('Bucketed consequence class.'),
    homozygote_count: z.number().describe('Homozygote count (joint across callsets).'),
    source: z.string().describe('Carried callset(s), pipe-joined (e.g. exome|genome).'),
    flags: z.string().describe('Quality flags, pipe-joined (empty when none).'),
  })
  .describe('One gene-variant row — also the canvas table column set.');

export const gnomadListGeneVariants = tool('gnomad_list_gene_variants', {
  title: 'gnomad-genetics-mcp-server: list gene variants',
  description:
    'List every gnomAD variant in a gene, transcript, or region with allele frequencies and predicted consequences, optionally filtered to one consequence class (lof, missense, synonymous, other) and/or a maximum allele frequency. The full result is staged on a DataCanvas table named gene_variants and an inline preview is returned alongside canvas_id and table_name — run gnomad_dataframe_query against them to rank by AF, count by consequence, or group across the complete set rather than the preview. When the canvas is disabled (CANVAS_PROVIDER_TYPE != duckdb) the tool returns a capped inline preview with spilled=false and canvas_id empty; the SQL path is then unavailable. Supply exactly one of gene, transcript_id, or region. Echoes the effective dataset and build.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    gene: geneField.optional(),
    transcript_id: z
      .string()
      .optional()
      .describe(
        'Ensembl transcript ID (e.g. ENST00000302118). Mutually exclusive with gene and region.',
      ),
    region: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(REGION_REGEX, 'Region must be chrom-start-stop, e.g. 13-32315474-32400266.')
          .describe(
            'Genomic region chrom-start-stop (1-based inclusive, e.g. 13-32315474-32400266).',
          ),
      ])
      .optional()
      .describe(
        'Genomic region chrom-start-stop (1-based inclusive). Mutually exclusive with gene and transcript_id.',
      ),
    consequence_class: z
      .enum(['lof', 'missense', 'synonymous', 'other'])
      .optional()
      .describe('Keep only variants in this consequence class. Omit to return all classes.'),
    max_af: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        'Keep only variants with allele frequency ≤ this value (0–1). Variants with null AF are always kept.',
      ),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'Optional canvas ID from a prior call. Omit to start a fresh canvas — the response returns a new one.',
      ),
    dataset: datasetField,
    reference_genome: referenceGenomeField,
  }),
  output: z.object({
    preview: z.array(GeneVariantRowSchema).describe('Inline preview rows — the immediate answer.'),
    canvas_id: z
      .string()
      .describe(
        'Canvas ID — pass to gnomad_dataframe_query. Empty string when canvas is disabled.',
      ),
    table_name: z
      .string()
      .describe('Canvas table holding the full set (gene_variants); empty when not spilled.'),
    spilled: z
      .boolean()
      .describe('True when the full result was staged on the canvas beyond the preview.'),
    total: z
      .number()
      .describe('Total matching variants (staged row count when spilled, else preview length).'),
    dataset: z.string().describe('Effective gnomAD dataset.'),
    reference_genome: z.string().describe('Effective reference build.'),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no variants matched, or when the canvas is disabled and the preview is capped.',
      ),
  },
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
    },
  ],

  async handler(input, ctx) {
    const svc = getGnomadService();
    const dsCtx = svc.resolveDatasetContext(input.dataset, input.reference_genome);
    const target = resolveGenomeTarget(
      { gene: input.gene, transcript_id: input.transcript_id, region: input.region || undefined },
      ctx,
    );

    const rows = await svc.listGeneVariants(
      target,
      { consequenceClass: input.consequence_class, maxAf: input.max_af },
      dsCtx,
      ctx,
    );

    const canvas = getCanvas();

    // Canvas disabled — capped inline preview, no SQL path.
    if (!canvas) {
      const preview = rows.slice(0, INLINE_PREVIEW_CAP);
      if (rows.length === 0) {
        ctx.enrich.notice(noMatchNotice(target.kind, target.value, input));
      } else if (rows.length > INLINE_PREVIEW_CAP) {
        ctx.enrich.notice(
          `Canvas is disabled (set CANVAS_PROVIDER_TYPE=duckdb) — showing ${INLINE_PREVIEW_CAP} of ${rows.length} variants. Enable the canvas to query the full set with gnomad_dataframe_query.`,
        );
      }
      return {
        preview,
        canvas_id: '',
        table_name: '',
        spilled: false,
        total: rows.length,
        dataset: dsCtx.dataset,
        reference_genome: dsCtx.reference_genome,
      };
    }

    const instance = await canvas.acquire(input.canvas_id, ctx);
    const result = await spillover<GeneVariantRow>({
      canvas: instance,
      source: rows,
      previewChars: 60_000,
      tableName: TABLE_NAME,
      signal: ctx.signal,
    });

    if (rows.length === 0) {
      ctx.enrich.notice(noMatchNotice(target.kind, target.value, input));
    }

    return {
      preview: result.previewRows,
      canvas_id: instance.canvasId,
      table_name: result.spilled ? result.handle.tableName : '',
      spilled: result.spilled,
      total: result.spilled ? result.handle.rowCount : result.previewRows.length,
      dataset: dsCtx.dataset,
      reference_genome: dsCtx.reference_genome,
    };
  },

  format: (result) => {
    const lines = [
      `## Gene variants — ${result.total} total`,
      `**Dataset:** ${result.dataset} (${result.reference_genome}) | **Spilled:** ${result.spilled ? 'yes' : 'no'}`,
      result.spilled
        ? `**Staged:** canvas_id \`${result.canvas_id}\`, table \`${result.table_name}\` — query with gnomad_dataframe_query.`
        : result.canvas_id
          ? '**Staged:** result fit inline; no canvas table created.'
          : '**Canvas disabled** — inline preview only.',
      '',
      `Showing ${result.preview.length} preview row(s):`,
    ];
    for (const r of result.preview) {
      const af = r.af != null ? `${r.af} (${r.af.toExponential(3)})` : 'n/a';
      lines.push(
        `- **${r.variant_id}** | ${r.consequence_class}${r.consequence ? ` (${r.consequence})` : ''} | AF ${af} | AC ${r.ac}/${r.an} | hom ${r.homozygote_count} | ${r.source || 'none'}${r.flags ? ` | flags ${r.flags}` : ''}`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

function noMatchNotice(
  kind: string,
  value: string,
  input: { consequence_class?: string | undefined; max_af?: number | undefined },
): string {
  const filters: string[] = [];
  if (input.consequence_class) filters.push(`consequence_class=${input.consequence_class}`);
  if (input.max_af != null) filters.push(`max_af=${input.max_af}`);
  const filterText = filters.length ? ` matching ${filters.join(', ')}` : '';
  return `No variants in ${kind} "${value}"${filterText}. Broaden the filters, or verify the ${kind} exists in this dataset.`;
}
