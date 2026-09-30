/**
 * @fileoverview Unit tests for GnomadService logic — dataset→build derivation,
 * coherence validation, the by-symbol/by-id gene routing, the region parser,
 * and how upstream failures are classified. The classification tests fake only
 * global fetch, so the real retry loop, fetchWithTimeout, and the sanitizer all
 * run; everything here is deterministic and offline-safe.
 * @module tests/services/gnomad-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
      gene: { chrom: '1', coverage: { exome: bins, genome: null } },
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
      transcript: { chrom: '1', coverage: { exome: bins, genome: null } },
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
        body: JSON.stringify({ errors: [{ message, path: ['gene'] }], data: { gene: null } }),
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
          errors: [{ message: 'Service overloaded', path: ['variant'] }],
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
        errors: [{ message: 'Multiple genes found for symbol ABC', path: ['gene'] }],
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
