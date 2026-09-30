/**
 * @fileoverview Behavior tests for the gnomad_get_variant handler — batch
 * partial success: a resolved variant, an absent variant, a malformed ID, and a
 * service throw all coexist in one call, each failure carrying its typed reason
 * and recovery hint. Handler tests stub the service accessor; the failed[]
 * reason tests run the real service with only global fetch faked.
 * @module tests/tools/gnomad-get-variant.test
 */

import {
  JsonRpcErrorCode,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { gnomadGetVariant } from '@/mcp-server/tools/definitions/gnomad-get-variant.tool.js';
import * as serviceModule from '@/services/gnomad/gnomad-service.js';
import { GnomadService, initGnomadService } from '@/services/gnomad/gnomad-service.js';
import type { VariantRecord } from '@/services/gnomad/types.js';
import { minimalVariant } from '../helpers/minimal-variant.js';

/** Real service for genuine dataset/build derivation; network method overridden per-test. */
const realService = new GnomadService(getServerConfig());

/** The recovery hint gnomad_get_variant declares for a reason. */
function declared(reason: string): string | undefined {
  return gnomadGetVariant.errors?.find((entry) => entry.reason === reason)?.recovery;
}

function textOf(blocks: readonly unknown[]): string {
  return (blocks as { text?: string }[]).map((block) => block.text ?? '').join('\n');
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function record(variantId: string): VariantRecord {
  return {
    variant_id: variantId,
    rsids: ['rs1'],
    reference_genome: 'GRCh38',
    dataset: 'gnomad_r4',
    ac: 10,
    an: 1000,
    af: 0.01,
    homozygote_count: 0,
    hemizygote_count: null,
    populations: [
      {
        id: 'nfe',
        source: 'exome',
        ac: 5,
        an: 500,
        af: 0.01,
        homozygote_count: 0,
        hemizygote_count: null,
      },
    ],
    source: ['exome'],
    flags: [],
    consequence: 'missense_variant',
    transcript_id: 'ENST1',
    gene_symbol: 'GENE1',
    in_silico: [{ id: 'revel_max', value: 0.5, annotation: null }],
    clinvar: null,
    clinvar_unavailable: false,
  };
}

describe('gnomad_get_variant handler', () => {
  it('partitions a batch into found and failed with partial success', async () => {
    const fake = {
      resolveDatasetContext: () => ({ dataset: 'gnomad_r4', reference_genome: 'GRCh38' }) as const,
      getVariant: vi.fn(async (id: string) => {
        if (id === '1-100-A-T') return record(id);
        if (id === '1-200-A-T') return null; // absent in dataset
        throw serviceUnavailable('gnomAD is unavailable or rate-limited.', {
          reason: 'upstream_unavailable',
          retryable: true,
        });
      }),
    };
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(fake as never);

    const ctx = createMockContext({ errors: gnomadGetVariant.errors });
    const input = gnomadGetVariant.input.parse({
      variants: ['1-100-A-T', '1-200-A-T', '1-300-A-T', 'not-a-variant'],
    });
    const result = await gnomadGetVariant.handler(input, ctx as never);

    expect(result.dataset).toBe('gnomad_r4');
    expect(result.reference_genome).toBe('GRCh38');
    expect(result.found.map((v) => v.variant_id)).toEqual(['1-100-A-T']);
    // absent, service-throw, and malformed all land in failed[], each with its reason
    expect(result.failed.map((f) => [f.variant, f.reason])).toEqual([
      ['1-200-A-T', 'variant_not_found'],
      ['1-300-A-T', 'upstream_unavailable'],
      ['not-a-variant', 'invalid_variant_id'],
    ]);
    for (const failure of result.failed) {
      expect(failure.recovery).toBe(declared(failure.reason));
    }
    expect(result).toEqual(expect.schemaMatching(gnomadGetVariant.output));
    const malformed = result.failed.find((f) => f.variant === 'not-a-variant');
    expect(malformed?.error).toMatch(/Malformed ID/);
    // getVariant is never called for the malformed ID (rejected before the service)
    expect(fake.getVariant).toHaveBeenCalledTimes(3);
  });

  it('fails the call on an error that carries no declared reason instead of recording it per item', async () => {
    const fake = {
      resolveDatasetContext: () => ({ dataset: 'gnomad_r4', reference_genome: 'GRCh38' }) as const,
      getVariant: vi.fn(async (id: string) => {
        if (id === '1-100-A-T') return record(id);
        throw new TypeError('normalizer bug');
      }),
    };
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(fake as never);

    await expect(
      gnomadGetVariant.handler(
        gnomadGetVariant.input.parse({ variants: ['1-100-A-T', '1-200-A-T'] }),
        createMockContext({ errors: gnomadGetVariant.errors }) as never,
      ),
    ).rejects.toThrow('normalizer bug');
  });

  it('rethrows an item failure once the request is cancelled instead of reporting it per item', async () => {
    const controller = new AbortController();
    const fake = {
      resolveDatasetContext: () => ({ dataset: 'gnomad_r4', reference_genome: 'GRCh38' }) as const,
      getVariant: vi.fn(async () => {
        controller.abort();
        throw serviceUnavailable('gnomAD is unavailable or rate-limited.', {
          reason: 'upstream_unavailable',
          retryable: true,
        });
      }),
    };
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(fake as never);

    await expect(
      gnomadGetVariant.handler(
        gnomadGetVariant.input.parse({ variants: ['1-100-A-T'] }),
        createMockContext({ errors: gnomadGetVariant.errors, signal: controller.signal }) as never,
      ),
    ).rejects.toMatchObject({ data: { reason: 'upstream_unavailable' } });
  });

  it('dispatches the batch concurrently instead of serially', async () => {
    let active = 0;
    let peak = 0;
    const fake = {
      resolveDatasetContext: () => ({ dataset: 'gnomad_r4', reference_genome: 'GRCh38' }) as const,
      getVariant: vi.fn(async (id: string) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active -= 1;
        return record(id);
      }),
    };
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(fake as never);

    const ctx = createMockContext();
    const ids = Array.from({ length: 5 }, (_, i) => `1-${100 + i}-A-T`);
    const result = await gnomadGetVariant.handler(
      gnomadGetVariant.input.parse({ variants: ids }),
      ctx as never,
    );

    // The fake carries no semaphore, so true concurrent dispatch peaks at the
    // full batch size; the old serial for-loop would have peaked at 1. This
    // guards the dispatch change itself — the live semaphore cap is exercised in
    // field-testing, which a mocked service cannot prove.
    expect(peak).toBe(5);
    expect(result.found.map((v) => v.variant_id)).toEqual(ids);
  });

  it('keeps found[]/failed[] in input order regardless of upstream resolution order', async () => {
    // Per-item delays deliberately invert the input order: the first input
    // resolves last, so resolution order is not input order.
    const delays: Record<string, number> = {
      '1-300-A-T': 30,
      rs100: 20,
      '1-200-A-T': 10,
      '1-100-A-T': 5,
    };
    const fake = {
      resolveDatasetContext: () => ({ dataset: 'gnomad_r4', reference_genome: 'GRCh38' }) as const,
      getVariant: vi.fn(async (id: string) => {
        await new Promise((r) => setTimeout(r, delays[id] ?? 0));
        if (id === '1-200-A-T') return null; // absent in dataset → failed[]
        return record(id);
      }),
    };
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(fake as never);

    const ctx = createMockContext({ errors: gnomadGetVariant.errors });
    const input = gnomadGetVariant.input.parse({
      variants: ['1-300-A-T', 'not-a-variant', 'rs100', '1-100-A-T', '1-200-A-T'],
    });
    const result = await gnomadGetVariant.handler(input, ctx as never);

    // found[] and failed[] each follow input order, not the scrambled resolution
    // order (which would be not-a-variant, 1-100, 1-200, rs100, 1-300).
    expect(result.found.map((v) => v.variant_id)).toEqual(['1-300-A-T', 'rs100', '1-100-A-T']);
    expect(result.failed.map((f) => [f.variant, f.reason])).toEqual([
      ['not-a-variant', 'invalid_variant_id'],
      ['1-200-A-T', 'variant_not_found'],
    ]);
  });

  it('renders found and failed records in format() for content[] parity', async () => {
    const fake = {
      resolveDatasetContext: () => ({ dataset: 'gnomad_r4', reference_genome: 'GRCh38' }) as const,
      getVariant: vi.fn(async () => record('1-100-A-T')),
    };
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(fake as never);

    const ctx = createMockContext();
    const input = gnomadGetVariant.input.parse({ variants: ['1-100-A-T'] });
    const result = await gnomadGetVariant.handler(input, ctx as never);
    const text = (gnomadGetVariant.format?.(result) ?? [])
      .map((b) => ('text' in b ? b.text : ''))
      .join('');
    expect(text).toContain('1-100-A-T');
    expect(text).toContain('GENE1');
    expect(text).toContain('nfe');
  });

  it('renders plain predictor scores and missing ones as n/a in format()', async () => {
    const withPredictors: VariantRecord = {
      ...record('1-100-A-T'),
      in_silico: [
        { id: 'phylop', value: -3.87, annotation: null },
        { id: 'spliceai_ds_max', value: null, annotation: null },
      ],
    };
    const text = textOf(
      gnomadGetVariant.format?.({
        found: [withPredictors],
        failed: [],
        dataset: 'gnomad_r4',
        reference_genome: 'GRCh38',
      }) ?? [],
    );

    expect(text).toContain('**In-silico:** phylop=-3.87, spliceai_ds_max=n/a');
  });

  it('renders every failed item with its ID, message, and rsID candidates in format()', async () => {
    const fake = {
      resolveDatasetContext: () => ({ dataset: 'gnomad_r4', reference_genome: 'GRCh38' }) as const,
      getVariant: vi.fn(async (id: string) => {
        if (id === 'rs5') {
          throw validationError(
            'rs5 maps to multiple variants; retry with a candidate variant ID.',
            {
              reason: 'ambiguous_rsid',
              retryable: false,
              candidates: ['1-500-A-T', '1-500-A-G'],
            },
          );
        }
        return null;
      }),
    };
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(fake as never);

    const result = await gnomadGetVariant.handler(
      gnomadGetVariant.input.parse({ variants: ['not-a-variant', '1-200-A-T', 'rs5'] }),
      createMockContext({ errors: gnomadGetVariant.errors }) as never,
    );
    const text = (gnomadGetVariant.format?.(result) ?? [])
      .map((block) => ('text' in block ? block.text : ''))
      .join('');

    expect(result.failed.map((item) => item.variant)).toEqual([
      'not-a-variant',
      '1-200-A-T',
      'rs5',
    ]);
    expect(text).toContain('### Failed');
    for (const item of result.failed) {
      expect(text).toContain(`**${item.variant}:** ${item.error}`);
    }
    expect(text).toContain('Candidates: 1-500-A-T, 1-500-A-G');
  });

  it('distinguishes unavailable ClinVar from an ordinary absent entry on both surfaces', async () => {
    const unavailable = { ...record('1-100-A-T'), clinvar: null, clinvar_unavailable: true };
    const fake = {
      resolveDatasetContext: () => ({ dataset: 'gnomad_r4', reference_genome: 'GRCh38' }) as const,
      getVariant: vi.fn(async () => unavailable),
    };
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(fake as never);
    const ctx = createMockContext({ errors: gnomadGetVariant.errors });

    const result = await gnomadGetVariant.handler(
      gnomadGetVariant.input.parse({ variants: ['1-100-A-T'] }),
      ctx as never,
    );
    expect(result.found[0]).toMatchObject({ clinvar: null, clinvar_unavailable: true });
    expect(result).toEqual(expect.schemaMatching(gnomadGetVariant.output));
    expect(getEnrichment(ctx).notice).toContain('1-100-A-T');
    const text = (gnomadGetVariant.format?.(result) ?? [])
      .map((block) => ('text' in block ? block.text : ''))
      .join('');
    expect(text).toContain('ClinVar:** unavailable');
  });

  it('rejects an incoherent dataset/reference_genome pair before any lookup', async () => {
    const getVariant = vi.fn(async () => record('1-100-A-T'));
    const fake = {
      resolveDatasetContext: realService.resolveDatasetContext.bind(realService),
      getVariant,
    };
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(fake as never);

    const ctx = createMockContext({ errors: gnomadGetVariant.errors });
    const input = gnomadGetVariant.input.parse({
      variants: ['1-100-A-T'],
      dataset: 'gnomad_r4',
      reference_genome: 'GRCh37',
    });
    await expect(gnomadGetVariant.handler(input, ctx as never)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'incoherent_build' },
    });
    expect(getVariant).not.toHaveBeenCalled();
  });

  it('preserves a sparse record (null af, no clinvar, no in-silico) without inventing data', async () => {
    const sparse: VariantRecord = {
      variant_id: '7-100-A-T',
      rsids: [],
      reference_genome: 'GRCh38',
      dataset: 'gnomad_r4',
      ac: 0,
      an: 0,
      af: null,
      homozygote_count: 0,
      hemizygote_count: null,
      populations: [],
      source: [],
      flags: [],
      consequence: null,
      transcript_id: null,
      gene_symbol: null,
      in_silico: [],
      clinvar: null,
      clinvar_unavailable: false,
    };
    const fake = {
      resolveDatasetContext: realService.resolveDatasetContext.bind(realService),
      getVariant: vi.fn(async () => sparse),
    };
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(fake as never);

    const ctx = createMockContext({ errors: gnomadGetVariant.errors });
    const input = gnomadGetVariant.input.parse({ variants: ['7-100-A-T'] });
    const result = await gnomadGetVariant.handler(input, ctx as never);

    expect(result.found).toHaveLength(1);
    expect(result.found[0]?.af).toBeNull();
    expect(result).toEqual(expect.schemaMatching(gnomadGetVariant.output));

    const text = (gnomadGetVariant.format?.(result) ?? [])
      .map((b) => ('text' in b ? b.text : ''))
      .join('');
    // Missing af and clinvar render as explicit unknowns, not fabricated values.
    expect(text).toContain('AF Not available');
    expect(text).toContain('ClinVar:** no entry');
  });

  it('accepts a full batch of 25 IDs but rejects 26 at parse time', () => {
    const ids25 = Array.from({ length: 25 }, (_, i) => `1-${100 + i}-A-T`);
    expect(() => gnomadGetVariant.input.parse({ variants: ids25 })).not.toThrow();

    const ids26 = Array.from({ length: 26 }, (_, i) => `1-${100 + i}-A-T`);
    expect(() => gnomadGetVariant.input.parse({ variants: ids26 })).toThrow();
  });

  it('rejects an empty variants array at parse time', () => {
    expect(() => gnomadGetVariant.input.parse({ variants: [] })).toThrow();
  });

  it('accepts an rsID in the batch and routes it to the service', async () => {
    const getVariant = vi.fn(async (id: string) => record(id));
    const fake = {
      resolveDatasetContext: realService.resolveDatasetContext.bind(realService),
      getVariant,
    };
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(fake as never);

    const ctx = createMockContext({ errors: gnomadGetVariant.errors });
    const input = gnomadGetVariant.input.parse({ variants: ['rs11591147'] });
    const result = await gnomadGetVariant.handler(input, ctx as never);

    expect(result.found).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
    expect(getVariant).toHaveBeenCalledWith('rs11591147', expect.anything(), expect.anything());
  });
});

interface GraphqlRequest {
  query: string;
  variables: Record<string, unknown>;
}

/** A fetch that stays pending until its signal aborts, as a stalled upstream does. */
function hang(init: RequestInit | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  });
}

interface FailureCase {
  candidates?: string[];
  fetches: number;
  id: string;
  reason: string;
  respond?: (request: GraphqlRequest, init: RequestInit | undefined) => Promise<Response>;
}

/** One case per reason a failed[] item can carry, each driven through the real service. */
const FAILURE_CASES: FailureCase[] = [
  { reason: 'invalid_variant_id', id: 'not-a-variant', fetches: 0 },
  {
    reason: 'variant_not_found',
    id: '1-1-A-T',
    fetches: 1,
    respond: async () =>
      Response.json({
        errors: [{ message: 'Variant not found' }],
        data: { variant: null, clinvar_variant: null },
      }),
  },
  { reason: 'mitochondrial_unsupported', id: 'M-3243-A-G', fetches: 0 },
  {
    reason: 'ambiguous_rsid',
    id: 'rs11591147',
    fetches: 2,
    candidates: ['1-55039974-G-T', '1-55039974-G-A'],
    respond: async ({ query }) =>
      query.includes('GnomadVariantSearch')
        ? Response.json({
            data: {
              variant_search: [{ variant_id: '1-55039974-G-T' }, { variant_id: '1-55039974-G-A' }],
            },
          })
        : Response.json({
            errors: [{ message: 'Multiple variants found, query using variant ID to select one.' }],
            data: { variant: null },
          }),
  },
  {
    reason: 'graphql_error',
    id: '1-100-A-T',
    fetches: 1,
    respond: async () =>
      Response.json({
        errors: [{ message: 'Invalid variant ID' }],
        data: { variant: null, clinvar_variant: null },
      }),
  },
  {
    reason: 'upstream_build_mismatch',
    id: '1-100-A-T',
    fetches: 1,
    respond: async () =>
      Response.json({
        data: { variant: minimalVariant('1-100-A-T', 'GRCh37'), clinvar_variant: null },
      }),
  },
  {
    reason: 'upstream_unavailable',
    id: '1-100-A-T',
    fetches: 4,
    respond: async () => new Response('Service Unavailable', { status: 503 }),
  },
  {
    reason: 'upstream_timeout',
    id: '1-100-A-T',
    fetches: 4,
    respond: (_request, init) => hang(init),
  },
  {
    reason: 'upstream_access',
    id: '1-100-A-T',
    fetches: 1,
    respond: async () => new Response('Forbidden', { status: 403 }),
  },
  {
    reason: 'invalid_upstream_response',
    id: '1-100-A-T',
    fetches: 4,
    respond: async () => new Response('PRIVATE_MALFORMED_RESPONSE'),
  },
];

describe('gnomad_get_variant failed[] reasons and recovery hints', () => {
  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/43
  it.each(FAILURE_CASES)(
    'carries $reason and its declared hint on both surfaces',
    async ({ reason, id, fetches, respond, candidates }) => {
      vi.useFakeTimers();
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
        if (!respond) throw new Error(`Unexpected fetch for ${id}`);
        return respond(JSON.parse(String(init?.body)) as GraphqlRequest, init);
      });
      initGnomadService({} as never, {} as never);

      const pending = runToolContract(gnomadGetVariant, { variants: [id], dataset: 'gnomad_r4' });
      for (let tick = 0; tick < 10; tick += 1) await vi.advanceTimersByTimeAsync(60_000);
      const result = await pending;

      expect(result.isError).toBeFalsy();
      const out = result.structuredContent as {
        found: unknown[];
        failed: Record<string, unknown>[];
      };
      const hint = declared(reason);
      expect(hint).toBeDefined();
      expect(out.found).toEqual([]);
      expect(out.failed).toEqual([
        {
          variant: id,
          error: expect.any(String),
          reason,
          recovery: hint,
          ...(candidates ? { candidates } : {}),
        },
      ]);
      const text = textOf(result.content);
      expect(text).toContain(id);
      expect(text).toContain(reason);
      expect(text).toContain(hint);
      for (const candidate of candidates ?? []) expect(text).toContain(candidate);
      expect(fetch).toHaveBeenCalledTimes(fetches);
    },
  );

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/43
  it('keeps found[] and every failed[] reason in input order across a mixed batch', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const { query, variables } = JSON.parse(String(init?.body)) as GraphqlRequest;
      if (query.includes('GnomadVariantByRsid')) {
        return Response.json({
          errors: [{ message: 'Variant not found' }],
          data: { variant: null },
        });
      }
      if (variables.variantId === '1-1-A-T') {
        return Response.json({
          errors: [{ message: 'Variant not found' }],
          data: { variant: null, clinvar_variant: null },
        });
      }
      if (variables.variantId === '1-2-A-T') {
        return Response.json({
          errors: [{ message: 'Invalid variant ID' }],
          data: { variant: null, clinvar_variant: null },
        });
      }
      return Response.json({
        data: { variant: minimalVariant(String(variables.variantId)), clinvar_variant: null },
      });
    });
    initGnomadService({} as never, {} as never);

    const result = await runToolContract(gnomadGetVariant, {
      variants: ['1-1-A-T', '1-100-A-T', 'bad', 'rs999999999999', '1-2-A-T', '2-200-C-G'],
      dataset: 'gnomad_r4',
    });

    const out = result.structuredContent as {
      found: { variant_id: string }[];
      failed: { variant: string; reason: string; recovery: string }[];
    };
    expect(out.found.map((record) => record.variant_id)).toEqual(['1-100-A-T', '2-200-C-G']);
    expect(out.failed.map((item) => [item.variant, item.reason])).toEqual([
      ['1-1-A-T', 'variant_not_found'],
      ['bad', 'invalid_variant_id'],
      ['rs999999999999', 'variant_not_found'],
      ['1-2-A-T', 'graphql_error'],
    ]);
    for (const item of out.failed) expect(item.recovery).toBe(declared(item.reason));
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/43
  it('declares exactly the reasons failed[] carries, plus the batch-level incoherent_build', () => {
    const itemReasons = FAILURE_CASES.map((failureCase) => failureCase.reason);
    const reasons = gnomadGetVariant.errors?.map((entry) => entry.reason) ?? [];

    expect([...reasons].sort()).toEqual([...itemReasons, 'incoherent_build'].sort());
    const failedItem = gnomadGetVariant.output.shape.failed.element;
    expect([...failedItem.shape.reason.options].sort()).toEqual([...itemReasons].sort());
    for (const entry of gnomadGetVariant.errors ?? []) {
      const ownRejection =
        entry.reason === 'invalid_variant_id' || entry.reason === 'variant_not_found';
      const thrownBy = 'thrownBy' in entry ? entry.thrownBy : undefined;
      expect(thrownBy).toBe(ownRejection ? undefined : 'service');
    }
  });
});

/** gnomad_r3 `in_silico_predictors` for three live variants, as gnomAD returns them. */
const R3_PREDICTORS: Record<string, { id: string; value: string }[]> = {
  '1-55039974-G-T': [
    { id: 'revel', value: '0.0280' },
    { id: 'cadd', value: '10.4' },
    { id: 'splice_ai', value: '0.00 (no_consequence)' },
    { id: 'primate_ai', value: '0.504' },
  ],
  '1-55051215-G-GA': [
    { id: 'cadd', value: '0.791' },
    { id: 'splice_ai', value: '0.0100 (acceptor_gain)' },
  ],
  '17-7661943-T-C': [
    { id: 'revel', value: '0.0770' },
    { id: 'cadd', value: '0.0210' },
  ],
};

describe('gnomad_get_variant in-silico annotations', () => {
  function fakeR3(): void {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const { variables } = JSON.parse(String(init?.body)) as GraphqlRequest;
      const variantId = String(variables.variantId);
      return Response.json({
        data: {
          variant: { ...minimalVariant(variantId), in_silico_predictors: R3_PREDICTORS[variantId] },
          clinvar_variant: null,
        },
      });
    });
    initGnomadService({} as never, {} as never);
  }

  type Found = { variant_id: string; in_silico: Record<string, unknown>[] }[];

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/36
  it('returns both gnomad_r3 records with the SpliceAI score and event split on both surfaces', async () => {
    fakeR3();

    const result = await runToolContract(gnomadGetVariant, {
      variants: ['1-55039974-G-T', '1-55051215-G-GA'],
      dataset: 'gnomad_r3',
    });

    expect(result.isError).toBeFalsy();
    const found = (result.structuredContent as { found: Found }).found;
    expect(found.map((variant) => variant.variant_id)).toEqual([
      '1-55039974-G-T',
      '1-55051215-G-GA',
    ]);
    expect(found[0]?.in_silico).toEqual([
      { id: 'revel', value: 0.028, annotation: null },
      { id: 'cadd', value: 10.4, annotation: null },
      { id: 'splice_ai', value: 0, annotation: 'no_consequence' },
      { id: 'primate_ai', value: 0.504, annotation: null },
    ]);
    expect(found[1]?.in_silico).toContainEqual({
      id: 'splice_ai',
      value: 0.01,
      annotation: 'acceptor_gain',
    });
    const text = textOf(result.content);
    expect(text).toContain(
      '**In-silico:** revel=0.028, cadd=10.4, splice_ai=0 (no_consequence), primate_ai=0.504',
    );
    expect(text).toContain('**In-silico:** cadd=0.791, splice_ai=0.01 (acceptor_gain)');
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/36
  it('keeps a variant without splice_ai when a batch mate carries one', async () => {
    fakeR3();

    const result = await runToolContract(gnomadGetVariant, {
      variants: ['17-7661943-T-C', '1-55039974-G-T'],
      dataset: 'gnomad_r3',
    });

    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as { found: Found; failed: unknown[] };
    expect(out.failed).toEqual([]);
    expect(out.found.map((variant) => variant.variant_id)).toEqual([
      '17-7661943-T-C',
      '1-55039974-G-T',
    ]);
    expect(out.found[0]?.in_silico).toEqual([
      { id: 'revel', value: 0.077, annotation: null },
      { id: 'cadd', value: 0.021, annotation: null },
    ]);
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/36
  it('renders a predictor with no number as n/a beside its raw text', () => {
    const text = textOf(
      gnomadGetVariant.format?.({
        found: [
          {
            ...record('1-100-A-T'),
            in_silico: [{ id: 'splice_ai', value: null, annotation: 'not scored' }],
          },
        ],
        failed: [],
        dataset: 'gnomad_r3',
        reference_genome: 'GRCh38',
      }) ?? [],
    );

    expect(text).toContain('**In-silico:** splice_ai=n/a (not scored)');
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/36
  it('names the predictor ids each dataset carries in the id description', () => {
    const inSilico = gnomadGetVariant.output.shape.found.element.shape.in_silico.element;
    const idDescription = inSilico.shape.id.description ?? '';

    for (const id of [
      'cadd',
      'revel_max',
      'spliceai_ds_max',
      'pangolin_largest_ds',
      'phylop',
      'sift_max',
      'polyphen_max',
      'revel',
      'splice_ai',
      'primate_ai',
    ]) {
      expect(idDescription).toContain(id);
    }
    expect(idDescription).toMatch(/gnomad_r2_1 and exac[^.]*none/);
  });
});
