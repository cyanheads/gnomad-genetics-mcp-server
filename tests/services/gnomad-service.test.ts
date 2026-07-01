/**
 * @fileoverview Unit tests for GnomadService pure logic — dataset→build
 * derivation, coherence validation, and the by-symbol/by-id gene routing.
 * Network methods are covered by live smoke tests; these assert the
 * deterministic, offline-safe behavior.
 * @module tests/services/gnomad-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { GnomadService } from '@/services/gnomad/gnomad-service.js';

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

describe('GnomadService.getCoverage — region bin bounding', () => {
  afterEach(() => vi.restoreAllMocks());

  it('bounds region coverage bins to the requested span — single position → positions:1', async () => {
    // gnomAD pads a single-position region(...) to a ~151bp window; the service
    // must keep only the bin at the requested base, not the ±75bp neighborhood.
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

  it('leaves gene coverage bins unbounded — the intended whole-feature set', async () => {
    const bins = [covBin(1, 10), covBin(2, 20), covBin(3, 30)];
    vi.spyOn(svc as any, 'graphql').mockResolvedValue({
      gene: { coverage: { exome: bins, genome: null } },
    });
    const dsCtx = svc.resolveDatasetContext('gnomad_r4');

    const summaries = await svc.getCoverage(
      { kind: 'gene', value: 'PCSK9' },
      dsCtx,
      createMockContext(),
    );

    expect(summaries[0]?.positions).toBe(3); // all bins summarized; no bounding
    expect(summaries[0]?.mean_depth).toBe(20); // (10+20+30)/3
  });

  it('leaves transcript coverage bins unbounded', async () => {
    const bins = [covBin(10, 40), covBin(11, 41)];
    vi.spyOn(svc as any, 'graphql').mockResolvedValue({
      transcript: { coverage: { exome: bins, genome: null } },
    });
    const dsCtx = svc.resolveDatasetContext('gnomad_r4');

    const summaries = await svc.getCoverage(
      { kind: 'transcript', value: 'ENST00000302118' },
      dsCtx,
      createMockContext(),
    );

    expect(summaries[0]?.positions).toBe(2);
  });
});
