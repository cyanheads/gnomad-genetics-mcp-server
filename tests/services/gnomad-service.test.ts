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
