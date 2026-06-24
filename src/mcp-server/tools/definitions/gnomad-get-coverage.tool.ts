/**
 * @fileoverview gnomad_get_coverage — sequencing coverage across a gene /
 * transcript / region: mean & median depth and the fraction of samples over
 * depth thresholds (1/5/10/15/20/25/30/50/100×). Disambiguates a true absent
 * variant from an uncallable position before concluding "not seen in gnomAD."
 * @module mcp-server/tools/definitions/gnomad-get-coverage.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getGnomadService } from '@/services/gnomad/gnomad-service.js';
import {
  datasetField,
  geneField,
  REGION_REGEX,
  referenceGenomeField,
  resolveGenomeTarget,
} from '../shared-schemas.js';

const CoverageSummarySchema = z
  .object({
    source: z
      .enum(['exome', 'genome'])
      .describe('Which gnomAD coverage track this summary covers.'),
    positions: z.number().describe('Number of base positions summarized across the target.'),
    mean_depth: z
      .number()
      .nullable()
      .describe('Mean read depth averaged across positions; null when no data.'),
    median_depth: z
      .number()
      .nullable()
      .describe('Median read depth across positions; null when no data.'),
    fraction_over_1: z
      .number()
      .nullable()
      .describe('Mean fraction of samples covered at ≥1×; null when no data.'),
    fraction_over_5: z
      .number()
      .nullable()
      .describe('Mean fraction of samples covered at ≥5×; null when no data.'),
    fraction_over_10: z
      .number()
      .nullable()
      .describe('Mean fraction of samples covered at ≥10×; null when no data.'),
    fraction_over_15: z
      .number()
      .nullable()
      .describe('Mean fraction of samples covered at ≥15×; null when no data.'),
    fraction_over_20: z
      .number()
      .nullable()
      .describe('Mean fraction of samples covered at ≥20×; null when no data.'),
    fraction_over_25: z
      .number()
      .nullable()
      .describe('Mean fraction of samples covered at ≥25×; null when no data.'),
    fraction_over_30: z
      .number()
      .nullable()
      .describe('Mean fraction of samples covered at ≥30×; null when no data.'),
    fraction_over_50: z
      .number()
      .nullable()
      .describe('Mean fraction of samples covered at ≥50×; null when no data.'),
    fraction_over_100: z
      .number()
      .nullable()
      .describe('Mean fraction of samples covered at ≥100×; null when no data.'),
  })
  .describe('Aggregate coverage for one callset track over the target.');

export const gnomadGetCoverage = tool('gnomad_get_coverage', {
  title: 'gnomad-genetics-mcp-server: get coverage',
  description:
    'Fetch gnomAD sequencing-coverage summary across a gene, transcript, or region — mean and median read depth, plus the mean fraction of samples covered at each depth threshold (1× through 100×), separated by exome and genome track. Use this to disambiguate a true absent variant from an uncallable position: a variant missing from a well-covered region is informative, while one missing from a poorly-covered region is not. Supply exactly one of gene, transcript_id, or region. The optional coverage_source narrows to one track; by default both available tracks are returned. Echoes the effective dataset and build.',
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
          .regex(REGION_REGEX, 'Region must be chrom-start-stop, e.g. 1-55039447-55064852.')
          .describe(
            'Genomic region chrom-start-stop (1-based inclusive, e.g. 1-55039447-55064852).',
          ),
      ])
      .optional()
      .describe(
        'Genomic region chrom-start-stop (1-based inclusive, e.g. 1-55039447-55064852). Mutually exclusive with gene and transcript_id.',
      ),
    coverage_source: z
      .enum(['exome', 'genome'])
      .optional()
      .describe('Restrict to one coverage track. Omit to return every available track.'),
    dataset: datasetField,
    reference_genome: referenceGenomeField,
  }),
  output: z.object({
    target: z
      .string()
      .describe(
        'The resolved target (gene symbol/ID, transcript ID, or region) the coverage describes.',
      ),
    target_kind: z
      .enum(['gene', 'transcript', 'region'])
      .describe('Which target type was queried.'),
    summaries: z
      .array(CoverageSummarySchema)
      .describe('Per-track coverage summaries (exome and/or genome).'),
    dataset: z.string().describe('Effective gnomAD dataset.'),
    reference_genome: z.string().describe('Effective reference build.'),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Guidance when no coverage data is available for the target.'),
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

    let summaries = await svc.getCoverage(target, dsCtx, ctx);
    if (input.coverage_source) {
      summaries = summaries.filter((s) => s.source === input.coverage_source);
    }
    if (summaries.length === 0) {
      ctx.enrich.notice(
        `No ${input.coverage_source ?? ''} coverage data for ${target.kind} "${target.value}" in ${dsCtx.dataset}. The position may lie outside the callset, or the coverage track is unavailable for this dataset.`,
      );
    }

    ctx.log.info('gnomad_get_coverage resolved', {
      target: target.value,
      kind: target.kind,
      dataset: dsCtx.dataset,
      tracks: summaries.length,
    });

    return {
      target: target.value,
      target_kind: target.kind,
      summaries,
      dataset: dsCtx.dataset,
      reference_genome: dsCtx.reference_genome,
    };
  },

  format: (result) => {
    const pct = (v: number | null) => (v != null ? `${(v * 100).toFixed(1)}%` : 'Not available');
    const num = (v: number | null) => (v != null ? v.toFixed(1) : 'Not available');
    const lines = [
      `## Coverage — ${result.target_kind} ${result.target}`,
      `**Dataset:** ${result.dataset} (${result.reference_genome})`,
    ];
    for (const s of result.summaries) {
      lines.push('', `### ${s.source} (${s.positions} positions)`);
      lines.push(`**Mean depth:** ${num(s.mean_depth)} | **Median depth:** ${num(s.median_depth)}`);
      lines.push(
        `**Frac ≥:** 1×=${pct(s.fraction_over_1)} 5×=${pct(s.fraction_over_5)} 10×=${pct(s.fraction_over_10)} 15×=${pct(s.fraction_over_15)} 20×=${pct(s.fraction_over_20)} 25×=${pct(s.fraction_over_25)} 30×=${pct(s.fraction_over_30)} 50×=${pct(s.fraction_over_50)} 100×=${pct(s.fraction_over_100)}`,
      );
    }
    if (result.summaries.length === 0) lines.push('', '_No coverage data available._');
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
