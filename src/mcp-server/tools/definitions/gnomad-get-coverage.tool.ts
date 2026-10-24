/**
 * @fileoverview gnomad_get_coverage — sequencing coverage across a gene /
 * transcript / region: mean & median depth and the fraction of samples over
 * depth thresholds (1/5/10/15/20/25/30/50/100×). Disambiguates a true absent
 * variant from an uncallable position before concluding "not seen in gnomAD."
 * @module mcp-server/tools/definitions/gnomad-get-coverage.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { getGnomadService } from '@/services/gnomad/gnomad-service.js';
import {
  datasetField,
  optionalGeneField,
  REGION_REGEX,
  referenceGenomeField,
  resolveGenomeTarget,
} from '../shared-schemas.js';

const fractionOver = (depth: number) =>
  z
    .number()
    .nullable()
    .describe(
      `Fraction of samples covered at ≥${depth}×, averaged over the summarized buckets (gnomAD rounds each bucket's fraction up to the next 0.01); null when no data.`,
    );

const CoverageSummarySchema = z
  .object({
    source: z
      .enum(['exome', 'genome'])
      .describe('Which gnomAD coverage track this summary covers.'),
    positions: z
      .number()
      .describe(
        'Target bases inside the summarized buckets: of start..stop for a region, of the exons ±75 bp for a gene or transcript. Falls short of the target when the track has no records at its edges (typically outside the exome capture); those bases are left out, not counted as zero depth.',
      ),
    target_positions: z
      .number()
      .describe(
        'Total target bases: start..stop inclusive for a region, merged exons ±75 bp for a gene or transcript.',
      ),
    missing_positions: z
      .number()
      .describe(
        'Target bases without returned coverage buckets (target_positions minus positions). Callability is unknown for these bases; they are not measured zero depth.',
      ),
    bucket_count: z
      .number()
      .describe(
        'Number of gnomAD coverage buckets summarized: every returned bucket overlapping the target bases. gnomAD returns every bucket between the first and last record of a track, so an empty bucket inside that span counts as zero depth; buckets past the outermost records are not returned and not counted.',
      ),
    bucket_size: z
      .number()
      .describe(
        'Width of each gnomAD coverage bucket in bp: 1 for a region spanning under 850 bp, otherwise about 1/500 of the queried size. Depth and fraction values describe buckets, not single bases.',
      ),
    mean_depth: z
      .number()
      .nullable()
      .describe(
        'Mean read depth: the average of the summarized buckets’ mean depths; null when no data.',
      ),
    median_depth: z
      .number()
      .nullable()
      .describe(
        'Median, across the summarized buckets, of each bucket’s depth (the average of its per-base medians); null when no data.',
      ),
    fraction_over_1: fractionOver(1),
    fraction_over_5: fractionOver(5),
    fraction_over_10: fractionOver(10),
    fraction_over_15: fractionOver(15),
    fraction_over_20: fractionOver(20),
    fraction_over_25: fractionOver(25),
    fraction_over_30: fractionOver(30),
    fraction_over_50: fractionOver(50),
    fraction_over_100: fractionOver(100),
  })
  .describe('Aggregate coverage for one callset track over the target.');

export const gnomadGetCoverage = tool('gnomad_get_coverage', {
  title: 'gnomad-genetics-mcp-server: get coverage',
  description:
    'Fetch gnomAD sequencing-coverage summary across a gene, transcript, or region — mean and median read depth, plus the mean fraction of samples covered at each depth threshold (1× through 100×), separated by exome and genome track. gnomAD reports coverage in buckets: 1 bp for a region spanning under 850 bp, wider for larger targets (bucket_size), and a gene or transcript is summarized over its exons ±75 bp, not its introns. Use this to disambiguate a true absent variant from an uncallable position: a variant missing from a well-covered region is informative, while one missing from a poorly-covered region is not. Supply exactly one of gene, transcript_id, or region. The optional coverage_source narrows to one track; by default both available tracks are returned. Echoes the effective dataset and build.\nData source: gnomAD (Broad Institute) — https://gnomad.broadinstitute.org/',
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
          .regex(REGION_REGEX, 'Region must be chrom-start-stop, e.g. 1-55039447-55064852.')
          .describe(
            'Genomic region chrom-start-stop (1-based inclusive, e.g. 1-55039447-55064852) on chromosome 1–22, X, or Y, optional chr prefix.',
          ),
      ])
      .optional()
      .describe(
        'Genomic region chrom-start-stop (1-based inclusive, e.g. 1-55039447-55064852): chromosome 1–22, X, or Y with an optional chr prefix (mitochondrial regions are not served) and a span (stop − start) under 2,500,000 bp. Mutually exclusive with gene and transcript_id.',
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
      .describe(
        'Disclosure of missing target bases, missing supported tracks, or an explicitly requested unsupported track. Missing data leaves callability unknown.',
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
        'Pass region as chrom-start-stop on chromosome 1–22, X, or Y (optional chr prefix, e.g. chr1-55039447-55064852), with start at least 1, stop below 1,000,000,000, and start ≤ stop.',
      thrownBy: 'service',
    },
    {
      reason: 'region_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The region spans 2,500,000 bp or more, beyond what gnomAD summarizes at once.',
      recovery:
        'Narrow the region to a span (stop − start) under 2,500,000 bp, or split it into consecutive sub-regions and summarize each one.',
      thrownBy: 'service',
    },
    {
      reason: 'mitochondrial_unsupported',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The gene, transcript, or region is on the mitochondrial chromosome (M or MT).',
      recovery:
        'Mitochondrial coverage is outside this server; view it in the gnomAD browser at https://gnomad.broadinstitute.org/, or query a target on chromosomes 1–22, X, or Y.',
      thrownBy: 'service',
    },
    {
      reason: 'graphql_error',
      code: JsonRpcErrorCode.ValidationError,
      when: 'gnomAD rejected the coverage query with a GraphQL error.',
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
        'gnomAD did not answer in time; wait a few seconds and retry, or summarize a smaller region instead of a large gene.',
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

    let summaries = await svc.getCoverage(target, dsCtx, ctx);
    if (input.coverage_source) {
      summaries = summaries.filter((s) => s.source === input.coverage_source);
    }
    const supported = {
      gnomad_r4: ['exome', 'genome'],
      gnomad_r3: ['genome'],
      gnomad_r2_1: ['exome', 'genome'],
      exac: ['exome'],
    } as const;
    const requested = input.coverage_source ? [input.coverage_source] : supported[dsCtx.dataset];
    const notices: string[] = [];
    for (const source of requested) {
      if (!(supported[dsCtx.dataset] as readonly string[]).includes(source)) {
        notices.push(
          `The ${source} coverage track is not supported in ${dsCtx.dataset}. Callability is unknown from this track.`,
        );
        continue;
      }
      const summary = summaries.find((item) => item.source === source);
      if (!summary) {
        notices.push(
          `No ${source} coverage data for ${target.kind} "${target.value}" in ${dsCtx.dataset}. This supported track returned no target records; callability is unknown, not measured zero depth.`,
        );
      } else if (summary.missing_positions > 0) {
        notices.push(
          `${source}: ${summary.missing_positions} of ${summary.target_positions} target bases have no returned coverage buckets. Their callability is unknown; statistics describe only the ${summary.positions} observed bases.`,
        );
      }
    }
    if (notices.length) ctx.enrich.notice(notices.join(' '));

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
      `**Coverage — ${result.target_kind}:** ${escapeMarkdownInline(result.target)}`,
      `**Dataset:** ${result.dataset} (${result.reference_genome})`,
    ];
    for (const s of result.summaries) {
      lines.push('', `### ${s.source} (${s.positions} positions)`);
      lines.push(
        `**Target bases:** ${s.target_positions} | **Missing bases:** ${s.missing_positions} (callability unknown)`,
      );
      lines.push(
        `**Buckets:** ${s.bucket_count} × ${s.bucket_size} bp${s.bucket_size > 1 ? ' — depths and fractions average the buckets, not single bases' : ''}`,
      );
      lines.push(`**Mean depth:** ${num(s.mean_depth)} | **Median depth:** ${num(s.median_depth)}`);
      lines.push(
        `**Frac ≥:** 1×=${pct(s.fraction_over_1)} 5×=${pct(s.fraction_over_5)} 10×=${pct(s.fraction_over_10)} 15×=${pct(s.fraction_over_15)} 20×=${pct(s.fraction_over_20)} 25×=${pct(s.fraction_over_25)} 30×=${pct(s.fraction_over_30)} 50×=${pct(s.fraction_over_50)} 100×=${pct(s.fraction_over_100)}`,
      );
    }
    if (result.summaries.length === 0) lines.push('', '_No coverage data available._');
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
