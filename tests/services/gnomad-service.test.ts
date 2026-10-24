/**
 * @fileoverview Unit tests for GnomadService logic — dataset→build derivation,
 * coherence validation, the by-symbol/by-id gene routing, the region parser,
 * how coverage buckets are selected and summarized, and how upstream failures
 * are classified. The coverage and classification tests fake only global
 * fetch, so the real retry loop, fetchWithTimeout, response validation, and the
 * sanitizer all run; everything here is deterministic and offline-safe.
 * @module tests/services/gnomad-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { CLINVAR_LOOKUP_BUDGET_MS, GnomadService } from '@/services/gnomad/gnomad-service.js';
import { fakeCoverage, LIVE_COVERAGE } from '../helpers/fake-gnomad-coverage.js';

const svc = new GnomadService(getServerConfig());

describe('GnomadService.resolveDatasetContext', () => {
  it('defaults to gnomad_r4 / GRCh38 when nothing supplied', () => {
    expect(svc.resolveDatasetContext(undefined)).toEqual({
      dataset: 'gnomad_r4',
      reference_genome: 'GRCh38',
    });
  });

  it('derives GRCh37 for v2.1 and exac', () => {
    expect(svc.resolveDatasetContext('gnomad_r2_1').reference_genome).toBe('GRCh37');
    expect(svc.resolveDatasetContext('exac').reference_genome).toBe('GRCh37');
  });

  it('derives GRCh38 for v3', () => {
    expect(svc.resolveDatasetContext('gnomad_r3').reference_genome).toBe('GRCh38');
  });

  it('accepts a coherent explicit build', () => {
    expect(svc.resolveDatasetContext('gnomad_r4', 'GRCh38').reference_genome).toBe('GRCh38');
    expect(svc.resolveDatasetContext('gnomad_r2_1', 'GRCh37').reference_genome).toBe('GRCh37');
  });

  it('rejects an incoherent dataset/build pair', () => {
    expect(() => svc.resolveDatasetContext('gnomad_r4', 'GRCh37')).toThrow(McpError);
    expect(() => svc.resolveDatasetContext('gnomad_r2_1', 'GRCh38')).toThrow(
      /requires reference_genome/,
    );
  });

  it('accepts a coherent v3 explicit build', () => {
    expect(svc.resolveDatasetContext('gnomad_r3', 'GRCh38').reference_genome).toBe('GRCh38');
  });

  it('carries the incoherent_build reason and the expected/supplied build on the error', () => {
    const err = (() => {
      try {
        svc.resolveDatasetContext('gnomad_r4', 'GRCh37');
        return;
      } catch (e) {
        return e as McpError;
      }
    })();
    expect(err).toBeInstanceOf(McpError);
    expect(err?.data).toMatchObject({
      reason: 'incoherent_build',
      dataset: 'gnomad_r4',
      expected: 'GRCh38',
      supplied: 'GRCh37',
    });
  });
});

describe('GnomadService.listGeneVariants — dual-callset joint frequency', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sums an across callsets and recomputes joint af (not exome-only)', async () => {
    // Live gnomad_r4 / GRCh38 values for 1-55051215-G-GA: the variant is carried
    // by both callsets, so the row must report joint counts matching
    // gnomad_get_variant (AC 919 / AN 456260 / AF 0.002014…).
    const raw = {
      variant_id: '1-55051215-G-GA',
      consequence: 'frameshift_variant',
      flags: null,
      exome: { ac: 192, an: 303936, af: 0.0006317119393556538, homozygote_count: 0 },
      genome: { ac: 727, an: 152324, af: 0.004772721304587589, homozygote_count: 1 },
    };
    vi.spyOn(svc as any, 'graphql').mockResolvedValue({ region: { variants: [raw] } });

    const dsCtx = svc.resolveDatasetContext('gnomad_r4');
    const rows = await svc.listGeneVariants(
      { kind: 'region', value: '1-55051215-55051215' },
      {},
      dsCtx,
      createMockContext(),
    );

    expect(rows).toHaveLength(1);
    const [r] = rows;
    expect(r?.ac).toBe(919);
    // Joint AN is the sum (456260), NOT max-across-callsets (303936 = exome only).
    expect(r?.an).toBe(456260);
    // Joint AF recomputed from joint counts — NOT the single-callset exome af
    // (0.000632) the old code returned.
    expect(r?.af).toBe(919 / 456260);
    expect(r?.af).toBeCloseTo(0.0020142, 6);
    expect(r?.source).toBe('exome|genome');
  });

  it('leaves a single-callset variant unchanged', async () => {
    const raw = {
      variant_id: '1-55051216-A-G',
      consequence: 'missense_variant',
      flags: null,
      exome: null,
      genome: { ac: 10, an: 1000, af: 0.01, homozygote_count: 0 },
    };
    vi.spyOn(svc as any, 'graphql').mockResolvedValue({ region: { variants: [raw] } });

    const dsCtx = svc.resolveDatasetContext('gnomad_r4');
    const rows = await svc.listGeneVariants(
      { kind: 'region', value: '1-55051216-55051216' },
      {},
      dsCtx,
      createMockContext(),
    );

    const [r] = rows;
    expect(r?.ac).toBe(10);
    expect(r?.an).toBe(1000);
    expect(r?.af).toBe(0.01);
    expect(r?.source).toBe('genome');
  });
});

describe('GnomadService — region ordering guard', () => {
  afterEach(() => vi.restoreAllMocks());

  it('rejects an inverted region (start>stop) before any upstream call — list and coverage alike', async () => {
    const graphql = vi.spyOn(svc as any, 'graphql').mockResolvedValue({});
    const dsCtx = svc.resolveDatasetContext('gnomad_r4');
    const ctx = createMockContext();

    await expect(
      svc.listGeneVariants({ kind: 'region', value: '1-55064852-55039447' }, {}, dsCtx, ctx),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_region' },
    });
    await expect(
      svc.getCoverage({ kind: 'region', value: '1-55064852-55039447' }, dsCtx, ctx),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_region' },
    });

    // The malformed region never reaches the network — no retry storm, no
    // misleading "unavailable" error.
    expect(graphql).not.toHaveBeenCalled();
  });

  it('accepts a single-position region (start == stop) and reaches the upstream query', async () => {
    const graphql = vi
      .spyOn(svc as any, 'graphql')
      .mockResolvedValue({ region: { coverage: { exome: null, genome: null } } });
    const dsCtx = svc.resolveDatasetContext('gnomad_r4');

    await svc.getCoverage(
      { kind: 'region', value: '1-55051215-55051215' },
      dsCtx,
      createMockContext(),
    );
    expect(graphql).toHaveBeenCalledTimes(1);
  });
});

describe('GnomadService — region parser edges', () => {
  afterEach(() => vi.restoreAllMocks());

  const dsCtx = svc.resolveDatasetContext('gnomad_r4');

  async function sentVariables(region: string): Promise<Record<string, unknown>> {
    const graphql = vi
      .spyOn(svc as any, 'graphql')
      .mockResolvedValue({ region: { coverage: { exome: null, genome: null } } });
    await svc.getCoverage({ kind: 'region', value: region }, dsCtx, createMockContext());
    return graphql.mock.calls[0]?.[1] as Record<string, unknown>;
  }

  async function rejection(region: string): Promise<unknown> {
    const graphql = vi.spyOn(svc as any, 'graphql').mockResolvedValue({});
    const error = await svc
      .listGeneVariants({ kind: 'region', value: region }, {}, dsCtx, createMockContext())
      .catch((err: unknown) => err);
    expect(graphql).not.toHaveBeenCalled();
    return error;
  }

  it.each([
    ['1-1-1', { chrom: '1', start: 1, stop: 1 }],
    ['22-999999990-999999999', { chrom: '22', start: 999999990, stop: 999999999 }],
    ['chrX-100-2500099', { chrom: 'X', start: 100, stop: 2500099 }],
    ['Chry-5-6', { chrom: 'Y', start: 5, stop: 6 }],
  ])('sends %s at the edge of every bound as %j', async (region, expected) => {
    expect(await sentVariables(region)).toMatchObject(expected);
  });

  it.each([
    ['1-100-2500100', 'region_too_large'],
    ['CHR-1-2', 'invalid_region'],
    ['chr-1-2', 'invalid_region'],
    ['1-0-0', 'invalid_region'],
    ['1-1-99999999999999999999', 'invalid_region'],
    ['1-1000000000-1000000001', 'invalid_region'],
    ['chrMT-1-2', 'mitochondrial_unsupported'],
    ['m-1-2', 'mitochondrial_unsupported'],
  ])('rejects %s as %s without a fetch', async (region, reason) => {
    expect(await rejection(region)).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason, retryable: false },
    });
  });

  it('reports the span in the region_too_large message', async () => {
    const error = (await rejection('1-100-2500100')) as McpError;
    expect(error.message).toContain('2,500,000 bp');
  });

  it.each([
    ['gene', 'M'],
    ['gene', 'MT'],
    ['transcript', 'M'],
  ] as const)(
    'refuses a %s whose gnomAD chrom is %s on both list and coverage',
    async (kind, chrom) => {
      vi.spyOn(svc as any, 'graphql').mockResolvedValue({
        [kind]: { chrom, variants: [], coverage: { exome: [], genome: [] } },
      });
      const target = { kind, value: kind === 'gene' ? 'MT-TL1' : 'ENST00000386347' };
      for (const call of [
        () => svc.listGeneVariants(target, {}, dsCtx, createMockContext()),
        () => svc.getCoverage(target, dsCtx, createMockContext()),
      ]) {
        await expect(call()).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'mitochondrial_unsupported', retryable: false },
        });
      }
    },
  );

  it.each(['M-3243-A-G', 'MT-3243-A-G', 'chrM-3243-A-G', 'chrmt-3243-a-g'])(
    'refuses variant %s before any fetch',
    async (id) => {
      const graphql = vi.spyOn(svc as any, 'graphql');
      await expect(svc.getVariant(id, dsCtx, createMockContext())).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'mitochondrial_unsupported', retryable: false },
      });
      expect(graphql).not.toHaveBeenCalled();
    },
  );
});

/** A raw gnomAD coverage bin with a position and a flat depth. */
function covBin(pos: number, depth: number, fracHigh = 0): Record<string, number> {
  return {
    pos,
    mean: depth,
    median: depth,
    over_1: 1,
    over_5: 1,
    over_10: 1,
    over_15: fracHigh,
    over_20: fracHigh,
    over_25: fracHigh,
    over_30: fracHigh,
    over_50: 0,
    over_100: 0,
  };
}

describe('GnomadService.getCoverage — coverage bucket bounding', () => {
  afterEach(() => vi.restoreAllMocks());

  it('bounds region coverage bins to the requested span — single position → positions:1', async () => {
    // gnomAD queries a single-position region ±75 bp (1 bp buckets); the service
    // must keep only the bucket at the requested base, not the padded neighborhood.
    const bins = [covBin(55039973, 8), covBin(55039974, 42, 1), covBin(55039975, 9)];
    vi.spyOn(svc as any, 'graphql').mockResolvedValue({
      region: { coverage: { exome: bins, genome: null } },
    });
    const dsCtx = svc.resolveDatasetContext('gnomad_r4');

    const summaries = await svc.getCoverage(
      { kind: 'region', value: '1-55039974-55039974' },
      dsCtx,
      createMockContext(),
    );

    expect(summaries).toHaveLength(1);
    const [s] = summaries;
    // Positions is the requested base only, NOT 3 (or the upstream 151).
    expect(s?.positions).toBe(1);
    // Depth is that base's value, not the ±window average of (8+42+9)/3.
    expect(s?.mean_depth).toBe(42);
    expect(s?.median_depth).toBe(42);
    expect(s?.fraction_over_30).toBe(1);
  });

  it('bounds a multi-base region to start..stop', async () => {
    const bins = [covBin(100, 5), covBin(101, 20), covBin(102, 30), covBin(103, 99)];
    vi.spyOn(svc as any, 'graphql').mockResolvedValue({
      region: { coverage: { exome: bins, genome: null } },
    });
    const dsCtx = svc.resolveDatasetContext('gnomad_r4');

    const summaries = await svc.getCoverage(
      { kind: 'region', value: '1-101-102' },
      dsCtx,
      createMockContext(),
    );

    // Only pos 101 and 102 fall in start..stop; the flanking 100 and 103 drop.
    expect(summaries[0]?.positions).toBe(2);
    expect(summaries[0]?.mean_depth).toBe(25); // (20+30)/2, not (5+20+30+99)/4
  });

  it('bounds gene coverage bins to the exons ±75 bp gnomAD queried', async () => {
    // Exon 101–101 → interval 26–176. Bins 1 and 177 are intron gnomAD never queried.
    const bins = [covBin(1, 10), covBin(26, 20), covBin(176, 30), covBin(177, 90)];
    vi.spyOn(svc as any, 'graphql').mockResolvedValue({
      gene: {
        chrom: '1',
        exons: [{ start: 101, stop: 101 }],
        coverage: { exome: bins, genome: null },
      },
    });
    const dsCtx = svc.resolveDatasetContext('gnomad_r4');

    const summaries = await svc.getCoverage(
      { kind: 'gene', value: 'PCSK9' },
      dsCtx,
      createMockContext(),
    );

    expect(summaries[0]).toMatchObject({ positions: 2, bucket_count: 2, bucket_size: 1 });
    expect(summaries[0]?.mean_depth).toBe(25); // (20+30)/2, not (10+20+30+90)/4
  });

  it('bounds transcript coverage bins to the exons ±75 bp gnomAD queried', async () => {
    const bins = [covBin(25, 5), covBin(26, 40), covBin(27, 41), covBin(400, 0)];
    vi.spyOn(svc as any, 'graphql').mockResolvedValue({
      transcript: {
        chrom: '1',
        exons: [{ start: 101, stop: 101 }],
        coverage: { exome: bins, genome: null },
      },
    });
    const dsCtx = svc.resolveDatasetContext('gnomad_r4');

    const summaries = await svc.getCoverage(
      { kind: 'transcript', value: 'ENST00000302118' },
      dsCtx,
      createMockContext(),
    );

    expect(summaries[0]).toMatchObject({ positions: 2, bucket_count: 2, mean_depth: 40.5 });
  });
});

/** A float summary value, matched to nine decimal places. */
const close = (value: number) => expect.closeTo(value, 9);

const coverageOf = (kind: 'gene' | 'transcript' | 'region', value: string) =>
  svc.getCoverage({ kind, value }, svc.resolveDatasetContext('gnomad_r4'), createMockContext());

describe('GnomadService.getCoverage — gnomAD coverage buckets at the fetch seam', () => {
  afterEach(() => vi.restoreAllMocks());

  it('summarizes only the requested base of a live single-position region', async () => {
    fakeCoverage(LIVE_COVERAGE['region:1-55039974-55039974']);

    const summaries = await coverageOf('region', '1-55039974-55039974');

    expect(summaries).toEqual([
      {
        source: 'exome',
        positions: 1,
        target_positions: 1,
        missing_positions: 0,
        bucket_count: 1,
        bucket_size: 1,
        mean_depth: 56.13959972474064,
        median_depth: 31,
        fraction_over_1: 1,
        fraction_over_5: 1,
        fraction_over_10: 0.98,
        fraction_over_15: 0.97,
        fraction_over_20: 0.96,
        fraction_over_25: 0.91,
        fraction_over_30: 0.62,
        fraction_over_50: 0.32,
        fraction_over_100: 0.19,
      },
      {
        source: 'genome',
        positions: 1,
        target_positions: 1,
        missing_positions: 0,
        bucket_count: 1,
        bucket_size: 1,
        mean_depth: 35.59847702992943,
        median_depth: 34,
        fraction_over_1: 1,
        fraction_over_5: 1,
        fraction_over_10: 1,
        fraction_over_15: 1,
        fraction_over_20: 1,
        fraction_over_25: 0.94,
        fraction_over_30: 0.8,
        fraction_over_50: 0.09,
        fraction_over_100: 0.01,
      },
    ]);
  });

  it('omits a track gnomAD returns empty and summarizes the other', async () => {
    fakeCoverage({
      data: {
        gene: {
          chrom: '1',
          exons: [{ start: 1076, stop: 1080 }],
          coverage: { exome: [], genome: [covBin(1001, 30), covBin(1155, 40)] },
        },
      },
    });

    const summaries = await coverageOf('gene', 'PCSK9');

    expect(summaries.map((s) => s.source)).toEqual(['genome']);
    expect(summaries[0]).toMatchObject({ positions: 2, mean_depth: 35 });
  });

  it('summarizes the live PCSK9 response over its exons ±75 bp, not the zero-filled introns', async () => {
    const requests = fakeCoverage(LIVE_COVERAGE['gene:PCSK9']);

    const summaries = await coverageOf('gene', 'PCSK9');

    // The exons ride in the same request as the coverage they bound.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.query).toMatch(/exons \{ start stop \}[\s\S]*coverage\(dataset/);
    // 34 exon features merge to 14 padded intervals summing to 7,797 bp → 15 bp
    // buckets. The genome track keeps the 535 buckets overlapping them out of 587.
    expect(summaries).toEqual([
      {
        source: 'exome',
        positions: 894,
        target_positions: 7811,
        missing_positions: 6917,
        bucket_count: 61,
        bucket_size: 15,
        mean_depth: close(20.31600189688799),
        median_depth: close(6),
        fraction_over_1: close(0.5924590163934427),
        fraction_over_5: close(0.5511475409836066),
        fraction_over_10: close(0.4888524590163935),
        fraction_over_15: close(0.4537704918032788),
        fraction_over_20: close(0.43000000000000016),
        fraction_over_25: close(0.38967213114754096),
        fraction_over_30: close(0.24590163934426237),
        fraction_over_50: close(0.08770491803278689),
        fraction_over_100: close(0.043114754098360644),
      },
      {
        source: 'genome',
        positions: 7811,
        target_positions: 7811,
        missing_positions: 0,
        bucket_count: 535,
        bucket_size: 15,
        mean_depth: close(32.49755523382596),
        median_depth: 33,
        fraction_over_1: close(0.9950280373831775),
        fraction_over_5: close(0.9950280373831775),
        fraction_over_10: close(0.9950093457943924),
        fraction_over_15: close(0.9945046728971961),
        fraction_over_20: close(0.9690093457943999),
        fraction_over_25: close(0.8762990654205581),
        fraction_over_30: close(0.7061308411214963),
        fraction_over_50: close(0.031495327102803505),
        fraction_over_100: close(0.00999999999999987),
      },
    ]);
  });

  it('summarizes a live transcript over its own exons ±75 bp, in 10 bp buckets', async () => {
    const requests = fakeCoverage(LIVE_COVERAGE['transcript:ENST00000302118']);

    const summaries = await coverageOf('transcript', 'ENST00000302118');

    expect(requests[0]?.query).toContain('exons { start stop }');
    expect(summaries).toEqual([
      {
        source: 'exome',
        positions: 630,
        target_positions: 5437,
        missing_positions: 4807,
        bucket_count: 63,
        bucket_size: 10,
        mean_depth: close(29.468469069263534),
        median_depth: close(28.8),
        fraction_over_1: close(0.8566666666666667),
        fraction_over_5: close(0.7987301587301584),
        fraction_over_10: close(0.709365079365079),
        fraction_over_15: close(0.657936507936508),
        fraction_over_20: close(0.6239682539682543),
        fraction_over_25: close(0.566031746031746),
        fraction_over_30: close(0.3565079365079364),
        fraction_over_50: close(0.12682539682539684),
        fraction_over_100: close(0.062380952380952384),
      },
      {
        source: 'genome',
        positions: 647,
        target_positions: 5437,
        missing_positions: 4790,
        bucket_count: 65,
        bucket_size: 10,
        mean_depth: close(34.30150891004619),
        median_depth: close(33.9),
        fraction_over_1: close(0.9996923076923075),
        fraction_over_5: close(0.9996923076923075),
        fraction_over_10: close(0.9996923076923075),
        fraction_over_15: close(0.9996923076923075),
        fraction_over_20: close(0.9926153846153841),
        fraction_over_25: close(0.9309230769230759),
        fraction_over_30: close(0.7781538461538451),
        fraction_over_50: close(0.05523076923076923),
        fraction_over_100: close(0.010000000000000005),
      },
    ]);
  });

  it('keeps the live 4,800 bp bucket at 998,400 that covers the start of 1-1000000-3400000', async () => {
    fakeCoverage(LIVE_COVERAGE['region:1-1000000-3400000']);

    const summaries = await coverageOf('region', '1-1000000-3400000');

    // The trimmed response holds each track's first and last three buckets.
    expect(summaries).toEqual([
      {
        source: 'exome',
        positions: 27200, // 3,200 + 2×4,800 at the head, 3×4,800 at the tail (last ends 3,398,399)
        target_positions: 2400001,
        missing_positions: 2372801,
        bucket_count: 6,
        bucket_size: 4800,
        mean_depth: close(7.7747301265779),
        median_depth: close(9.391143911439114),
        fraction_over_1: close(0.35666666666666663),
        fraction_over_5: close(0.3116666666666667),
        fraction_over_10: close(0.255),
        fraction_over_15: close(0.22499999999999998),
        fraction_over_20: close(0.20166666666666666),
        fraction_over_25: close(0.17666666666666667),
        fraction_over_30: close(0.12166666666666666),
        fraction_over_50: close(0.013333333333333334),
        fraction_over_100: close(0.008333333333333333),
      },
      {
        source: 'genome',
        positions: 24001, // 3,200 + 2×4,800 at the head; 2×4,800 + 1,601 at the tail
        target_positions: 2400001,
        missing_positions: 2376000,
        bucket_count: 6,
        bucket_size: 4800,
        mean_depth: close(32.16623947907194),
        median_depth: close(32.673125),
        fraction_over_1: close(0.9983333333333334),
        fraction_over_5: close(0.9983333333333334),
        fraction_over_10: close(0.9983333333333334),
        fraction_over_15: close(0.9966666666666667),
        fraction_over_20: close(0.9649999999999999),
        fraction_over_25: close(0.8649999999999999),
        fraction_over_30: close(0.69),
        fraction_over_50: close(0.030000000000000002),
        fraction_over_100: close(0.01),
      },
    ]);
  });

  it('counts every bucket and base of 1-1000000-3400000 across the full live key range', async () => {
    // Bucket keys as gnomAD returned them: exome 998,400…3,393,600 (500 buckets,
    // its last records end before the stop) and genome 998,400…3,398,400 (501).
    const keys = (last: number) =>
      Array.from({ length: (last - 998400) / 4800 + 1 }, (_, i) => 998400 + i * 4800);
    fakeCoverage({
      data: {
        region: {
          coverage: {
            exome: keys(3393600).map((pos) => covBin(pos, 30)),
            genome: keys(3398400).map((pos) => covBin(pos, 30)),
          },
        },
      },
    });

    const summaries = await coverageOf('region', '1-1000000-3400000');

    expect(
      summaries.map(({ source, positions, bucket_count, bucket_size }) => ({
        source,
        positions,
        bucket_count,
        bucket_size,
      })),
    ).toEqual([
      { source: 'exome', positions: 2_398_400, bucket_count: 500, bucket_size: 4800 },
      { source: 'genome', positions: 2_400_001, bucket_count: 501, bucket_size: 4800 },
    ]);
  });

  it('keeps the live 20 bp buckets straddling start and stop and drops those wholly in the pad', async () => {
    fakeCoverage(LIVE_COVERAGE['region:1-55039447-55049447']);

    const summaries = await coverageOf('region', '1-55039447-55049447');

    // Genome: 55,039,360–55,039,420 and 55,049,460–55,049,520 lie wholly in the
    // ±75 bp pad and drop; 55,039,440 (13 bases from start) and 55,049,440
    // (8 bases to stop) straddle the edges and stay.
    expect(summaries).toEqual([
      {
        source: 'exome',
        positions: 320,
        target_positions: 10001,
        missing_positions: 9681,
        bucket_count: 16,
        bucket_size: 20,
        mean_depth: close(21.74737370416841),
        median_depth: close(31.842105263157894),
        fraction_over_1: close(0.78375),
        fraction_over_5: close(0.7050000000000001),
        fraction_over_10: close(0.63625),
        fraction_over_15: close(0.606875),
        fraction_over_20: close(0.5887500000000001),
        fraction_over_25: close(0.56125),
        fraction_over_30: close(0.43187499999999995),
        fraction_over_50: close(0.035),
        fraction_over_100: close(0.020000000000000004),
      },
      {
        source: 'genome',
        positions: 141,
        target_positions: 10001,
        missing_positions: 9860,
        bucket_count: 8,
        bucket_size: 20,
        mean_depth: close(33.60507578240496),
        median_depth: 34,
        fraction_over_1: 1,
        fraction_over_5: 1,
        fraction_over_10: 1,
        fraction_over_15: 1,
        fraction_over_20: close(0.9900000000000001),
        fraction_over_25: close(0.92),
        fraction_over_30: close(0.7649999999999999),
        fraction_over_50: close(0.039999999999999994),
        fraction_over_100: close(0.01),
      },
    ]);
  });

  it('keeps a zero bucket inside the exon intervals and never one outside them', async () => {
    // One exon at 1,076–1,080 → queried interval 1,001–1,155 → 1 bp buckets.
    // Inside: 1,001 (40×), 1,078 (no records, zero-filled), 1,155 (20×).
    // Outside: the zero-filled intron at 1,000, 1,156, and 1,500.
    const bucket = (pos: number, depth: number, frac: number) => ({
      pos,
      mean: depth,
      median: depth,
      over_1: frac,
      over_5: frac,
      over_10: frac,
      over_15: frac,
      over_20: frac,
      over_25: frac,
      over_30: frac,
      over_50: frac,
      over_100: frac,
    });
    fakeCoverage({
      data: {
        gene: {
          chrom: '1',
          exons: [{ start: 1076, stop: 1080 }],
          coverage: {
            exome: [
              bucket(1000, 0, 0),
              bucket(1001, 40, 0.9),
              bucket(1078, 0, 0),
              bucket(1155, 20, 0.6),
              bucket(1156, 0, 0),
              bucket(1500, 0, 0),
            ],
            genome: null,
          },
        },
      },
    });

    const summaries = await coverageOf('gene', 'PCSK9');

    // Every field differs from the all-buckets answer (mean 10, median 0, fractions 0.25).
    expect(summaries).toEqual([
      {
        source: 'exome',
        positions: 3,
        target_positions: 155,
        missing_positions: 152,
        bucket_count: 3,
        bucket_size: 1,
        mean_depth: 20,
        median_depth: 20,
        fraction_over_1: close(0.5),
        fraction_over_5: close(0.5),
        fraction_over_10: close(0.5),
        fraction_over_15: close(0.5),
        fraction_over_20: close(0.5),
        fraction_over_25: close(0.5),
        fraction_over_30: close(0.5),
        fraction_over_50: close(0.5),
        fraction_over_100: close(0.5),
      },
    ]);
  });

  it.each([
    // [start, stop, bucket size] — size = max(floor((stop − start + 150) / 500), 1)
    [1001, 1850, 1], // span 849 → 999 → 1 bp
    [1001, 1851, 2], // span 850 → 1,000 → 2 bp
    [1001, 1852, 2], // span 851 → 1,001 → 2 bp
    [1001, 2349, 2], // span 1,348 → 1,498 → 2 bp
    [1001, 2350, 2], // span 1,349 → 1,499 → 2 bp
    [1001, 2351, 3], // span 1,350 → 1,500 → 3 bp
  ])(
    'derives the bucket size of region 1-%i-%i as %i bp from gnomAD’s formula',
    async (start, stop, size) => {
      // Two sparse buckets only, so the returned bucket count says nothing about size.
      const first = Math.floor(start / size) * size;
      const last = Math.floor(stop / size) * size;
      fakeCoverage({
        data: {
          region: { coverage: { exome: [covBin(first, 30), covBin(last, 30)], genome: null } },
        },
      });

      const [summary] = await coverageOf('region', `1-${start}-${stop}`);

      expect(summary?.bucket_size).toBe(size);
      expect(summary?.bucket_count).toBe(2);
      expect(summary?.positions).toBe(first + size - start + (stop - last + 1));
    },
  );

  it('pads, sorts, and merges overlapping and adjacent exons as gnomAD does', async () => {
    // Exons listed 3′→5′ as a minus-strand feature can arrive. Padded: 1,576–2,001,
    // 1,001–1,575, 1,025–1,275. The third nests in the second; the first starts one
    // base past the second's end, so all three merge to 1,001–2,001 (Σ stop − start
    // = 1,000 → 2 bp buckets). Unmerged, the sizes sum to 999 → 1 bp buckets.
    fakeCoverage({
      data: {
        gene: {
          chrom: '1',
          exons: [
            { start: 1651, stop: 1926 },
            { start: 1076, stop: 1500 },
            { start: 1100, stop: 1200 },
          ],
          coverage: {
            exome: [
              covBin(998, 0), // 998–999: before the interval
              covBin(1000, 30), // 1,000–1,001: one base inside
              covBin(1574, 30), // 1,574–1,575 and 1,576–1,577 straddle the merge seam
              covBin(1576, 30),
              covBin(2000, 30), // 2,000–2,001: both bases inside
              covBin(2002, 0), // 2,002–2,003: past the interval
            ],
            genome: null,
          },
        },
      },
    });

    const [summary] = await coverageOf('gene', 'PCSK9');

    expect(summary).toMatchObject({
      bucket_size: 2,
      bucket_count: 4,
      positions: 7,
      mean_depth: 30,
    });
  });

  it('sizes feature buckets from the summed stop − start of the padded exons, not their base counts', async () => {
    // Exon 1,076–1,925 pads to 1,001–2,000: stop − start = 999 → 1 bp buckets.
    // Counting bases (1,000) instead would give 2 bp buckets.
    fakeCoverage({
      data: {
        gene: {
          chrom: '1',
          exons: [{ start: 1076, stop: 1925 }],
          coverage: { exome: [covBin(1001, 30), covBin(2000, 30)], genome: null },
        },
      },
    });

    const [summary] = await coverageOf('gene', 'PCSK9');

    expect(summary).toMatchObject({ bucket_size: 1, bucket_count: 2, positions: 2 });
  });

  it('returns no summary for a track whose buckets all fall outside the exon intervals', async () => {
    fakeCoverage({
      data: {
        transcript: {
          chrom: '1',
          exons: [{ start: 1076, stop: 1080 }],
          coverage: {
            exome: [covBin(5000, 0), covBin(5001, 0)],
            genome: [covBin(1078, 25)],
          },
        },
      },
    });

    const summaries = await coverageOf('transcript', 'ENST00000302118');

    expect(summaries).toEqual([
      expect.objectContaining({ source: 'genome', positions: 1, bucket_count: 1, mean_depth: 25 }),
    ]);
  });
});

interface Reply {
  body: string | null;
  status: number;
}

/** gnomAD's GraphQL error envelope — the body its resolvers send on a failure. */
function graphqlErrors(...messages: string[]): string {
  return JSON.stringify({ errors: messages.map((message) => ({ message })), data: null });
}

/** Fake gnomAD's HTTP replies in order, the last one repeating. Returns the fetch spy. */
function fakeReplies(...replies: Reply[]) {
  let call = 0;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const { status, body } = replies[Math.min(call++, replies.length - 1)] as Reply;
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  });
}

/**
 * Settle a service call while advancing fake timers past every backoff the
 * retry loop schedules. The handler is attached before the timers move, so a
 * rejection is never momentarily unobserved.
 */
async function settle<T>(op: () => Promise<T>): Promise<T | McpError> {
  const outcome = op().catch((err: unknown) => err as McpError);
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(60_000);
  return outcome;
}

describe('GnomadService — upstream failure classification at the fetch seam', () => {
  const dsCtx = svc.resolveDatasetContext('gnomad_r4');
  const listRegion = () =>
    svc.listGeneVariants(
      { kind: 'region', value: '1-1000000-3400000' },
      {},
      dsCtx,
      createMockContext(),
    );
  const coverageRegion = () =>
    svc.getCoverage({ kind: 'region', value: '1-1000000-3400000' }, dsCtx, createMockContext());
  const listGene = () =>
    svc.listGeneVariants({ kind: 'gene', value: 'PCSK9' }, {}, dsCtx, createMockContext());

  /** The sanitized transient error every exhausted retry ends as. */
  function expectRetriedOut(outcome: unknown): void {
    expect(outcome).toBeInstanceOf(McpError);
    const error = outcome as McpError;
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toBe('gnomAD is unavailable or rate-limited. (failed after 4 attempts)');
    expect(error.data).toMatchObject({
      reason: 'upstream_unavailable',
      retryable: true,
      retryAttempts: 4,
    });
    // The hint comes from each surface's declaration, never from the service.
    expect(error.data).not.toHaveProperty('recovery');
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each<[string, Reply]>([
    [
      'an HTTP 400 carrying the rate-limit message',
      {
        status: 400,
        body: graphqlErrors('Query rate limit exceeded. Please try again in a few minutes.'),
      },
    ],
    ['an HTTP 429', { status: 429, body: 'Too Many Requests' }],
    [
      'a 500 "An unknown error occurred"',
      { status: 500, body: graphqlErrors('An unknown error occurred') },
    ],
    ['a 500 "Request timed out"', { status: 500, body: graphqlErrors('Request timed out') }],
    ['a 500 "Service overloaded"', { status: 500, body: graphqlErrors('Service overloaded') }],
    ['a 500 with an unlisted message', { status: 500, body: graphqlErrors('Resolver exploded') }],
    [
      'a 500 whose messages mix a region message with an unlisted one',
      {
        status: 500,
        body: graphqlErrors('Select a smaller region to view variants', 'Resolver exploded'),
      },
    ],
    ['a 500 with a non-JSON body', { status: 500, body: '<h1>Internal Server Error</h1>' }],
    ['a 500 with a JSON body that is no GraphQL envelope', { status: 500, body: '{"data":null}' }],
    ['a 500 with an empty errors list', { status: 500, body: '{"errors":[],"data":null}' }],
    ['a 500 with an empty body', { status: 500, body: '' }],
    ['a 500 with no body', { status: 500, body: null }],
    ['a 502 gateway page', { status: 502, body: 'Bad Gateway' }],
  ])('retries %s four times, then fails as upstream_unavailable', async (_label, reply) => {
    const fetch = fakeReplies(reply);
    expectRetriedOut(await settle(listRegion));
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('recovers when a transient 500 clears on a later attempt', async () => {
    const fetch = fakeReplies(
      { status: 500, body: graphqlErrors('Service overloaded') },
      { status: 500, body: graphqlErrors('Request timed out') },
      { status: 200, body: JSON.stringify({ data: { region: { variants: [] } } }) },
    );
    expect(await settle(listRegion)).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each<[string, string, () => Promise<unknown>]>([
    [
      'This region has too many variants to display. Select a smaller region to view variants.',
      'region_too_large',
      listRegion,
    ],
    ['Select a smaller region to view variants', 'region_too_large', listRegion],
    ['Coverage is not available for a region this large', 'region_too_large', coverageRegion],
    ["Invalid chromosome: '23'", 'invalid_region', listRegion],
    ['Region start must be greater than 0', 'invalid_region', listRegion],
    ['Region start must be less than 1,000,000,000', 'invalid_region', coverageRegion],
    ['Region stop must be greater than 0', 'invalid_region', listRegion],
    ['Region stop must be less than 1,000,000,000', 'invalid_region', coverageRegion],
    ['Region stop must be greater than region start', 'invalid_region', listRegion],
  ])('fails a 500 "%s" once as %s, relaying the message alone', async (message, reason, call) => {
    const fetch = fakeReplies({ status: 500, body: graphqlErrors(message) });
    const error = (await settle(call)) as McpError;
    expect(error).toBeInstanceOf(McpError);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.message).toBe(message);
    expect(error.data).toEqual({ reason, retryable: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('prefers invalid_region when a 500 carries both kinds of region message', async () => {
    const fetch = fakeReplies({
      status: 500,
      body: graphqlErrors("Invalid chromosome: 'Z'", 'Select a smaller region to view variants'),
    });
    const error = (await settle(listRegion)) as McpError;
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toEqual({ reason: 'invalid_region', retryable: false });
    expect(error.message).toBe("Invalid chromosome: 'Z'; Select a smaller region to view variants");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    'Request timed out',
    'Service overloaded',
    'Query rate limit exceeded. Please try again in a few minutes.',
  ])(
    'retries "%s" on an HTTP 200 envelope, then fails as upstream_unavailable',
    async (message) => {
      const fetch = fakeReplies({
        status: 200,
        body: JSON.stringify({ errors: [{ message }], data: { gene: null } }),
      });
      expectRetriedOut(await settle(listGene));
      expect(fetch).toHaveBeenCalledTimes(4);
    },
  );

  it('retries a transient HTTP 200 error on the variant root and recovers', async () => {
    const variant = {
      variant_id: '1-55051215-G-GA',
      reference_genome: 'GRCh38',
      rsids: [],
      flags: null,
      exome: null,
      genome: null,
      transcript_consequences: null,
      in_silico_predictors: null,
    };
    const fetch = fakeReplies(
      {
        status: 200,
        body: JSON.stringify({
          errors: [{ message: 'Service overloaded' }],
          data: { variant: null, clinvar_variant: null },
        }),
      },
      { status: 200, body: JSON.stringify({ data: { variant, clinvar_variant: null } }) },
    );
    const record = await settle(() =>
      svc.getVariant('1-55051215-G-GA', dsCtx, createMockContext()),
    );
    expect(record).toMatchObject({ variant_id: '1-55051215-G-GA', clinvar_unavailable: false });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps a non-transient HTTP 200 error as a single non-retryable graphql_error', async () => {
    const fetch = fakeReplies({
      status: 200,
      body: JSON.stringify({
        errors: [{ message: 'Multiple genes found for symbol ABC' }],
        data: { gene: null },
      }),
    });
    expect(await settle(listGene)).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'graphql_error', retryable: false },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('GnomadService.getVariant — ClinVar attribution through the retry loop', () => {
  const GNOMAD_ORIGIN = new URL(getServerConfig().gnomadApiBaseUrl).origin;
  const ID = '1-55051215-G-GA';
  const variant = {
    variant_id: ID,
    reference_genome: 'GRCh38',
    rsids: ['rs527413419'],
    flags: null,
    exome: null,
    genome: {
      ac: 3,
      an: 1_000,
      af: 0.003,
      homozygote_count: 0,
      hemizygote_count: null,
      populations: [],
    },
    transcript_consequences: null,
    in_silico_predictors: null,
  };
  const ok = (data: unknown): Reply => ({ status: 200, body: JSON.stringify({ data }) });
  const envelope = (message: string, data: unknown): Reply => ({
    status: 200,
    body: JSON.stringify({ errors: [{ message }], data }),
  });
  /** gnomAD's combined reply when an error sits beside a resolved variant. */
  const erroredCombined = envelope('Invalid variant ID', { variant, clinvar_variant: null });
  const overloaded = (data: unknown) => envelope('Service overloaded', data);

  type Route = Reply | ((init: RequestInit | undefined) => Promise<Response>);

  /**
   * Fake gnomAD per GraphQL operation and record the operation each request
   * named. A request to another origin, or naming an operation without a route,
   * throws instead of reaching the network.
   */
  function fakeOperations(routes: Record<string, Route>) {
    const operations: string[] = [];
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url).origin !== GNOMAD_ORIGIN) throw new Error(`Unmocked fetch to ${url}`);
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      const operation = /query\s+(\w+)/.exec(query)?.[1] ?? 'anonymous';
      operations.push(operation);
      const route = routes[operation];
      if (!route) throw new Error(`Unmocked gnomAD operation ${operation}`);
      if (typeof route === 'function') return route(init);
      return new Response(route.body, {
        status: route.status,
        headers: { 'content-type': 'application/json' },
      });
    });
    return { fetch, operations };
  }

  /** A request that stays pending until its signal aborts, as a stalled upstream does. */
  const hang = (init: RequestInit | undefined) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });

  const lookup = (id: string, ctx = createMockContext()) =>
    svc.getVariant(id, svc.resolveDatasetContext('gnomad_r4'), ctx);

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/44
  it('retries "Service overloaded" beside a null variant on the combined request only', async () => {
    const { operations } = fakeOperations({
      GnomadVariant: overloaded({ variant: null, clinvar_variant: null }),
    });

    expect(await settle(() => lookup(ID))).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unavailable', retryAttempts: 4 },
    });
    expect(operations).toEqual(Array(4).fill('GnomadVariant'));
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/44
  it('fails the item as upstream_unavailable when the split variant-only request stays overloaded', async () => {
    const { operations } = fakeOperations({
      GnomadVariant: erroredCombined,
      GnomadVariantOnly: overloaded({ variant }),
    });

    expect(await settle(() => lookup(ID))).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unavailable', retryAttempts: 4 },
    });
    expect(operations).toEqual(['GnomadVariant', ...Array(4).fill('GnomadVariantOnly')]);
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/44
  it('recovers the split variant-only request once a transient error clears', async () => {
    let attempt = 0;
    const { operations } = fakeOperations({
      GnomadVariant: erroredCombined,
      GnomadVariantOnly: async () => {
        attempt += 1;
        const reply = attempt < 3 ? overloaded({ variant: null }) : ok({ variant });
        return new Response(reply.body, { status: reply.status });
      },
      GnomadClinvar: ok({ clinvar_variant: null }),
    });

    expect(await settle(() => lookup(ID))).toMatchObject({
      variant_id: ID,
      ac: 3,
      clinvar_unavailable: false,
    });
    expect(operations).toEqual([
      'GnomadVariant',
      'GnomadVariantOnly',
      'GnomadVariantOnly',
      'GnomadVariantOnly',
      'GnomadClinvar',
    ]);
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/44
  it.each<[string, Reply]>([
    ['"Service overloaded" through every retry', overloaded({ clinvar_variant: null })],
    ['an HTTP 503', { status: 503, body: 'Service Unavailable' }],
    [
      'an HTTP 400 rate limit',
      { status: 400, body: graphqlErrors('Query rate limit exceeded. Please try again later.') },
    ],
  ])(
    'degrades a coordinate ID to clinvar_unavailable when the ClinVar-only request answers %s',
    async (_label, reply) => {
      const { operations } = fakeOperations({
        GnomadVariant: erroredCombined,
        GnomadVariantOnly: ok({ variant }),
        GnomadClinvar: reply,
      });

      expect(await settle(() => lookup(ID))).toMatchObject({
        variant_id: ID,
        ac: 3,
        clinvar: null,
        clinvar_unavailable: true,
      });
      expect(operations).toEqual([
        'GnomadVariant',
        'GnomadVariantOnly',
        ...Array(4).fill('GnomadClinvar'),
      ]);
    },
  );

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/44
  it.each<[string, Reply]>([
    ['"Service overloaded" through every retry', overloaded({ clinvar_variant: null })],
    ['an HTTP 503', { status: 503, body: 'Service Unavailable' }],
    [
      'an HTTP 500 GraphQL error',
      { status: 500, body: graphqlErrors('An unknown error occurred') },
    ],
  ])(
    'degrades an rsID to clinvar_unavailable when its ClinVar request answers %s',
    async (_label, reply) => {
      const { operations } = fakeOperations({
        GnomadVariantByRsid: ok({ variant }),
        GnomadClinvar: reply,
      });

      expect(await settle(() => lookup('rs527413419'))).toMatchObject({
        variant_id: ID,
        clinvar: null,
        clinvar_unavailable: true,
      });
      expect(operations).toEqual(['GnomadVariantByRsid', ...Array(4).fill('GnomadClinvar')]);
    },
  );

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/44
  it.each([
    ['a coordinate ID', ID, { GnomadVariant: erroredCombined, GnomadVariantOnly: ok({ variant }) }],
    ['an rsID', 'rs527413419', { GnomadVariantByRsid: ok({ variant }) }],
  ])(
    'ends a stalled ClinVar request for %s at the lookup budget, not after every per-attempt timeout',
    async (_label, id, routes) => {
      const { operations } = fakeOperations({ ...routes, GnomadClinvar: hang });
      let settled: unknown;
      void lookup(id).then(
        (value) => {
          settled = value;
        },
        (error: unknown) => {
          settled = error;
        },
      );

      await vi.advanceTimersByTimeAsync(CLINVAR_LOOKUP_BUDGET_MS - 1);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);

      expect(settled).toMatchObject({ variant_id: ID, clinvar: null, clinvar_unavailable: true });
      // The 45 s budget outlasts one 30 s per-attempt timeout, so a stall gets one retry, not three.
      expect(operations.filter((operation) => operation === 'GnomadClinvar')).toHaveLength(2);
    },
  );

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/44
  it('skips the ClinVar request when the lookup budget is already spent', async () => {
    const { operations } = fakeOperations({
      GnomadVariantByRsid: async () => {
        vi.setSystemTime(Date.now() + CLINVAR_LOOKUP_BUDGET_MS);
        return new Response(JSON.stringify({ data: { variant } }));
      },
    });

    const record = await settle(() =>
      svc.getVariant('rs527413419', svc.resolveDatasetContext('gnomad_r4'), createMockContext(), {
        startedAt: Date.now(),
      }),
    );

    expect(record).toMatchObject({ variant_id: ID, clinvar_unavailable: true });
    expect(operations).toEqual(['GnomadVariantByRsid']);
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/44
  it('rejects a call cancelled before its ClinVar lookup', async () => {
    const controller = new AbortController();
    const { operations } = fakeOperations({
      GnomadVariantByRsid: async () => {
        controller.abort(new Error('client cancelled'));
        return new Response(JSON.stringify({ data: { variant } }), { status: 200 });
      },
    });

    const outcome = await settle(() =>
      svc.getVariant(
        'rs527413419',
        svc.resolveDatasetContext('gnomad_r4'),
        createMockContext({ signal: controller.signal }),
        { startedAt: Date.now() },
      ),
    );

    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).not.toHaveProperty('variant_id');
    expect(operations).toEqual(['GnomadVariantByRsid']);
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/44
  it.each([
    ['a coordinate ID', ID, { GnomadVariant: erroredCombined, GnomadVariantOnly: ok({ variant }) }],
    ['an rsID', 'rs527413419', { GnomadVariantByRsid: ok({ variant }) }],
  ])(
    'rejects %s cancelled during its ClinVar request instead of degrading it',
    async (_label, id, routes) => {
      const controller = new AbortController();
      const { operations } = fakeOperations({
        ...routes,
        GnomadClinvar: (init) => {
          queueMicrotask(() => controller.abort(new Error('client cancelled')));
          return hang(init);
        },
      });

      const outcome = await settle(() =>
        lookup(id, createMockContext({ signal: controller.signal })),
      );

      expect(outcome).toBeInstanceOf(Error);
      expect(outcome).not.toHaveProperty('variant_id');
      expect(operations.at(-1)).toBe('GnomadClinvar');
    },
  );
});
