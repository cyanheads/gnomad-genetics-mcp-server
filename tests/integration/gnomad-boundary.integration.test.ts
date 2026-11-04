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
import type { GraphqlRequest } from '../helpers/fake-gnomad-graphql.js';
import { fakeLiveConstraint } from '../helpers/live-constraint.js';

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
    initGnomadService({} as never, {} as never);

    // gnomAD rejects an uppercase rsID as invalid, so the tool lowercases it first (#62).
    const { found } = await gnomadGetVariant.handler(
      gnomadGetVariant.input.parse({ variants: ['RS11591147'] }),
      createMockContext({ errors: gnomadGetVariant.errors }),
    );
    const [result] = found;

    expect(requests).toHaveLength(2);
    expect(requests[0]?.variables).toEqual({ rsid: 'rs11591147', dataset: 'gnomad_r4' });
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

/** One population row as gnomAD sends it: [id, ac, an, homozygote_count, hemizygote_count]. */
type PopulationRow = readonly [string, number, number, number, number | null];

/** A callset (or joint) record as gnomAD sends it, from its totals and population rows. */
function frequencyRecord(
  ac: number,
  an: number,
  homozygoteCount: number,
  rows: readonly PopulationRow[],
) {
  return {
    ac,
    an,
    homozygote_count: homozygoteCount,
    hemizygote_count: 0,
    populations: rows.map(([id, popAc, popAn, hom, hemi]) => ({
      id,
      ac: popAc,
      an: popAn,
      homozygote_count: hom,
      hemizygote_count: hemi,
    })),
  };
}

/**
 * Live gnomAD records captured 2026-11-01 (UTC): each callset's totals and every
 * population row except the 1000 Genomes/HGDP subpopulations, of which two real
 * gnomad_r3 rows are kept. The upstream `af` is ac/an and is filled in below.
 */
const LIVE = {
  r3_974: {
    variant_id: '1-55039974-G-T',
    reference_genome: 'GRCh38',
    exome: null,
    genome: frequencyRecord(1866, 152286, 17, [
      ['oth', 27, 2094, 0, 0],
      ['oth_XX', 13, 1034, 0, 0],
      ['oth_XY', 14, 1060, 0, 0],
      ['amr', 133, 15292, 1, 0],
      ['amr_XX', 61, 6790, 0, 0],
      ['amr_XY', 72, 8502, 1, 0],
      ['fin', 467, 10630, 11, 0],
      ['fin_XX', 103, 2574, 3, 0],
      ['fin_XY', 364, 8056, 8, 0],
      ['ami', 6, 912, 0, 0],
      ['ami_XX', 2, 470, 0, 0],
      ['ami_XY', 4, 442, 0, 0],
      ['eas', 0, 5200, 0, 0],
      ['eas_XX', 0, 2282, 0, 0],
      ['eas_XY', 0, 2918, 0, 0],
      ['mid', 0, 316, 0, 0],
      ['mid_XX', 0, 164, 0, 0],
      ['mid_XY', 0, 152, 0, 0],
      ['afr', 109, 41480, 1, 0],
      ['afr_XX', 50, 22170, 0, 0],
      ['afr_XY', 59, 19310, 1, 0],
      ['sas', 4, 4836, 0, 0],
      ['sas_XX', 1, 1166, 0, 0],
      ['sas_XY', 3, 3670, 0, 0],
      ['asj', 16, 3472, 0, 0],
      ['asj_XX', 7, 1868, 0, 0],
      ['asj_XY', 9, 1604, 0, 0],
      ['nfe', 1104, 68054, 4, 0],
      ['nfe_XX', 627, 39370, 1, 0],
      ['nfe_XY', 477, 28684, 3, 0],
      ['XX', 864, 77888, 4, 0],
      ['XY', 1002, 74398, 13, 0],
      ['hgdp:balochi', 1, 42, 0, 0],
      ['hgdp:russian', 1, 50, 0, 0],
    ]),
    joint: null,
  },
  r2_1_647: {
    variant_id: '1-55505647-G-T',
    reference_genome: 'GRCh37',
    exome: frequencyRecord(2341, 196220, 29, [
      ['afr', 28, 11560, 0, 0],
      ['afr_XX', 17, 7170, 0, 0],
      ['afr_XY', 11, 4390, 0, 0],
      ['amr', 189, 29350, 1, 0],
      ['amr_XX', 99, 16978, 0, 0],
      ['amr_XY', 90, 12372, 1, 0],
      ['asj', 42, 9042, 0, 0],
      ['asj_XX', 18, 4290, 0, 0],
      ['asj_XY', 24, 4752, 0, 0],
      ['eas', 0, 14742, 0, 0],
      ['eas_jpn', 0, 80, 0, null],
      ['eas_kor', 0, 3122, 0, null],
      ['eas_oea', 0, 11540, 0, null],
      ['eas_XX', 0, 7330, 0, 0],
      ['eas_XY', 0, 7412, 0, 0],
      ['fin', 717, 17188, 19, 0],
      ['fin_XX', 367, 8724, 11, 0],
      ['fin_XY', 350, 8464, 8, 0],
      ['nfe', 1270, 84162, 9, 0],
      ['nfe_bgr', 10, 1564, 0, null],
      ['nfe_est', 1, 214, 0, null],
      ['nfe_nwe', 608, 37854, 6, null],
      ['nfe_onf', 326, 24052, 0, null],
      ['nfe_seu', 89, 5846, 2, null],
      ['nfe_swe', 236, 14632, 1, null],
      ['nfe_XX', 552, 37496, 4, 0],
      ['nfe_XY', 718, 46666, 5, 0],
      ['oth', 66, 5142, 0, 0],
      ['oth_XX', 31, 2488, 0, 0],
      ['oth_XY', 35, 2654, 0, 0],
      ['sas', 29, 25034, 0, 0],
      ['sas_XX', 7, 6348, 0, 0],
      ['sas_XY', 22, 18686, 0, 0],
      ['XX', 1091, 90824, 15, 0],
      ['XY', 1250, 105396, 14, 0],
    ]),
    genome: frequencyRecord(441, 31400, 8, [
      ['afr', 25, 8710, 1, 0],
      ['afr_XX', 7, 3680, 0, 0],
      ['afr_XY', 18, 5030, 1, 0],
      ['amr', 4, 848, 0, 0],
      ['amr_XX', 2, 414, 0, 0],
      ['amr_XY', 2, 434, 0, 0],
      ['asj', 2, 290, 0, 0],
      ['asj_XX', 1, 80, 0, 0],
      ['asj_XY', 1, 210, 0, 0],
      ['eas', 0, 1560, 0, 0],
      ['eas_XX', 0, 538, 0, 0],
      ['eas_XY', 0, 1022, 0, 0],
      ['fin', 163, 3476, 6, 0],
      ['fin_XX', 81, 1846, 2, 0],
      ['fin_XY', 82, 1630, 4, 0],
      ['nfe', 231, 15430, 1, 0],
      ['nfe_est', 67, 4592, 0, null],
      ['nfe_nwe', 137, 8594, 1, null],
      ['nfe_onf', 27, 2138, 0, null],
      ['nfe_seu', 0, 106, 0, null],
      ['nfe_XX', 94, 6810, 0, 0],
      ['nfe_XY', 137, 8620, 1, 0],
      ['oth', 16, 1086, 0, 0],
      ['oth_XX', 12, 560, 0, 0],
      ['oth_XY', 4, 526, 0, 0],
      ['sas', 0, 0, 0, 0],
      ['sas_XX', 0, 0, 0, 0],
      ['sas_XY', 0, 0, 0, 0],
      ['XX', 197, 13928, 2, 0],
      ['XY', 244, 17472, 6, 0],
    ]),
    joint: null,
  },
  exac_647: {
    variant_id: '1-55505647-G-T',
    reference_genome: 'GRCh37',
    exome: frequencyRecord(689, 31082, 5, [
      ['afr', 14, 3388, 0, 0],
      ['amr', 29, 1308, 0, 0],
      ['eas', 0, 1548, 0, 0],
      ['fin', 81, 452, 3, 0],
      ['nfe', 549, 15734, 2, 0],
      ['oth', 3, 248, 0, 0],
      ['sas', 13, 8404, 0, 0],
    ]),
    genome: null,
    joint: null,
  },
  r4_974: {
    variant_id: '1-55039974-G-T',
    reference_genome: 'GRCh38',
    exome: frequencyRecord(21634, 1428186, 209, [
      ['remaining', 786, 59126, 12, 0],
      ['remaining_XX', 439, 31272, 6, 0],
      ['remaining_XY', 347, 27854, 6, 0],
      ['amr', 273, 40196, 2, 0],
      ['amr_XX', 138, 22768, 0, 0],
      ['amr_XY', 135, 17428, 2, 0],
      ['fin', 1927, 50394, 37, 0],
      ['fin_XX', 989, 26402, 21, 0],
      ['fin_XY', 938, 23992, 16, 0],
      ['mid', 26, 4844, 1, 0],
      ['mid_XX', 16, 2036, 0, 0],
      ['mid_XY', 10, 2808, 1, 0],
      ['nfe', 18328, 1096136, 155, 0],
      ['nfe_XX', 9655, 566440, 74, 0],
      ['nfe_XY', 8673, 529696, 81, 0],
      ['sas', 88, 81336, 1, 0],
      ['sas_XX', 19, 21094, 0, 0],
      ['sas_XY', 69, 60242, 1, 0],
      ['asj', 131, 25476, 0, 0],
      ['asj_XX', 72, 12272, 0, 0],
      ['asj_XY', 59, 13204, 0, 0],
      ['eas', 0, 37878, 0, 0],
      ['eas_XX', 0, 19656, 0, 0],
      ['eas_XY', 0, 18222, 0, 0],
      ['afr', 75, 32800, 1, 0],
      ['afr_XX', 45, 18908, 1, 0],
      ['afr_XY', 30, 13892, 0, 0],
      ['XX', 11373, 720848, 102, 0],
      ['XY', 10261, 707338, 107, 0],
    ]),
    genome: frequencyRecord(1866, 152404, 17, [
      ['remaining', 27, 2116, 0, 0],
      ['remaining_XX', 13, 1050, 0, 0],
      ['remaining_XY', 14, 1066, 0, 0],
      ['amr', 133, 15312, 1, 0],
      ['amr_XX', 61, 6796, 0, 0],
      ['amr_XY', 72, 8516, 1, 0],
      ['fin', 467, 10630, 11, 0],
      ['fin_XX', 103, 2574, 3, 0],
      ['fin_XY', 364, 8056, 8, 0],
      ['ami', 6, 912, 0, 0],
      ['ami_XX', 2, 470, 0, 0],
      ['ami_XY', 4, 442, 0, 0],
      ['eas', 0, 5188, 0, 0],
      ['eas_XX', 0, 2272, 0, 0],
      ['eas_XY', 0, 2916, 0, 0],
      ['mid', 0, 294, 0, 0],
      ['mid_XX', 0, 144, 0, 0],
      ['mid_XY', 0, 150, 0, 0],
      ['sas', 4, 4832, 0, 0],
      ['sas_XX', 1, 1154, 0, 0],
      ['sas_XY', 3, 3678, 0, 0],
      ['asj', 16, 3472, 0, 0],
      ['asj_XX', 7, 1868, 0, 0],
      ['asj_XY', 9, 1604, 0, 0],
      ['afr', 109, 41602, 1, 0],
      ['afr_XX', 50, 22186, 0, 0],
      ['afr_XY', 59, 19416, 1, 0],
      ['nfe', 1104, 68046, 4, 0],
      ['nfe_XX', 627, 39364, 1, 0],
      ['nfe_XY', 477, 28682, 3, 0],
      ['XX', 864, 77878, 4, 0],
      ['XY', 1002, 74526, 13, 0],
    ]),
    joint: frequencyRecord(23500, 1580590, 226, [
      ['remaining', 813, 61242, 12, 0],
      ['remaining_XX', 452, 32322, 6, 0],
      ['remaining_XY', 361, 28920, 6, 0],
      ['amr', 406, 55508, 3, 0],
      ['amr_XX', 199, 29564, 0, 0],
      ['amr_XY', 207, 25944, 3, 0],
      ['fin', 2394, 61024, 48, 0],
      ['fin_XX', 1092, 28976, 24, 0],
      ['fin_XY', 1302, 32048, 24, 0],
      ['ami', 6, 912, 0, 0],
      ['ami_XX', 2, 470, 0, 0],
      ['ami_XY', 4, 442, 0, 0],
      ['eas', 0, 43066, 0, 0],
      ['eas_XX', 0, 21928, 0, 0],
      ['eas_XY', 0, 21138, 0, 0],
      ['mid', 26, 5138, 1, 0],
      ['mid_XX', 16, 2180, 0, 0],
      ['mid_XY', 10, 2958, 1, 0],
      ['sas', 92, 86168, 1, 0],
      ['sas_XX', 20, 22248, 0, 0],
      ['sas_XY', 72, 63920, 1, 0],
      ['asj', 147, 28948, 0, 0],
      ['asj_XX', 79, 14140, 0, 0],
      ['asj_XY', 68, 14808, 0, 0],
      ['afr', 184, 74402, 2, 0],
      ['afr_XX', 95, 41094, 1, 0],
      ['afr_XY', 89, 33308, 1, 0],
      ['nfe', 19432, 1164182, 159, 0],
      ['nfe_XX', 10282, 605804, 75, 0],
      ['nfe_XY', 9150, 558378, 84, 0],
      ['', 23500, 1580590, 226, 0],
      ['XX', 12237, 798726, 106, 0],
      ['XY', 11263, 781864, 120, 0],
      ['XX', 12237, 798726, 106, 0],
      ['XY', 11263, 781864, 120, 0],
    ]),
  },
  r4_784: {
    variant_id: '1-55039784-C-G',
    reference_genome: 'GRCh38',
    exome: null,
    genome: frequencyRecord(3, 152386, 0, [
      ['remaining', 0, 2116, 0, 0],
      ['remaining_XX', 0, 1050, 0, 0],
      ['remaining_XY', 0, 1066, 0, 0],
      ['amr', 0, 15312, 0, 0],
      ['amr_XX', 0, 6798, 0, 0],
      ['amr_XY', 0, 8514, 0, 0],
      ['fin', 0, 10632, 0, 0],
      ['fin_XX', 0, 2574, 0, 0],
      ['fin_XY', 0, 8058, 0, 0],
      ['ami', 0, 912, 0, 0],
      ['ami_XX', 0, 470, 0, 0],
      ['ami_XY', 0, 442, 0, 0],
      ['eas', 0, 5178, 0, 0],
      ['eas_XX', 0, 2264, 0, 0],
      ['eas_XY', 0, 2914, 0, 0],
      ['mid', 0, 294, 0, 0],
      ['mid_XX', 0, 144, 0, 0],
      ['mid_XY', 0, 150, 0, 0],
      ['sas', 0, 4834, 0, 0],
      ['sas_XX', 0, 1154, 0, 0],
      ['sas_XY', 0, 3680, 0, 0],
      ['asj', 0, 3472, 0, 0],
      ['asj_XX', 0, 1868, 0, 0],
      ['asj_XY', 0, 1604, 0, 0],
      ['afr', 3, 41594, 0, 0],
      ['afr_XX', 1, 22180, 0, 0],
      ['afr_XY', 2, 19414, 0, 0],
      ['nfe', 0, 68042, 0, 0],
      ['nfe_XX', 0, 39364, 0, 0],
      ['nfe_XY', 0, 28678, 0, 0],
      ['XX', 1, 77866, 0, 0],
      ['XY', 2, 74520, 0, 0],
    ]),
    joint: frequencyRecord(3, 1558598, 0, [
      ['remaining', 0, 60316, 0, 0],
      ['remaining_XX', 0, 31884, 0, 0],
      ['remaining_XY', 0, 28432, 0, 0],
      ['amr', 0, 52708, 0, 0],
      ['amr_XX', 0, 27876, 0, 0],
      ['amr_XY', 0, 24832, 0, 0],
      ['fin', 0, 59748, 0, 0],
      ['fin_XX', 0, 28452, 0, 0],
      ['fin_XY', 0, 31296, 0, 0],
      ['ami', 0, 912, 0, 0],
      ['ami_XX', 0, 470, 0, 0],
      ['ami_XY', 0, 442, 0, 0],
      ['eas', 0, 42946, 0, 0],
      ['eas_XX', 0, 21874, 0, 0],
      ['eas_XY', 0, 21072, 0, 0],
      ['mid', 0, 4372, 0, 0],
      ['mid_XX', 0, 1782, 0, 0],
      ['mid_XY', 0, 2590, 0, 0],
      ['sas', 0, 84986, 0, 0],
      ['sas_XX', 0, 21996, 0, 0],
      ['sas_XY', 0, 62990, 0, 0],
      ['asj', 0, 28620, 0, 0],
      ['asj_XX', 0, 13958, 0, 0],
      ['asj_XY', 0, 14662, 0, 0],
      ['afr', 3, 74272, 0, 0],
      ['afr_XX', 1, 41020, 0, 0],
      ['afr_XY', 2, 33252, 0, 0],
      ['nfe', 0, 1149718, 0, 0],
      ['nfe_XX', 0, 599500, 0, 0],
      ['nfe_XY', 0, 550218, 0, 0],
      ['', 3, 1558598, 0, 0],
      ['XX', 1, 788812, 0, 0],
      ['XY', 2, 769786, 0, 0],
      ['XX', 1, 788812, 0, 0],
      ['XY', 2, 769786, 0, 0],
    ]),
  },
} as const;

type LiveKey = keyof typeof LIVE;

/** The VariantDetails payload gnomAD returns for a live record (`af` = ac/an on each callset). */
function liveVariant(key: LiveKey) {
  const { exome, genome, joint, ...identity } = LIVE[key];
  const withAf = (callset: typeof exome | typeof genome) =>
    callset && { ...callset, af: callset.ac / callset.an };
  return {
    ...identity,
    rsids: [],
    flags: [],
    exome: withAf(exome),
    genome: withAf(genome),
    joint,
    transcript_consequences: null,
    in_silico_predictors: null,
  };
}

const LIVE_DATASET: Record<LiveKey, 'gnomad_r4' | 'gnomad_r3' | 'gnomad_r2_1' | 'exac'> = {
  r3_974: 'gnomad_r3',
  r2_1_647: 'gnomad_r2_1',
  exac_647: 'exac',
  r4_974: 'gnomad_r4',
  r4_784: 'gnomad_r4',
};

/** Resolve a live record through the real service, faking only fetch. */
async function liveRecord(key: LiveKey) {
  const requests = fakeGraphql(() => ({
    data: { variant: liveVariant(key), clinvar_variant: null },
  }));
  const svc = new GnomadService(getServerConfig());
  const result = await svc.getVariant(
    LIVE[key].variant_id,
    svc.resolveDatasetContext(LIVE_DATASET[key]),
    createMockContext(),
  );
  return { result, requests };
}

describe('GnomadService ancestry groups across datasets (#55)', () => {
  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/55
  it.each<[LiveKey, 'exome' | 'genome', number, number, string[]]>([
    [
      'r3_974',
      'genome',
      1866,
      152286,
      ['oth', 'amr', 'fin', 'ami', 'eas', 'mid', 'afr', 'sas', 'asj', 'nfe'],
    ],
    ['r2_1_647', 'exome', 2341, 196220, ['afr', 'amr', 'asj', 'eas', 'fin', 'nfe', 'oth', 'sas']],
    ['r2_1_647', 'genome', 441, 31400, ['afr', 'amr', 'asj', 'eas', 'fin', 'nfe', 'oth', 'sas']],
    ['exac_647', 'exome', 689, 31082, ['afr', 'amr', 'eas', 'fin', 'nfe', 'oth', 'sas']],
  ])(
    'returns every top-level group of %s %s, so the groups sum to the callset AC and AN',
    async (key, source, callsetAc, callsetAn, ids) => {
      const { result } = await liveRecord(key);

      const groups = result?.populations.filter((population) => population.source === source);
      expect(groups?.map((population) => population.id)).toEqual(ids);
      expect(groups?.reduce((sum, population) => sum + population.ac, 0)).toBe(callsetAc);
      expect(groups?.reduce((sum, population) => sum + population.an, 0)).toBe(callsetAn);
    },
  );

  it.each<[LiveKey, 'exome' | 'genome', number]>([
    ['r3_974', 'genome', 27],
    ['r2_1_647', 'exome', 66],
    ['r2_1_647', 'genome', 16],
    ['exac_647', 'exome', 3],
  ])('returns oth from %s %s with AC %i', async (key, source, ac) => {
    const { result } = await liveRecord(key);

    expect(result?.populations).toContainEqual(expect.objectContaining({ id: 'oth', source, ac }));
  });

  it('drops the sex-split, subgroup, and HGDP rows the same payload carries', async () => {
    const decoys = ['oth_XX', 'eas_jpn', 'nfe_bgr', 'XX', 'hgdp:balochi'];
    const sent = [LIVE.r2_1_647.exome, LIVE.r2_1_647.genome, LIVE.r3_974.genome].flatMap(
      (callset) => callset.populations.map((population) => population.id),
    );
    expect(sent).toEqual(expect.arrayContaining(decoys));

    const ids = [
      ...((await liveRecord('r2_1_647')).result?.populations ?? []),
      ...((await liveRecord('r3_974')).result?.populations ?? []),
    ].map((population) => population.id);

    expect(ids.length).toBeGreaterThan(0);
    for (const decoy of decoys) expect(ids).not.toContain(decoy);
  });

  it('keeps remaining and carries no oth on gnomad_r4', async () => {
    const { result } = await liveRecord('r4_974');

    const remaining = result?.populations.filter((population) => population.id === 'remaining');
    expect(remaining?.map(({ source, ac }) => [source, ac])).toEqual([
      ['exome', 786],
      ['genome', 27],
    ]);
    expect(result?.populations.map((population) => population.id)).not.toContain('oth');
  });
});

describe('GnomadService joint frequencies (#53)', () => {
  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/53
  it('reads the overall counts of a genome-only gnomad_r4 variant from joint, across both callsets', async () => {
    const { result } = await liveRecord('r4_784');

    expect(result).toMatchObject({
      ac: 3,
      an: 1_558_598,
      af: 3 / 1_558_598,
      homozygote_count: 0,
      hemizygote_count: 0,
      source: ['genome'],
    });
    // The genome callset alone: 3 / 152,386.
    expect(result?.af).not.toBe(3 / 152_386);
    expect(result?.populations.length).toBeGreaterThan(0);
    expect(new Set(result?.populations.map((population) => population.source))).toEqual(
      new Set(['genome']),
    );
  });

  it('returns the ten joint ancestry groups, without the blank, XX/XY, or sex-split rows', async () => {
    const sent = LIVE.r4_784.joint.populations.map((population) => population.id);
    expect(sent).toEqual(expect.arrayContaining(['', 'XX', 'XY', 'afr_XX']));

    const { result } = await liveRecord('r4_784');

    expect(result?.joint_populations).toEqual(
      [
        ['remaining', 0, 60316],
        ['amr', 0, 52708],
        ['fin', 0, 59748],
        ['ami', 0, 912],
        ['eas', 0, 42946],
        ['mid', 0, 4372],
        ['sas', 0, 84986],
        ['asj', 0, 28620],
        ['afr', 3, 74272],
        ['nfe', 0, 1149718],
      ].map(([id, ac, an]) => ({
        id,
        ac,
        an,
        af: Number(ac) / Number(an),
        homozygote_count: 0,
        hemizygote_count: 0,
      })),
    );
  });

  it('reads a dual-callset gnomad_r4 variant from joint, which equals the callset sums there', async () => {
    const { result } = await liveRecord('r4_974');

    expect(result).toMatchObject({
      ac: 23500,
      an: 1_580_590,
      af: 23500 / 1_580_590,
      homozygote_count: 226,
      source: ['exome', 'genome'],
    });
    expect(result?.joint_populations.map((population) => population.id)).toEqual([
      'remaining',
      'amr',
      'fin',
      'ami',
      'eas',
      'mid',
      'sas',
      'asj',
      'afr',
      'nfe',
    ]);
    expect(result?.joint_populations.find((population) => population.id === 'nfe')).toEqual({
      id: 'nfe',
      ac: 19432,
      an: 1_164_182,
      af: 19432 / 1_164_182,
      homozygote_count: 159,
      hemizygote_count: 0,
    });
  });

  it.each<[LiveKey, number, number]>([
    ['r3_974', 1866, 152286],
    ['r2_1_647', 2782, 227620],
    ['exac_647', 689, 31082],
  ])(
    'keeps the carried-callset sum on %s, where joint is null, with no joint groups',
    async (key, ac, an) => {
      const { result } = await liveRecord(key);

      expect(result).toMatchObject({ ac, an, af: ac / an });
      expect(result?.joint_populations).toEqual([]);
    },
  );

  it('selects the joint totals and joint groups in the variant document', async () => {
    const { requests } = await liveRecord('r4_784');

    expect(requests[0]?.query.replace(/\s+/g, ' ')).toContain(
      'joint { ac an homozygote_count hemizygote_count faf95 { popmax popmax_population } populations { id ac an homozygote_count hemizygote_count } }',
    );
  });

  it('reads list rows from joint, and keeps a row with no joint record and no counts unknown', async () => {
    const requests = fakeGraphql(() => ({
      data: {
        gene: {
          chrom: '1',
          variants: [
            // Live PCSK9 row, gnomad_r4, captured 2026-11-01 (UTC).
            {
              variant_id: '1-55039784-C-G',
              consequence: '5_prime_UTR_variant',
              flags: [],
              exome: null,
              genome: { ac: 3, an: 152386, af: 3 / 152386, homozygote_count: 0 },
              joint: { ac: 3, an: 1_558_598, homozygote_count: 0 },
            },
            {
              variant_id: '1-101-A-G',
              consequence: null,
              flags: null,
              exome: { ac: null, an: null, af: null, homozygote_count: null },
              genome: null,
              joint: null,
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

    expect(rows[0]).toMatchObject({ ac: 3, an: 1_558_598, af: 3 / 1_558_598, source: 'genome' });
    expect(rows[1]).toMatchObject({ af: null, ac: 0, an: 0, homozygote_count: 0, source: '' });
    const query = requests[0]?.query.replace(/\s+/g, ' ') ?? '';
    expect(query).toContain(
      'joint { ac an homozygote_count hemizygote_count fafmax @include(if: $jointFafmax) { faf95_max faf95_max_gen_anc } }',
    );
    // joint.populations feeds no column and would multiply the response about 3.6×.
    expect(query).not.toMatch(/joint \{[^}]*populations/);
  });
});

/**
 * Callset totals and QC filters of live gnomad_r4 VariantDetails records,
 * captured 2026-11-01 (UTC), with population rows left out. `joint.filters` is
 * the live value too: it disagrees with the callsets and must never decide QC.
 */
const QC_DETAIL = {
  '1-55039866-G-A': {
    exome: [0, 1_410_978, 0, ['AC0']],
    genome: null,
    joint: [0, 1_562_614, 0, []],
  },
  '1-55039800-G-A': {
    exome: [4, 1_415_942, 0, ['AS_VQSR']],
    genome: null,
    joint: [4, 1_568_302, 0, []],
  },
  '1-55039793-C-T': {
    exome: [0, 1_412_788, 0, ['AC0']],
    genome: [3, 152_276, 0, []],
    joint: [3, 1_565_064, 0, ['discrepant_frequencies']],
  },
  '1-55039974-G-T': {
    exome: [21_634, 1_428_186, 209, []],
    genome: [1_866, 152_404, 17, []],
    joint: [23_500, 1_580_590, 226, []],
  },
} as const;

type QcCallset = readonly [number, number, number, readonly string[]] | null;

/** A callset (or joint) record as gnomAD sends it: totals, filters, no population rows. */
function qcCallset(callset: QcCallset, withAf = true) {
  if (!callset) return null;
  const [ac, an, hom, filters] = callset;
  return {
    ac,
    an,
    ...(withAf && { af: ac / an }),
    homozygote_count: hom,
    hemizygote_count: 0,
    filters: [...filters],
    populations: [],
  };
}

function qcDetail(variantId: keyof typeof QC_DETAIL) {
  const { exome, genome, joint } = QC_DETAIL[variantId];
  return {
    variant_id: variantId,
    reference_genome: 'GRCh38',
    rsids: [],
    flags: [],
    exome: qcCallset(exome),
    genome: qcCallset(genome),
    joint: qcCallset(joint, false),
    transcript_consequences: null,
    in_silico_predictors: null,
  };
}

/** Rows of the live gnomad_r4 PCSK9 gene list, captured 2026-11-01 (UTC), as the list document selects them. */
const QC_LIST_R4 = [
  {
    variant_id: '1-55039793-C-T',
    consequence: '5_prime_UTR_variant',
    flags: [],
    exome: { ac: 0, an: 1412788, af: 0, homozygote_count: 0, filters: ['AC0'] },
    genome: { ac: 3, an: 152276, af: 0.00001970106911135044, homozygote_count: 0, filters: [] },
    joint: { ac: 3, an: 1565064, homozygote_count: 0 },
  },
  {
    variant_id: '1-55039766-G-T',
    consequence: '5_prime_UTR_variant',
    flags: [],
    exome: { ac: 0, an: 1380722, af: 0, homozygote_count: 0, filters: ['AC0', 'AS_VQSR'] },
    genome: null,
    joint: { ac: 0, an: 1533108, homozygote_count: 0 },
  },
  {
    variant_id: '1-55039784-C-G',
    consequence: '5_prime_UTR_variant',
    flags: [],
    exome: null,
    genome: { ac: 3, an: 152386, af: 0.000019686847873164203, homozygote_count: 0, filters: [] },
    joint: { ac: 3, an: 1558598, homozygote_count: 0 },
  },
  {
    variant_id: '1-55046674-A-C',
    consequence: 'intron_variant',
    flags: [],
    exome: null,
    genome: { ac: 0, an: 146584, af: 0, homozygote_count: 0, filters: ['AC0'] },
    joint: { ac: 0, an: 1606364, homozygote_count: 0 },
  },
  {
    variant_id: '1-55052616-T-G',
    consequence: 'intron_variant',
    flags: [],
    exome: { ac: 0, an: 1457636, af: 0, homozygote_count: 0, filters: ['AC0', 'AS_VQSR'] },
    genome: {
      ac: 2,
      an: 151386,
      af: 0.000013211261279114317,
      homozygote_count: 0,
      filters: ['AS_VQSR'],
    },
    joint: { ac: 2, an: 1609022, homozygote_count: 0 },
  },
  {
    variant_id: '1-55039974-G-T',
    consequence: 'missense_variant',
    flags: [],
    exome: {
      ac: 21634,
      an: 1428186,
      af: 0.015147886899885589,
      homozygote_count: 209,
      filters: [],
    },
    genome: { ac: 1866, an: 152404, af: 0.01224377312931419, homozygote_count: 17, filters: [] },
    joint: { ac: 23500, an: 1580590, homozygote_count: 226 },
  },
];

/** Rows of the live gnomad_r2_1 PCSK9 region 1-55505475-55505477, captured 2026-11-01 (UTC). */
const QC_LIST_R21 = [
  {
    variant_id: '1-55505475-C-T',
    consequence: '5_prime_UTR_variant',
    flags: [],
    exome: { ac: 1, an: 178702, af: 0.000005595908271871607, homozygote_count: 0, filters: ['RF'] },
    genome: null,
    joint: null,
  },
  {
    variant_id: '1-55505477-C-T',
    consequence: '5_prime_UTR_variant',
    flags: [],
    exome: { ac: 2, an: 178734, af: 0.000011189812794431949, homozygote_count: 0, filters: [] },
    genome: { ac: 1, an: 31404, af: 0.00003184307731499172, homozygote_count: 0, filters: [] },
    joint: null,
  },
];

/** The QC columns of each list row, keyed by variant ID. */
async function listQc(variants: unknown[], dataset: 'gnomad_r4' | 'gnomad_r2_1' = 'gnomad_r4') {
  const requests = fakeGraphql(() => ({ data: { gene: { chrom: '1', variants } } }));
  const svc = new GnomadService(getServerConfig());
  const rows = await svc.listGeneVariants(
    { kind: 'gene', value: 'PCSK9' },
    {},
    svc.resolveDatasetContext(dataset),
    createMockContext(),
  );
  const qc = Object.fromEntries(
    rows.map((row) => [
      row.variant_id,
      [row.exome_filters, row.genome_filters, row.qc_status] as const,
    ]),
  );
  return { rows, qc, requests };
}

describe('GnomadService QC filters (#54)', () => {
  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/54
  it('selects filters on both callsets of the variant and list documents, never on joint', async () => {
    const detail = fakeGraphql(() => ({
      data: { variant: qcDetail('1-55039974-G-T'), clinvar_variant: null },
    }));
    const svc = new GnomadService(getServerConfig());
    await svc.getVariant(
      '1-55039974-G-T',
      svc.resolveDatasetContext('gnomad_r4'),
      createMockContext(),
    );
    const { requests: list } = await listQc(QC_LIST_R4);

    for (const query of [detail[0]?.query, list[0]?.query]) {
      const flat = query?.replace(/\s+/g, ' ') ?? '';
      expect(flat).toMatch(/exome \{[^}]*\bfilters\b/);
      expect(flat).toMatch(/genome \{[^}]*\bfilters\b/);
      expect(flat).not.toMatch(/joint \{[^}]*\bfilters\b/);
    }
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/54
  it.each<[keyof typeof QC_DETAIL, 'pass' | 'filtered', unknown, unknown]>([
    [
      '1-55039866-G-A',
      'filtered',
      { ac: 0, an: 1_410_978, af: 0, homozygote_count: 0, hemizygote_count: 0, filters: ['AC0'] },
      null,
    ],
    [
      '1-55039800-G-A',
      'filtered',
      {
        ac: 4,
        an: 1_415_942,
        af: 4 / 1_415_942,
        homozygote_count: 0,
        hemizygote_count: 0,
        filters: ['AS_VQSR'],
      },
      null,
    ],
    [
      '1-55039793-C-T',
      'pass',
      { ac: 0, an: 1_412_788, af: 0, homozygote_count: 0, hemizygote_count: 0, filters: ['AC0'] },
      {
        ac: 3,
        an: 152_276,
        af: 3 / 152_276,
        homozygote_count: 0,
        hemizygote_count: 0,
        filters: [],
      },
    ],
    [
      '1-55039974-G-T',
      'pass',
      {
        ac: 21_634,
        an: 1_428_186,
        af: 21_634 / 1_428_186,
        homozygote_count: 209,
        hemizygote_count: 0,
        filters: [],
      },
      {
        ac: 1_866,
        an: 152_404,
        af: 1_866 / 152_404,
        homozygote_count: 17,
        hemizygote_count: 0,
        filters: [],
      },
    ],
  ])(
    'returns %s as qc_status %s with each callset on its own counts and filters',
    async (variantId, qcStatus, exome, genome) => {
      fakeGraphql(() => ({ data: { variant: qcDetail(variantId), clinvar_variant: null } }));
      const svc = new GnomadService(getServerConfig());

      const record = await svc.getVariant(
        variantId,
        svc.resolveDatasetContext('gnomad_r4'),
        createMockContext(),
      );

      // qcDetail selects no faf95, which reads as null (#64).
      const noFaf = (callset: unknown) => callset && { ...(callset as object), faf95: null };
      expect(record?.callsets).toEqual({ exome: noFaf(exome), genome: noFaf(genome) });
      expect(record?.qc_status).toBe(qcStatus);
      // The overall counts still read joint; callsets carry the per-callset view beside them.
      expect(record?.ac).toBe(QC_DETAIL[variantId].joint[0]);
    },
  );

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/54
  it('reads a carried callset with no filter list as unproven, never as a pass', async () => {
    // A reply to a document that predates the filters selection: the genome record has no `filters`.
    fakeGraphql(() => ({
      data: {
        variant: {
          ...qcDetail('1-55039974-G-T'),
          variant_id: '1-55039784-C-G',
          exome: null,
          genome: {
            ac: 3,
            an: 152_386,
            af: 3 / 152_386,
            homozygote_count: 0,
            hemizygote_count: 0,
            populations: [],
          },
          joint: null,
        },
        clinvar_variant: null,
      },
    }));
    const svc = new GnomadService(getServerConfig());

    const record = await svc.getVariant(
      '1-55039784-C-G',
      svc.resolveDatasetContext('gnomad_r4'),
      createMockContext(),
    );

    expect(record?.source).toEqual(['genome']);
    expect(record?.callsets.genome).toEqual({
      ac: 3,
      an: 152_386,
      af: 3 / 152_386,
      homozygote_count: 0,
      hemizygote_count: 0,
      filters: null,
      faf95: null,
    });
    expect(record?.qc_status).toBe('filtered');
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/54
  it("computes each callset's af from its own ac and an, never from gnomAD's af field", async () => {
    // gnomAD types a callset's af nullable; a null one must not reach callsets.*.af.
    fakeGraphql(() => ({
      data: {
        variant: {
          ...qcDetail('1-55039793-C-T'),
          exome: {
            ac: 0,
            an: 1_412_788,
            af: null,
            homozygote_count: 0,
            hemizygote_count: 0,
            filters: ['AC0'],
            populations: [],
          },
          genome: {
            ac: 3,
            an: 152_276,
            af: null,
            homozygote_count: 0,
            hemizygote_count: 0,
            filters: [],
            populations: [],
          },
        },
        clinvar_variant: null,
      },
    }));
    const svc = new GnomadService(getServerConfig());

    const record = await svc.getVariant(
      '1-55039793-C-T',
      svc.resolveDatasetContext('gnomad_r4'),
      createMockContext(),
    );

    expect(record?.callsets.exome?.af).toBe(0);
    expect(record?.callsets.genome?.af).toBe(3 / 152_276);
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/54
  it('derives each list row from its callsets: any carried callset passing makes the row pass', async () => {
    const { qc } = await listQc(QC_LIST_R4);

    expect(qc).toEqual({
      '1-55039793-C-T': ['AC0', '', 'pass'],
      '1-55039766-G-T': ['AC0|AS_VQSR', null, 'filtered'],
      '1-55039784-C-G': [null, '', 'pass'],
      '1-55046674-A-C': [null, 'AC0', 'filtered'],
      '1-55052616-T-G': ['AC0|AS_VQSR', 'AS_VQSR', 'filtered'],
      '1-55039974-G-T': ['', '', 'pass'],
    });
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/54
  it('reads a dataset-specific filter (gnomad_r2_1 RF) as filtered without a known-filter list', async () => {
    const { qc } = await listQc(QC_LIST_R21, 'gnomad_r2_1');

    expect(qc).toEqual({
      '1-55505475-C-T': ['RF', null, 'filtered'],
      '1-55505477-C-T': ['', '', 'pass'],
    });
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/54
  it('gives a callset that does not carry the variant, or carries no filter list, a null column', async () => {
    const { rows, qc } = await listQc([
      {
        variant_id: '1-101-A-G',
        consequence: null,
        flags: null,
        exome: { ac: null, an: null, af: null, homozygote_count: null, filters: [] },
        genome: null,
        joint: null,
      },
      {
        variant_id: '1-102-A-G',
        consequence: null,
        flags: null,
        exome: { ac: 1, an: 1_000, af: 0.001, homozygote_count: 0 },
        genome: null,
        joint: null,
      },
    ]);

    expect(rows.map((row) => row.source)).toEqual(['', 'exome']);
    expect(qc).toEqual({
      '1-101-A-G': [null, null, 'filtered'],
      '1-102-A-G': [null, null, 'filtered'],
    });
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

/** Live PCSK9 constraint objects per build, as `gene { gnomad_constraint exac_constraint mitochondrial_constraint }` returns them. */
const PCSK9_CONSTRAINT = {
  GRCh38: {
    gnomad_constraint: {
      pli: 2.765187110917756e-18,
      oe_lof: 0.9176378304213768,
      oe_lof_lower: 0.7416265467075939,
      oe_lof_upper: 1.1441346736692857,
      oe_lof_percentile: 71,
      oe_mis: 0.906450937101462,
      oe_mis_lower: 0.857514089563757,
      oe_mis_upper: 0.9586561741086429,
      oe_syn: 0.9453046063830313,
      oe_syn_lower: 0.8700186318667248,
      oe_syn_upper: 1.028252849618702,
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
    mitochondrial_constraint: null,
  },
  GRCh37: {
    gnomad_constraint: {
      pli: 2.7059204562649786e-17,
      oe_lof: 0.9662316499147062,
      // biome-ignore lint/suspicious/noApproximativeNumericConstant: gnomAD's live PCSK9 v2.1.1 LOEUF lower bound, not √½.
      oe_lof_lower: 0.707,
      oe_lof_upper: 1.341,
      oe_lof_percentile: null,
      oe_mis: 0.9632446051921747,
      oe_mis_lower: 0.888,
      oe_mis_upper: 1.044,
      oe_syn: 0.9066008152125259,
      oe_syn_lower: 0.799,
      oe_syn_upper: 1.03,
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
    mitochondrial_constraint: null,
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
      oe_lof_percentile: null,
      oe_mis: null,
      oe_mis_lower: null,
      oe_mis_upper: null,
      oe_syn: null,
      oe_syn_lower: null,
      oe_syn_upper: null,
      constraint_flags: [],
      mitochondrial_constraint: null,
    });
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/73
  it.each([
    ['symbol', 'MT-CO1'],
    ['Ensembl ID', 'ENSG00000198804'],
  ])(
    'selects both mitochondrial constraint members, typename included, in the by-%s document',
    async (_label, gene) => {
      const requests = fakePcsk9Constraint();
      const svc = new GnomadService(getServerConfig());

      await svc.getGeneConstraint(
        gene,
        svc.resolveDatasetContext('gnomad_r4'),
        createMockContext(),
      );

      const query = requests[0]?.query.replace(/\s+/g, ' ') ?? '';
      expect(query).toMatch(/mitochondrial_constraint \{ __typename /);
      const member = (name: string) =>
        new RegExp(`\\.\\.\\. on ${name} \\{([^}]*)\\}`).exec(query)?.[1]?.trim().split(' ') ?? [];
      expect(member('ProteinMitochondrialGeneConstraint').sort()).toEqual(
        ['lof', 'mis', 'syn']
          .flatMap((c) => [`obs_${c}`, `exp_${c}`, `oe_${c}`, `oe_${c}_lower`, `oe_${c}_upper`])
          .sort(),
      );
      expect(member('RNAMitochondrialGeneConstraint').sort()).toEqual(
        ['observed', 'expected', 'oe', 'oe_lower', 'oe_upper'].sort(),
      );
    },
  );

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/73
  it.each(['gnomad_r4', 'gnomad_r3', 'gnomad_r2_1', 'exac', 'gnomad_r4_non_ukb'] as const)(
    'reads the mitochondrial constraint beside the %s table, by build',
    async (dataset) => {
      const requests = fakeLiveConstraint();
      const svc = new GnomadService(getServerConfig());

      const protein = await svc.getGeneConstraint(
        'MT-CO1',
        svc.resolveDatasetContext(dataset),
        createMockContext(),
      );
      const rna = await svc.getGeneConstraint(
        'MT-RNR1',
        svc.resolveDatasetContext(dataset),
        createMockContext(),
      );

      expect(requests.map((request) => request.variables.referenceGenome)).toEqual(
        Array(2).fill(dataset === 'gnomad_r2_1' || dataset === 'exac' ? 'GRCh37' : 'GRCh38'),
      );
      expect(protein?.mitochondrial_constraint).toMatchObject({
        kind: 'protein',
        oe_lof_upper: 0.042,
        oe_mis: 0.159,
      });
      expect(protein).toMatchObject({ pli: null, oe_lof_upper: null, obs_lof: null });
      expect(rna?.mitochondrial_constraint).toEqual({
        kind: 'rna',
        observed: 315.935,
        expected: 1229.075,
        oe: 0.257,
        oe_lower: 0.234,
        oe_upper: 0.28,
      });
    },
  );

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/69
  it.each([
    ['symbol', 'PCSK9'],
    ['Ensembl ID', 'ENSG00000169174'],
  ])(
    'selects the LOEUF percentile and the missense/synonymous intervals in the by-%s document',
    async (_label, gene) => {
      const requests = fakePcsk9Constraint();
      const svc = new GnomadService(getServerConfig());

      await svc.getGeneConstraint(
        gene,
        svc.resolveDatasetContext('gnomad_r4'),
        createMockContext(),
      );

      const table = /gnomad_constraint\s*\{([^}]*)\}/.exec(requests[0]?.query ?? '')?.[1] ?? '';
      for (const field of [
        'oe_lof_percentile',
        'oe_mis_lower',
        'oe_mis_upper',
        'oe_syn_lower',
        'oe_syn_upper',
      ]) {
        expect(table).toMatch(new RegExp(`\\b${field}\\b`));
      }
      const exac = /exac_constraint\s*\{([^}]*)\}/.exec(requests[0]?.query ?? '')?.[1] ?? '';
      expect(exac).not.toMatch(/percentile|_lower|_upper/);
    },
  );

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
          mitochondrial_constraint: null,
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

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/68
describe('GnomadService constraint routing — a subset reads its parent release’s table (#68)', () => {
  it.each([
    ['gnomad_r4_non_ukb', 'GRCh38', 'gnomAD v4.1.2'],
    ['gnomad_r3_controls_and_biobanks', 'GRCh38', 'gnomAD v4.1.2'],
    ['gnomad_r3_non_cancer', 'GRCh38', 'gnomAD v4.1.2'],
    ['gnomad_r3_non_neuro', 'GRCh38', 'gnomAD v4.1.2'],
    ['gnomad_r3_non_topmed', 'GRCh38', 'gnomAD v4.1.2'],
    ['gnomad_r3_non_v2', 'GRCh38', 'gnomAD v4.1.2'],
    ['gnomad_r2_1_controls', 'GRCh37', 'gnomAD v2.1.1'],
    ['gnomad_r2_1_non_cancer', 'GRCh37', 'gnomAD v2.1.1'],
    ['gnomad_r2_1_non_neuro', 'GRCh37', 'gnomAD v2.1.1'],
    ['gnomad_r2_1_non_topmed', 'GRCh37', 'gnomAD v2.1.1'],
  ] as const)(
    'reads %s from the %s gnomad_constraint table as %s, echoing the subset',
    async (dataset, referenceGenome, release) => {
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
        constraint_release: release,
        ...metrics,
        constraint_flags: flags,
      });
    },
  );
});

describe('GnomadService gene resolution and constraint normalization', () => {
  it('reads a not-found error beside a null gene as absence', async () => {
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
                mitochondrial_constraint: null,
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
                  oe_lof_percentile: 0,
                  oe_mis: 0,
                  oe_mis_lower: 0,
                  oe_mis_upper: 0,
                  oe_syn: 0,
                  oe_syn_lower: 0,
                  oe_syn_upper: 0,
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
            mitochondrial_constraint: null,
          },
        },
      };
    });
    const svc = new GnomadService(getServerConfig());
    const dsCtx = svc.resolveDatasetContext('gnomad_r4');

    const absent = await svc.getGeneConstraint('SPARSE', dsCtx, createMockContext());
    const low = await svc.getGeneConstraint('LOW', dsCtx, createMockContext());

    expect(absent).toMatchObject({
      pli: null,
      oe_lof_upper: null,
      obs_lof: null,
      oe_lof_percentile: null,
      oe_mis_lower: null,
    });
    expect(low).toMatchObject({
      pli: 0,
      oe_lof_upper: 0,
      obs_lof: 0,
      oe_lof_percentile: 0,
      oe_mis_lower: 0,
      oe_syn_upper: 0,
    });
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
    // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/65
    // A row without lof reads it as null, and a call without annotations adds none of the five.
    expect(rows.map((row) => row.lof)).toEqual([null, null]);
    expect(rows.every((row) => !('hgvsc' in row) && !('rsids' in row))).toBe(true);
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/65
  it('sends annotations on the list document only, as the call asks, and reads its absent fields as null', async () => {
    const requests = fakeGraphql(({ query }) =>
      query.includes('coverage(')
        ? { data: { region: { coverage: { exome: [], genome: null } } } }
        : {
            data: {
              region: {
                variants: [
                  {
                    variant_id: '1-100-A-T',
                    consequence: 'stop_gained',
                    transcript_id: 'ENST1',
                    lof: 'HC',
                    flags: [],
                    exome: { ac: 1, an: 1_000, af: 0.001, homozygote_count: 0, filters: [] },
                    genome: null,
                  },
                ],
              },
            },
          },
    );
    const svc = new GnomadService(getServerConfig());
    const dsCtx = svc.resolveDatasetContext('gnomad_r4');
    const region = { kind: 'region', value: '1-100-100' } as const;

    const [annotated] = await svc.listGeneVariants(
      region,
      { annotations: true },
      dsCtx,
      createMockContext(),
    );
    const [plain] = await svc.listGeneVariants(region, {}, dsCtx, createMockContext());
    await svc.getCoverage(region, dsCtx, createMockContext());

    expect(requests.map((request) => request.variables.annotations)).toEqual([
      true,
      false,
      undefined,
    ]);
    expect(requests[0]?.query).toContain('$annotations: Boolean!');
    expect(requests[2]?.query).not.toContain('$annotations');
    // gnomAD omitted the five here, so each reads as null (rsids as none), never invented.
    expect(annotated).toMatchObject({
      lof: 'HC',
      hgvsc: null,
      hgvsp: null,
      lof_filter: null,
      lof_flags: null,
      rsids: '',
    });
    expect(plain).toMatchObject({ lof: 'HC' });
    expect(Object.keys(plain ?? {})).not.toContain('hgvsc');
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
            ...(key === 'region' ? {} : { chrom: '1', exons: [{ start: 100, stop: 100 }] }),
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

    const gene = await svc.getCoverage(
      { kind: 'gene', value: 'ENSG00000169174' },
      dsCtx,
      createMockContext(),
    );
    const transcript = await svc.getCoverage(
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
    expect(requests[0]?.query).toContain('exons { start stop }');
    expect(region[0]).toMatchObject({
      positions: 1,
      bucket_count: 1,
      bucket_size: 1,
      mean_depth: 30,
    });
    // The 1 bp bucket at 100 lies inside the exon's 25–175 interval.
    for (const feature of [gene, transcript]) {
      expect(feature[0]).toMatchObject({ positions: 1, bucket_count: 1, bucket_size: 1 });
    }
  });
});
