/**
 * @fileoverview Behavior tests for the gnomad://variant/{dataset}/{variantId}
 * resource — mirrors gnomad_get_variant for a single variant, and surfaces the
 * variant_not_found contract reason when the variant is absent from the dataset,
 * or variant_not_found_other_build when its string lifts over from the other build.
 * Handler tests stub the service accessor; the wire tests run the real service
 * behind a worker handler with only global fetch faked.
 * @module tests/resources/variant.resource.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GNOMAD_DATASETS, getServerConfig } from '@/config/server-config.js';
import { variantResource } from '@/mcp-server/resources/definitions/variant.resource.js';
import { gnomadGetVariant } from '@/mcp-server/tools/definitions/gnomad-get-variant.tool.js';
import * as serviceModule from '@/services/gnomad/gnomad-service.js';
import type { VariantRecord } from '@/services/gnomad/types.js';
import { fakeFafVariants } from '../helpers/live-faf.js';
import { SUBSET_REPLIES } from '../helpers/live-subsets.js';
import { minimalVariant } from '../helpers/minimal-variant.js';
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
    faf95: null,
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
        faf95: null,
      },
      genome: null,
    },
    source: ['exome'],
    flags: [],
    qc_status: 'pass',
    consequence: null,
    transcript_id: null,
    hgvsc: null,
    hgvsp: null,
    lof: null,
    lof_filter: null,
    lof_flags: null,
    primary_transcript: null,
    gene_symbol: null,
    lof_curations: [],
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
      resolveDatasetContext: () =>
        ({ dataset: 'gnomad_r4', parent: 'gnomad_r4', reference_genome: 'GRCh38' }) as const,
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
      resolveDatasetContext: () =>
        ({ dataset: 'gnomad_r4', parent: 'gnomad_r4', reference_genome: 'GRCh38' }) as const,
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
      {
        startedAt: expect.any(Number),
      },
    );
  });

  it('rejects invalid coordinate bounds before lookup', async () => {
    const getVariant = vi.fn();
    const fake = {
      resolveDatasetContext: () =>
        ({ dataset: 'gnomad_r4', parent: 'gnomad_r4', reference_genome: 'GRCh38' }) as const,
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
      resolveDatasetContext: () =>
        ({ dataset: 'gnomad_r4', parent: 'gnomad_r4', reference_genome: 'GRCh38' }) as const,
      getVariant: vi.fn(async () => null),
      liftoverCandidates: vi.fn(async () => new Map<string, string[]>()),
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

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/58
  it('fails a lifted absent ID as variant_not_found_other_build, lifting under the lookup start', async () => {
    const getVariant = vi.fn(
      async (_id: string, _dsCtx: unknown, _ctx: unknown, _options: { startedAt: number }) => null,
    );
    const liftoverCandidates = vi.fn(async () => new Map([['1-55039974-G-T', ['1-55505647-G-T']]]));
    const fake = {
      resolveDatasetContext: () =>
        ({ dataset: 'gnomad_r2_1', parent: 'gnomad_r2_1', reference_genome: 'GRCh37' }) as const,
      getVariant,
      liftoverCandidates,
    };
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(fake as never);

    const ctx = createMockContext({ errors: variantResource.errors });
    const params = variantResource.params!.parse({
      dataset: 'gnomad_r2_1',
      variantId: 'chr1-55039974-g-t',
    });
    await expect(variantResource.handler(params, ctx as never)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message:
        'Variant "chr1-55039974-g-t" not found in gnomad_r2_1. Read as an ID on the other reference build, the same string lifts over to the GRCh37 ID in candidates.',
      data: { reason: 'variant_not_found_other_build', candidates: ['1-55505647-G-T'] },
    });
    const startedAt = getVariant.mock.calls[0]?.[3]?.startedAt;
    expect(startedAt).toEqual(expect.any(Number));
    expect(liftoverCandidates).toHaveBeenCalledWith(
      ['1-55039974-G-T'],
      expect.anything(),
      expect.anything(),
      { startedAt },
    );
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
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) =>
        Response.json(
          String(init?.body).includes('GnomadLiftover')
            ? { data: { l0: [] } }
            : {
                errors: [{ message: 'Variant not found' }],
                data: { variant: null, clinvar_variant: clinvar },
              },
        ),
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
      // The variant lookup, then one liftover request for the absent ID.
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/58
  it('fails a GRCh38 ID on gnomad_r2_1 with variant_not_found_other_build and its candidates in error data', async () => {
    const sent: { query: string; variables: Record<string, unknown> }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as (typeof sent)[number];
      sent.push(request);
      if (request.query.includes('GnomadLiftover')) {
        return Response.json({
          data: {
            l0: [
              {
                source: { variant_id: '1-55505647-G-T' },
                liftover: { variant_id: '1-55039974-G-T' },
              },
            ],
          },
        });
      }
      return Response.json({
        errors: [{ message: 'Variant not found' }],
        data: { variant: null, clinvar_variant: null },
      });
    });
    serviceModule.initGnomadService({} as never, {} as never);

    const error = await read('gnomad://variant/gnomad_r2_1/1-55039974-G-T');

    const declared = variantResource.errors?.find(
      (entry) => entry.reason === 'variant_not_found_other_build',
    );
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'variant_not_found_other_build', candidates: ['1-55505647-G-T'] },
    });
    expect(error.data.recovery?.hint).toBe(declared?.recovery);
    expect(error.message).not.toMatch(/wrong|mismatch|incorrect/i);
    expect(sent.map((request) => request.variables)).toEqual([
      { variantId: '1-55039974-G-T', dataset: 'gnomad_r2_1', referenceGenome: 'GRCh37' },
      { v0: '1-55039974-G-T', referenceGenome: 'GRCh38' },
    ]);
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/58
  it('fails an absent rsID with variant_not_found and never sends it to liftover', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () =>
        Response.json({ errors: [{ message: 'Variant not found' }], data: { variant: null } }),
      );
    serviceModule.initGnomadService({} as never, {} as never);

    const error = await read('gnomad://variant/gnomad_r4/rs999999999999');

    expect(error).toMatchObject({ data: { reason: 'variant_not_found' } });
    expect(fetch).toHaveBeenCalledOnce();
  });

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

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/62
  it.each([
    ['RS505151', { rsid: 'rs505151', dataset: 'gnomad_r4' }],
    [
      '1:55039974:G:T',
      { variantId: '1-55039974-G-T', dataset: 'gnomad_r4', referenceGenome: 'GRCh38' },
    ],
  ])('resolves %s, sending gnomAD its canonical form', async (variantId, variables) => {
    const sent: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      sent.push(request.variables);
      if (request.query.includes('GnomadClinvar')) {
        return Response.json({ data: { clinvar_variant: null } });
      }
      return Response.json({
        data: { variant: minimalVariant('1-55039974-G-T'), clinvar_variant: null },
      });
    });
    serviceModule.initGnomadService({} as never, {} as never);

    const record = await readRecord(`gnomad://variant/gnomad_r4/${variantId}`);

    expect(record).toMatchObject({ variant_id: '1-55039974-G-T', dataset: 'gnomad_r4' });
    expect(sent[0]).toEqual(variables);
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/68
  it('reads a gnomad_r4_non_ukb segment as sent, with the record the tool returns', async () => {
    const live = SUBSET_REPLIES['variant:gnomad_r4_non_ukb:1-55039974-G-T'];
    const sent: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { variables: Record<string, unknown> };
      sent.push(request.variables);
      if (!live) throw new Error('Unmocked gnomAD document');
      return Response.json(live.body, { status: live.status });
    });
    serviceModule.initGnomadService({} as never, {} as never);

    const record = await readRecord('gnomad://variant/gnomad_r4_non_ukb/1-55039974-G-T');
    const tool = await runToolContract(gnomadGetVariant, {
      variants: ['1-55039974-G-T'],
      dataset: 'gnomad_r4_non_ukb',
    });

    expect(sent[0]).toEqual({
      variantId: '1-55039974-G-T',
      dataset: 'gnomad_r4_non_ukb',
      referenceGenome: 'GRCh38',
    });
    expect(record).toMatchObject({ dataset: 'gnomad_r4_non_ukb', ac: 9660, an: 747492 });
    expect(record).toEqual((tool.structuredContent as { found: unknown[] }).found[0]);
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/68
  it('lists every dataset value in its segment description', () => {
    const segment = variantResource.params!.shape.dataset.description ?? '';
    for (const dataset of GNOMAD_DATASETS) {
      expect(segment).toMatch(new RegExp(`(?<!\\w)${dataset}(?!\\w)`));
    }
  });
});

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/64
describe('gnomad://variant resource — the filtering allele frequency (#64)', () => {
  const readRecord = async (uri: string) =>
    resourceRecordOf(await readResourceBody(variantResource, uri));

  it('says in its description that a gnomad_r4 or gnomad_r3 subset reads faf95 null, since it carries no notice', () => {
    expect(variantResource.description).toContain('the filtering allele frequency (faf95)');
    expect(variantResource.description).toContain(
      "On a gnomad_r4 or gnomad_r3 subset, faf95 and each callset's faf95 are null: gnomAD's record there carries the parent release's FAF, not the subset's, and a resource carries no notice to say so — read the parent's segment for its faf95.",
    );
  });

  it.each([
    [
      'gnomad_r4',
      { value: 0.01649444, group: 'nfe', source: 'joint' },
      { value: 0.01651719, group: 'nfe' },
    ],
    ['gnomad_r4_non_ukb', null, null],
  ] as const)(
    'returns the faf95 gnomad_get_variant returns on %s',
    async (dataset, faf95, exomeFaf95) => {
      fakeFafVariants();
      serviceModule.initGnomadService({} as never, {} as never);

      const record = await readRecord(`gnomad://variant/${dataset}/1-55039974-G-T`);
      const tool = await runToolContract(gnomadGetVariant, {
        variants: ['1-55039974-G-T'],
        dataset,
      });

      expect(record).toMatchObject({ dataset, faf95, callsets: { exome: { faf95: exomeFaf95 } } });
      expect(record).toEqual((tool.structuredContent as { found: unknown[] }).found[0]);
    },
  );
});
