/**
 * @fileoverview Correct-behavior regressions for unresolved genetics
 * correctness defects. Each remains skipped with its public issue link until
 * the production behavior is fixed.
 * @module tests/integration/unresolved-correctness.integration.test
 */

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

function fakeGraphql(responder: (request: GraphqlRequest) => unknown): {
  requests: GraphqlRequest[];
  fetch: ReturnType<typeof vi.spyOn>;
} {
  const requests: GraphqlRequest[] = [];
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const request = JSON.parse(typeof init?.body === 'string' ? init.body : '') as GraphqlRequest;
    requests.push(request);
    return new Response(JSON.stringify(responder(request)));
  });
  return { requests, fetch };
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
  it.skip('rejects a variant payload labeled for a different reference build', async () => {
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
  it.skip('accepts a chr-prefixed coordinate identifier', async () => {
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
  it.skip('rejects impossible chromosome and zero-position coordinates before fetch', async () => {
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
  it.skip('canonicalizes equivalent padded alleles before upstream lookup', async () => {
    const { requests } = fakeGraphql(({ variables }) => ({
      data: { variant: variant(String(variables.variantId)), clinvar_variant: null },
    }));
    initGnomadService({} as never, {} as never);

    await gnomadGetVariant.handler(
      gnomadGetVariant.input.parse({ variants: ['1-101-A-AT', '1-100-CA-CAT'] }),
      createMockContext({ errors: gnomadGetVariant.errors }),
    );

    expect(requests.map((request) => request.variables.variantId)).toEqual([
      '1-101-A-AT',
      '1-101-A-AT',
    ]);
  });
});

describe('constraint metric ranges', () => {
  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/18
  it.skip('rejects out-of-range pLI and negative observed/expected ratios', async () => {
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
        },
      },
    }));
    const svc = new GnomadService(getServerConfig());

    await expect(
      svc.getGeneConstraint('PCSK9', svc.resolveDatasetContext('gnomad_r4'), createMockContext()),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
  });
});

describe('GraphQL error and partial-data contracts', () => {
  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/19
  it.skip('classifies malformed 2xx JSON as a clean upstream response error', async () => {
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
  it.skip('classifies malformed ClinVar 2xx JSON without leaking the response body', async () => {
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
  it.skip('returns usable variant data when only the optional ClinVar join errors', async () => {
    fakeGraphql(({ variables }) => ({
      errors: [{ message: 'ClinVar resolver temporarily unavailable' }],
      data: {
        variant: variant(String(variables.variantId)),
        clinvar_variant: null,
      },
    }));
    const svc = new GnomadService(getServerConfig());

    const result = await svc.getVariant(
      '1-100-A-T',
      svc.resolveDatasetContext('gnomad_r4'),
      createMockContext(),
    );

    expect(result).toMatchObject({ variant_id: '1-100-A-T', clinvar: null });
  });
});
