/**
 * @fileoverview Behavior tests for the gnomad://variant/{dataset}/{variantId}
 * resource — mirrors gnomad_get_variant for a single variant, and surfaces the
 * variant_not_found contract reason when the variant is absent from the dataset.
 * Handler tests stub the service accessor; the wire tests run the real service
 * behind a worker handler with only global fetch faked.
 * @module tests/resources/variant.resource.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { variantResource } from '@/mcp-server/resources/definitions/variant.resource.js';
import { gnomadGetVariant } from '@/mcp-server/tools/definitions/gnomad-get-variant.tool.js';
import * as serviceModule from '@/services/gnomad/gnomad-service.js';
import type { VariantRecord } from '@/services/gnomad/types.js';
import { readResourceBody, resourceRecordOf, rpcErrorOf } from '../helpers/worker-resource-read.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function record(variantId: string): VariantRecord {
  return {
    variant_id: variantId,
    rsids: [],
    reference_genome: 'GRCh38',
    dataset: 'gnomad_r4',
    ac: 1,
    an: 1000,
    af: 0.001,
    homozygote_count: 0,
    hemizygote_count: null,
    populations: [],
    joint_populations: [],
    callsets: {
      exome: {
        ac: 1,
        an: 1000,
        af: 0.001,
        homozygote_count: 0,
        hemizygote_count: null,
        filters: [],
      },
      genome: null,
    },
    source: ['exome'],
    flags: [],
    qc_status: 'pass',
    consequence: null,
    transcript_id: null,
    primary_transcript: null,
    gene_symbol: null,
    in_silico: [],
    clinvar: null,
    clinvar_unavailable: false,
  };
}

describe('gnomad://variant resource', () => {
  it('attributes the gnomAD source in its description', () => {
    expect(variantResource.description).toContain(
      'Data source: gnomAD (Broad Institute) — https://gnomad.broadinstitute.org/',
    );
  });
  it('returns the population record for a resolved variant', async () => {
    const fake = {
      resolveDatasetContext: () => ({ dataset: 'gnomad_r4', reference_genome: 'GRCh38' }) as const,
      getVariant: vi.fn(async () => ({
        ...record('1-55051215-G-GA'),
        clinvar_unavailable: true,
      })),
    };
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(fake as never);

    const ctx = createMockContext({ errors: variantResource.errors });
    const params = variantResource.params!.parse({
      dataset: 'gnomad_r4',
      variantId: '1-55051215-G-GA',
    });
    const result = await variantResource.handler(params, ctx as never);
    expect(result).toMatchObject({
      variant_id: '1-55051215-G-GA',
      dataset: 'gnomad_r4',
      clinvar_unavailable: true,
    });
  });

  it('canonicalizes chr prefixes and allele case before lookup', async () => {
    const getVariant = vi.fn(async () => record('1-55051215-G-GA'));
    const fake = {
      resolveDatasetContext: () => ({ dataset: 'gnomad_r4', reference_genome: 'GRCh38' }) as const,
      getVariant,
    };
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(fake as never);

    const ctx = createMockContext({ errors: variantResource.errors });
    const params = variantResource.params!.parse({
      dataset: 'gnomad_r4',
      variantId: 'chr1-55051215-g-ga',
    });
    await variantResource.handler(params, ctx as never);

    expect(getVariant).toHaveBeenCalledWith(
      '1-55051215-G-GA',
      expect.anything(),
      expect.anything(),
    );
  });

  it('rejects invalid coordinate bounds before lookup', async () => {
    const getVariant = vi.fn();
    const fake = {
      resolveDatasetContext: () => ({ dataset: 'gnomad_r4', reference_genome: 'GRCh38' }) as const,
      getVariant,
    };
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(fake as never);

    const ctx = createMockContext({ errors: variantResource.errors });
    const params = variantResource.params!.parse({ dataset: 'gnomad_r4', variantId: '23-0-A-T' });

    await expect(variantResource.handler(params, ctx as never)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_variant_id' },
    });
    expect(getVariant).not.toHaveBeenCalled();
  });

  it('throws ctx.fail("variant_not_found") when the variant is absent', async () => {
    const fake = {
      resolveDatasetContext: () => ({ dataset: 'gnomad_r4', reference_genome: 'GRCh38' }) as const,
      getVariant: vi.fn(async () => null),
    };
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(fake as never);

    const ctx = createMockContext({ errors: variantResource.errors });
    const params = variantResource.params!.parse({
      dataset: 'gnomad_r4',
      variantId: '1-55051215-G-GA',
    });
    await expect(variantResource.handler(params, ctx as never)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'variant_not_found' },
    });
  });
});

describe('gnomad://variant resource — through the real service (wire)', () => {
  const read = async (uri: string) => rpcErrorOf(await readResourceBody(variantResource, uri));
  const readRecord = async (uri: string) =>
    resourceRecordOf(await readResourceBody(variantResource, uri));

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/36
  it('returns the gnomad_r3 SpliceAI score and event split, as the tool does', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({
        data: {
          variant: {
            variant_id: '1-55039974-G-T',
            reference_genome: 'GRCh38',
            rsids: ['rs11591147'],
            flags: null,
            exome: null,
            genome: {
              ac: 1866,
              an: 152_286,
              af: 0.0123,
              homozygote_count: 17,
              hemizygote_count: 0,
              populations: [],
            },
            transcript_consequences: null,
            in_silico_predictors: [
              { id: 'revel', value: '0.0280' },
              { id: 'cadd', value: '10.4' },
              { id: 'splice_ai', value: '0.00 (no_consequence)' },
              { id: 'primate_ai', value: '0.504' },
            ],
          },
          clinvar_variant: null,
        },
      }),
    );
    serviceModule.initGnomadService({} as never, {} as never);

    const record = await readRecord('gnomad://variant/gnomad_r3/1-55039974-G-T');

    expect(record).toMatchObject({ variant_id: '1-55039974-G-T', dataset: 'gnomad_r3' });
    expect(record.in_silico).toEqual([
      { id: 'revel', value: 0.028, annotation: null },
      { id: 'cadd', value: 10.4, annotation: null },
      { id: 'splice_ai', value: 0, annotation: 'no_consequence' },
      { id: 'primate_ai', value: 0.504, annotation: null },
    ]);
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/25
  it.each([
    ['ClinVar null', null],
    [
      'ClinVar populated',
      {
        clinical_significance: 'Pathogenic',
        review_status: 'criteria provided, multiple submitters, no conflicts',
        gold_stars: 3,
        clinvar_variation_id: '9589',
      },
    ],
  ])(
    'fails an absent coordinate ID with variant_not_found and its declared hint (%s)',
    async (_label, clinvar) => {
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
        Response.json({
          errors: [{ message: 'Variant not found' }],
          data: { variant: null, clinvar_variant: clinvar },
        }),
      );
      serviceModule.initGnomadService({} as never, {} as never);

      const error = await read('gnomad://variant/gnomad_r4/1-1-A-T');

      const declared = variantResource.errors?.find(
        (entry) => entry.reason === 'variant_not_found',
      );
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'variant_not_found' },
      });
      expect(error.message).toContain('1-1-A-T');
      expect(error.message).toContain('gnomad_r4');
      expect(error.data.recovery?.hint).toBe(declared?.recovery);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/44
  it('keeps the record with clinvar_unavailable when only the ClinVar-only request fails', async () => {
    const origin = new URL(getServerConfig().gnomadApiBaseUrl).origin;
    const variant = {
      variant_id: '1-55051215-G-GA',
      reference_genome: 'GRCh38',
      rsids: ['rs527413419'],
      flags: null,
      exome: null,
      genome: {
        ac: 3,
        an: 1000,
        af: 0.003,
        homozygote_count: 0,
        hemizygote_count: null,
        populations: [],
      },
      transcript_consequences: null,
      in_silico_predictors: null,
    };
    const operations: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url).origin !== origin) throw new Error(`Unmocked fetch to ${url}`);
      const operation = /query\s+(\w+)/.exec(String(JSON.parse(String(init?.body)).query))?.[1];
      operations.push(String(operation));
      if (operation === 'GnomadVariant') {
        return Response.json({
          errors: [{ message: 'Invalid variant ID' }],
          data: { variant, clinvar_variant: null },
        });
      }
      if (operation === 'GnomadVariantOnly') return Response.json({ data: { variant } });
      if (operation === 'GnomadClinvar') {
        return Response.json({
          errors: [{ message: 'Invalid variant ID' }],
          data: { clinvar_variant: null },
        });
      }
      throw new Error(`Unmocked gnomAD operation ${operation}`);
    });
    serviceModule.initGnomadService({} as never, {} as never);

    const record = await readRecord('gnomad://variant/gnomad_r4/1-55051215-G-GA');

    expect(record).toMatchObject({
      variant_id: '1-55051215-G-GA',
      ac: 3,
      clinvar: null,
      clinvar_unavailable: true,
    });
    expect(operations).toEqual(['GnomadVariant', 'GnomadVariantOnly', 'GnomadClinvar']);
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/53
  it('returns the joint an and joint groups gnomad_get_variant returns', async () => {
    // Rows of the live gnomad_r4 1-55039784-C-G record, captured 2026-11-01 (UTC).
    const populations = (rows: [string, number, number][]) =>
      rows.map(([id, ac, an]) => ({ id, ac, an, homozygote_count: 0, hemizygote_count: 0 }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({
        data: {
          variant: {
            variant_id: '1-55039784-C-G',
            reference_genome: 'GRCh38',
            rsids: [],
            flags: [],
            exome: null,
            genome: {
              ac: 3,
              an: 152_386,
              af: 3 / 152_386,
              homozygote_count: 0,
              hemizygote_count: 0,
              populations: populations([['afr', 3, 41_594]]),
            },
            joint: {
              ac: 3,
              an: 1_558_598,
              homozygote_count: 0,
              hemizygote_count: 0,
              populations: populations([
                ['afr', 3, 74_272],
                ['afr_XY', 2, 33_252],
                ['', 3, 1_558_598],
                ['XY', 2, 769_786],
              ]),
            },
            transcript_consequences: null,
            in_silico_predictors: null,
          },
          clinvar_variant: null,
        },
      }),
    );
    serviceModule.initGnomadService({} as never, {} as never);

    const record = await readRecord('gnomad://variant/gnomad_r4/1-55039784-C-G');
    const tool = await runToolContract(gnomadGetVariant, { variants: ['1-55039784-C-G'] });

    expect(record).toMatchObject({ an: 1_558_598, af: 3 / 1_558_598 });
    expect(record.joint_populations).toEqual([
      { id: 'afr', ac: 3, an: 74_272, af: 3 / 74_272, homozygote_count: 0, hemizygote_count: 0 },
    ]);
    const [found] = (tool.structuredContent as { found: VariantRecord[] }).found;
    expect(found?.an).toBe(record.an);
    expect(found?.joint_populations).toEqual(record.joint_populations);
  });
});
