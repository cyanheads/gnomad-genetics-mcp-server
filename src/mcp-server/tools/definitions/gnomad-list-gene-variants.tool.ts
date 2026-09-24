/**
 * @fileoverview gnomad_list_gene_variants — every variant in a gene / transcript
 * / region with allele frequencies and predicted consequences, filterable by
 * consequence class and a max-AF threshold. Sets larger than the inline
 * preview spill to a DataCanvas table (gene_variants) for gnomad_dataframe_describe
 * and gnomad_dataframe_query; returns canvas_id + table_name plus the preview.
 * Degrades to a capped inline preview when the canvas is disabled.
 * @module mcp-server/tools/definitions/gnomad-list-gene-variants.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
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
 * line), measured at ~1.63 serialized bytes per JSON character on real PCSK9
 * rows, so 14,000 keeps a response near 23 KB.
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
});

const GeneVariantRowSchema = z
  .object({
    variant_id: z.string().describe('chrom-pos-ref-alt variant ID.'),
    af: z
      .number()
      .nullable()
      .describe('Allele frequency computed from joint allele counts; null when uncomputable.'),
    ac: z.number().describe('Allele count (joint across carried callsets).'),
    an: z.number().describe('Allele number (joint sum across carried callsets).'),
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
    'List every gnomAD variant in a gene, transcript, or region with allele frequencies and predicted consequences, optionally filtered to one consequence class (lof, missense, synonymous, other) and/or a maximum allele frequency. A result too large to inline is staged on a DataCanvas table named gene_variants, returned as canvas_id and table_name beside an inline preview — call gnomad_dataframe_describe for its columns, then gnomad_dataframe_query to rank by AF, count by consequence, or group across every row rather than the preview. A result that fits inline stages no table unless canvas_id is supplied. When the canvas is disabled (CANVAS_PROVIDER_TYPE != duckdb) the tool returns a capped inline preview and the SQL path is unavailable. Supply exactly one of gene, transcript_id, or region. Echoes the effective dataset and build.\nData source: gnomAD (Broad Institute) — https://gnomad.broadinstitute.org/',
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
    total: z.number().describe('Total matching variants, including any beyond the preview.'),
    dataset: z.string().describe('Effective gnomAD dataset.'),
    reference_genome: z.string().describe('Effective reference build.'),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no variants matched, when the canvas is disabled and the preview is capped, and — when a table was staged — its name with the next steps: gnomad_dataframe_describe, then gnomad_dataframe_query.',
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
    const dsCtx = svc.resolveDatasetContext(
      input.dataset,
      input.reference_genome,
      ctx.recoveryFor('incoherent_build'),
    );
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

    /**
     * ctx.enrich.notice is last-wins, so every part is collected here and
     * written once, in order: no-match or capped preview → staged table.
     */
    const notices: string[] = [];
    if (rows.length === 0) notices.push(noMatchNotice(target.kind, target.value, input));

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

    return { ...staged, dataset: dsCtx.dataset, reference_genome: dsCtx.reference_genome };
  },

  format: (result) => {
    const lines = [
      `## Gene variants — ${result.total} total`,
      `**Dataset:** ${result.dataset} (${result.reference_genome}) | **Spilled:** ${result.spilled ? 'yes' : 'no'}`,
      stagedLine(result),
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
