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

  it('accepts mitochondrial, sex-chromosome, indel, and MNV identifiers through the tool', async () => {
    fakeGraphql(({ query, variables }) => {
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

    expect(result.failed).toEqual([]);
    expect(result.found.map((variant) => variant.variant_id)).toEqual([
      'M-100-A-G',
      'X-200-G-GA',
      'Y-300-AC-GT',
      '1-400-AC-GT',
      '1-101-A-G',
    ]);
    expect(result.reference_genome).toBe('GRCh38');
  });

  it('treats GraphQL not-found plus null data as absence rather than an upstream fault', async () => {
    fakeGraphql(() => ({
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
  });
});

describe('GnomadService gene resolution and constraint normalization', () => {
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
