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
import { getServerConfig, resetServerConfig } from '@/config/server-config.js';
import { gnomadGetVariant } from '@/mcp-server/tools/definitions/gnomad-get-variant.tool.js';
import * as serviceModule from '@/services/gnomad/gnomad-service.js';
import { GnomadService, initGnomadService } from '@/services/gnomad/gnomad-service.js';
import type { VariantRecord } from '@/services/gnomad/types.js';
import {
  CDKN2A_ARF_STOP_GAINED_R4,
  CDKN2A_STOP_GAINED_R4,
  CDKN2B_AS1_INTRON_R4,
  PCSK9_FRAMESHIFT_R2_1,
} from '../helpers/live-consequences.js';
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
    joint_populations: [],
    callsets: {
      exome: {
        ac: 10,
        an: 1000,
        af: 0.01,
        homozygote_count: 0,
        hemizygote_count: null,
        filters: [],
      },
      genome: null,
    },
    source: ['exome'],
    flags: [],
    qc_status: 'pass',
    consequence: 'missense_variant',
    transcript_id: 'ENST1',
    primary_transcript: null,
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
      liftoverCandidates: vi.fn(async () => new Map<string, string[]>()),
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
      liftoverCandidates: vi.fn(async () => new Map<string, string[]>()),
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
      liftoverCandidates: vi.fn(async () => new Map<string, string[]>()),
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
      joint_populations: [],
      callsets: { exome: null, genome: null },
      source: [],
      flags: [],
      qc_status: 'filtered',
      consequence: null,
      transcript_id: null,
      primary_transcript: null,
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
    // Missing af, clinvar, and primary transcript render as explicit unknowns, not fabricated values.
    expect(text).toContain('AF Not available');
    expect(text).toContain('ClinVar:** no entry');
    expect(text.split('\n')).toContain('**Primary transcript:** Not available');
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
    expect(getVariant).toHaveBeenCalledWith('rs11591147', expect.anything(), expect.anything(), {
      startedAt: expect.any(Number),
    });
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/58
  it('hands the absent IDs to one liftover lookup under the batch start and fails each lifted one as variant_not_found_other_build', async () => {
    const getVariant = vi.fn(
      async (id: string, _dsCtx: unknown, _ctx: unknown, _options: { startedAt: number }) =>
        id === '2-100-C-G' ? record(id) : null,
    );
    const liftoverCandidates = vi.fn(async () => new Map([['1-55039974-G-T', ['1-55505647-G-T']]]));
    const fake = {
      resolveDatasetContext: realService.resolveDatasetContext.bind(realService),
      getVariant,
      liftoverCandidates,
    };
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(fake as never);

    const result = await gnomadGetVariant.handler(
      gnomadGetVariant.input.parse({
        variants: ['chr1-55039974-g-t', 'rs999', '2-100-C-G', '1-55039975-A-C'],
        dataset: 'gnomad_r2_1',
      }),
      createMockContext({ errors: gnomadGetVariant.errors }) as never,
    );

    expect(liftoverCandidates).toHaveBeenCalledOnce();
    expect(liftoverCandidates).toHaveBeenCalledWith(
      ['1-55039974-G-T', 'rs999', '1-55039975-A-C'],
      { dataset: 'gnomad_r2_1', reference_genome: 'GRCh37' },
      expect.anything(),
      { startedAt: getVariant.mock.calls[0]?.[3]?.startedAt },
    );
    expect(result.found.map((v) => v.variant_id)).toEqual(['2-100-C-G']);
    expect(result.failed).toEqual([
      {
        variant: 'chr1-55039974-g-t',
        error:
          'Not found in gnomad_r2_1. Read as an ID on the other reference build, the same string lifts over to the GRCh37 ID in candidates.',
        reason: 'variant_not_found_other_build',
        recovery: declared('variant_not_found_other_build'),
        candidates: ['1-55505647-G-T'],
      },
      {
        variant: 'rs999',
        error: 'Not found in gnomad_r2_1.',
        reason: 'variant_not_found',
        recovery: declared('variant_not_found'),
      },
      {
        variant: '1-55039975-A-C',
        error: 'Not found in gnomad_r2_1.',
        reason: 'variant_not_found',
        recovery: declared('variant_not_found'),
      },
    ]);
    expect(result).toEqual(expect.schemaMatching(gnomadGetVariant.output));
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/58
  it('sends no liftover lookup when every ID is found', async () => {
    const liftoverCandidates = vi.fn(async () => new Map<string, string[]>());
    const fake = {
      resolveDatasetContext: realService.resolveDatasetContext.bind(realService),
      getVariant: vi.fn(async (id: string) => record(id)),
      liftoverCandidates,
    };
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(fake as never);

    const result = await gnomadGetVariant.handler(
      gnomadGetVariant.input.parse({ variants: ['1-100-A-T', 'rs1', 'not-a-variant'] }),
      createMockContext({ errors: gnomadGetVariant.errors }) as never,
    );

    expect(result.found).toHaveLength(2);
    expect(liftoverCandidates).not.toHaveBeenCalled();
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

/** gnomAD's reply to the variant document for an ID it does not hold. */
const VARIANT_NOT_FOUND = {
  errors: [{ message: 'Variant not found' }],
  data: { variant: null, clinvar_variant: null },
};

/** The live gnomAD liftover entry pairing GRCh37 1-55505647-G-T with GRCh38 1-55039974-G-T. */
const PCSK9_LIFTOVER = {
  source: { variant_id: '1-55505647-G-T' },
  liftover: { variant_id: '1-55039974-G-T' },
};

/** One case per reason a failed[] item can carry, each driven through the real service. */
const FAILURE_CASES: FailureCase[] = [
  { reason: 'invalid_variant_id', id: 'not-a-variant', fetches: 0 },
  {
    reason: 'variant_not_found',
    id: '1-1-A-T',
    fetches: 2,
    respond: async ({ query }) =>
      Response.json(query.includes('GnomadLiftover') ? { data: { l0: [] } } : VARIANT_NOT_FOUND),
  },
  {
    reason: 'variant_not_found_other_build',
    id: '1-55505647-G-T',
    fetches: 2,
    candidates: ['1-55039974-G-T'],
    respond: async ({ query }) =>
      Response.json(
        query.includes('GnomadLiftover') ? { data: { l0: [PCSK9_LIFTOVER] } } : VARIANT_NOT_FOUND,
      ),
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
    fetches: 2,
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
      if (query.includes('GnomadLiftover')) return Response.json({ data: { l0: [] } });
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
        entry.reason === 'invalid_variant_id' ||
        entry.reason === 'variant_not_found' ||
        entry.reason === 'variant_not_found_other_build';
      const thrownBy = 'thrownBy' in entry ? entry.thrownBy : undefined;
      expect(thrownBy).toBe(ownRejection ? undefined : 'service');
    }
  });
});

describe('gnomad_get_variant ClinVar side lookups in a batch', () => {
  const GNOMAD_ORIGIN = new URL(getServerConfig().gnomadApiBaseUrl).origin;
  const clinvarEntry = {
    clinical_significance: 'Likely benign',
    review_status: 'criteria provided, single submitter',
    gold_stars: 1,
    clinvar_variation_id: '1234',
  };

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/44
  it('degrades only the items whose ClinVar lookup stalls, and settles at the lookup budget', async () => {
    vi.useFakeTimers();
    const operations: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url).origin !== GNOMAD_ORIGIN) throw new Error(`Unmocked fetch to ${url}`);
      const { query, variables } = JSON.parse(String(init?.body)) as GraphqlRequest;
      const operation = /query\s+(\w+)/.exec(query)?.[1] ?? 'anonymous';
      operations.push(operation);
      const id = String(variables.variantId);
      switch (operation) {
        case 'GnomadVariant':
          if (id === '1-400-A-T') {
            return Response.json({
              errors: [{ message: 'Variant not found' }],
              data: { variant: null, clinvar_variant: null },
            });
          }
          if (id === '1-200-A-T') {
            return Response.json({
              errors: [{ message: 'Invalid variant ID' }],
              data: { variant: minimalVariant(id), clinvar_variant: null },
            });
          }
          return Response.json({
            data: {
              variant: minimalVariant(id),
              clinvar_variant: id === '1-100-A-T' ? clinvarEntry : null,
            },
          });
        case 'GnomadVariantOnly':
          return Response.json({ data: { variant: minimalVariant(id) } });
        case 'GnomadVariantByRsid':
          return Response.json({ data: { variant: minimalVariant('3-300-A-T') } });
        case 'GnomadClinvar':
          return hang(init);
        default:
          throw new Error(`Unmocked gnomAD operation ${operation}`);
      }
    });
    initGnomadService({} as never, {} as never);

    let result: Awaited<ReturnType<typeof runToolContract>> | undefined;
    void runToolContract(gnomadGetVariant, {
      variants: ['1-100-A-T', '1-200-A-T', 'rs300', '1-400-A-T', '1-500-A-T'],
      dataset: 'gnomad_r4',
    }).then((settled) => {
      result = settled;
    });
    await vi.advanceTimersByTimeAsync(serviceModule.CLINVAR_LOOKUP_BUDGET_MS - 1);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(result?.isError).toBeFalsy();
    const out = result?.structuredContent as {
      found: { variant_id: string; clinvar: unknown; clinvar_unavailable: boolean }[];
      failed: { variant: string; reason: string }[];
      notice?: string;
    };
    expect(out.found.map((v) => [v.variant_id, v.clinvar, v.clinvar_unavailable])).toEqual([
      ['1-100-A-T', clinvarEntry, false],
      ['1-200-A-T', null, true],
      ['3-300-A-T', null, true],
      ['1-500-A-T', null, false],
    ]);
    expect(out.failed.map((item) => [item.variant, item.reason])).toEqual([
      ['1-400-A-T', 'variant_not_found'],
    ]);
    expect(out.notice).toBe(
      'ClinVar annotation was unavailable for: 1-200-A-T, 3-300-A-T. Population data is complete.',
    );
    const text = textOf(result?.content ?? []);
    const section = (id: string) =>
      text.slice(text.indexOf(`**Variant:** ${id}`)).split('\n**Variant:** ')[0] ?? '';
    expect(section('1-100-A-T')).toContain('**ClinVar:** Likely benign | stars 1');
    expect(section('1-200-A-T')).toContain('**ClinVar:** unavailable');
    expect(section('3-300-A-T')).toContain('**ClinVar:** unavailable');
    expect(section('1-500-A-T')).toContain('**ClinVar:** no entry');
    expect(text).toContain('ClinVar annotation was unavailable for: 1-200-A-T, 3-300-A-T.');
    expect([...operations].sort()).toEqual(
      [
        ...Array(4).fill('GnomadVariant'),
        'GnomadVariantOnly',
        'GnomadVariantByRsid',
        ...Array(4).fill('GnomadClinvar'),
      ].sort(),
    );
  });
});

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/58
describe('gnomad_get_variant liftover hint for an absent coordinate ID', () => {
  /** Live gnomAD liftover entries (GRCh37 source → GRCh38 target), captured 2026-11-01. */
  const LIVE_LIFTOVER = [
    PCSK9_LIFTOVER,
    { source: { variant_id: '11-2181023-T-C' }, liftover: { variant_id: '11-2159793-T-C' } },
  ];
  const operationOf = (query: string) => /query\s+(\w+)/.exec(query)?.[1] ?? 'anonymous';

  /**
   * Fake gnomAD: the variant documents hold only the GRCh38 IDs in `found`, and
   * each liftover alias answers the live entries whose side named by the
   * document's argument matches its ID, as gnomAD's resolver filters them —
   * unless `liftover` answers the liftover request instead. Returns every
   * request sent.
   */
  function serveGnomad({
    found = [],
    liftover,
  }: {
    found?: string[];
    liftover?: (request: GraphqlRequest, init: RequestInit | undefined) => Promise<Response>;
  } = {}): GraphqlRequest[] {
    const requests: GraphqlRequest[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as GraphqlRequest;
      requests.push(request);
      const operation = operationOf(request.query);
      if (operation === 'GnomadLiftover') {
        if (liftover) return liftover(request, init);
        const side = request.query.includes('source_variant_id:') ? 'source' : 'liftover';
        const aliases = Object.entries(request.variables).filter(
          ([name]) => name !== 'referenceGenome',
        );
        return Response.json({
          data: Object.fromEntries(
            aliases.map(([name, id]) => [
              `l${name.slice(1)}`,
              LIVE_LIFTOVER.filter((entry) => entry[side].variant_id === id),
            ]),
          ),
        });
      }
      if (operation === 'GnomadVariantByRsid') {
        return Response.json({
          errors: [{ message: 'Variant not found' }],
          data: { variant: null },
        });
      }
      const id = String(request.variables.variantId);
      if (found.includes(id)) {
        return Response.json({ data: { variant: minimalVariant(id), clinvar_variant: null } });
      }
      return Response.json(VARIANT_NOT_FOUND);
    });
    initGnomadService({} as never, {} as never);
    return requests;
  }

  const liftoverRequests = (requests: GraphqlRequest[]) =>
    requests.filter((request) => operationOf(request.query) === 'GnomadLiftover');

  it.each([
    [
      'gnomad_r2_1',
      '1-55039974-G-T',
      '1-55039974-G-T',
      'liftover_variant_id',
      'GRCh38',
      '1-55505647-G-T',
    ],
    [
      'gnomad_r4',
      '1-55505647-G-T',
      '1-55505647-G-T',
      'source_variant_id',
      'GRCh37',
      '1-55039974-G-T',
    ],
    // A valid GRCh38 ID gnomAD lacks also lifts: the hint never asserts a build mismatch.
    [
      'gnomad_r4',
      '11-2181023-T-C',
      '11-2181023-T-C',
      'source_variant_id',
      'GRCh37',
      '11-2159793-T-C',
    ],
    [
      'gnomad_r2_1',
      'chr1-55039974-g-t',
      '1-55039974-G-T',
      'liftover_variant_id',
      'GRCh38',
      '1-55505647-G-T',
    ],
  ] as const)(
    'fails %s %s as variant_not_found_other_build with its lift onto the dataset build on both surfaces',
    async (dataset, input, sent, argument, idBuild, candidate) => {
      const requests = serveGnomad();

      const result = await runToolContract(gnomadGetVariant, { variants: [input], dataset });

      const out = result.structuredContent as { failed: { error: string; recovery: string }[] };
      const hint = declared('variant_not_found_other_build');
      expect(out.failed).toEqual([
        {
          variant: input,
          error: expect.any(String),
          reason: 'variant_not_found_other_build',
          recovery: hint,
          candidates: [candidate],
        },
      ]);
      for (const text of [out.failed[0]?.error, out.failed[0]?.recovery]) {
        expect(text).not.toMatch(/wrong|mismatch|incorrect/i);
      }
      const [lift] = liftoverRequests(requests);
      expect(liftoverRequests(requests)).toHaveLength(1);
      expect(lift?.query).toContain(
        `l0: liftover(${argument}: $v0, reference_genome: $referenceGenome)`,
      );
      expect(lift?.variables).toEqual({ v0: sent, referenceGenome: idBuild });
      const text = textOf(result.content);
      expect(text).toContain(`Candidates: ${candidate}`);
      expect(text).toContain('variant_not_found_other_build');
      expect(text).toContain(hint);
    },
  );

  it.each([
    ['gnomad_r2_1', '1-55039975-A-C'],
    ['gnomad_r4', '1-55505648-A-C'],
  ] as const)(
    'keeps %s %s variant_not_found, with the build check first, when nothing lifts',
    async (dataset, id) => {
      serveGnomad();

      const result = await runToolContract(gnomadGetVariant, { variants: [id], dataset });

      const recovery =
        "A coordinate ID carries no build, so confirm it is on the dataset's reference build, then run gnomad_get_coverage to check the position is callable before concluding true absence.";
      expect((result.structuredContent as { failed: unknown[] }).failed).toEqual([
        { variant: id, error: `Not found in ${dataset}.`, reason: 'variant_not_found', recovery },
      ]);
      expect(textOf(result.content)).toContain(recovery);
    },
  );

  it('sends one liftover request for every absent coordinate ID, never an rsID, and keeps input order', async () => {
    const requests = serveGnomad({ found: ['2-100-C-G'] });

    const result = await runToolContract(gnomadGetVariant, {
      variants: [
        '1-55505647-G-T',
        'rs999999999999',
        '2-100-C-G',
        '1-55505648-A-C',
        '11-2181023-T-C',
      ],
      dataset: 'gnomad_r4',
    });

    const out = result.structuredContent as {
      found: { variant_id: string }[];
      failed: { variant: string; reason: string; candidates?: string[] }[];
    };
    expect(out.found.map((record) => record.variant_id)).toEqual(['2-100-C-G']);
    expect(out.failed.map((item) => [item.variant, item.reason, item.candidates])).toEqual([
      ['1-55505647-G-T', 'variant_not_found_other_build', ['1-55039974-G-T']],
      ['rs999999999999', 'variant_not_found', undefined],
      ['1-55505648-A-C', 'variant_not_found', undefined],
      ['11-2181023-T-C', 'variant_not_found_other_build', ['11-2159793-T-C']],
    ]);
    expect(liftoverRequests(requests).map((request) => request.variables)).toEqual([
      {
        v0: '1-55505647-G-T',
        v1: '1-55505648-A-C',
        v2: '11-2181023-T-C',
        referenceGenome: 'GRCh37',
      },
    ]);
  });

  it.each([
    ['every ID is found', ['1-100-A-T', '2-100-C-G'], ['GnomadVariant', 'GnomadVariant']],
    ['the only absent ID is an rsID', ['rs999999999999'], ['GnomadVariantByRsid']],
  ])('sends no liftover request when %s', async (_label, variants, operations) => {
    const requests = serveGnomad({ found: ['1-100-A-T', '2-100-C-G'] });

    await runToolContract(gnomadGetVariant, { variants, dataset: 'gnomad_r4' });

    expect(requests.map((request) => operationOf(request.query))).toEqual(operations);
  });

  it('leaves plain variant_not_found and the rest of the batch when gnomAD rejects the liftover request', async () => {
    const requests = serveGnomad({
      found: ['2-100-C-G'],
      liftover: async () =>
        Response.json({ errors: [{ message: 'Unexpected liftover failure' }], data: null }),
    });

    const result = await runToolContract(gnomadGetVariant, {
      variants: ['1-55505647-G-T', '2-100-C-G'],
      dataset: 'gnomad_r4',
    });

    const out = result.structuredContent as {
      found: { variant_id: string }[];
      failed: { variant: string; reason: string; recovery: string }[];
    };
    expect(out.found.map((record) => record.variant_id)).toEqual(['2-100-C-G']);
    expect(out.failed).toEqual([
      {
        variant: '1-55505647-G-T',
        error: 'Not found in gnomad_r4.',
        reason: 'variant_not_found',
        recovery: declared('variant_not_found'),
      },
    ]);
    expect(liftoverRequests(requests)).toHaveLength(1);
  });

  it("rejects with the caller's reason when cancelled while the liftover request is in flight", async () => {
    const controller = new AbortController();
    const requests = serveGnomad({
      liftover: (_request, init) => {
        queueMicrotask(() => controller.abort(new Error('client cancelled')));
        return hang(init);
      },
    });

    await expect(
      gnomadGetVariant.handler(
        gnomadGetVariant.input.parse({ variants: ['1-55505647-G-T'], dataset: 'gnomad_r4' }),
        createMockContext({ errors: gnomadGetVariant.errors, signal: controller.signal }) as never,
      ),
    ).rejects.toThrow('client cancelled');
    expect(liftoverRequests(requests)).toHaveLength(1);
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

/** A gnomAD population row from [id, ac, an, homozygote_count, hemizygote_count]. */
function populationRow([id, ac, an, hom, hemi]: readonly [
  string,
  number,
  number,
  number,
  number | null,
]) {
  return { id, ac, an, homozygote_count: hom, hemizygote_count: hemi };
}

/** Serve one VariantDetails payload for every variant request, through the real service. */
function serveVariant(variant: Record<string, unknown>): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    Response.json({ data: { variant, clinvar_variant: null } }),
  );
  initGnomadService({} as never, {} as never);
}

/** The format() line for one population row. */
function populationLine(label: string, row: { ac: number; an: number; af: number | null }) {
  const af = row.af == null ? 'Not available' : `${row.af} (${row.af.toExponential(3)})`;
  return `- ${label}: AC ${row.ac} / AN ${row.an} | AF ${af} | hom 0 | hemi 0`;
}

describe('gnomad_get_variant oth ancestry group (#55)', () => {
  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/55
  it('carries the gnomad_r2_1 oth rows on both surfaces, without the sex-split and subgroup rows', async () => {
    // Rows of the live gnomad_r2_1 1-55505647-G-T record, captured 2026-11-01 (UTC).
    serveVariant({
      ...minimalVariant('1-55505647-G-T', 'GRCh37'),
      exome: {
        ac: 2341,
        an: 196220,
        af: 2341 / 196220,
        homozygote_count: 29,
        hemizygote_count: 0,
        populations: (
          [
            ['nfe', 1270, 84162, 9, 0],
            ['nfe_bgr', 10, 1564, 0, null],
            ['eas_jpn', 0, 80, 0, null],
            ['oth', 66, 5142, 0, 0],
            ['oth_XX', 31, 2488, 0, 0],
          ] as const
        ).map(populationRow),
      },
      genome: {
        ac: 441,
        an: 31400,
        af: 441 / 31400,
        homozygote_count: 8,
        hemizygote_count: 0,
        populations: (
          [
            ['oth', 16, 1086, 0, 0],
            ['oth_XY', 4, 526, 0, 0],
          ] as const
        ).map(populationRow),
      },
    });

    const result = await runToolContract(gnomadGetVariant, {
      variants: ['1-55505647-G-T'],
      dataset: 'gnomad_r2_1',
    });

    expect(result.isError).toBeFalsy();
    const [found] = (result.structuredContent as { found: VariantRecord[] }).found;
    expect(found?.populations.map(({ id, source }) => `${id}/${source}`)).toEqual([
      'nfe/exome',
      'oth/exome',
      'oth/genome',
    ]);
    const oth = found?.populations.filter((population) => population.id === 'oth') ?? [];
    expect(oth.map(({ ac, an }) => [ac, an])).toEqual([
      [66, 5142],
      [16, 1086],
    ]);
    const lines = textOf(result.content).split('\n');
    for (const row of oth) expect(lines).toContain(populationLine(`oth (${row.source})`, row));
  });
});

describe('gnomad_get_variant joint frequencies (#53)', () => {
  /** Rows of the live gnomad_r4 1-55039784-C-G record, captured 2026-11-01 (UTC). */
  function serveGenomeOnlyR4(): void {
    serveVariant({
      ...minimalVariant('1-55039784-C-G'),
      genome: {
        ac: 3,
        an: 152386,
        af: 3 / 152386,
        homozygote_count: 0,
        hemizygote_count: 0,
        populations: (
          [
            ['afr', 3, 41594, 0, 0],
            ['nfe', 0, 68042, 0, 0],
          ] as const
        ).map(populationRow),
      },
      joint: {
        ac: 3,
        an: 1558598,
        homozygote_count: 0,
        hemizygote_count: 0,
        populations: (
          [
            ['afr', 3, 74272, 0, 0],
            ['afr_XX', 1, 41020, 0, 0],
            ['nfe', 0, 1149718, 0, 0],
            ['', 3, 1558598, 0, 0],
            ['XX', 1, 788812, 0, 0],
            ['XY', 2, 769786, 0, 0],
            ['XX', 1, 788812, 0, 0],
          ] as const
        ).map(populationRow),
      },
    });
  }

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/53
  it('returns the joint overall counts and joint groups on both surfaces', async () => {
    serveGenomeOnlyR4();

    const result = await runToolContract(gnomadGetVariant, { variants: ['1-55039784-C-G'] });

    expect(result.isError).toBeFalsy();
    const [found] = (result.structuredContent as { found: VariantRecord[] }).found;
    expect(found).toMatchObject({ ac: 3, an: 1558598, af: 3 / 1558598, source: ['genome'] });
    expect(found?.populations.map(({ id, source, an }) => [id, source, an])).toEqual([
      ['afr', 'genome', 41594],
      ['nfe', 'genome', 68042],
    ]);
    expect(found?.joint_populations).toEqual([
      { id: 'afr', ac: 3, an: 74272, af: 3 / 74272, homozygote_count: 0, hemizygote_count: 0 },
      { id: 'nfe', ac: 0, an: 1149718, af: 0, homozygote_count: 0, hemizygote_count: 0 },
    ]);
    const text = textOf(result.content);
    expect(text).toContain(`**Overall:** AC 3 / AN 1558598 | AF ${3 / 1558598} (`);
    const lines = text.split('\n');
    const header = lines.indexOf('**Joint per-ancestry (exomes + genomes):**');
    expect(header).toBeGreaterThan(lines.indexOf('**Per-ancestry:**'));
    expect(lines.slice(header + 1, header + 3)).toEqual(
      (found?.joint_populations ?? []).map((row) => populationLine(row.id, row)),
    );
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/53
  it('renders no joint section for a record without joint groups', () => {
    const text = textOf(
      gnomadGetVariant.format?.({
        found: [record('1-100-A-T')],
        failed: [],
        dataset: 'gnomad_r3',
        reference_genome: 'GRCh38',
      }) ?? [],
    );

    expect(text).toContain('**Per-ancestry:**');
    expect(text).not.toContain('Joint per-ancestry');
  });

  it('describes the joint source and the callset-sum fallback on an', () => {
    const description = gnomadGetVariant.output.shape.found.element.shape.an.description ?? '';

    expect(description).toMatch(/joint/i);
    expect(description).toMatch(/sum/i);
  });
});

/** A callset record from its live totals and QC filters, population rows left out. */
function qcCallset(ac: number, an: number, hom: number, filters: string[]) {
  return {
    ac,
    an,
    af: ac / an,
    homozygote_count: hom,
    hemizygote_count: 0,
    filters,
    populations: [],
  };
}

/** Callset totals and filters of live gnomad_r4 records, captured 2026-11-01 (UTC). */
const QC_RECORDS: Record<string, Record<string, unknown>> = {
  '1-55039866-G-A': {
    ...minimalVariant('1-55039866-G-A'),
    exome: qcCallset(0, 1_410_978, 0, ['AC0']),
    genome: null,
    joint: { ...qcCallset(0, 1_562_614, 0, []), af: undefined },
  },
  '1-55039800-G-A': {
    ...minimalVariant('1-55039800-G-A'),
    exome: qcCallset(4, 1_415_942, 0, ['AS_VQSR']),
    genome: null,
    joint: { ...qcCallset(4, 1_568_302, 0, []), af: undefined },
  },
  '1-55039793-C-T': {
    ...minimalVariant('1-55039793-C-T'),
    exome: qcCallset(0, 1_412_788, 0, ['AC0']),
    genome: qcCallset(3, 152_276, 0, []),
    joint: { ...qcCallset(3, 1_565_064, 0, ['discrepant_frequencies']), af: undefined },
  },
  '1-55039974-G-T': {
    ...minimalVariant('1-55039974-G-T'),
    exome: qcCallset(21_634, 1_428_186, 209, []),
    genome: qcCallset(1_866, 152_404, 17, []),
    joint: { ...qcCallset(23_500, 1_580_590, 226, []), af: undefined },
  },
};

/** Serve each variant ID its own VariantDetails payload through the real service. */
function serveQcRecords(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const { variables } = JSON.parse(String(init?.body)) as { variables: { variantId: string } };
    return Response.json({
      data: { variant: QC_RECORDS[variables.variantId] ?? null, clinvar_variant: null },
    });
  });
  initGnomadService({} as never, {} as never);
}

describe('gnomad_get_variant QC status (#54)', () => {
  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/54
  it('keeps QC-failed variants in found[] with qc_status filtered and their callset filters on both surfaces', async () => {
    serveQcRecords();

    const result = await runToolContract(gnomadGetVariant, {
      variants: ['1-55039866-G-A', '1-55039800-G-A'],
    });

    expect(result.isError).toBeFalsy();
    const { found, failed } = result.structuredContent as {
      found: VariantRecord[];
      failed: unknown[];
    };
    expect(failed).toEqual([]);
    expect(found.map((v) => [v.variant_id, v.qc_status, v.callsets.exome?.filters])).toEqual([
      ['1-55039866-G-A', 'filtered', ['AC0']],
      ['1-55039800-G-A', 'filtered', ['AS_VQSR']],
    ]);
    expect(found.map((v) => v.callsets.genome)).toEqual([null, null]);
    const lines = textOf(result.content).split('\n');
    expect(lines.filter((line) => line === '**QC status:** filtered')).toHaveLength(2);
    expect(lines).toContain(
      '- exome: AC 0 / AN 1410978 | AF 0 (0.000e+0) | hom 0 | hemi 0 | filters AC0',
    );
    expect(lines).toContain(
      `- exome: AC 4 / AN 1415942 | AF ${4 / 1_415_942} (${(4 / 1_415_942).toExponential(3)}) | hom 0 | hemi 0 | filters AS_VQSR`,
    );
    expect(lines.some((line) => line.startsWith('- genome:'))).toBe(false);
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/54
  it('passes a variant filtered in exomes but passing in genomes, rendering both callsets', async () => {
    serveQcRecords();

    const result = await runToolContract(gnomadGetVariant, { variants: ['1-55039793-C-T'] });

    const [found] = (result.structuredContent as { found: VariantRecord[] }).found;
    expect(found?.qc_status).toBe('pass');
    expect(found?.callsets.exome?.filters).toEqual(['AC0']);
    expect(found?.callsets.genome?.filters).toEqual([]);
    const lines = textOf(result.content).split('\n');
    expect(lines).toContain('**QC status:** pass');
    expect(lines).toContain(
      `- genome: AC 3 / AN 152276 | AF ${3 / 152_276} (${(3 / 152_276).toExponential(3)}) | hom 0 | hemi 0 | filters none (passed)`,
    );
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/54
  it("reports each callset's own counts beside the joint overall counts", async () => {
    serveQcRecords();

    const result = await runToolContract(gnomadGetVariant, { variants: ['1-55039974-G-T'] });

    const [found] = (result.structuredContent as { found: VariantRecord[] }).found;
    expect(found).toMatchObject({ ac: 23_500, an: 1_580_590 });
    expect(found?.callsets.exome?.ac).toBe(21_634);
    expect(found?.callsets.genome?.an).toBe(152_404);
    expect(found?.callsets.genome?.af).toBe(1_866 / 152_404);
  });

  it('places callsets after joint_populations and qc_status after flags', async () => {
    serveQcRecords();

    const result = await runToolContract(gnomadGetVariant, { variants: ['1-55039974-G-T'] });

    const [found] = (result.structuredContent as { found: Record<string, unknown>[] }).found;
    const keys = Object.keys(found ?? {});
    expect(keys[keys.indexOf('joint_populations') + 1]).toBe('callsets');
    expect(keys[keys.indexOf('flags') + 1]).toBe('qc_status');
    // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/57
    expect(keys).toEqual([
      'variant_id',
      'rsids',
      'reference_genome',
      'dataset',
      'ac',
      'an',
      'af',
      'homozygote_count',
      'hemizygote_count',
      'populations',
      'joint_populations',
      'callsets',
      'source',
      'flags',
      'qc_status',
      'consequence',
      'transcript_id',
      'primary_transcript',
      'gene_symbol',
      'in_silico',
      'clinvar',
      'clinvar_unavailable',
    ]);
  });

  it('renders a callset with no filter list as not reported', () => {
    const unproven: VariantRecord = {
      ...record('1-100-A-T'),
      callsets: {
        exome: {
          ac: 10,
          an: 1000,
          af: 0.01,
          homozygote_count: 0,
          hemizygote_count: null,
          filters: null,
        },
        genome: null,
      },
      qc_status: 'filtered',
    };

    const text = textOf(
      gnomadGetVariant.format?.({
        found: [unproven],
        failed: [],
        dataset: 'gnomad_r4',
        reference_genome: 'GRCh38',
      }) ?? [],
    );

    expect(text.split('\n')).toContain(
      '- exome: AC 10 / AN 1000 | AF 0.01 (1.000e-2) | hom 0 | filters not reported',
    );
  });
});

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/57
describe('gnomad_get_variant primary transcript (#57)', () => {
  it('returns the MANE Select consequence beside the unchanged most severe one, on both surfaces', async () => {
    serveVariant({
      ...minimalVariant('9-21968220-C-A'),
      transcript_consequences: CDKN2A_STOP_GAINED_R4,
    });

    const result = await runToolContract(gnomadGetVariant, { variants: ['9-21968220-C-A'] });

    expect(result.isError).toBeFalsy();
    const [found] = (result.structuredContent as { found: VariantRecord[] }).found;
    expect(found).toMatchObject({
      consequence: 'stop_gained',
      transcript_id: 'ENST00000579122',
      gene_symbol: 'CDKN2A',
    });
    expect(found?.primary_transcript).toEqual({
      transcript_id: 'ENST00000304494',
      is_mane_select: true,
      consequence: '3_prime_UTR_variant',
      hgvsc: 'c.*9G>T',
      hgvsp: null,
      lof: null,
    });
    const lines = textOf(result.content).split('\n');
    expect(lines).toContain('**Gene:** CDKN2A | **Consequence:** stop_gained');
    expect(lines).toContain(
      '**Primary transcript:** ENST00000304494 | MANE Select yes | consequence 3_prime_UTR_variant | HGVSc c.\\*9G>T | HGVSp none | LoF none',
    );
  });

  it('renders a GRCh37 canonical entry with no MANE status on both surfaces', async () => {
    serveVariant({
      ...minimalVariant('1-55516888-G-GA', 'GRCh37'),
      transcript_consequences: PCSK9_FRAMESHIFT_R2_1,
    });

    const result = await runToolContract(gnomadGetVariant, {
      variants: ['1-55516888-G-GA'],
      dataset: 'gnomad_r2_1',
    });

    const [found] = (result.structuredContent as { found: VariantRecord[] }).found;
    expect(found?.transcript_id).toBe('ENST00000452118');
    expect(found?.primary_transcript).toMatchObject({
      transcript_id: 'ENST00000302118',
      is_mane_select: null,
      consequence: 'intron_variant',
    });
    expect(textOf(result.content).split('\n')).toContain(
      '**Primary transcript:** ENST00000302118 | MANE Select not reported | consequence intron_variant | HGVSc c.524-1063_524-1062insA | HGVSp none | LoF none',
    );
  });

  it('renders a canonical fallback on a GRCh38 gene as not MANE Select, with its HGVSp and LoF call', () => {
    const text = textOf(
      gnomadGetVariant.format?.({
        found: [
          {
            ...record('1-100-A-T'),
            primary_transcript: {
              transcript_id: 'ENST2',
              is_mane_select: false,
              consequence: 'stop_gained',
              hgvsc: 'c.10C>T',
              hgvsp: 'p.Gln4Ter',
              lof: 'HC',
            },
          },
        ],
        failed: [],
        dataset: 'gnomad_r4',
        reference_genome: 'GRCh38',
      }) ?? [],
    );

    expect(text.split('\n')).toContain(
      '**Primary transcript:** ENST2 | MANE Select no | consequence stop_gained | HGVSc c.10C>T | HGVSp p.Gln4Ter | LoF HC',
    );
  });

  it('describes each consequence field by the term it names', () => {
    const shape = gnomadGetVariant.output.shape.found.element.shape;

    expect(shape.consequence.description).toMatch(/most severe/i);
    expect(shape.transcript_id.description).toMatch(/not necessarily/);
    expect(shape.primary_transcript.description).toMatch(
      /MANE Select entry, else its canonical entry/,
    );
  });

  it('marks a variant outside the gene’s MANE Select and canonical transcripts, on both surfaces', async () => {
    serveVariant({
      ...minimalVariant('9-21994160-G-A'),
      transcript_consequences: CDKN2A_ARF_STOP_GAINED_R4,
    });

    const result = await runToolContract(gnomadGetVariant, { variants: ['9-21994160-G-A'] });

    const [found] = (result.structuredContent as { found: VariantRecord[] }).found;
    expect(found).toMatchObject({
      consequence: 'stop_gained',
      gene_symbol: 'CDKN2A',
      primary_transcript: null,
    });
    expect(textOf(result.content).split('\n')).toContain(
      "**Primary transcript:** none — gnomAD lists no consequence on CDKN2A's MANE Select or canonical transcript",
    );
    expect(
      gnomadGetVariant.output.shape.found.element.shape.primary_transcript.description,
    ).toMatch(/outside/);
  });

  it('reports no MANE status for a GRCh38 gene without a MANE Select, as described', async () => {
    serveVariant({
      ...minimalVariant('9-22050002-T-A'),
      transcript_consequences: CDKN2B_AS1_INTRON_R4,
    });

    const result = await runToolContract(gnomadGetVariant, { variants: ['9-22050002-T-A'] });

    const [found] = (result.structuredContent as { found: VariantRecord[] }).found;
    expect(found?.primary_transcript).toMatchObject({
      transcript_id: 'ENST00000650946',
      is_mane_select: null,
    });
    expect(
      gnomadGetVariant.output.shape.found.element.shape.primary_transcript.unwrap().shape
        .is_mane_select.description,
    ).toMatch(/gene without a MANE Select/);
  });
});

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/62
describe('gnomad_get_variant identifier normalization (#62)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetServerConfig();
  });

  /** Answer every gnomAD request with a found variant for whatever ID it names; returns the requests. */
  function serveFound(): { query: string; variables: Record<string, unknown> }[] {
    const requests: { query: string; variables: Record<string, unknown> }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      requests.push(request);
      if (request.query.includes('GnomadClinvar')) {
        return Response.json({ data: { clinvar_variant: null } });
      }
      const id = String(request.variables.variantId ?? '1-55039974-G-T');
      return Response.json({ data: { variant: minimalVariant(id), clinvar_variant: null } });
    });
    initGnomadService({} as never, {} as never);
    return requests;
  }

  it('sends an uppercase rsID to gnomAD lowercased', async () => {
    const requests = serveFound();

    const result = await runToolContract(gnomadGetVariant, { variants: ['RS505151'] });

    expect(result.isError).toBeFalsy();
    expect(requests[0]?.variables).toEqual({ rsid: 'rs505151', dataset: 'gnomad_r4' });
  });

  it.each([
    ['1:55039974:G:T', '1-55039974-G-T'],
    ['chr1:55039974:G:T', '1-55039974-G-T'],
    ['X:100:a:g', 'X-100-A-G'],
  ])('sends colon form %s to gnomAD as %s', async (variant, canonical) => {
    const requests = serveFound();

    const result = await runToolContract(gnomadGetVariant, { variants: [variant] });

    expect(result.isError).toBeFalsy();
    expect(requests[0]?.variables).toMatchObject({ variantId: canonical });
    expect((result.structuredContent as { found: VariantRecord[] }).found).toHaveLength(1);
  });

  it('keeps the caller’s colon spelling in failed[] when the variant is absent', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) =>
      Response.json(
        String(init?.body).includes('GnomadLiftover') ? { data: { l0: [] } } : VARIANT_NOT_FOUND,
      ),
    );
    initGnomadService({} as never, {} as never);

    const result = await runToolContract(gnomadGetVariant, { variants: ['1:55039974:G:T'] });

    expect(result.structuredContent).toMatchObject({
      found: [],
      failed: [{ variant: '1:55039974:G:T', reason: 'variant_not_found' }],
    });
    expect(textOf(result.content)).toContain('1:55039974:G:T');
  });

  it('refuses MT:3243:A:G as mitochondrial_unsupported without a fetch', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    initGnomadService({} as never, {} as never);

    const result = await runToolContract(gnomadGetVariant, { variants: ['MT:3243:A:G'] });

    expect(result.structuredContent).toMatchObject({
      failed: [{ variant: 'MT:3243:A:G', reason: 'mitochondrial_unsupported' }],
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['1_100_A_T', '1:100-A-T', ' 1:100:A:T', '1:100:A:T ', '1:100:A'])(
    'keeps %j an invalid_variant_id with no fetch',
    async (variant) => {
      const fetch = vi.spyOn(globalThis, 'fetch');
      initGnomadService({} as never, {} as never);

      const result = await runToolContract(gnomadGetVariant, { variants: [variant] });

      expect(result.structuredContent).toMatchObject({
        failed: [{ variant, reason: 'invalid_variant_id' }],
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  describe('with GNOMAD_NORMALIZE_IDS=false', () => {
    it('fails a colon form as invalid_variant_id with no fetch', async () => {
      vi.stubEnv('GNOMAD_NORMALIZE_IDS', 'false');
      resetServerConfig();
      const fetch = vi.spyOn(globalThis, 'fetch');
      initGnomadService({} as never, {} as never);

      const result = await runToolContract(gnomadGetVariant, { variants: ['1:55039974:G:T'] });

      expect(result.structuredContent).toMatchObject({
        failed: [{ variant: '1:55039974:G:T', reason: 'invalid_variant_id' }],
      });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('sends an uppercase rsID to gnomAD as written', async () => {
      vi.stubEnv('GNOMAD_NORMALIZE_IDS', 'false');
      resetServerConfig();
      const requests = serveFound();

      await runToolContract(gnomadGetVariant, { variants: ['RS505151'] });

      expect(requests[0]?.variables).toEqual({ rsid: 'RS505151', dataset: 'gnomad_r4' });
    });
  });
});
