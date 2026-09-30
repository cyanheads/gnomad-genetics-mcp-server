/**
 * @fileoverview Offline integration tests for the gnomAD GraphQL boundary.
 * Exercises request routing, typed response parsing, genetics normalization,
 * dataset/build propagation, and partial not-found behavior through the real
 * GnomadService and gnomad_get_variant handler. Only global fetch is faked.
 * @module tests/integration/gnomad-boundary.integration.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { gnomadGetVariant } from '@/mcp-server/tools/definitions/gnomad-get-variant.tool.js';
import { GnomadService, initGnomadService } from '@/services/gnomad/gnomad-service.js';

interface GraphqlRequest {
  query: string;
  variables: Record<string, unknown>;
}

type GraphqlResponder = (request: GraphqlRequest, callIndex: number) => unknown;

function fakeGraphql(responder: GraphqlResponder): GraphqlRequest[] {
  const requests: GraphqlRequest[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const body = typeof init?.body === 'string' ? init.body : '';
    const request = JSON.parse(body) as GraphqlRequest;
    requests.push(request);
    return new Response(JSON.stringify(responder(request, requests.length - 1)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return requests;
}

function rawVariant(variantId: string, referenceGenome = 'GRCh38') {
  return {
    variant_id: variantId,
    reference_genome: referenceGenome,
    rsids: ['rs11591147'],
    flags: null,
    exome: {
      ac: 0,
      an: 1_000,
      af: 0,
      homozygote_count: 0,
      hemizygote_count: null,
      populations: [
        {
          id: 'afr',
          ac: 0,
          an: 500,
          homozygote_count: 0,
          hemizygote_count: null,
        },
        {
          id: 'nfe',
          ac: null,
          an: null,
          homozygote_count: null,
          hemizygote_count: null,
        },
        {
          id: 'afr_XX',
          ac: 7,
          an: 250,
          homozygote_count: 0,
          hemizygote_count: null,
        },
      ],
    },
    genome: null,
    transcript_consequences: [
      {
        gene_symbol: 'PCSK9',
        transcript_id: 'ENST00000302118',
        major_consequence: 'frameshift_variant',
      },
    ],
    in_silico_predictors: [
      { id: 'revel_max', value: '0.91' },
      { id: 'spliceai_ds_max', value: '' },
    ],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GnomadService variant boundary', () => {
  it('propagates the explicit dataset/build and distinguishes zero AF from unknown AF', async () => {
    const requests = fakeGraphql(({ variables }) => ({
      data: {
        variant: rawVariant(String(variables.variantId)),
        clinvar_variant: null,
      },
    }));
    const svc = new GnomadService(getServerConfig());
    const ctx = createMockContext();
    const dsCtx = svc.resolveDatasetContext('gnomad_r4', 'GRCh38');

    const result = await svc.getVariant('1-55051215-G-GA', dsCtx, ctx);

    expect(requests[0]?.variables).toEqual({
      variantId: '1-55051215-G-GA',
      dataset: 'gnomad_r4',
      referenceGenome: 'GRCh38',
    });
    expect(result).toMatchObject({
      variant_id: '1-55051215-G-GA',
      dataset: 'gnomad_r4',
      reference_genome: 'GRCh38',
      ac: 0,
      an: 1_000,
      af: 0,
    });
    expect(result?.populations).toEqual([
      expect.objectContaining({ id: 'afr', ac: 0, an: 500, af: 0 }),
      expect.objectContaining({ id: 'nfe', af: null }),
    ]);
    expect(result?.populations.map((population) => population.id)).not.toContain('afr_XX');
  });

  it('keeps dataset-specific presence separate for the same coordinate', async () => {
    fakeGraphql(({ variables }) => ({
      data: {
        variant: variables.dataset === 'gnomad_r4' ? rawVariant(String(variables.variantId)) : null,
        clinvar_variant: null,
      },
    }));
    const svc = new GnomadService(getServerConfig());
    const ctx = createMockContext();

    const r4 = await svc.getVariant('1-55051215-G-GA', svc.resolveDatasetContext('gnomad_r4'), ctx);
    const r3 = await svc.getVariant('1-55051215-G-GA', svc.resolveDatasetContext('gnomad_r3'), ctx);

    expect(r4?.dataset).toBe('gnomad_r4');
    expect(r3).toBeNull();
  });

  it('routes an uppercase rsID through rsid lookup and joins ClinVar by resolved variant ID', async () => {
    const requests = fakeGraphql(({ query }) => {
      if (query.includes('GnomadVariantByRsid')) {
        return { data: { variant: rawVariant('1-55051215-G-GA') } };
      }
      return {
        data: {
          clinvar_variant: {
            clinical_significance: 'Pathogenic',
            review_status: 'reviewed by expert panel',
            gold_stars: 3,
            clinvar_variation_id: '411816',
          },
        },
      };
    });
    const svc = new GnomadService(getServerConfig());

    const result = await svc.getVariant(
      'RS11591147',
      svc.resolveDatasetContext('gnomad_r4'),
      createMockContext(),
    );

    expect(requests).toHaveLength(2);
    expect(requests[0]?.variables).toEqual({ rsid: 'RS11591147', dataset: 'gnomad_r4' });
    expect(requests[1]?.variables).toEqual({
      variantId: '1-55051215-G-GA',
      referenceGenome: 'GRCh38',
    });
    expect(result?.variant_id).toBe('1-55051215-G-GA');
    expect(result?.clinvar).toMatchObject({
      clinical_significance: 'Pathogenic',
      gold_stars: 3,
    });
  });

  it('accepts sex-chromosome, indel, and MNV identifiers through the tool, and refuses a mitochondrial one before any fetch', async () => {
    const requests = fakeGraphql(({ query, variables }) => {
      if (query.includes('GnomadVariantByRsid')) {
        return { data: { variant: rawVariant('1-101-A-G') } };
      }
      if (query.includes('GnomadClinvar')) return { data: { clinvar_variant: null } };
      return {
        data: {
          variant: rawVariant(String(variables.variantId)),
          clinvar_variant: null,
        },
      };
    });
    initGnomadService({} as never, {} as never);
    const input = gnomadGetVariant.input.parse({
      variants: ['M-100-A-G', 'X-200-G-GA', 'Y-300-AC-GT', '1-400-AC-GT', 'RS123'],
    });

    const result = await gnomadGetVariant.handler(
      input,
      createMockContext({ errors: gnomadGetVariant.errors }),
    );

    expect(result.failed).toEqual([
      {
        variant: 'M-100-A-G',
        error: expect.stringMatching(/mitochondrial/i),
        reason: 'mitochondrial_unsupported',
        recovery: gnomadGetVariant.errors?.find(
          (entry) => entry.reason === 'mitochondrial_unsupported',
        )?.recovery,
      },
    ]);
    expect(result.found.map((variant) => variant.variant_id)).toEqual([
      'X-200-G-GA',
      'Y-300-AC-GT',
      '1-400-AC-GT',
      '1-101-A-G',
    ]);
    expect(requests.some((request) => request.variables.variantId === 'M-100-A-G')).toBe(false);
    expect(result.reference_genome).toBe('GRCh38');
  });

  it('reads a pathless not-found error beside a null variant as absence on the coordinate operation', async () => {
    const requests = fakeGraphql(() => ({
      errors: [{ message: 'Variant not found' }],
      data: { variant: null, clinvar_variant: null },
    }));
    const svc = new GnomadService(getServerConfig());

    const result = await svc.getVariant(
      '1-999-A-T',
      svc.resolveDatasetContext('gnomad_r4'),
      createMockContext(),
    );

    expect(result).toBeNull();
    expect(requests).toHaveLength(1);
  });
});

/** gnomad_r4 predictor ids and value strings, shaped like the live `in_silico_predictors`. */
const R4_PREDICTORS = [
  { id: 'cadd', value: '10.4' },
  { id: 'revel_max', value: '0.028' },
  { id: 'spliceai_ds_max', value: '0.00' },
  { id: 'pangolin_largest_ds', value: '0.02' },
  { id: 'phylop', value: '-3.87' },
  { id: 'sift_max', value: '0.33' },
  { id: 'polyphen_max', value: '0.001' },
];

describe('GnomadService in-silico predictor mapping', () => {
  async function inSilicoFor(
    predictors: readonly { id: string; value: string | null }[] | null,
    dataset: 'gnomad_r4' | 'gnomad_r3' | 'gnomad_r2_1' | 'exac' = 'gnomad_r4',
  ) {
    fakeGraphql(({ variables }) => ({
      data: {
        variant: {
          ...rawVariant(String(variables.variantId), String(variables.referenceGenome)),
          in_silico_predictors: predictors,
        },
        clinvar_variant: null,
      },
    }));
    const svc = new GnomadService(getServerConfig());
    const result = await svc.getVariant(
      '1-55039974-G-T',
      svc.resolveDatasetContext(dataset),
      createMockContext(),
    );
    return result?.in_silico;
  }

  it('maps plain numeric strings, negatives included, to numbers and leaves empty or null values null', async () => {
    const inSilico = await inSilicoFor([
      ...R4_PREDICTORS,
      { id: 'empty', value: '' },
      { id: 'missing', value: null },
    ]);

    expect(inSilico).toMatchObject([
      { id: 'cadd', value: 10.4 },
      { id: 'revel_max', value: 0.028 },
      { id: 'spliceai_ds_max', value: 0 },
      { id: 'pangolin_largest_ds', value: 0.02 },
      { id: 'phylop', value: -3.87 },
      { id: 'sift_max', value: 0.33 },
      { id: 'polyphen_max', value: 0.001 },
      { id: 'empty', value: null },
      { id: 'missing', value: null },
    ]);
  });

  it.each([
    ['gnomad_r2_1', null],
    ['exac', []],
  ] as const)('returns no predictors for %s, which carries none', async (dataset, predictors) => {
    await expect(inSilicoFor(predictors, dataset)).resolves.toEqual([]);
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/36
  it('gives every plain numeric predictor a null annotation', async () => {
    const inSilico = await inSilicoFor(R4_PREDICTORS);

    expect(inSilico?.map((predictor) => predictor.annotation)).toEqual(
      R4_PREDICTORS.map(() => null),
    );
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/36
  it('splits a gnomad_r3 SpliceAI score from its parenthesized event', async () => {
    const inSilico = await inSilicoFor(
      [
        { id: 'revel', value: '0.0280' },
        { id: 'cadd', value: '10.4' },
        { id: 'splice_ai', value: '0.00 (no_consequence)' },
        { id: 'primate_ai', value: '0.504' },
      ],
      'gnomad_r3',
    );

    expect(inSilico).toEqual([
      { id: 'revel', value: 0.028, annotation: null },
      { id: 'cadd', value: 10.4, annotation: null },
      { id: 'splice_ai', value: 0, annotation: 'no_consequence' },
      { id: 'primate_ai', value: 0.504, annotation: null },
    ]);
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/36
  it.each([
    ['0.0100 (acceptor_gain)', 0.01, 'acceptor_gain'],
    ['-0.5 (donor_loss)', -0.5, 'donor_loss'],
    ['1e-3 (acceptor_loss)', 0.001, 'acceptor_loss'],
    ['0.2(donor_gain)', 0.2, 'donor_gain'],
    ['  0.3   ( spaced event )  ', 0.3, 'spaced event'],
    ['0.4 ()', 0.4, null],
    ['not scored', null, 'not scored'],
    ['(no_consequence)', null, '(no_consequence)'],
    ['0.5 no_parens', null, '0.5 no_parens'],
    ['NaN', null, 'NaN'],
    ['Infinity', null, 'Infinity'],
    ['1e999', null, '1e999'],
    ['1e999 (overflow)', null, '1e999 (overflow)'],
    ['0x10', null, '0x10'],
    ['   ', null, null],
    ['', null, null],
    [null, null, null],
  ])(
    'maps %j to value %j and annotation %j, never a non-finite number',
    async (raw, value, annotation) => {
      const inSilico = await inSilicoFor([{ id: 'splice_ai', value: raw }], 'gnomad_r3');

      expect(inSilico).toEqual([{ id: 'splice_ai', value, annotation }]);
    },
  );
});

/** Live PCSK9 constraint objects per build, as `gene { gnomad_constraint exac_constraint }` returns them. */
const PCSK9_CONSTRAINT = {
  GRCh38: {
    gnomad_constraint: {
      pli: 2.765187110917756e-18,
      oe_lof: 0.9176378304213768,
      oe_lof_lower: 0.7416265467075939,
      oe_lof_upper: 1.1441346736692857,
      oe_mis: 0.906450937101462,
      oe_syn: 0.9453046063830313,
      lof_z: 0.5506733800624033,
      mis_z: 1.2360458676592712,
      syn_z: 0.6603188478981492,
      obs_lof: 57,
      exp_lof: 62.116009290752274,
      obs_mis: 870,
      exp_mis: 959.7871924342421,
      obs_syn: 387,
      exp_syn: 409.3918482855569,
      flags: [],
    },
    exac_constraint: null,
  },
  GRCh37: {
    gnomad_constraint: {
      pli: 2.7059204562649786e-17,
      oe_lof: 0.9662316499147062,
      // biome-ignore lint/suspicious/noApproximativeNumericConstant: gnomAD's live PCSK9 v2.1.1 LOEUF lower bound, not √½.
      oe_lof_lower: 0.707,
      oe_lof_upper: 1.341,
      oe_mis: 0.9632446051921747,
      oe_syn: 0.9066008152125259,
      lof_z: 0.16232122832806772,
      mis_z: 0.2724115375371906,
      syn_z: 1.005369593751177,
      obs_lof: 26,
      exp_lof: 26.90866108794422,
      obs_mis: 419,
      exp_mis: 434.9881616169615,
      obs_syn: 170,
      exp_syn: 187.5136191667206,
      flags: [],
    },
    exac_constraint: {
      pli: 1.02507611210468e-10,
      lof_z: 0.221252094879999,
      mis_z: 0.555820087234748,
      syn_z: 1.37004966509371,
      obs_lof: 16,
      exp_lof: 16.9187162512,
      obs_mis: 258,
      exp_mis: 276.909800337,
      obs_syn: 111,
      exp_syn: 136.853201549,
    },
  },
} as const;

/** Answer every constraint query with PCSK9's objects for the requested build. */
function fakePcsk9Constraint(): GraphqlRequest[] {
  return fakeGraphql(({ variables }) => ({
    data: {
      gene: {
        gene_id: 'ENSG00000169174',
        symbol: 'PCSK9',
        ...PCSK9_CONSTRAINT[variables.referenceGenome as 'GRCh38' | 'GRCh37'],
      },
    },
  }));
}

describe('GnomadService constraint routing by dataset', () => {
  it.each([
    ['gnomad_r4', 'GRCh38'],
    ['gnomad_r3', 'GRCh38'],
    ['gnomad_r2_1', 'GRCh37'],
  ] as const)(
    'reads the %s build’s gnomad_constraint table on %s',
    async (dataset, referenceGenome) => {
      const requests = fakePcsk9Constraint();
      const svc = new GnomadService(getServerConfig());

      const result = await svc.getGeneConstraint(
        'PCSK9',
        svc.resolveDatasetContext(dataset),
        createMockContext(),
      );

      expect(requests[0]?.variables).toEqual({ gene: 'PCSK9', referenceGenome });
      const { flags, ...metrics } = PCSK9_CONSTRAINT[referenceGenome].gnomad_constraint;
      expect(result).toMatchObject({
        gene_id: 'ENSG00000169174',
        symbol: 'PCSK9',
        dataset,
        reference_genome: referenceGenome,
        ...metrics,
        constraint_flags: flags,
      });
    },
  );

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/26
  it.each([
    ['gnomad_r4', 'gnomAD v4.1.2'],
    ['gnomad_r3', 'gnomAD v4.1.2'],
    ['gnomad_r2_1', 'gnomAD v2.1.1'],
    ['exac', 'ExAC r0.3'],
  ] as const)('labels %s constraint as %s', async (dataset, release) => {
    fakePcsk9Constraint();
    const svc = new GnomadService(getServerConfig());

    const result = await svc.getGeneConstraint(
      'PCSK9',
      svc.resolveDatasetContext(dataset),
      createMockContext(),
    );

    expect(result?.constraint_release).toBe(release);
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/26
  it('reads exac from exac_constraint, not the GRCh37 gnomad_constraint beside it', async () => {
    const requests = fakePcsk9Constraint();
    const svc = new GnomadService(getServerConfig());

    const result = await svc.getGeneConstraint(
      'PCSK9',
      svc.resolveDatasetContext('exac'),
      createMockContext(),
    );

    expect(requests[0]?.variables).toEqual({ gene: 'PCSK9', referenceGenome: 'GRCh37' });
    expect(result).toEqual({
      gene_id: 'ENSG00000169174',
      symbol: 'PCSK9',
      dataset: 'exac',
      reference_genome: 'GRCh37',
      constraint_release: 'ExAC r0.3',
      ...PCSK9_CONSTRAINT.GRCh37.exac_constraint,
      oe_lof: null,
      oe_lof_lower: null,
      oe_lof_upper: null,
      oe_mis: null,
      oe_syn: null,
      constraint_flags: [],
    });
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/26
  it.each([
    ['symbol', 'PCSK9', 'gene_symbol: $gene'],
    ['Ensembl ID', 'ENSG00000169174', 'gene_id: $gene'],
  ])('selects exac_constraint in the by-%s query document', async (_label, gene, argument) => {
    const requests = fakePcsk9Constraint();
    const svc = new GnomadService(getServerConfig());

    await svc.getGeneConstraint(gene, svc.resolveDatasetContext('exac'), createMockContext());

    expect(requests[0]?.query).toContain(argument);
    expect(requests[0]?.query).toMatch(
      /exac_constraint\s*\{[^}]*\bpli\b[^}]*\blof_z\b[^}]*\bobs_lof\b[^}]*\bexp_syn\b[^}]*\}/,
    );
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/26
  it('returns all-null metrics with the release named when a gene has no ExAC constraint', async () => {
    fakeGraphql(() => ({
      data: {
        gene: {
          gene_id: 'ENSG00000143631',
          symbol: 'FLG',
          gnomad_constraint: PCSK9_CONSTRAINT.GRCh37.gnomad_constraint,
          exac_constraint: null,
        },
      },
    }));
    const svc = new GnomadService(getServerConfig());

    const result = await svc.getGeneConstraint(
      'FLG',
      svc.resolveDatasetContext('exac'),
      createMockContext(),
    );

    expect(result).toMatchObject({
      symbol: 'FLG',
      constraint_release: 'ExAC r0.3',
      pli: null,
      lof_z: null,
      obs_lof: null,
      exp_lof: null,
      oe_lof_upper: null,
      constraint_flags: [],
    });
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/26
  it.each(['gnomad_r4', 'gnomad_r3', 'gnomad_r2_1', 'exac'] as const)(
    'returns null for a gene gnomAD does not hold on %s',
    async (dataset) => {
      fakeGraphql(() => ({ errors: [{ message: 'Gene not found' }], data: { gene: null } }));
      const svc = new GnomadService(getServerConfig());

      await expect(
        svc.getGeneConstraint('NOTAGENE', svc.resolveDatasetContext(dataset), createMockContext()),
      ).resolves.toBeNull();
    },
  );
});

describe('GnomadService gene resolution and constraint normalization', () => {
  it('preserves pathless not-found partial data for operations without an exact-path policy', async () => {
    fakeGraphql(() => ({
      errors: [{ message: 'Gene not found' }],
      data: { gene: null },
    }));
    const svc = new GnomadService(getServerConfig());

    const result = await svc.getGeneConstraint(
      'NORESULT',
      svc.resolveDatasetContext('gnomad_r4'),
      createMockContext(),
    );

    expect(result).toBeNull();
  });

  it('routes symbols, aliases, deprecated symbols, and Ensembl IDs without silently changing identity', async () => {
    const canonical: Record<string, { geneId: string; symbol: string }> = {
      PARK2: { geneId: 'ENSG00000185345', symbol: 'PRKN' },
      MLL2: { geneId: 'ENSG00000167548', symbol: 'KMT2D' },
      ENSG00000169174: { geneId: 'ENSG00000169174', symbol: 'PCSK9' },
    };
    const requests = fakeGraphql(({ variables }) => {
      const gene = String(variables.gene);
      const resolved = canonical[gene];
      return {
        data: {
          gene: resolved
            ? {
                gene_id: resolved.geneId,
                symbol: resolved.symbol,
                gnomad_constraint: null,
                exac_constraint: null,
              }
            : null,
        },
      };
    });
    const svc = new GnomadService(getServerConfig());
    const dsCtx = svc.resolveDatasetContext('gnomad_r4');

    const alias = await svc.getGeneConstraint('PARK2', dsCtx, createMockContext());
    const deprecated = await svc.getGeneConstraint('MLL2', dsCtx, createMockContext());
    const stableId = await svc.getGeneConstraint('ENSG00000169174', dsCtx, createMockContext());

    expect(alias).toMatchObject({ gene_id: 'ENSG00000185345', symbol: 'PRKN' });
    expect(deprecated).toMatchObject({ gene_id: 'ENSG00000167548', symbol: 'KMT2D' });
    expect(stableId).toMatchObject({ gene_id: 'ENSG00000169174', symbol: 'PCSK9' });
    expect(requests[0]?.query).toContain('gene_symbol: $gene');
    expect(requests[1]?.query).toContain('gene_symbol: $gene');
    expect(requests[2]?.query).toContain('gene_id: $gene');
  });

  it('surfaces an ambiguous gene response instead of selecting a plausible match', async () => {
    fakeGraphql(() => ({
      errors: [{ message: 'Multiple genes found for symbol ABC' }],
      data: { gene: null },
    }));
    const svc = new GnomadService(getServerConfig());

    await expect(
      svc.getGeneConstraint('ABC', svc.resolveDatasetContext('gnomad_r4'), createMockContext()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'graphql_error', retryable: false },
    });
  });

  it('distinguishes no constraint data from genuine low and zero-valued metrics', async () => {
    fakeGraphql(({ variables }) => {
      const absent = variables.gene === 'SPARSE';
      return {
        data: {
          gene: {
            gene_id: absent ? 'ENSG00000999999' : 'ENSG00000888888',
            symbol: String(variables.gene),
            gnomad_constraint: absent
              ? null
              : {
                  pli: 0,
                  oe_lof: 0,
                  oe_lof_lower: 0,
                  oe_lof_upper: 0,
                  oe_mis: 0,
                  oe_syn: 0,
                  lof_z: 0,
                  mis_z: 0,
                  syn_z: 0,
                  obs_lof: 0,
                  exp_lof: 0,
                  obs_mis: 0,
                  exp_mis: 0,
                  obs_syn: 0,
                  exp_syn: 0,
                  flags: [],
                },
            exac_constraint: null,
          },
        },
      };
    });
    const svc = new GnomadService(getServerConfig());
    const dsCtx = svc.resolveDatasetContext('gnomad_r4');

    const absent = await svc.getGeneConstraint('SPARSE', dsCtx, createMockContext());
    const low = await svc.getGeneConstraint('LOW', dsCtx, createMockContext());

    expect(absent).toMatchObject({ pli: null, oe_lof_upper: null, obs_lof: null });
    expect(low).toMatchObject({ pli: 0, oe_lof_upper: 0, obs_lof: 0 });
  });
});

describe('GnomadService list and coverage boundary', () => {
  it('keeps unknown list frequency null while retaining a genuine zero frequency', async () => {
    fakeGraphql(() => ({
      data: {
        gene: {
          chrom: '1',
          variants: [
            {
              variant_id: '1-100-A-T',
              consequence: 'missense_variant',
              flags: null,
              exome: { ac: 0, an: 1_000, af: 0, homozygote_count: 0 },
              genome: null,
            },
            {
              variant_id: '1-101-A-G',
              consequence: null,
              flags: null,
              exome: { ac: null, an: null, af: null, homozygote_count: null },
              genome: null,
            },
          ],
        },
      },
    }));
    const svc = new GnomadService(getServerConfig());

    const rows = await svc.listGeneVariants(
      { kind: 'gene', value: 'PCSK9' },
      {},
      svc.resolveDatasetContext('gnomad_r4'),
      createMockContext(),
    );

    expect(rows[0]).toMatchObject({ af: 0, ac: 0, an: 1_000 });
    expect(rows[1]).toMatchObject({ af: null, ac: 0, an: 0 });
  });

  it('routes Ensembl gene, transcript, and region coverage with the effective build', async () => {
    const requests = fakeGraphql(({ query }) => {
      const key = query.includes('gene(')
        ? 'gene'
        : query.includes('transcript(')
          ? 'transcript'
          : 'region';
      return {
        data: {
          [key]: {
            ...(key === 'region' ? {} : { chrom: '1' }),
            coverage: {
              exome: [
                {
                  pos: 100,
                  mean: 30,
                  median: 30,
                  over_1: 1,
                  over_5: 1,
                  over_10: 1,
                  over_15: 1,
                  over_20: 1,
                  over_25: 1,
                  over_30: 0.5,
                  over_50: 0,
                  over_100: 0,
                },
              ],
              genome: null,
            },
          },
        },
      };
    });
    const svc = new GnomadService(getServerConfig());
    const dsCtx = svc.resolveDatasetContext('gnomad_r4');

    await svc.getCoverage({ kind: 'gene', value: 'ENSG00000169174' }, dsCtx, createMockContext());
    await svc.getCoverage(
      { kind: 'transcript', value: 'ENST00000302118' },
      dsCtx,
      createMockContext(),
    );
    const region = await svc.getCoverage(
      { kind: 'region', value: '1-100-100' },
      dsCtx,
      createMockContext(),
    );

    expect(requests[0]?.query).toContain('GnomadGeneCoverageById');
    expect(requests[0]?.variables.referenceGenome).toBe('GRCh38');
    expect(requests[1]?.variables.transcriptId).toBe('ENST00000302118');
    expect(requests[2]?.variables).toMatchObject({ chrom: '1', start: 100, stop: 100 });
    expect(region[0]).toMatchObject({ positions: 1, mean_depth: 30 });
  });
});
