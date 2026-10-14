/**
 * @fileoverview Correct-behavior regressions for unresolved genetics
 * correctness defects. Each regression retains its public issue link so the
 * implementation contract stays traceable.
 * @module tests/integration/unresolved-correctness.integration.test
 */

import { readFileSync } from 'node:fs';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { gnomadGetVariant } from '@/mcp-server/tools/definitions/gnomad-get-variant.tool.js';
import { ClinVarService } from '@/services/clinvar/clinvar-service.js';
import { GnomadService, initGnomadService } from '@/services/gnomad/gnomad-service.js';

interface GraphqlRequest {
  query: string;
  variables: Record<string, unknown>;
}

function variant(variantId: string, referenceGenome = 'GRCh38') {
  return {
    variant_id: variantId,
    reference_genome: referenceGenome,
    rsids: null,
    flags: null,
    exome: {
      ac: 1,
      an: 1_000,
      af: 0.001,
      homozygote_count: 0,
      hemizygote_count: null,
      populations: null,
    },
    genome: null,
    transcript_consequences: null,
    in_silico_predictors: null,
  };
}

const GNOMAD_ORIGIN = new URL(getServerConfig().gnomadApiBaseUrl).origin;

/** The GraphQL operation name a request document declares (`query GnomadClinvar(…)` → `GnomadClinvar`). */
function operationOf(request: GraphqlRequest): string {
  return /query\s+(\w+)/.exec(request.query)?.[1] ?? 'anonymous';
}

/** Fake gnomAD's GraphQL API; any request to another origin throws rather than reaching the network. */
function fakeGraphql(responder: (request: GraphqlRequest) => unknown): {
  requests: GraphqlRequest[];
  fetch: ReturnType<typeof vi.spyOn>;
} {
  const requests: GraphqlRequest[] = [];
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).origin !== GNOMAD_ORIGIN) throw new Error(`Unmocked fetch to ${url}`);
    const request = JSON.parse(typeof init?.body === 'string' ? init.body : '') as GraphqlRequest;
    requests.push(request);
    return new Response(JSON.stringify(responder(request)));
  });
  return { requests, fetch };
}

/**
 * Answer each gnomAD operation from its own route; an operation without a route
 * throws, so a request the code under test should not send fails the test.
 */
function fakeOperations(routes: Record<string, (request: GraphqlRequest) => unknown>) {
  const fake = fakeGraphql((request) => {
    const route = routes[operationOf(request)];
    if (!route) throw new Error(`Unmocked gnomAD operation ${operationOf(request)}`);
    return route(request);
  });
  return { ...fake, operations: () => fake.requests.map(operationOf) };
}

async function rejectAfterRetries(operation: () => Promise<unknown>): Promise<unknown> {
  const settled = operation().then(
    (value) => value,
    (error: unknown) => error,
  );
  for (let index = 0; index < 10; index += 1) {
    await vi.advanceTimersByTimeAsync(60_000);
  }
  return settled;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('upstream build integrity', () => {
  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/16
  it('rejects a variant payload labeled for a different reference build', async () => {
    fakeGraphql(({ variables }) => ({
      data: {
        variant: variant(String(variables.variantId), 'GRCh37'),
        clinvar_variant: null,
      },
    }));
    const svc = new GnomadService(getServerConfig());

    await expect(
      svc.getVariant(
        '1-100-A-T',
        svc.resolveDatasetContext('gnomad_r4', 'GRCh38'),
        createMockContext(),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'upstream_build_mismatch' },
    });
  });
});

describe('variant identifier normalization', () => {
  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/17
  it('accepts a chr-prefixed coordinate identifier', async () => {
    const { fetch } = fakeGraphql(({ variables }) => ({
      data: { variant: variant(String(variables.variantId)), clinvar_variant: null },
    }));
    initGnomadService({} as never, {} as never);

    const result = await gnomadGetVariant.handler(
      gnomadGetVariant.input.parse({ variants: ['chr1-100-A-T'] }),
      createMockContext({ errors: gnomadGetVariant.errors }),
    );

    expect(result.failed).toEqual([]);
    expect(result.found).toHaveLength(1);
    expect(fetch).toHaveBeenCalledOnce();
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/17
  it('rejects impossible chromosome and zero-position coordinates before fetch', async () => {
    const { fetch } = fakeGraphql(({ variables }) => ({
      data: { variant: variant(String(variables.variantId)), clinvar_variant: null },
    }));
    initGnomadService({} as never, {} as never);
    const ids = ['1-0-A-T', '0-100-A-T', '23-100-A-T', '99-100-A-T'];

    const result = await gnomadGetVariant.handler(
      gnomadGetVariant.input.parse({ variants: ids }),
      createMockContext({ errors: gnomadGetVariant.errors }),
    );

    expect(result.found).toEqual([]);
    expect(result.failed.map((failure) => failure.variant)).toEqual(ids);
    expect(fetch).not.toHaveBeenCalled();
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/17
  it('canonicalizes chr prefixes and allele case before upstream lookup', async () => {
    const { requests } = fakeGraphql(({ variables }) => ({
      data: { variant: variant(String(variables.variantId)), clinvar_variant: null },
    }));
    initGnomadService({} as never, {} as never);

    await gnomadGetVariant.handler(
      gnomadGetVariant.input.parse({ variants: ['chr1-55051215-g-ga', 'CHR1-55051215-G-GA'] }),
      createMockContext({ errors: gnomadGetVariant.errors }),
    );

    expect(requests.map((request) => request.variables.variantId)).toEqual([
      '1-55051215-G-GA',
      '1-55051215-G-GA',
    ]);
  });
});

describe('constraint metric ranges', () => {
  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/18
  it('rejects out-of-range pLI and negative observed/expected ratios', async () => {
    fakeGraphql(() => ({
      data: {
        gene: {
          gene_id: 'ENSG00000169174',
          symbol: 'PCSK9',
          gnomad_constraint: {
            pli: 1.2,
            oe_lof: -0.1,
            oe_lof_lower: -0.2,
            oe_lof_upper: -0.05,
            oe_mis: -1,
            oe_syn: -1,
            lof_z: 0,
            mis_z: 0,
            syn_z: 0,
            obs_lof: -1,
            exp_lof: -1,
            obs_mis: -1,
            exp_mis: -1,
            obs_syn: -1,
            exp_syn: -1,
            flags: [],
          },
          exac_constraint: null,
        },
      },
    }));
    const svc = new GnomadService(getServerConfig());

    await expect(
      svc.getGeneConstraint('PCSK9', svc.resolveDatasetContext('gnomad_r4'), createMockContext()),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/18
  it.each([false, 0, ''])(
    'rejects a falsy malformed constraint payload: %j',
    async (constraint) => {
      fakeGraphql(() => ({
        data: {
          gene: {
            gene_id: 'ENSG00000169174',
            symbol: 'PCSK9',
            gnomad_constraint: constraint,
            exac_constraint: null,
          },
        },
      }));
      const svc = new GnomadService(getServerConfig());

      await expect(
        svc.getGeneConstraint('PCSK9', svc.resolveDatasetContext('gnomad_r4'), createMockContext()),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_constraint_data' },
      });
    },
  );

  /** A plausible ExAC constraint object with some fields overridden. */
  function exacConstraint(override: Record<string, unknown>) {
    return {
      pli: 0.912,
      lof_z: 3.5,
      mis_z: 1.4,
      syn_z: -0.04,
      obs_lof: 2,
      exp_lof: 16.35,
      obs_mis: 125,
      exp_mis: 160.7,
      obs_syn: 67,
      exp_syn: 66.4,
      ...override,
    };
  }

  function fakeExac(exac_constraint: unknown): void {
    fakeGraphql(() => ({
      data: {
        gene: {
          gene_id: 'ENSG00000141510',
          symbol: 'TP53',
          gnomad_constraint: null,
          exac_constraint,
        },
      },
    }));
  }

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/26
  it.each([
    ['pLI above 1', exacConstraint({ pli: 1.2 })],
    ['pLI below 0', exacConstraint({ pli: -0.1 })],
    ['a negative observed count', exacConstraint({ obs_lof: -1 })],
    ['a negative expected count', exacConstraint({ exp_syn: -0.5 })],
    ['a non-numeric Z-score', exacConstraint({ mis_z: 'high' })],
    ['a falsy non-object payload', false],
  ])('rejects ExAC constraint with %s as invalid_constraint_data', async (_label, payload) => {
    fakeExac(payload);
    const svc = new GnomadService(getServerConfig());

    await expect(
      svc.getGeneConstraint('TP53', svc.resolveDatasetContext('exac'), createMockContext()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_constraint_data' },
    });
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/26
  it('keeps signed ExAC Z-scores and the pLI bounds themselves', async () => {
    fakeExac(exacConstraint({ pli: 1, lof_z: -2.5, mis_z: -18.5, syn_z: 0, obs_lof: 0 }));
    const svc = new GnomadService(getServerConfig());

    await expect(
      svc.getGeneConstraint('TP53', svc.resolveDatasetContext('exac'), createMockContext()),
    ).resolves.toMatchObject({ pli: 1, lof_z: -2.5, mis_z: -18.5, syn_z: 0, obs_lof: 0 });
  });
});

describe('GraphQL error and partial-data contracts', () => {
  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/19
  it('classifies malformed 2xx JSON as a clean upstream response error', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response('PRIVATE_MALFORMED_RESPONSE'),
    );
    const svc = new GnomadService(getServerConfig());

    const error = await rejectAfterRetries(() =>
      svc.getVariant('1-100-A-T', svc.resolveDatasetContext('gnomad_r4'), createMockContext()),
    );

    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'invalid_upstream_response', retryable: true },
    });
    expect(JSON.stringify(error)).not.toContain('PRIVATE_MALFORMED_RESPONSE');
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/19
  it('classifies a malformed gnomAD schema payload without leaking response fields', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ data: { variant: { private_upstream_field: 'DO_NOT_LEAK' } } }),
        ),
    );
    const svc = new GnomadService(getServerConfig());

    const error = await rejectAfterRetries(() =>
      svc.getVariant('1-100-A-T', svc.resolveDatasetContext('gnomad_r4'), createMockContext()),
    );

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'invalid_upstream_response', retryable: true },
    });
    expect(JSON.stringify(error)).not.toContain('DO_NOT_LEAK');
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/19
  it('classifies malformed ClinVar 2xx JSON without leaking the response body', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response('PRIVATE_MALFORMED_RESPONSE'),
    );
    const svc = new ClinVarService(getServerConfig());

    const error = await rejectAfterRetries(() => svc.searchGene('PCSK9', {}, createMockContext()));

    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'invalid_upstream_response', retryable: true },
    });
    expect(JSON.stringify(error)).not.toContain('PRIVATE_MALFORMED_RESPONSE');
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/20
  it('returns usable variant data when only the optional ClinVar join errors', async () => {
    const { operations } = fakeOperations({
      GnomadVariant: ({ variables }) => ({
        errors: [{ message: 'ClinVar resolver temporarily unavailable' }],
        data: { variant: variant(String(variables.variantId)), clinvar_variant: null },
      }),
      GnomadVariantOnly: ({ variables }) => ({
        data: { variant: variant(String(variables.variantId)) },
      }),
      GnomadClinvar: () => ({
        errors: [{ message: 'ClinVar resolver temporarily unavailable' }],
        data: { clinvar_variant: null },
      }),
    });
    const svc = new GnomadService(getServerConfig());

    const result = await svc.getVariant(
      '1-100-A-T',
      svc.resolveDatasetContext('gnomad_r4'),
      createMockContext(),
    );

    expect(result).toMatchObject({
      variant_id: '1-100-A-T',
      clinvar: null,
      clinvar_unavailable: true,
    });
    expect(operations()).toEqual(['GnomadVariant', 'GnomadVariantOnly', 'GnomadClinvar']);
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/20
  it.each(['resolver failed', 'ClinVar variant not found'])(
    'keeps a variant-root failure fatal when the variant-only reply repeats "%s"',
    async (message) => {
      const failing = ({ variables }: GraphqlRequest) => ({
        errors: [{ message }],
        data: { variant: variant(String(variables.variantId)), clinvar_variant: null },
      });
      const { operations } = fakeOperations({
        GnomadVariant: failing,
        GnomadVariantOnly: failing,
      });
      const svc = new GnomadService(getServerConfig());

      await expect(
        svc.getVariant('1-100-A-T', svc.resolveDatasetContext('gnomad_r4'), createMockContext()),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'graphql_error' },
      });
      expect(operations()).toEqual(['GnomadVariant', 'GnomadVariantOnly']);
    },
  );
});

describe('ClinVar attribution by request', () => {
  /** gnomAD's live reply to the combined document when only its ClinVar resolver fails: no `path`. */
  const live = JSON.parse(
    readFileSync(
      new URL('../fixtures/gnomad-variant-clinvar-error.live.json', import.meta.url),
      'utf8',
    ),
  ) as {
    errors: { message: string }[];
    data: { variant: ReturnType<typeof variant>; clinvar_variant: null };
  };
  const LIVE_ID = '1-55051215-G-GA';
  const clinvarEntry = {
    clinical_significance: 'Pathogenic',
    review_status: 'criteria provided, single submitter',
    gold_stars: 1,
    clinvar_variation_id: '440395',
  };
  const lookup = (id: string, ctx = createMockContext()) => {
    const svc = new GnomadService(getServerConfig());
    return svc.getVariant(id, svc.resolveDatasetContext('gnomad_r4'), ctx);
  };

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/44
  it('keeps a clean combined reply to one request', async () => {
    const { operations } = fakeOperations({
      GnomadVariant: () => ({
        data: { variant: live.data.variant, clinvar_variant: clinvarEntry },
      }),
    });

    const result = await lookup(LIVE_ID);

    expect(result).toMatchObject({
      variant_id: LIVE_ID,
      rsids: ['rs527413419'],
      clinvar: clinvarEntry,
      clinvar_unavailable: false,
    });
    expect(operations()).toEqual(['GnomadVariant']);
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/44
  it('keeps the record when the live pathless ClinVar error recurs on the ClinVar-only request', async () => {
    expect(live.errors).toEqual([{ message: 'Invalid variant ID' }]);
    const { requests, operations } = fakeOperations({
      GnomadVariant: () => live,
      GnomadVariantOnly: () => ({ data: { variant: live.data.variant } }),
      GnomadClinvar: () => ({ errors: live.errors, data: { clinvar_variant: null } }),
    });

    const result = await lookup(LIVE_ID);

    expect(result).toMatchObject({
      variant_id: LIVE_ID,
      rsids: ['rs527413419'],
      clinvar: null,
      clinvar_unavailable: true,
    });
    expect(result?.ac).toBeGreaterThan(0);
    expect(operations()).toEqual(['GnomadVariant', 'GnomadVariantOnly', 'GnomadClinvar']);
    expect(requests.map((request) => request.variables)).toEqual([
      { variantId: LIVE_ID, dataset: 'gnomad_r4', referenceGenome: 'GRCh38' },
      { variantId: LIVE_ID, dataset: 'gnomad_r4' },
      { variantId: LIVE_ID, referenceGenome: 'GRCh38' },
    ]);
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/44
  it('takes the record from the split replies when both come back clean', async () => {
    const { operations } = fakeOperations({
      GnomadVariant: () => ({
        errors: live.errors,
        data: { variant: { ...variant(LIVE_ID), flags: ['from_combined'] }, clinvar_variant: null },
      }),
      GnomadVariantOnly: () => ({
        data: { variant: { ...variant(LIVE_ID), flags: ['from_split'] } },
      }),
      GnomadClinvar: () => ({ data: { clinvar_variant: clinvarEntry } }),
    });

    const result = await lookup(LIVE_ID);

    expect(result).toMatchObject({
      variant_id: LIVE_ID,
      flags: ['from_split'],
      clinvar: clinvarEntry,
      clinvar_unavailable: false,
    });
    expect(operations()).toEqual(['GnomadVariant', 'GnomadVariantOnly', 'GnomadClinvar']);
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/44
  it('splits without reading a combined reply whose variant came back nulled inside', async () => {
    const nulledInside = variant(LIVE_ID);
    const { operations } = fakeOperations({
      GnomadVariant: () => ({
        errors: [{ message: 'An unknown error occurred' }],
        data: {
          variant: { ...nulledInside, exome: { ...nulledInside.exome, populations: [null] } },
          clinvar_variant: null,
        },
      }),
      GnomadVariantOnly: () => ({ data: { variant: variant(LIVE_ID) } }),
      GnomadClinvar: () => ({ data: { clinvar_variant: clinvarEntry } }),
    });

    const result = await lookup(LIVE_ID);

    expect(result).toMatchObject({
      variant_id: LIVE_ID,
      clinvar: clinvarEntry,
      clinvar_unavailable: false,
    });
    expect(operations()).toEqual(['GnomadVariant', 'GnomadVariantOnly', 'GnomadClinvar']);
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/44
  it('splits instead of retrying the combined request when a transient error sits beside a populated variant', async () => {
    vi.useFakeTimers();
    const { operations } = fakeOperations({
      GnomadVariant: () => ({
        errors: [{ message: 'Service overloaded' }],
        data: { variant: variant(LIVE_ID), clinvar_variant: null },
      }),
      GnomadVariantOnly: () => ({ data: { variant: variant(LIVE_ID) } }),
      GnomadClinvar: () => ({ data: { clinvar_variant: null } }),
    });

    const result = await rejectAfterRetries(() => lookup(LIVE_ID));

    expect(result).toMatchObject({
      variant_id: LIVE_ID,
      clinvar: null,
      clinvar_unavailable: false,
    });
    expect(operations()).toEqual(['GnomadVariant', 'GnomadVariantOnly', 'GnomadClinvar']);
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/44
  it('keeps an rsID record when the ClinVar-only request fails with a pathless error', async () => {
    const { requests, operations } = fakeOperations({
      GnomadVariantByRsid: () => ({ data: { variant: live.data.variant } }),
      GnomadClinvar: () => ({
        errors: [{ message: 'An unknown error occurred' }],
        data: { clinvar_variant: null },
      }),
    });

    const result = await lookup('rs527413419');

    expect(result).toMatchObject({ variant_id: LIVE_ID, clinvar: null, clinvar_unavailable: true });
    expect(operations()).toEqual(['GnomadVariantByRsid', 'GnomadClinvar']);
    expect(requests[1]?.variables).toEqual({ variantId: LIVE_ID, referenceGenome: 'GRCh38' });
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/44
  it('keeps variant(rsid:) strict: its own error still fails the item without a ClinVar request', async () => {
    const { operations } = fakeOperations({
      GnomadVariantByRsid: () => ({
        errors: [{ message: 'An unknown error occurred' }],
        data: { variant: live.data.variant },
      }),
    });

    await expect(lookup('rs527413419')).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'graphql_error' },
    });
    expect(operations()).toEqual(['GnomadVariantByRsid']);
  });
});

describe('coordinate-ID absence', () => {
  /** ClinVar record gnomAD returns beside `variant: null` when ClinVar knows the variant. */
  const clinvarRecord = {
    clinical_significance: 'Pathogenic',
    review_status: 'criteria provided, multiple submitters, no conflicts',
    gold_stars: 3,
    clinvar_variation_id: '9589',
  };

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/25
  it.each([
    ['live shape, ClinVar null', [{ message: 'Variant not found' }], null],
    ['live shape, ClinVar populated', [{ message: 'Variant not found' }], clinvarRecord],
    [
      'repeated pathless not-found errors',
      [{ message: 'Variant not found' }, { message: 'Variant not found' }],
      clinvarRecord,
    ],
  ])('returns null after one fetch for gnomAD absence: %s', async (_label, errors, clinvar) => {
    const { fetch } = fakeGraphql(() => ({
      errors,
      data: { variant: null, clinvar_variant: clinvar },
    }));
    const svc = new GnomadService(getServerConfig());

    const result = await svc.getVariant(
      '1-1-A-T',
      svc.resolveDatasetContext('gnomad_r4'),
      createMockContext(),
    );

    expect(result).toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/25
  // A populated variant beside an error splits (#44): the variant-only reply
  // repeats the error, so the item fails without a ClinVar request.
  it.each([
    ['not-found beside a populated variant', [{ message: 'Variant not found' }], true],
    ['Invalid variant ID', [{ message: 'Invalid variant ID' }], false],
    ['Multiple variants found', [{ message: 'Multiple variants found' }], false],
    [
      'not-found mixed with another error',
      [{ message: 'Variant not found' }, { message: 'Unexpected resolver failure' }],
      false,
    ],
  ])('keeps %s a fatal graphql_error', async (_label, errors, populated) => {
    const { fetch, requests } = fakeGraphql(({ variables }) => ({
      errors,
      data: {
        variant: populated ? variant(String(variables.variantId)) : null,
        clinvar_variant: null,
      },
    }));
    const svc = new GnomadService(getServerConfig());

    await expect(
      svc.getVariant('1-1-A-T', svc.resolveDatasetContext('gnomad_r4'), createMockContext()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'graphql_error', retryable: false },
    });
    expect(fetch).toHaveBeenCalledTimes(populated ? 2 : 1);
    expect(requests.map(operationOf)).toEqual(
      populated ? ['GnomadVariant', 'GnomadVariantOnly'] : ['GnomadVariant'],
    );
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/25
  it('keeps rsID absence a null result after one fetch', async () => {
    const { fetch } = fakeGraphql(() => ({
      errors: [{ message: 'Variant not found' }],
      data: { variant: null },
    }));
    const svc = new GnomadService(getServerConfig());

    const result = await svc.getVariant(
      'rs999999999999',
      svc.resolveDatasetContext('gnomad_r4'),
      createMockContext(),
    );

    expect(result).toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/25
  it('gives an absent coordinate ID the same failed[] item as an absent rsID, in input order', async () => {
    const { requests } = fakeGraphql(({ query, variables }) => {
      if (query.includes('GnomadVariantByRsid')) {
        return { errors: [{ message: 'Variant not found' }], data: { variant: null } };
      }
      if (query.includes('GnomadClinvar')) return { data: { clinvar_variant: null } };
      if (variables.variantId === '1-55039974-G-T') {
        return { data: { variant: variant('1-55039974-G-T'), clinvar_variant: null } };
      }
      return {
        errors: [{ message: 'Variant not found' }],
        data: { variant: null, clinvar_variant: clinvarRecord },
      };
    });
    initGnomadService({} as never, {} as never);

    const result = await gnomadGetVariant.handler(
      gnomadGetVariant.input.parse({
        variants: ['1-1-A-T', 'rs999999999999', '1-55039974-G-T', '2-1-C-G'],
        dataset: 'gnomad_r4',
      }),
      createMockContext({ errors: gnomadGetVariant.errors }),
    );

    expect(result.found.map((record) => record.variant_id)).toEqual(['1-55039974-G-T']);
    expect(result.failed.map((item) => item.variant)).toEqual([
      '1-1-A-T',
      'rs999999999999',
      '2-1-C-G',
    ]);
    const [coordinate, rsid, second] = result.failed;
    expect(coordinate?.error).toMatch(/^Not found in gnomad_r4\./);
    expect(rsid?.error).toBe(coordinate?.error);
    expect(second?.error).toBe(coordinate?.error);
    expect(requests).toHaveLength(4);
  });
});
