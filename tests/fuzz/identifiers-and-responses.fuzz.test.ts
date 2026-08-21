/**
 * @fileoverview Deterministic fuzz cases for genetics identifiers and sparse or
 * malformed upstream response envelopes. Mutates case, whitespace, separators,
 * truncation, alphabet, and JSON shapes while exercising only public schemas or
 * real service methods behind a fake global fetch boundary.
 * @module tests/fuzz/identifiers-and-responses.fuzz.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { gnomadGetGeneConstraint } from '@/mcp-server/tools/definitions/gnomad-get-gene-constraint.tool.js';
import { gnomadGetVariant } from '@/mcp-server/tools/definitions/gnomad-get-variant.tool.js';
import {
  RSID_REGEX,
  VARIANT_ID_REGEX,
  VARIANT_OR_RSID_REGEX,
} from '@/mcp-server/tools/shared-schemas.js';
import { ClinVarService } from '@/services/clinvar/clinvar-service.js';
import { GnomadService, initGnomadService } from '@/services/gnomad/gnomad-service.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function rejectAfterRetries(operation: () => Promise<unknown>): Promise<unknown> {
  const settled = operation().then(
    () => {
      throw new Error('operation did not reject');
    },
    (error: unknown) => error,
  );
  for (let index = 0; index < 10; index += 1) {
    await vi.advanceTimersByTimeAsync(60_000);
  }
  return settled;
}

describe('variant and rsID parser fuzz', () => {
  it.each(['1-100-A-T', 'x-200-a-g', 'Y-300-G-GA', 'm-400-AC-GT', 'RS11591147', 'rs1'])(
    'accepts supported case and allele-length variants: %s',
    (identifier) => {
      expect(VARIANT_OR_RSID_REGEX.test(identifier)).toBe(true);
    },
  );

  it.each([
    '',
    'rs',
    'rs12x',
    '1-100-A',
    '1-100-A-',
    '1-100--T',
    '1-100-N-T',
    '1:100:A:T',
    '1_100_A_T',
    '1-100-A-T-extra',
    ' 1-100-A-T',
    '1-100-A-T ',
    '\u00001-100-A-T',
    '../../1-100-A-T',
  ])('rejects malformed, truncated, padded, or hostile identifiers: %j', (identifier) => {
    expect(VARIANT_OR_RSID_REGEX.test(identifier)).toBe(false);
  });

  it('keeps the component matchers disjoint under wrong-case inputs', () => {
    expect(RSID_REGEX.test('RS42')).toBe(true);
    expect(VARIANT_ID_REGEX.test('RS42')).toBe(false);
    expect(VARIANT_ID_REGEX.test('m-42-a-t')).toBe(true);
    expect(RSID_REGEX.test('m-42-a-t')).toBe(false);
  });

  it('reports each malformed non-empty batch item without touching fetch', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    initGnomadService({} as never, {} as never);
    const input = gnomadGetVariant.input.parse({
      variants: ['rsNOPE', '1-100-N-T', '1:100:A:T', ' 1-100-A-T '],
    });

    const result = await gnomadGetVariant.handler(
      input,
      createMockContext({ errors: gnomadGetVariant.errors }),
    );

    expect(result.found).toEqual([]);
    expect(result.failed.map((failure) => failure.variant)).toEqual(input.variants);
    expect(result.failed.every((failure) => failure.error.includes('Malformed ID'))).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('gene parser fuzz', () => {
  it.each(['PCSK9', 'pcsk9', 'PARK2', 'MLL2', 'ENSG00000169174', 'ensg00000169174'])(
    'accepts symbol, alias, deprecated-symbol, and stable-ID shapes: %s',
    (gene) => {
      expect(gnomadGetGeneConstraint.input.safeParse({ gene }).success).toBe(true);
    },
  );

  it.each(['', 'A'])('rejects empty and truncated gene identifiers: %j', (gene) => {
    expect(gnomadGetGeneConstraint.input.safeParse({ gene }).success).toBe(false);
  });

  it('preserves wrong-case input at the boundary while returning upstream canonical identity', async () => {
    let requestedGene: unknown;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '') as {
        variables: Record<string, unknown>;
      };
      requestedGene = body.variables.gene;
      return new Response(
        JSON.stringify({
          data: {
            gene: {
              gene_id: 'ENSG00000169174',
              symbol: 'PCSK9',
              gnomad_constraint: null,
            },
          },
        }),
      );
    });
    const svc = new GnomadService(getServerConfig());

    const result = await svc.getGeneConstraint(
      'pcsk9',
      svc.resolveDatasetContext('gnomad_r4'),
      createMockContext(),
    );

    expect(requestedGene).toBe('pcsk9');
    expect(result).toMatchObject({ gene_id: 'ENSG00000169174', symbol: 'PCSK9' });
  });
});

describe('gnomAD response-envelope fuzz', () => {
  it.each([
    'not-json',
    '{"data":',
    JSON.stringify({}),
    JSON.stringify({ data: null }),
    JSON.stringify({ data: {} }),
    JSON.stringify({ data: { variant: {} } }),
    JSON.stringify({ data: { variant: null } }),
    JSON.stringify({
      data: {
        variant: {
          variant_id: '1-100-A-T',
          reference_genome: 'GRCh38',
          rsids: 'rs1',
          flags: null,
          exome: null,
          genome: null,
          transcript_consequences: null,
          in_silico_predictors: null,
        },
        clinvar_variant: null,
      },
    }),
  ])(
    'rejects truncated or wrong-type GraphQL payloads without returning a record',
    async (body) => {
      vi.useFakeTimers();
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(body));
      const svc = new GnomadService(getServerConfig());

      const error = await rejectAfterRetries(() =>
        svc.getVariant('1-100-A-T', svc.resolveDatasetContext('gnomad_r4'), createMockContext()),
      );
      expect(error).toBeDefined();
    },
  );
});

describe('ClinVar response-envelope fuzz', () => {
  it.each([
    'not-json',
    '{"esearchresult":',
    JSON.stringify({}),
    JSON.stringify({ esearchresult: null }),
    JSON.stringify({ esearchresult: { idlist: '1,2,3' } }),
    JSON.stringify({ esearchresult: { idlist: [1, 2, 3] } }),
  ])('rejects malformed or wrong-type esearch payloads without returning rows', async (body) => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(body));
    const svc = new ClinVarService(getServerConfig());

    const error = await rejectAfterRetries(() => svc.searchGene('PCSK9', {}, createMockContext()));
    expect(error).toBeDefined();
  });

  it('treats an omitted idlist in a valid esearch envelope as an empty result', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ esearchresult: {} })),
    );
    const svc = new ClinVarService(getServerConfig());

    await expect(svc.searchGene('PCSK9', {}, createMockContext())).resolves.toEqual([]);
  });
});
