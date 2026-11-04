/**
 * @fileoverview Unit tests for GnomadService logic — dataset→build derivation,
 * coherence validation, the by-symbol/by-id gene routing, the region parser,
 * how coverage buckets are selected and summarized, how upstream failures are
 * classified, the best-effort liftover hint, the dataset lineage table,
 * hemizygote_count sourcing on list rows, and co-occurrence labelling and
 * refusals. The fetch-seam tests fake only global
 * fetch, so the real retry loop, fetchWithTimeout, response validation, and the
 * sanitizer all run; everything here is deterministic and offline-safe.
 * @module tests/services/gnomad-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig, resetServerConfig } from '@/config/server-config.js';
import {
  CLINVAR_LOOKUP_BUDGET_MS,
  classifyConsequence,
  GnomadService,
} from '@/services/gnomad/gnomad-service.js';
import type { Dataset } from '@/services/gnomad/types.js';
import { UPSTREAM_CALL_BUDGET_MS } from '@/services/upstream-deadline.js';
import { fakeCoverage, LIVE_COVERAGE } from '../helpers/fake-gnomad-coverage.js';
import {
  CDKN2A_R2_1_GENE,
  CDKN2A_STOP_GAINED_R4,
  INS_STOP_GAINED_R2_1,
  INTERGENIC_R4_ROW,
  PCSK9_FRAMESHIFT_R2_1,
  PCSK9_FRAMESHIFT_R2_1_CURATIONS,
  PCSK9_R2_1_REGION_ANNOTATED_ROW,
  PCSK9_R2_1_REGION_ROW,
  PCSK9_R4_GENE,
} from '../helpers/live-consequences.js';
import { fakeCooccurrenceFetch, liveCooccurrence } from '../helpers/live-cooccurrence.js';
import {
  FAF_GENE_LISTS,
  FAF_VARIANT_ALIASES,
  fafRegionRow,
  fafVariant,
  fakeFafLists,
  fakeFafVariants,
  selectedFafFields,
  selectedTranscriptFields,
} from '../helpers/live-faf.js';
import { fakeSubsetCoverage } from '../helpers/live-subsets.js';
import { minimalVariant } from '../helpers/minimal-variant.js';

const svc = new GnomadService(getServerConfig());

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/74
describe('classifyConsequence — gnomAD consequence categories', () => {
  /** Every term of gnomad-browser's browser/src/vepConsequences.ts, in its rank order, with its category. */
  const GNOMAD_TABLE = [
    ['transcript_ablation', 'lof'],
    ['splice_acceptor_variant', 'lof'],
    ['splice_donor_variant', 'lof'],
    ['stop_gained', 'lof'],
    ['frameshift_variant', 'lof'],
    ['stop_lost', 'missense'],
    ['start_lost', 'missense'],
    ['feature_elongation', 'other'],
    ['feature_truncation', 'other'],
    ['inframe_insertion', 'missense'],
    ['inframe_deletion', 'missense'],
    ['missense_variant', 'missense'],
    ['protein_altering_variant', 'other'],
    ['splice_region_variant', 'other'],
    ['incomplete_terminal_codon_variant', 'other'],
    ['stop_retained_variant', 'other'],
    ['synonymous_variant', 'synonymous'],
    ['coding_sequence_variant', 'other'],
    ['mature_miRNA_variant', 'other'],
    ['5_prime_UTR_variant', 'other'],
    ['3_prime_UTR_variant', 'other'],
    ['non_coding_transcript_exon_variant', 'other'],
    ['non_coding_exon_variant', 'other'],
    ['intron_variant', 'other'],
    ['NMD_transcript_variant', 'other'],
    ['non_coding_transcript_variant', 'other'],
    ['nc_transcript_variant', 'other'],
    ['upstream_gene_variant', 'other'],
    ['downstream_gene_variant', 'other'],
    ['TFBS_ablation', 'other'],
    ['TFBS_amplification', 'other'],
    ['TF_binding_site_variant', 'other'],
    ['regulatory_region_ablation', 'other'],
    ['regulatory_region_amplification', 'other'],
    ['regulatory_region_variant', 'other'],
    ['intergenic_variant', 'other'],
  ] as const;

  /**
   * Terms gnomAD's data pipeline ranks (vep.py CONSEQUENCE_TERMS) but its
   * browser lists in no category, an unknown term, a prototype key, and null:
   * the browser's filter reads every one as Other.
   */
  const OFF_TABLE = [
    'transcript_amplification',
    'initiator_codon_variant',
    'start_retained_variant',
    'not_a_vep_term',
    'constructor',
    null,
  ] as const;

  it('covers all 36 terms of gnomAD’s table', () => {
    expect(new Set(GNOMAD_TABLE.map(([term]) => term)).size).toBe(36);
  });

  it.each(GNOMAD_TABLE)('classes %s as %s', (term, category) => {
    expect(classifyConsequence(term)).toBe(category);
  });

  it.each(OFF_TABLE)('classes %s as other', (term) => {
    expect(classifyConsequence(term)).toBe('other');
  });
});

describe('GnomadService.resolveDatasetContext', () => {
  it('defaults to gnomad_r4 / GRCh38 when nothing supplied', () => {
    expect(svc.resolveDatasetContext(undefined)).toEqual({
      dataset: 'gnomad_r4',
      parent: 'gnomad_r4',
      reference_genome: 'GRCh38',
    });
  });

  it('derives GRCh37 for v2.1 and exac', () => {
    expect(svc.resolveDatasetContext('gnomad_r2_1').reference_genome).toBe('GRCh37');
    expect(svc.resolveDatasetContext('exac').reference_genome).toBe('GRCh37');
  });

  it('derives GRCh38 for v3', () => {
    expect(svc.resolveDatasetContext('gnomad_r3').reference_genome).toBe('GRCh38');
  });

  it('accepts a coherent explicit build', () => {
    expect(svc.resolveDatasetContext('gnomad_r4', 'GRCh38').reference_genome).toBe('GRCh38');
    expect(svc.resolveDatasetContext('gnomad_r2_1', 'GRCh37').reference_genome).toBe('GRCh37');
  });

  it('rejects an incoherent dataset/build pair', () => {
    expect(() => svc.resolveDatasetContext('gnomad_r4', 'GRCh37')).toThrow(McpError);
    expect(() => svc.resolveDatasetContext('gnomad_r2_1', 'GRCh38')).toThrow(
      /requires reference_genome/,
    );
  });

  it('accepts a coherent v3 explicit build', () => {
    expect(svc.resolveDatasetContext('gnomad_r3', 'GRCh38').reference_genome).toBe('GRCh38');
  });

  it('carries the incoherent_build reason and the expected/supplied build on the error', () => {
    const err = (() => {
      try {
        svc.resolveDatasetContext('gnomad_r4', 'GRCh37');
        return;
      } catch (e) {
        return e as McpError;
      }
    })();
    expect(err).toBeInstanceOf(McpError);
    expect(err?.data).toMatchObject({
      reason: 'incoherent_build',
      dataset: 'gnomad_r4',
      expected: 'GRCh38',
      supplied: 'GRCh37',
    });
  });
});

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/68
describe('GnomadService.resolveDatasetContext — subsets and their parent releases (#68)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetServerConfig();
  });

  /**
   * gnomAD's 14 DatasetId values with the parent release and build gnomAD's
   * browser assigns each (dataset-metadata/metadata.ts: coverageDatasetId,
   * referenceGenome).
   */
  const LINEAGE = [
    ['gnomad_r4', 'gnomad_r4', 'GRCh38'],
    ['gnomad_r4_non_ukb', 'gnomad_r4', 'GRCh38'],
    ['gnomad_r3', 'gnomad_r3', 'GRCh38'],
    ['gnomad_r3_controls_and_biobanks', 'gnomad_r3', 'GRCh38'],
    ['gnomad_r3_non_cancer', 'gnomad_r3', 'GRCh38'],
    ['gnomad_r3_non_neuro', 'gnomad_r3', 'GRCh38'],
    ['gnomad_r3_non_topmed', 'gnomad_r3', 'GRCh38'],
    ['gnomad_r3_non_v2', 'gnomad_r3', 'GRCh38'],
    ['gnomad_r2_1', 'gnomad_r2_1', 'GRCh37'],
    ['gnomad_r2_1_controls', 'gnomad_r2_1', 'GRCh37'],
    ['gnomad_r2_1_non_neuro', 'gnomad_r2_1', 'GRCh37'],
    ['gnomad_r2_1_non_cancer', 'gnomad_r2_1', 'GRCh37'],
    ['gnomad_r2_1_non_topmed', 'gnomad_r2_1', 'GRCh37'],
    ['exac', 'exac', 'GRCh37'],
  ] as const;

  it.each(LINEAGE)('resolves %s to parent %s on %s', (dataset, parent, build) => {
    const expected = { dataset, parent, reference_genome: build };
    expect(svc.resolveDatasetContext(dataset)).toEqual(expected);
    expect(svc.resolveDatasetContext(dataset, build)).toEqual(expected);
  });

  it('rejects GRCh38 beside gnomad_r2_1_non_cancer as incoherent_build', () => {
    let err: unknown;
    try {
      svc.resolveDatasetContext('gnomad_r2_1_non_cancer', 'GRCh38');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).data).toMatchObject({
      reason: 'incoherent_build',
      dataset: 'gnomad_r2_1_non_cancer',
      expected: 'GRCh37',
      supplied: 'GRCh38',
    });
  });

  it('takes a subset as GNOMAD_DEFAULT_DATASET', () => {
    vi.stubEnv('GNOMAD_DEFAULT_DATASET', 'gnomad_r3_non_cancer');
    resetServerConfig();

    expect(new GnomadService(getServerConfig()).resolveDatasetContext(undefined)).toEqual({
      dataset: 'gnomad_r3_non_cancer',
      parent: 'gnomad_r3',
      reference_genome: 'GRCh38',
    });
  });
});

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/68
describe('GnomadService.getCoverage — a subset reads its parent release (#68)', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['region', '1-55039974-55039974', 'gnomad_r4_non_ukb', 'gnomad_r4'],
    ['region', '1-55039974-55039974', 'gnomad_r3_non_topmed', 'gnomad_r3'],
    ['transcript', 'ENST00000302118', 'gnomad_r4_non_ukb', 'gnomad_r4'],
    ['gene', 'PCSK9', 'gnomad_r4_non_ukb', 'gnomad_r4'],
  ] as const)(
    'sends a %s target on %s as its parent %s in one request, with the parent’s summaries',
    async (kind, value, subset, parent) => {
      const requests = fakeSubsetCoverage();
      const target = { kind, value };

      const summaries = await svc.getCoverage(
        target,
        svc.resolveDatasetContext(subset),
        createMockContext(),
      );

      expect(requests).toHaveLength(1);
      expect(requests[0]?.variables.dataset).toBe(parent);
      const onParent = await svc.getCoverage(
        target,
        svc.resolveDatasetContext(parent),
        createMockContext(),
      );
      expect(summaries.length).toBeGreaterThan(0);
      expect(summaries).toEqual(onParent);
    },
  );

  it('sends the parent release itself unchanged', async () => {
    const requests = fakeSubsetCoverage();

    await svc.getCoverage(
      { kind: 'region', value: '1-55039974-55039974' },
      svc.resolveDatasetContext('gnomad_r3'),
      createMockContext(),
    );

    expect(requests.map((request) => request.variables.dataset)).toEqual(['gnomad_r3']);
  });
});

describe('GnomadService.listGeneVariants — carried-callset sum where a row has no joint record', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sums an across callsets and recomputes af (not exome-only)', async () => {
    // Live gnomad_r4 / GRCh38 callset values for 1-55051215-G-GA, with the joint
    // record left off the row so the fallback path runs: the variant is carried
    // by both callsets, so the row reports the callset sums (AC 919 / AN 456260 /
    // AF 0.002014…), the path every dataset without joint data takes.
    const raw = {
      variant_id: '1-55051215-G-GA',
      consequence: 'frameshift_variant',
      flags: null,
      exome: { ac: 192, an: 303936, af: 0.0006317119393556538, homozygote_count: 0 },
      genome: { ac: 727, an: 152324, af: 0.004772721304587589, homozygote_count: 1 },
    };
    vi.spyOn(svc as any, 'graphql').mockResolvedValue({ region: { variants: [raw] } });

    const dsCtx = svc.resolveDatasetContext('gnomad_r4');
    const rows = await svc.listGeneVariants(
      { kind: 'region', value: '1-55051215-55051215' },
      {},
      dsCtx,
      createMockContext(),
    );

    expect(rows).toHaveLength(1);
    const [r] = rows;
    expect(r?.ac).toBe(919);
    // AN is the callset sum (456260), NOT max-across-callsets (303936 = exome only).
    expect(r?.an).toBe(456260);
    // AF recomputed from the summed counts — NOT the single-callset exome af
    // (0.000632).
    expect(r?.af).toBe(919 / 456260);
    expect(r?.af).toBeCloseTo(0.0020142, 6);
    expect(r?.source).toBe('exome|genome');
  });

  it('leaves a single-callset variant unchanged', async () => {
    const raw = {
      variant_id: '1-55051216-A-G',
      consequence: 'missense_variant',
      flags: null,
      exome: null,
      genome: { ac: 10, an: 1000, af: 0.01, homozygote_count: 0 },
    };
    vi.spyOn(svc as any, 'graphql').mockResolvedValue({ region: { variants: [raw] } });

    const dsCtx = svc.resolveDatasetContext('gnomad_r4');
    const rows = await svc.listGeneVariants(
      { kind: 'region', value: '1-55051216-55051216' },
      {},
      dsCtx,
      createMockContext(),
    );

    const [r] = rows;
    expect(r?.ac).toBe(10);
    expect(r?.an).toBe(1000);
    expect(r?.af).toBe(0.01);
    expect(r?.source).toBe('genome');
  });
});

describe("GnomadService.listGeneVariants — gnomAD's joint record (#53)", () => {
  afterEach(() => vi.restoreAllMocks());

  /** List one region's raw rows through the real normalizer and filters. */
  async function listRows(raw: unknown[], filters: { maxAf?: number } = {}) {
    vi.spyOn(svc as any, 'graphql').mockResolvedValue({ region: { variants: raw } });
    return svc.listGeneVariants(
      { kind: 'region', value: '1-55039784-55039974' },
      filters,
      svc.resolveDatasetContext('gnomad_r4'),
      createMockContext(),
    );
  }

  // Live gnomad_r4 PCSK9 rows, captured 2026-11-01 (UTC).
  const GENOME_ONLY = {
    variant_id: '1-55039784-C-G',
    consequence: '5_prime_UTR_variant',
    flags: [],
    exome: null,
    genome: { ac: 3, an: 152386, af: 0.000019686847873164203, homozygote_count: 0 },
    joint: { ac: 3, an: 1558598, homozygote_count: 0 },
  };
  const DUAL_CALLSET = {
    variant_id: '1-55039974-G-T',
    consequence: 'missense_variant',
    flags: [],
    exome: { ac: 21634, an: 1428186, af: 0.015147886899885589, homozygote_count: 209 },
    genome: { ac: 1866, an: 152404, af: 0.01224377312931419, homozygote_count: 17 },
    joint: { ac: 23500, an: 1580590, homozygote_count: 226 },
  };

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/53
  it('reads ac, an, and homozygote_count from joint and computes af from them', async () => {
    const [genomeOnly, dual] = await listRows([GENOME_ONLY, DUAL_CALLSET]);

    expect(genomeOnly).toMatchObject({
      ac: 3,
      an: 1558598,
      af: 3 / 1558598,
      homozygote_count: 0,
      source: 'genome',
    });
    expect(dual).toMatchObject({
      ac: 23500,
      an: 1580590,
      af: 23500 / 1580590,
      homozygote_count: 226,
      source: 'exome|genome',
    });
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/53
  it('filters max_af on the joint af the row shows, not the single-callset frequency', async () => {
    // Genome alone: 3 / 152386 ≈ 1.97e-5, above the threshold; joint: ≈ 1.92e-6, below it.
    const rows = await listRows([GENOME_ONLY, DUAL_CALLSET], { maxAf: 0.00001 });

    expect(rows.map((row) => row.variant_id)).toEqual(['1-55039784-C-G']);
    expect(rows[0]?.af).toBe(3 / 1558598);
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/53
  it('gives an AC0 row whose carrying callset has AN 0 the joint af of 0, not null', async () => {
    // Live gnomad_r4 TTN row, captured 2026-11-01 (UTC): the exome record is AC0 with AN 0.
    const [row] = await listRows([
      {
        variant_id: '2-178753895-G-A',
        consequence: 'missense_variant',
        flags: [],
        exome: { ac: 0, an: 0, af: 0, homozygote_count: 0 },
        genome: null,
        joint: { ac: 0, an: 152156, homozygote_count: 0 },
      },
    ]);

    expect(row).toMatchObject({ ac: 0, an: 152156, af: 0, source: 'exome' });
  });
});

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/78
describe("GnomadService.listGeneVariants — pass_only reads a row's passing callsets (#78)", () => {
  afterEach(() => vi.restoreAllMocks());

  /** List raw rows through the real fetch seam, response validation, normalizer, and filters. */
  async function listRows(
    variants: unknown[],
    filters: { maxAf?: number; passOnly?: boolean },
    dataset: Dataset = 'gnomad_r2_1',
  ) {
    serveData({ region: { variants } });
    return svc.listGeneVariants(
      { kind: 'region', value: '1-55505483-55528992' },
      filters,
      svc.resolveDatasetContext(dataset),
      createMockContext(),
    );
  }

  // Live gnomad_r2_1 rows, captured 2026-11-01 (UTC).
  const EXOME_AC0 = {
    variant_id: '1-55505483-C-G',
    consequence: '5_prime_UTR_variant',
    transcript_id: 'ENST00000302118',
    flags: [],
    exome: { ac: 0, an: 178930, af: 0, homozygote_count: 0, filters: ['AC0'] },
    genome: { ac: 1, an: 31408, af: 0.00003183902190524707, homozygote_count: 0, filters: [] },
    joint: null,
  };
  /** The RF-filtered genome callset carries most of the alleles. */
  const GENOME_RF = {
    variant_id: '13-32970100-T-TC',
    consequence: 'intron_variant',
    transcript_id: 'ENST00000544455',
    flags: ['lcr'],
    exome: { ac: 7, an: 2412, af: 0.002902155887230514, homozygote_count: 0, filters: [] },
    genome: { ac: 1085, an: 14548, af: 0.07458069837778389, homozygote_count: 8, filters: ['RF'] },
    joint: null,
  };
  const BOTH_FILTERED = {
    variant_id: '1-55528992-G-A',
    consequence: 'intron_variant',
    transcript_id: 'ENST00000302118',
    flags: [],
    exome: { ac: 0, an: 199854, af: 0, homozygote_count: 0, filters: ['AC0'] },
    genome: { ac: 1, an: 31350, af: 0.00003189792663476874, homozygote_count: 0, filters: ['RF'] },
    joint: null,
  };
  const BOTH_PASSED = {
    variant_id: '1-55528992-G-T',
    consequence: 'intron_variant',
    transcript_id: 'ENST00000302118',
    flags: [],
    exome: { ac: 1, an: 199854, af: 0.000005003652666446506, homozygote_count: 0, filters: [] },
    genome: { ac: 1, an: 31350, af: 0.00003189792663476874, homozygote_count: 0, filters: [] },
    joint: null,
  };
  const ALL_ROWS = [EXOME_AC0, GENOME_RF, BOTH_FILTERED, BOTH_PASSED];

  /** Each row's counts and QC columns, keyed by variant ID. */
  const byId = (rows: Awaited<ReturnType<typeof listRows>>) =>
    Object.fromEntries(
      rows.map((row) => [
        row.variant_id,
        {
          ac: row.ac,
          an: row.an,
          af: row.af,
          homozygote_count: row.homozygote_count,
          source: row.source,
          exome_filters: row.exome_filters,
          genome_filters: row.genome_filters,
          qc_status: row.qc_status,
        },
      ]),
    );

  it('without pass_only, sums every carried callset, a QC-failed one included', async () => {
    const rows = byId(await listRows(ALL_ROWS, {}));

    expect(rows['1-55505483-C-G']).toMatchObject({ ac: 1, an: 210338, af: 1 / 210338 });
    expect(rows['13-32970100-T-TC']).toMatchObject({
      ac: 1092,
      an: 16960,
      af: 1092 / 16960,
      homozygote_count: 8,
    });
    expect(rows['1-55528992-G-A']).toMatchObject({ ac: 1, an: 231204, af: 1 / 231204 });
  });

  it('under pass_only, reads ac, an, and homozygote_count from the callsets that passed QC', async () => {
    const rows = byId(await listRows(ALL_ROWS, { passOnly: true }));

    expect(rows['1-55505483-C-G']).toEqual({
      ac: 1,
      an: 31408,
      af: 1 / 31408,
      homozygote_count: 0,
      // source and the QC columns still describe every carried callset.
      source: 'exome|genome',
      exome_filters: 'AC0',
      genome_filters: '',
      qc_status: 'pass',
    });
    expect(rows['13-32970100-T-TC']).toEqual({
      ac: 7,
      an: 2412,
      af: 7 / 2412,
      homozygote_count: 0,
      source: 'exome|genome',
      exome_filters: '',
      genome_filters: 'RF',
      qc_status: 'pass',
    });
    // Both callsets passed: the sum stands.
    expect(rows['1-55528992-G-T']).toMatchObject({ ac: 2, an: 231204, af: 2 / 231204 });
  });

  it('under pass_only, filters max_af on the af of the passing callsets', async () => {
    // Summed AF 1/210338 ≈ 4.75e-6 is below 1e-5; the passing genome's 1/31408 ≈ 3.18e-5 is above it.
    expect(await listRows([EXOME_AC0], { maxAf: 0.00001 })).toHaveLength(1);
    expect(await listRows([EXOME_AC0], { maxAf: 0.00001, passOnly: true })).toEqual([]);

    // Summed AF 1092/16960 ≈ 0.064 is above 0.01; the passing exome's 7/2412 ≈ 0.0029 is below it.
    expect(await listRows([GENOME_RF], { maxAf: 0.01 })).toEqual([]);
    const [kept] = await listRows([GENOME_RF], { maxAf: 0.01, passOnly: true });
    expect(kept).toMatchObject({ variant_id: '13-32970100-T-TC', ac: 7, an: 2412 });
  });

  it('under pass_only, keeps the summed counts of a row no callset passed, so max_af matches it as without', async () => {
    // The handler counts it in qc_filtered before pass_only drops it: the match set must not move.
    const [row] = await listRows([BOTH_FILTERED], { passOnly: true });
    expect(row).toMatchObject({ ac: 1, an: 231204, af: 1 / 231204, qc_status: 'filtered' });

    // Summed AF ≈ 4.33e-6 is above 1e-6, with and without pass_only.
    expect(await listRows([BOTH_FILTERED], { maxAf: 0.000001 })).toEqual([]);
    expect(await listRows([BOTH_FILTERED], { maxAf: 0.000001, passOnly: true })).toEqual([]);
  });

  it("leaves a joint row's counts unchanged under pass_only, a failed callset included", async () => {
    // Live gnomad_r4 PCSK9 row, captured 2026-11-01 (UTC): exome AC0, genome passing.
    const jointRow = {
      variant_id: '1-55039793-C-T',
      consequence: '5_prime_UTR_variant',
      flags: [],
      exome: { ac: 0, an: 1412788, af: 0, homozygote_count: 0, filters: ['AC0'] },
      genome: { ac: 3, an: 152276, af: 0.00001970106911135044, homozygote_count: 0, filters: [] },
      joint: { ac: 3, an: 1565064, homozygote_count: 0 },
    };

    for (const passOnly of [false, true]) {
      const [row] = await listRows([jointRow], { passOnly }, 'gnomad_r4');
      expect(row).toMatchObject({ ac: 3, an: 1565064, af: 3 / 1565064, qc_status: 'pass' });
    }
  });
});

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/75
describe('GnomadService.listGeneVariants — hemizygote_count from the source of the counts (#75)', () => {
  afterEach(() => vi.restoreAllMocks());

  async function listRows(variants: unknown[], dataset: Dataset, passOnly = false) {
    serveData({ region: { variants } });
    return svc.listGeneVariants(
      { kind: 'region', value: 'X-38403555-38403555' },
      { passOnly },
      svc.resolveDatasetContext(dataset),
      createMockContext(),
    );
  }

  const zygosity = (rows: Awaited<ReturnType<typeof listRows>>) =>
    rows.map((row) => [row.variant_id, row.homozygote_count, row.hemizygote_count]);

  /** Live rows of the region X-38403555-38403555, captured 2026-11-04 (UTC). */
  const X_R4 = {
    variant_id: 'X-38403555-G-A',
    consequence: 'intron_variant',
    transcript_id: 'ENST00000039007',
    flags: [],
    exome: {
      ac: 395059,
      an: 1028348,
      af: 0.38416858884346544,
      homozygote_count: 54539,
      hemizygote_count: 125444,
      filters: [],
    },
    genome: {
      ac: 51516,
      an: 110767,
      af: 0.46508436628237654,
      homozygote_count: 9642,
      hemizygote_count: 15246,
      filters: [],
    },
    joint: { ac: 446575, an: 1139115, homozygote_count: 64181, hemizygote_count: 140690 },
  };
  const X_R3 = {
    variant_id: 'X-38403555-G-A',
    consequence: 'intron_variant',
    transcript_id: 'ENST00000039007',
    flags: [],
    exome: null,
    genome: {
      ac: 51455,
      an: 110715,
      af: 0.46475184031070765,
      homozygote_count: 9632,
      hemizygote_count: 15198,
      filters: [],
    },
    joint: null,
  };

  it("reads gnomad_r4's joint hemizygote count, not the callset sum", async () => {
    const [row] = await listRows([X_R4], 'gnomad_r4');

    // The callsets sum to 140690 too; the joint record is the one read.
    expect(row).toMatchObject({ homozygote_count: 64181, hemizygote_count: 140690 });
    const [jointOnly] = await listRows(
      [{ ...X_R4, joint: { ...X_R4.joint, hemizygote_count: 7 } }],
      'gnomad_r4',
    );
    expect(jointOnly?.hemizygote_count).toBe(7);
  });

  it('sums the carried callsets on gnomad_r3, which has no joint data', async () => {
    expect(zygosity(await listRows([X_R3], 'gnomad_r3'))).toEqual([
      ['X-38403555-G-A', 9632, 15198],
    ]);
  });

  it('keeps 0 on an autosomal row, the value gnomAD reports there', async () => {
    // Live 1-55039974-G-T (gnomad_r4, gnomad_r3) and 1-55505647-G-T (gnomad_r2_1, exac) counts, captured 2026-11-04 (UTC).
    const autosomal = (callset: { ac: number; an: number; homozygote_count: number }) => ({
      ...callset,
      af: callset.ac / callset.an,
      hemizygote_count: 0,
      filters: [],
    });
    const cases = [
      [
        'gnomad_r4',
        {
          exome: autosomal({ ac: 21634, an: 1428186, homozygote_count: 209 }),
          genome: autosomal({ ac: 1866, an: 152404, homozygote_count: 17 }),
          joint: { ac: 23500, an: 1580590, homozygote_count: 226, hemizygote_count: 0 },
        },
      ],
      [
        'gnomad_r3',
        {
          exome: null,
          genome: autosomal({ ac: 1866, an: 152286, homozygote_count: 17 }),
          joint: null,
        },
      ],
      [
        'gnomad_r2_1',
        {
          exome: autosomal({ ac: 2341, an: 196220, homozygote_count: 29 }),
          genome: autosomal({ ac: 441, an: 31400, homozygote_count: 8 }),
          joint: null,
        },
      ],
      [
        'exac',
        {
          exome: autosomal({ ac: 689, an: 31082, homozygote_count: 5 }),
          genome: null,
          joint: null,
        },
      ],
    ] as const;
    for (const [dataset, callsets] of cases) {
      const [row] = await listRows(
        [{ variant_id: '1-1-G-T', consequence: 'missense_variant', flags: [], ...callsets }],
        dataset,
      );
      expect(row?.hemizygote_count).toBe(0);
    }
  });

  it('is null, not 0, on a row whose callsets report no hemizygote count and no joint record', async () => {
    const rows = await listRows(
      [
        {
          variant_id: 'X-1-A-G',
          consequence: null,
          flags: null,
          exome: { ac: 2, an: 1000, af: 0.002, homozygote_count: 0, filters: [] },
          genome: { ac: 1, an: 500, af: 0.002, homozygote_count: 0, hemizygote_count: null },
          joint: null,
        },
        // Joint carries an AC but reports none: the joint source stands, so null.
        { ...X_R4, variant_id: 'X-2-A-G', joint: { ac: 1, an: 2, homozygote_count: 0 } },
      ],
      'gnomad_r4',
    );

    expect(zygosity(rows)).toEqual([
      ['X-1-A-G', 0, null],
      ['X-2-A-G', 0, null],
    ]);
  });

  it("under pass_only, reads a row's passing callsets, as homozygote_count does", async () => {
    // Live gnomad_r2_1 genome counts of X-38262808-G-A (captured 2026-11-04 UTC) beside a constructed RF-failed exome call.
    const failedExome = {
      variant_id: 'X-38262808-G-A',
      consequence: 'intron_variant',
      flags: [],
      exome: {
        ac: 40,
        an: 2000,
        af: 0.02,
        homozygote_count: 3,
        hemizygote_count: 11,
        filters: ['RF'],
      },
      genome: {
        ac: 10003,
        an: 21686,
        af: 10003 / 21686,
        homozygote_count: 1612,
        hemizygote_count: 3629,
        filters: [],
      },
      joint: null,
    };

    expect(zygosity(await listRows([failedExome], 'gnomad_r2_1', true))).toEqual([
      ['X-38262808-G-A', 1612, 3629],
    ]);
    expect(zygosity(await listRows([failedExome], 'gnomad_r2_1'))).toEqual([
      ['X-38262808-G-A', 1615, 3640],
    ]);
  });

  it('selects hemizygote_count on the exome, genome, and joint records of the list document', async () => {
    const sent = serveData({ region: { variants: [] } });
    await svc.listGeneVariants(
      { kind: 'region', value: 'X-38403555-38403555' },
      {},
      svc.resolveDatasetContext('gnomad_r4'),
      createMockContext(),
    );

    const flat = sent[0]?.replace(/\s+/g, ' ') ?? '';
    for (const record of ['exome', 'genome', 'joint']) {
      expect(flat).toMatch(new RegExp(`${record} \\{[^}]*\\bhemizygote_count\\b`));
    }
  });
});

/**
 * Serve one GraphQL `data` payload for every request through the real fetch
 * seam, so the query document, response validation, and normalizer all run.
 * Returns the documents sent.
 */
function serveData(data: unknown): string[] {
  const sent: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    sent.push(String((JSON.parse(String(init?.body)) as { query: string }).query));
    return Response.json({ data });
  });
  return sent;
}

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/57
describe("GnomadService.listGeneVariants — the consequence's transcript", () => {
  afterEach(() => vi.restoreAllMocks());

  const list = (
    kind: 'gene' | 'transcript' | 'region',
    value: string,
    dataset: 'gnomad_r4' | 'gnomad_r2_1' = 'gnomad_r4',
  ) =>
    svc.listGeneVariants(
      { kind, value },
      {},
      svc.resolveDatasetContext(dataset),
      createMockContext(),
    );
  const marks = (
    rows: { variant_id: string; transcript_id: unknown; consequence_transcript: unknown }[],
  ) => rows.map((row) => [row.variant_id, row.transcript_id, row.consequence_transcript]);

  it('marks a gene row on the MANE Select transcript mane_select and one elsewhere other', async () => {
    const sent = serveData({ gene: PCSK9_R4_GENE });

    const rows = await list('gene', 'PCSK9');

    expect(marks(rows)).toEqual([
      ['1-55039838-A-G', 'ENST00000302118', 'mane_select'],
      ['1-55044012-T-A', 'ENST00000673903', 'other'],
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('canonical_transcript_id mane_select_transcript { ensembl_id }');
    expect(sent[0]).toMatch(/consequence\s+transcript_id\s+lof\s+hgvsc @include/);
  });

  it('measures against the MANE Select transcript, not the canonical one, when they differ', async () => {
    serveData({
      gene: {
        ...PCSK9_R4_GENE,
        canonical_transcript_id: 'ENST00000673903',
        mane_select_transcript: { ensembl_id: 'ENST00000302118' },
      },
    });

    expect(marks(await list('gene', 'PCSK9'))).toEqual([
      ['1-55039838-A-G', 'ENST00000302118', 'mane_select'],
      ['1-55044012-T-A', 'ENST00000673903', 'other'],
    ]);
  });

  it('falls back to the canonical transcript on a gene without a MANE Select (GRCh37)', async () => {
    serveData({ gene: CDKN2A_R2_1_GENE });

    expect(marks(await list('gene', 'CDKN2A', 'gnomad_r2_1'))).toEqual([
      ['9-21968154-G-T', 'ENST00000498124', 'canonical'],
      ['9-21968212-A-G', 'ENST00000579122', 'other'],
    ]);
  });

  it('marks nothing on a gene with neither a MANE Select nor a canonical transcript', async () => {
    serveData({
      gene: { ...PCSK9_R4_GENE, canonical_transcript_id: null, mane_select_transcript: null },
    });

    expect(marks(await list('gene', 'PCSK9'))).toEqual([
      ['1-55039838-A-G', 'ENST00000302118', null],
      ['1-55044012-T-A', 'ENST00000673903', null],
    ]);
  });

  it('marks a gene row whose consequence names no transcript other, as the browser marks it', async () => {
    serveData({ gene: { ...PCSK9_R4_GENE, variants: [INTERGENIC_R4_ROW] } });

    expect(marks(await list('gene', 'PCSK9'))).toEqual([['4-45000004-T-C', null, 'other']]);
  });

  it.each([
    [
      'transcript',
      'ENST00000302118',
      { transcript: { chrom: '1', variants: PCSK9_R4_GENE.variants } },
    ],
    ['region', '1-55039838-55044012', { region: { variants: PCSK9_R4_GENE.variants } }],
  ] as const)('keeps transcript_id and marks nothing on a %s target', async (kind, value, data) => {
    serveData(data);

    expect(marks(await list(kind, value))).toEqual([
      ['1-55039838-A-G', 'ENST00000302118', null],
      ['1-55044012-T-A', 'ENST00000673903', null],
    ]);
  });

  it('returns a null transcript_id for an intergenic region row', async () => {
    serveData({ region: { variants: [INTERGENIC_R4_ROW] } });

    expect(marks(await list('region', '4-45000004-45000004'))).toEqual([
      ['4-45000004-T-C', null, null],
    ]);
  });
});

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/57
describe('GnomadService.getVariant — primary_transcript', () => {
  afterEach(() => vi.restoreAllMocks());

  const lookup = (
    consequences: unknown,
    dataset: 'gnomad_r4' | 'gnomad_r2_1' = 'gnomad_r4',
    variantId = '9-21968220-C-A',
  ) => {
    const sent = serveData({
      variant: {
        ...minimalVariant(variantId, dataset === 'gnomad_r4' ? 'GRCh38' : 'GRCh37'),
        transcript_consequences: consequences,
      },
      clinvar_variant: null,
    });
    const record = svc.getVariant(
      variantId,
      svc.resolveDatasetContext(dataset),
      createMockContext(),
    );
    return { sent, record };
  };
  /** A live entry with fields replaced, for a shape the sampled genes never showed. */
  const entry = (i: number, patch: Record<string, unknown>) => ({
    ...(CDKN2A_STOP_GAINED_R4[i] as object),
    ...patch,
  });

  it('takes the MANE Select entry beside the most severe consequence, which stays as reported', async () => {
    const { sent, record } = lookup(CDKN2A_STOP_GAINED_R4);

    expect(await record).toMatchObject({
      consequence: 'stop_gained',
      transcript_id: 'ENST00000579122',
      gene_symbol: 'CDKN2A',
      primary_transcript: {
        transcript_id: 'ENST00000304494',
        is_mane_select: true,
        consequence: '3_prime_UTR_variant',
        hgvsc: 'c.*9G>T',
        hgvsp: null,
        lof: null,
      },
    });
    expect(sent[0]).toMatch(
      /gene_id\s+gene_symbol\s+transcript_id\s+major_consequence\s+is_mane_select\s+is_canonical\s+hgvsc\s+hgvsp\s+lof/,
    );
  });

  it('takes the canonical entry where gnomAD reports no MANE status (gnomad_r2_1)', async () => {
    const { record } = lookup(PCSK9_FRAMESHIFT_R2_1, 'gnomad_r2_1', '1-55516888-G-GA');

    const result = await record;
    expect(result?.transcript_id).toBe('ENST00000452118');
    expect(result?.primary_transcript).toEqual({
      transcript_id: 'ENST00000302118',
      is_mane_select: null,
      consequence: 'intron_variant',
      hgvsc: 'c.524-1063_524-1062insA',
      hgvsp: null,
      lof: null,
      lof_filter: null,
      lof_flags: null,
    });
  });

  it('prefers the MANE Select entry over a different canonical entry of the same gene', async () => {
    const { record } = lookup([
      entry(0, {}),
      entry(2, { is_canonical: true }),
      entry(1, { is_canonical: null }),
    ]);

    expect((await record)?.primary_transcript?.transcript_id).toBe('ENST00000304494');
  });

  it("never takes another gene's canonical entry, even one listed before the first gene's own", async () => {
    const otherGeneCanonical = CDKN2A_STOP_GAINED_R4[8];
    const ownCanonical = entry(3, { is_canonical: true });
    const withOwn = lookup([entry(0, {}), otherGeneCanonical, ownCanonical]);
    expect((await withOwn.record)?.primary_transcript?.transcript_id).toBe('ENST00000498124');
    vi.restoreAllMocks();

    const withoutOwn = lookup([entry(0, {}), otherGeneCanonical, entry(3, {})]);
    expect((await withoutOwn.record)?.primary_transcript).toBeNull();
  });

  it('is null for a variant with no transcript consequences', async () => {
    const { record } = lookup(null);

    expect((await record)?.primary_transcript).toBeNull();
  });
});

describe('GnomadService — region ordering guard', () => {
  afterEach(() => vi.restoreAllMocks());

  it('rejects an inverted region (start>stop) before any upstream call — list and coverage alike', async () => {
    const graphql = vi.spyOn(svc as any, 'graphql').mockResolvedValue({});
    const dsCtx = svc.resolveDatasetContext('gnomad_r4');
    const ctx = createMockContext();

    await expect(
      svc.listGeneVariants({ kind: 'region', value: '1-55064852-55039447' }, {}, dsCtx, ctx),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_region' },
    });
    await expect(
      svc.getCoverage({ kind: 'region', value: '1-55064852-55039447' }, dsCtx, ctx),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_region' },
    });

    // The malformed region never reaches the network — no retry storm, no
    // misleading "unavailable" error.
    expect(graphql).not.toHaveBeenCalled();
  });

  it('accepts a single-position region (start == stop) and reaches the upstream query', async () => {
    const graphql = vi
      .spyOn(svc as any, 'graphql')
      .mockResolvedValue({ region: { coverage: { exome: null, genome: null } } });
    const dsCtx = svc.resolveDatasetContext('gnomad_r4');

    await svc.getCoverage(
      { kind: 'region', value: '1-55051215-55051215' },
      dsCtx,
      createMockContext(),
    );
    expect(graphql).toHaveBeenCalledTimes(1);
  });
});

describe('GnomadService — region parser edges', () => {
  afterEach(() => vi.restoreAllMocks());

  const dsCtx = svc.resolveDatasetContext('gnomad_r4');

  async function sentVariables(region: string): Promise<Record<string, unknown>> {
    const graphql = vi
      .spyOn(svc as any, 'graphql')
      .mockResolvedValue({ region: { coverage: { exome: null, genome: null } } });
    await svc.getCoverage({ kind: 'region', value: region }, dsCtx, createMockContext());
    return graphql.mock.calls[0]?.[1] as Record<string, unknown>;
  }

  async function rejection(region: string): Promise<unknown> {
    const graphql = vi.spyOn(svc as any, 'graphql').mockResolvedValue({});
    const error = await svc
      .listGeneVariants({ kind: 'region', value: region }, {}, dsCtx, createMockContext())
      .catch((err: unknown) => err);
    expect(graphql).not.toHaveBeenCalled();
    return error;
  }

  it.each([
    ['1-1-1', { chrom: '1', start: 1, stop: 1 }],
    ['22-999999990-999999999', { chrom: '22', start: 999999990, stop: 999999999 }],
    ['chrX-100-2500099', { chrom: 'X', start: 100, stop: 2500099 }],
    ['Chry-5-6', { chrom: 'Y', start: 5, stop: 6 }],
  ])('sends %s at the edge of every bound as %j', async (region, expected) => {
    expect(await sentVariables(region)).toMatchObject(expected);
  });

  it.each([
    ['1-100-2500100', 'region_too_large'],
    ['CHR-1-2', 'invalid_region'],
    ['chr-1-2', 'invalid_region'],
    ['1-0-0', 'invalid_region'],
    ['1-1-99999999999999999999', 'invalid_region'],
    ['1-1000000000-1000000001', 'invalid_region'],
    ['chrMT-1-2', 'mitochondrial_unsupported'],
    ['m-1-2', 'mitochondrial_unsupported'],
  ])('rejects %s as %s without a fetch', async (region, reason) => {
    expect(await rejection(region)).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason, retryable: false },
    });
  });

  it('reports the span in the region_too_large message', async () => {
    const error = (await rejection('1-100-2500100')) as McpError;
    expect(error.message).toContain('2,500,000 bp');
  });

  it.each([
    ['gene', 'M'],
    ['gene', 'MT'],
    ['transcript', 'M'],
  ] as const)(
    'refuses a %s whose gnomAD chrom is %s on both list and coverage',
    async (kind, chrom) => {
      vi.spyOn(svc as any, 'graphql').mockResolvedValue({
        [kind]: { chrom, variants: [], coverage: { exome: [], genome: [] } },
      });
      const target = { kind, value: kind === 'gene' ? 'MT-TL1' : 'ENST00000386347' };
      for (const call of [
        () => svc.listGeneVariants(target, {}, dsCtx, createMockContext()),
        () => svc.getCoverage(target, dsCtx, createMockContext()),
      ]) {
        await expect(call()).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'mitochondrial_unsupported', retryable: false },
        });
      }
    },
  );

  it.each(['M-3243-A-G', 'MT-3243-A-G', 'chrM-3243-A-G', 'chrmt-3243-a-g'])(
    'refuses variant %s before any fetch',
    async (id) => {
      const graphql = vi.spyOn(svc as any, 'graphql');
      await expect(svc.getVariant(id, dsCtx, createMockContext())).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'mitochondrial_unsupported', retryable: false },
      });
      expect(graphql).not.toHaveBeenCalled();
    },
  );
});

/** A raw gnomAD coverage bin with a position and a flat depth. */
function covBin(pos: number, depth: number, fracHigh = 0): Record<string, number> {
  return {
    pos,
    mean: depth,
    median: depth,
    over_1: 1,
    over_5: 1,
    over_10: 1,
    over_15: fracHigh,
    over_20: fracHigh,
    over_25: fracHigh,
    over_30: fracHigh,
    over_50: 0,
    over_100: 0,
  };
}

describe('GnomadService.getCoverage — coverage bucket bounding', () => {
  afterEach(() => vi.restoreAllMocks());

  it('bounds region coverage bins to the requested span — single position → positions:1', async () => {
    // gnomAD queries a single-position region ±75 bp (1 bp buckets); the service
    // must keep only the bucket at the requested base, not the padded neighborhood.
    const bins = [covBin(55039973, 8), covBin(55039974, 42, 1), covBin(55039975, 9)];
    vi.spyOn(svc as any, 'graphql').mockResolvedValue({
      region: { coverage: { exome: bins, genome: null } },
    });
    const dsCtx = svc.resolveDatasetContext('gnomad_r4');

    const summaries = await svc.getCoverage(
      { kind: 'region', value: '1-55039974-55039974' },
      dsCtx,
      createMockContext(),
    );

    expect(summaries).toHaveLength(1);
    const [s] = summaries;
    // Positions is the requested base only, NOT 3 (or the upstream 151).
    expect(s?.positions).toBe(1);
    // Depth is that base's value, not the ±window average of (8+42+9)/3.
    expect(s?.mean_depth).toBe(42);
    expect(s?.median_depth).toBe(42);
    expect(s?.fraction_over_30).toBe(1);
  });

  it('bounds a multi-base region to start..stop', async () => {
    const bins = [covBin(100, 5), covBin(101, 20), covBin(102, 30), covBin(103, 99)];
    vi.spyOn(svc as any, 'graphql').mockResolvedValue({
      region: { coverage: { exome: bins, genome: null } },
    });
    const dsCtx = svc.resolveDatasetContext('gnomad_r4');

    const summaries = await svc.getCoverage(
      { kind: 'region', value: '1-101-102' },
      dsCtx,
      createMockContext(),
    );

    // Only pos 101 and 102 fall in start..stop; the flanking 100 and 103 drop.
    expect(summaries[0]?.positions).toBe(2);
    expect(summaries[0]?.mean_depth).toBe(25); // (20+30)/2, not (5+20+30+99)/4
  });

  it('bounds gene coverage bins to the exons ±75 bp gnomAD queried', async () => {
    // Exon 101–101 → interval 26–176. Bins 1 and 177 are intron gnomAD never queried.
    const bins = [covBin(1, 10), covBin(26, 20), covBin(176, 30), covBin(177, 90)];
    vi.spyOn(svc as any, 'graphql').mockResolvedValue({
      gene: {
        chrom: '1',
        exons: [{ start: 101, stop: 101 }],
        coverage: { exome: bins, genome: null },
      },
    });
    const dsCtx = svc.resolveDatasetContext('gnomad_r4');

    const summaries = await svc.getCoverage(
      { kind: 'gene', value: 'PCSK9' },
      dsCtx,
      createMockContext(),
    );

    expect(summaries[0]).toMatchObject({ positions: 2, bucket_count: 2, bucket_size: 1 });
    expect(summaries[0]?.mean_depth).toBe(25); // (20+30)/2, not (10+20+30+90)/4
  });

  it('bounds transcript coverage bins to the exons ±75 bp gnomAD queried', async () => {
    const bins = [covBin(25, 5), covBin(26, 40), covBin(27, 41), covBin(400, 0)];
    vi.spyOn(svc as any, 'graphql').mockResolvedValue({
      transcript: {
        chrom: '1',
        exons: [{ start: 101, stop: 101 }],
        coverage: { exome: bins, genome: null },
      },
    });
    const dsCtx = svc.resolveDatasetContext('gnomad_r4');

    const summaries = await svc.getCoverage(
      { kind: 'transcript', value: 'ENST00000302118' },
      dsCtx,
      createMockContext(),
    );

    expect(summaries[0]).toMatchObject({ positions: 2, bucket_count: 2, mean_depth: 40.5 });
  });
});

/** A float summary value, matched to nine decimal places. */
const close = (value: number) => expect.closeTo(value, 9);

const coverageOf = (kind: 'gene' | 'transcript' | 'region', value: string) =>
  svc.getCoverage({ kind, value }, svc.resolveDatasetContext('gnomad_r4'), createMockContext());

describe('GnomadService.getCoverage — gnomAD coverage buckets at the fetch seam', () => {
  afterEach(() => vi.restoreAllMocks());

  it('summarizes only the requested base of a live single-position region', async () => {
    fakeCoverage(LIVE_COVERAGE['region:1-55039974-55039974']);

    const summaries = await coverageOf('region', '1-55039974-55039974');

    expect(summaries).toEqual([
      {
        source: 'exome',
        positions: 1,
        target_positions: 1,
        missing_positions: 0,
        bucket_count: 1,
        bucket_size: 1,
        mean_depth: 56.13959972474064,
        median_depth: 31,
        fraction_over_1: 1,
        fraction_over_5: 1,
        fraction_over_10: 0.98,
        fraction_over_15: 0.97,
        fraction_over_20: 0.96,
        fraction_over_25: 0.91,
        fraction_over_30: 0.62,
        fraction_over_50: 0.32,
        fraction_over_100: 0.19,
      },
      {
        source: 'genome',
        positions: 1,
        target_positions: 1,
        missing_positions: 0,
        bucket_count: 1,
        bucket_size: 1,
        mean_depth: 35.59847702992943,
        median_depth: 34,
        fraction_over_1: 1,
        fraction_over_5: 1,
        fraction_over_10: 1,
        fraction_over_15: 1,
        fraction_over_20: 1,
        fraction_over_25: 0.94,
        fraction_over_30: 0.8,
        fraction_over_50: 0.09,
        fraction_over_100: 0.01,
      },
    ]);
  });

  it('omits a track gnomAD returns empty and summarizes the other', async () => {
    fakeCoverage({
      data: {
        gene: {
          chrom: '1',
          exons: [{ start: 1076, stop: 1080 }],
          coverage: { exome: [], genome: [covBin(1001, 30), covBin(1155, 40)] },
        },
      },
    });

    const summaries = await coverageOf('gene', 'PCSK9');

    expect(summaries.map((s) => s.source)).toEqual(['genome']);
    expect(summaries[0]).toMatchObject({ positions: 2, mean_depth: 35 });
  });

  it('summarizes the live PCSK9 response over its exons ±75 bp, not the zero-filled introns', async () => {
    const requests = fakeCoverage(LIVE_COVERAGE['gene:PCSK9']);

    const summaries = await coverageOf('gene', 'PCSK9');

    // The exons ride in the same request as the coverage they bound.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.query).toMatch(/exons \{ start stop \}[\s\S]*coverage\(dataset/);
    // 34 exon features merge to 14 padded intervals summing to 7,797 bp → 15 bp
    // buckets. The genome track keeps the 535 buckets overlapping them out of 587.
    expect(summaries).toEqual([
      {
        source: 'exome',
        positions: 894,
        target_positions: 7811,
        missing_positions: 6917,
        bucket_count: 61,
        bucket_size: 15,
        mean_depth: close(20.31600189688799),
        median_depth: close(6),
        fraction_over_1: close(0.5924590163934427),
        fraction_over_5: close(0.5511475409836066),
        fraction_over_10: close(0.4888524590163935),
        fraction_over_15: close(0.4537704918032788),
        fraction_over_20: close(0.43000000000000016),
        fraction_over_25: close(0.38967213114754096),
        fraction_over_30: close(0.24590163934426237),
        fraction_over_50: close(0.08770491803278689),
        fraction_over_100: close(0.043114754098360644),
      },
      {
        source: 'genome',
        positions: 7811,
        target_positions: 7811,
        missing_positions: 0,
        bucket_count: 535,
        bucket_size: 15,
        mean_depth: close(32.49755523382596),
        median_depth: 33,
        fraction_over_1: close(0.9950280373831775),
        fraction_over_5: close(0.9950280373831775),
        fraction_over_10: close(0.9950093457943924),
        fraction_over_15: close(0.9945046728971961),
        fraction_over_20: close(0.9690093457943999),
        fraction_over_25: close(0.8762990654205581),
        fraction_over_30: close(0.7061308411214963),
        fraction_over_50: close(0.031495327102803505),
        fraction_over_100: close(0.00999999999999987),
      },
    ]);
  });

  it('summarizes a live transcript over its own exons ±75 bp, in 10 bp buckets', async () => {
    const requests = fakeCoverage(LIVE_COVERAGE['transcript:ENST00000302118']);

    const summaries = await coverageOf('transcript', 'ENST00000302118');

    expect(requests[0]?.query).toContain('exons { start stop }');
    expect(summaries).toEqual([
      {
        source: 'exome',
        positions: 630,
        target_positions: 5437,
        missing_positions: 4807,
        bucket_count: 63,
        bucket_size: 10,
        mean_depth: close(29.468469069263534),
        median_depth: close(28.8),
        fraction_over_1: close(0.8566666666666667),
        fraction_over_5: close(0.7987301587301584),
        fraction_over_10: close(0.709365079365079),
        fraction_over_15: close(0.657936507936508),
        fraction_over_20: close(0.6239682539682543),
        fraction_over_25: close(0.566031746031746),
        fraction_over_30: close(0.3565079365079364),
        fraction_over_50: close(0.12682539682539684),
        fraction_over_100: close(0.062380952380952384),
      },
      {
        source: 'genome',
        positions: 647,
        target_positions: 5437,
        missing_positions: 4790,
        bucket_count: 65,
        bucket_size: 10,
        mean_depth: close(34.30150891004619),
        median_depth: close(33.9),
        fraction_over_1: close(0.9996923076923075),
        fraction_over_5: close(0.9996923076923075),
        fraction_over_10: close(0.9996923076923075),
        fraction_over_15: close(0.9996923076923075),
        fraction_over_20: close(0.9926153846153841),
        fraction_over_25: close(0.9309230769230759),
        fraction_over_30: close(0.7781538461538451),
        fraction_over_50: close(0.05523076923076923),
        fraction_over_100: close(0.010000000000000005),
      },
    ]);
  });

  it('keeps the live 4,800 bp bucket at 998,400 that covers the start of 1-1000000-3400000', async () => {
    fakeCoverage(LIVE_COVERAGE['region:1-1000000-3400000']);

    const summaries = await coverageOf('region', '1-1000000-3400000');

    // The trimmed response holds each track's first and last three buckets.
    expect(summaries).toEqual([
      {
        source: 'exome',
        positions: 27200, // 3,200 + 2×4,800 at the head, 3×4,800 at the tail (last ends 3,398,399)
        target_positions: 2400001,
        missing_positions: 2372801,
        bucket_count: 6,
        bucket_size: 4800,
        mean_depth: close(7.7747301265779),
        median_depth: close(9.391143911439114),
        fraction_over_1: close(0.35666666666666663),
        fraction_over_5: close(0.3116666666666667),
        fraction_over_10: close(0.255),
        fraction_over_15: close(0.22499999999999998),
        fraction_over_20: close(0.20166666666666666),
        fraction_over_25: close(0.17666666666666667),
        fraction_over_30: close(0.12166666666666666),
        fraction_over_50: close(0.013333333333333334),
        fraction_over_100: close(0.008333333333333333),
      },
      {
        source: 'genome',
        positions: 24001, // 3,200 + 2×4,800 at the head; 2×4,800 + 1,601 at the tail
        target_positions: 2400001,
        missing_positions: 2376000,
        bucket_count: 6,
        bucket_size: 4800,
        mean_depth: close(32.16623947907194),
        median_depth: close(32.673125),
        fraction_over_1: close(0.9983333333333334),
        fraction_over_5: close(0.9983333333333334),
        fraction_over_10: close(0.9983333333333334),
        fraction_over_15: close(0.9966666666666667),
        fraction_over_20: close(0.9649999999999999),
        fraction_over_25: close(0.8649999999999999),
        fraction_over_30: close(0.69),
        fraction_over_50: close(0.030000000000000002),
        fraction_over_100: close(0.01),
      },
    ]);
  });

  it('counts every bucket and base of 1-1000000-3400000 across the full live key range', async () => {
    // Bucket keys as gnomAD returned them: exome 998,400…3,393,600 (500 buckets,
    // its last records end before the stop) and genome 998,400…3,398,400 (501).
    const keys = (last: number) =>
      Array.from({ length: (last - 998400) / 4800 + 1 }, (_, i) => 998400 + i * 4800);
    fakeCoverage({
      data: {
        region: {
          coverage: {
            exome: keys(3393600).map((pos) => covBin(pos, 30)),
            genome: keys(3398400).map((pos) => covBin(pos, 30)),
          },
        },
      },
    });

    const summaries = await coverageOf('region', '1-1000000-3400000');

    expect(
      summaries.map(({ source, positions, bucket_count, bucket_size }) => ({
        source,
        positions,
        bucket_count,
        bucket_size,
      })),
    ).toEqual([
      { source: 'exome', positions: 2_398_400, bucket_count: 500, bucket_size: 4800 },
      { source: 'genome', positions: 2_400_001, bucket_count: 501, bucket_size: 4800 },
    ]);
  });

  it('keeps the live 20 bp buckets straddling start and stop and drops those wholly in the pad', async () => {
    fakeCoverage(LIVE_COVERAGE['region:1-55039447-55049447']);

    const summaries = await coverageOf('region', '1-55039447-55049447');

    // Genome: 55,039,360–55,039,420 and 55,049,460–55,049,520 lie wholly in the
    // ±75 bp pad and drop; 55,039,440 (13 bases from start) and 55,049,440
    // (8 bases to stop) straddle the edges and stay.
    expect(summaries).toEqual([
      {
        source: 'exome',
        positions: 320,
        target_positions: 10001,
        missing_positions: 9681,
        bucket_count: 16,
        bucket_size: 20,
        mean_depth: close(21.74737370416841),
        median_depth: close(31.842105263157894),
        fraction_over_1: close(0.78375),
        fraction_over_5: close(0.7050000000000001),
        fraction_over_10: close(0.63625),
        fraction_over_15: close(0.606875),
        fraction_over_20: close(0.5887500000000001),
        fraction_over_25: close(0.56125),
        fraction_over_30: close(0.43187499999999995),
        fraction_over_50: close(0.035),
        fraction_over_100: close(0.020000000000000004),
      },
      {
        source: 'genome',
        positions: 141,
        target_positions: 10001,
        missing_positions: 9860,
        bucket_count: 8,
        bucket_size: 20,
        mean_depth: close(33.60507578240496),
        median_depth: 34,
        fraction_over_1: 1,
        fraction_over_5: 1,
        fraction_over_10: 1,
        fraction_over_15: 1,
        fraction_over_20: close(0.9900000000000001),
        fraction_over_25: close(0.92),
        fraction_over_30: close(0.7649999999999999),
        fraction_over_50: close(0.039999999999999994),
        fraction_over_100: close(0.01),
      },
    ]);
  });

  it('keeps a zero bucket inside the exon intervals and never one outside them', async () => {
    // One exon at 1,076–1,080 → queried interval 1,001–1,155 → 1 bp buckets.
    // Inside: 1,001 (40×), 1,078 (no records, zero-filled), 1,155 (20×).
    // Outside: the zero-filled intron at 1,000, 1,156, and 1,500.
    const bucket = (pos: number, depth: number, frac: number) => ({
      pos,
      mean: depth,
      median: depth,
      over_1: frac,
      over_5: frac,
      over_10: frac,
      over_15: frac,
      over_20: frac,
      over_25: frac,
      over_30: frac,
      over_50: frac,
      over_100: frac,
    });
    fakeCoverage({
      data: {
        gene: {
          chrom: '1',
          exons: [{ start: 1076, stop: 1080 }],
          coverage: {
            exome: [
              bucket(1000, 0, 0),
              bucket(1001, 40, 0.9),
              bucket(1078, 0, 0),
              bucket(1155, 20, 0.6),
              bucket(1156, 0, 0),
              bucket(1500, 0, 0),
            ],
            genome: null,
          },
        },
      },
    });

    const summaries = await coverageOf('gene', 'PCSK9');

    // Every field differs from the all-buckets answer (mean 10, median 0, fractions 0.25).
    expect(summaries).toEqual([
      {
        source: 'exome',
        positions: 3,
        target_positions: 155,
        missing_positions: 152,
        bucket_count: 3,
        bucket_size: 1,
        mean_depth: 20,
        median_depth: 20,
        fraction_over_1: close(0.5),
        fraction_over_5: close(0.5),
        fraction_over_10: close(0.5),
        fraction_over_15: close(0.5),
        fraction_over_20: close(0.5),
        fraction_over_25: close(0.5),
        fraction_over_30: close(0.5),
        fraction_over_50: close(0.5),
        fraction_over_100: close(0.5),
      },
    ]);
  });

  it.each([
    // [start, stop, bucket size] — size = max(floor((stop − start + 150) / 500), 1)
    [1001, 1850, 1], // span 849 → 999 → 1 bp
    [1001, 1851, 2], // span 850 → 1,000 → 2 bp
    [1001, 1852, 2], // span 851 → 1,001 → 2 bp
    [1001, 2349, 2], // span 1,348 → 1,498 → 2 bp
    [1001, 2350, 2], // span 1,349 → 1,499 → 2 bp
    [1001, 2351, 3], // span 1,350 → 1,500 → 3 bp
  ])(
    'derives the bucket size of region 1-%i-%i as %i bp from gnomAD’s formula',
    async (start, stop, size) => {
      // Two sparse buckets only, so the returned bucket count says nothing about size.
      const first = Math.floor(start / size) * size;
      const last = Math.floor(stop / size) * size;
      fakeCoverage({
        data: {
          region: { coverage: { exome: [covBin(first, 30), covBin(last, 30)], genome: null } },
        },
      });

      const [summary] = await coverageOf('region', `1-${start}-${stop}`);

      expect(summary?.bucket_size).toBe(size);
      expect(summary?.bucket_count).toBe(2);
      expect(summary?.positions).toBe(first + size - start + (stop - last + 1));
    },
  );

  it('pads, sorts, and merges overlapping and adjacent exons as gnomAD does', async () => {
    // Exons listed 3′→5′ as a minus-strand feature can arrive. Padded: 1,576–2,001,
    // 1,001–1,575, 1,025–1,275. The third nests in the second; the first starts one
    // base past the second's end, so all three merge to 1,001–2,001 (Σ stop − start
    // = 1,000 → 2 bp buckets). Unmerged, the sizes sum to 999 → 1 bp buckets.
    fakeCoverage({
      data: {
        gene: {
          chrom: '1',
          exons: [
            { start: 1651, stop: 1926 },
            { start: 1076, stop: 1500 },
            { start: 1100, stop: 1200 },
          ],
          coverage: {
            exome: [
              covBin(998, 0), // 998–999: before the interval
              covBin(1000, 30), // 1,000–1,001: one base inside
              covBin(1574, 30), // 1,574–1,575 and 1,576–1,577 straddle the merge seam
              covBin(1576, 30),
              covBin(2000, 30), // 2,000–2,001: both bases inside
              covBin(2002, 0), // 2,002–2,003: past the interval
            ],
            genome: null,
          },
        },
      },
    });

    const [summary] = await coverageOf('gene', 'PCSK9');

    expect(summary).toMatchObject({
      bucket_size: 2,
      bucket_count: 4,
      positions: 7,
      mean_depth: 30,
    });
  });

  it('sizes feature buckets from the summed stop − start of the padded exons, not their base counts', async () => {
    // Exon 1,076–1,925 pads to 1,001–2,000: stop − start = 999 → 1 bp buckets.
    // Counting bases (1,000) instead would give 2 bp buckets.
    fakeCoverage({
      data: {
        gene: {
          chrom: '1',
          exons: [{ start: 1076, stop: 1925 }],
          coverage: { exome: [covBin(1001, 30), covBin(2000, 30)], genome: null },
        },
      },
    });

    const [summary] = await coverageOf('gene', 'PCSK9');

    expect(summary).toMatchObject({ bucket_size: 1, bucket_count: 2, positions: 2 });
  });

  it('returns no summary for a track whose buckets all fall outside the exon intervals', async () => {
    fakeCoverage({
      data: {
        transcript: {
          chrom: '1',
          exons: [{ start: 1076, stop: 1080 }],
          coverage: {
            exome: [covBin(5000, 0), covBin(5001, 0)],
            genome: [covBin(1078, 25)],
          },
        },
      },
    });

    const summaries = await coverageOf('transcript', 'ENST00000302118');

    expect(summaries).toEqual([
      expect.objectContaining({ source: 'genome', positions: 1, bucket_count: 1, mean_depth: 25 }),
    ]);
  });
});

interface Reply {
  body: string | null;
  status: number;
}

/** gnomAD's GraphQL error envelope — the body its resolvers send on a failure. */
function graphqlErrors(...messages: string[]): string {
  return JSON.stringify({ errors: messages.map((message) => ({ message })), data: null });
}

/** Fake gnomAD's HTTP replies in order, the last one repeating. Returns the fetch spy. */
function fakeReplies(...replies: Reply[]) {
  let call = 0;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const { status, body } = replies[Math.min(call++, replies.length - 1)] as Reply;
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  });
}

/**
 * Settle a service call while advancing fake timers past every backoff the
 * retry loop schedules. The handler is attached before the timers move, so a
 * rejection is never momentarily unobserved.
 */
async function settle<T>(op: () => Promise<T>): Promise<T | McpError> {
  const outcome = op().catch((err: unknown) => err as McpError);
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(60_000);
  return outcome;
}

describe('GnomadService — upstream failure classification at the fetch seam', () => {
  const dsCtx = svc.resolveDatasetContext('gnomad_r4');
  const listRegion = () =>
    svc.listGeneVariants(
      { kind: 'region', value: '1-1000000-3400000' },
      {},
      dsCtx,
      createMockContext(),
    );
  const coverageRegion = () =>
    svc.getCoverage({ kind: 'region', value: '1-1000000-3400000' }, dsCtx, createMockContext());
  const listGene = () =>
    svc.listGeneVariants({ kind: 'gene', value: 'PCSK9' }, {}, dsCtx, createMockContext());

  /** The sanitized transient error every exhausted retry ends as. */
  function expectRetriedOut(outcome: unknown): void {
    expect(outcome).toBeInstanceOf(McpError);
    const error = outcome as McpError;
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toBe('gnomAD is unavailable or rate-limited. (failed after 4 attempts)');
    expect(error.data).toMatchObject({
      reason: 'upstream_unavailable',
      retryable: true,
      retryAttempts: 4,
    });
    // The hint comes from each surface's declaration, never from the service.
    expect(error.data).not.toHaveProperty('recovery');
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each<[string, Reply]>([
    [
      'an HTTP 400 carrying the rate-limit message',
      {
        status: 400,
        body: graphqlErrors('Query rate limit exceeded. Please try again in a few minutes.'),
      },
    ],
    ['an HTTP 429', { status: 429, body: 'Too Many Requests' }],
    [
      'a 500 "An unknown error occurred"',
      { status: 500, body: graphqlErrors('An unknown error occurred') },
    ],
    ['a 500 "Request timed out"', { status: 500, body: graphqlErrors('Request timed out') }],
    ['a 500 "Service overloaded"', { status: 500, body: graphqlErrors('Service overloaded') }],
    ['a 500 with an unlisted message', { status: 500, body: graphqlErrors('Resolver exploded') }],
    [
      'a 500 whose messages mix a region message with an unlisted one',
      {
        status: 500,
        body: graphqlErrors('Select a smaller region to view variants', 'Resolver exploded'),
      },
    ],
    ['a 500 with a non-JSON body', { status: 500, body: '<h1>Internal Server Error</h1>' }],
    ['a 500 with a JSON body that is no GraphQL envelope', { status: 500, body: '{"data":null}' }],
    ['a 500 with an empty errors list', { status: 500, body: '{"errors":[],"data":null}' }],
    ['a 500 with an empty body', { status: 500, body: '' }],
    ['a 500 with no body', { status: 500, body: null }],
    ['a 502 gateway page', { status: 502, body: 'Bad Gateway' }],
  ])('retries %s four times, then fails as upstream_unavailable', async (_label, reply) => {
    const fetch = fakeReplies(reply);
    expectRetriedOut(await settle(listRegion));
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('recovers when a transient 500 clears on a later attempt', async () => {
    const fetch = fakeReplies(
      { status: 500, body: graphqlErrors('Service overloaded') },
      { status: 500, body: graphqlErrors('Request timed out') },
      { status: 200, body: JSON.stringify({ data: { region: { variants: [] } } }) },
    );
    expect(await settle(listRegion)).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each<[string, string, () => Promise<unknown>]>([
    [
      'This region has too many variants to display. Select a smaller region to view variants.',
      'region_too_large',
      listRegion,
    ],
    ['Select a smaller region to view variants', 'region_too_large', listRegion],
    ['Coverage is not available for a region this large', 'region_too_large', coverageRegion],
    ["Invalid chromosome: '23'", 'invalid_region', listRegion],
    ['Region start must be greater than 0', 'invalid_region', listRegion],
    ['Region start must be less than 1,000,000,000', 'invalid_region', coverageRegion],
    ['Region stop must be greater than 0', 'invalid_region', listRegion],
    ['Region stop must be less than 1,000,000,000', 'invalid_region', coverageRegion],
    ['Region stop must be greater than region start', 'invalid_region', listRegion],
  ])('fails a 500 "%s" once as %s, relaying the message alone', async (message, reason, call) => {
    const fetch = fakeReplies({ status: 500, body: graphqlErrors(message) });
    const error = (await settle(call)) as McpError;
    expect(error).toBeInstanceOf(McpError);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.message).toBe(message);
    expect(error.data).toEqual({ reason, retryable: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('prefers invalid_region when a 500 carries both kinds of region message', async () => {
    const fetch = fakeReplies({
      status: 500,
      body: graphqlErrors("Invalid chromosome: 'Z'", 'Select a smaller region to view variants'),
    });
    const error = (await settle(listRegion)) as McpError;
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toEqual({ reason: 'invalid_region', retryable: false });
    expect(error.message).toBe("Invalid chromosome: 'Z'; Select a smaller region to view variants");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    'Request timed out',
    'Service overloaded',
    'Query rate limit exceeded. Please try again in a few minutes.',
  ])(
    'retries "%s" on an HTTP 200 envelope, then fails as upstream_unavailable',
    async (message) => {
      const fetch = fakeReplies({
        status: 200,
        body: JSON.stringify({ errors: [{ message }], data: { gene: null } }),
      });
      expectRetriedOut(await settle(listGene));
      expect(fetch).toHaveBeenCalledTimes(4);
    },
  );

  it('retries a transient HTTP 200 error on the variant root and recovers', async () => {
    const variant = {
      variant_id: '1-55051215-G-GA',
      reference_genome: 'GRCh38',
      rsids: [],
      flags: null,
      exome: null,
      genome: null,
      transcript_consequences: null,
      in_silico_predictors: null,
    };
    const fetch = fakeReplies(
      {
        status: 200,
        body: JSON.stringify({
          errors: [{ message: 'Service overloaded' }],
          data: { variant: null, clinvar_variant: null },
        }),
      },
      { status: 200, body: JSON.stringify({ data: { variant, clinvar_variant: null } }) },
    );
    const record = await settle(() =>
      svc.getVariant('1-55051215-G-GA', dsCtx, createMockContext()),
    );
    expect(record).toMatchObject({ variant_id: '1-55051215-G-GA', clinvar_unavailable: false });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps a non-transient HTTP 200 error as a single non-retryable graphql_error', async () => {
    const fetch = fakeReplies({
      status: 200,
      body: JSON.stringify({
        errors: [{ message: 'Multiple genes found for symbol ABC' }],
        data: { gene: null },
      }),
    });
    expect(await settle(listGene)).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'graphql_error', retryable: false },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/56
describe('GnomadService — a gene or transcript gnomAD does not hold (#56)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  type FeatureTarget = { kind: 'gene' | 'transcript'; value: string };
  const operations: Record<
    'list' | 'coverage',
    (t: FeatureTarget, d: Dataset) => Promise<unknown>
  > = {
    list: (target: FeatureTarget, dataset: Dataset) =>
      svc.listGeneVariants(target, {}, svc.resolveDatasetContext(dataset), createMockContext()),
    coverage: (target: FeatureTarget, dataset: Dataset) =>
      svc.getCoverage(target, svc.resolveDatasetContext(dataset), createMockContext()),
  };
  const nullRoot = (root: 'gene' | 'transcript', ...messages: string[]) =>
    JSON.stringify({ errors: messages.map((message) => ({ message })), data: { [root]: null } });

  it.each([
    ['list', 'gene', 'NOTAGENE123', 'gnomad_r4', 'Gene not found', 'gene_not_found', 'GRCh38'],
    ['list', 'gene', 'NOTAGENE123', 'gnomad_r2_1', 'Gene not found', 'gene_not_found', 'GRCh37'],
    [
      'list',
      'transcript',
      'NM_174936.4',
      'gnomad_r4',
      'Transcript not found',
      'transcript_not_found',
      'GRCh38',
    ],
    ['coverage', 'gene', 'NOTAGENE123', 'gnomad_r4', 'Gene not found', 'gene_not_found', 'GRCh38'],
    [
      'coverage',
      'transcript',
      'ENST99999999999',
      'exac',
      'Transcript not found',
      'transcript_not_found',
      'GRCh37',
    ],
  ] as const)(
    '%s raises a null %s root (%s on %s) as %s, naming %s, after one request',
    async (operation, kind, value, dataset, message, reason, build) => {
      const fetch = fakeReplies({ status: 200, body: nullRoot(kind, message) });

      const error = (await settle(() =>
        operations[operation]({ kind, value }, dataset),
      )) as McpError;

      expect(error).toBeInstanceOf(McpError);
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data).toEqual({ reason, retryable: false });
      expect(error.message).toBe(
        `${kind === 'gene' ? 'Gene' : 'Transcript'} "${value}" not found in ${build}.`,
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['list', 'coverage'] as const)(
    '%s raises a null gene root that arrives without an error message as gene_not_found',
    async (operation) => {
      fakeReplies({ status: 200, body: JSON.stringify({ data: { gene: null } }) });

      await expect(
        settle(() => operations[operation]({ kind: 'gene', value: 'NOTAGENE123' }, 'gnomad_r4')),
      ).resolves.toMatchObject({ data: { reason: 'gene_not_found' } });
    },
  );

  it('retries a transient message beside a null root and its not-found message, then fails as upstream_unavailable', async () => {
    const fetch = fakeReplies({
      status: 200,
      body: nullRoot('gene', 'Gene not found', 'Request timed out'),
    });

    const error = (await settle(() =>
      operations.list({ kind: 'gene', value: 'PCSK9' }, 'gnomad_r4'),
    )) as McpError;

    expect(error.data).toMatchObject({ reason: 'upstream_unavailable', retryable: true });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('keeps any other message beside a null transcript root a graphql_error', async () => {
    fakeReplies({ status: 200, body: nullRoot('transcript', 'Invalid transcript ID') });

    await expect(
      settle(() => operations.coverage({ kind: 'transcript', value: 'ENST1' }, 'gnomad_r4')),
    ).resolves.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'graphql_error', retryable: false },
    });
  });

  it('refuses a mitochondrial gene ahead of reading its variants', async () => {
    fakeReplies({
      status: 200,
      body: JSON.stringify({ data: { gene: { chrom: 'M', variants: [] } } }),
    });

    await expect(
      settle(() => operations.list({ kind: 'gene', value: 'MT-TL1' }, 'gnomad_r3')),
    ).resolves.toMatchObject({ data: { reason: 'mitochondrial_unsupported' } });
  });
});

describe('GnomadService.getVariant — ClinVar attribution through the retry loop', () => {
  const GNOMAD_ORIGIN = new URL(getServerConfig().gnomadApiBaseUrl).origin;
  const ID = '1-55051215-G-GA';
  const variant = {
    variant_id: ID,
    reference_genome: 'GRCh38',
    rsids: ['rs527413419'],
    flags: null,
    exome: null,
    genome: {
      ac: 3,
      an: 1_000,
      af: 0.003,
      homozygote_count: 0,
      hemizygote_count: null,
      populations: [],
    },
    transcript_consequences: null,
    in_silico_predictors: null,
  };
  const ok = (data: unknown): Reply => ({ status: 200, body: JSON.stringify({ data }) });
  const envelope = (message: string, data: unknown): Reply => ({
    status: 200,
    body: JSON.stringify({ errors: [{ message }], data }),
  });
  /** gnomAD's combined reply when an error sits beside a resolved variant. */
  const erroredCombined = envelope('Invalid variant ID', { variant, clinvar_variant: null });
  const overloaded = (data: unknown) => envelope('Service overloaded', data);

  type Route = Reply | ((init: RequestInit | undefined) => Promise<Response>);

  /**
   * Fake gnomAD per GraphQL operation and record the operation each request
   * named. A request to another origin, or naming an operation without a route,
   * throws instead of reaching the network.
   */
  function fakeOperations(routes: Record<string, Route>) {
    const operations: string[] = [];
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url).origin !== GNOMAD_ORIGIN) throw new Error(`Unmocked fetch to ${url}`);
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      const operation = /query\s+(\w+)/.exec(query)?.[1] ?? 'anonymous';
      operations.push(operation);
      const route = routes[operation];
      if (!route) throw new Error(`Unmocked gnomAD operation ${operation}`);
      if (typeof route === 'function') return route(init);
      return new Response(route.body, {
        status: route.status,
        headers: { 'content-type': 'application/json' },
      });
    });
    return { fetch, operations };
  }

  /** A request that stays pending until its signal aborts, as a stalled upstream does. */
  const hang = (init: RequestInit | undefined) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });

  const lookup = (id: string, ctx = createMockContext()) =>
    svc.getVariant(id, svc.resolveDatasetContext('gnomad_r4'), ctx);

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/44
  it('retries "Service overloaded" beside a null variant on the combined request only', async () => {
    const { operations } = fakeOperations({
      GnomadVariant: overloaded({ variant: null, clinvar_variant: null }),
    });

    expect(await settle(() => lookup(ID))).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unavailable', retryAttempts: 4 },
    });
    expect(operations).toEqual(Array(4).fill('GnomadVariant'));
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/44
  it('fails the item as upstream_unavailable when the split variant-only request stays overloaded', async () => {
    const { operations } = fakeOperations({
      GnomadVariant: erroredCombined,
      GnomadVariantOnly: overloaded({ variant }),
    });

    expect(await settle(() => lookup(ID))).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unavailable', retryAttempts: 4 },
    });
    expect(operations).toEqual(['GnomadVariant', ...Array(4).fill('GnomadVariantOnly')]);
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/44
  it('recovers the split variant-only request once a transient error clears', async () => {
    let attempt = 0;
    const { operations } = fakeOperations({
      GnomadVariant: erroredCombined,
      GnomadVariantOnly: async () => {
        attempt += 1;
        const reply = attempt < 3 ? overloaded({ variant: null }) : ok({ variant });
        return new Response(reply.body, { status: reply.status });
      },
      GnomadClinvar: ok({ clinvar_variant: null }),
    });

    expect(await settle(() => lookup(ID))).toMatchObject({
      variant_id: ID,
      ac: 3,
      clinvar_unavailable: false,
    });
    expect(operations).toEqual([
      'GnomadVariant',
      'GnomadVariantOnly',
      'GnomadVariantOnly',
      'GnomadVariantOnly',
      'GnomadClinvar',
    ]);
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/44
  it.each<[string, Reply]>([
    ['"Service overloaded" through every retry', overloaded({ clinvar_variant: null })],
    ['an HTTP 503', { status: 503, body: 'Service Unavailable' }],
    [
      'an HTTP 400 rate limit',
      { status: 400, body: graphqlErrors('Query rate limit exceeded. Please try again later.') },
    ],
  ])(
    'degrades a coordinate ID to clinvar_unavailable when the ClinVar-only request answers %s',
    async (_label, reply) => {
      const { operations } = fakeOperations({
        GnomadVariant: erroredCombined,
        GnomadVariantOnly: ok({ variant }),
        GnomadClinvar: reply,
      });

      expect(await settle(() => lookup(ID))).toMatchObject({
        variant_id: ID,
        ac: 3,
        clinvar: null,
        clinvar_unavailable: true,
      });
      expect(operations).toEqual([
        'GnomadVariant',
        'GnomadVariantOnly',
        ...Array(4).fill('GnomadClinvar'),
      ]);
    },
  );

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/44
  it.each<[string, Reply]>([
    ['"Service overloaded" through every retry', overloaded({ clinvar_variant: null })],
    ['an HTTP 503', { status: 503, body: 'Service Unavailable' }],
    [
      'an HTTP 500 GraphQL error',
      { status: 500, body: graphqlErrors('An unknown error occurred') },
    ],
  ])(
    'degrades an rsID to clinvar_unavailable when its ClinVar request answers %s',
    async (_label, reply) => {
      const { operations } = fakeOperations({
        GnomadVariantByRsid: ok({ variant }),
        GnomadClinvar: reply,
      });

      expect(await settle(() => lookup('rs527413419'))).toMatchObject({
        variant_id: ID,
        clinvar: null,
        clinvar_unavailable: true,
      });
      expect(operations).toEqual(['GnomadVariantByRsid', ...Array(4).fill('GnomadClinvar')]);
    },
  );

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/44
  it.each([
    ['a coordinate ID', ID, { GnomadVariant: erroredCombined, GnomadVariantOnly: ok({ variant }) }],
    ['an rsID', 'rs527413419', { GnomadVariantByRsid: ok({ variant }) }],
  ])(
    'ends a stalled ClinVar request for %s at the lookup budget, not after every per-attempt timeout',
    async (_label, id, routes) => {
      const { operations } = fakeOperations({ ...routes, GnomadClinvar: hang });
      let settled: unknown;
      void lookup(id).then(
        (value) => {
          settled = value;
        },
        (error: unknown) => {
          settled = error;
        },
      );

      await vi.advanceTimersByTimeAsync(CLINVAR_LOOKUP_BUDGET_MS - 1);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);

      expect(settled).toMatchObject({ variant_id: ID, clinvar: null, clinvar_unavailable: true });
      // The 45 s budget outlasts one 30 s per-attempt timeout, so a stall gets one retry, not three.
      expect(operations.filter((operation) => operation === 'GnomadClinvar')).toHaveLength(2);
    },
  );

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/44
  it('skips the ClinVar request when the lookup budget is already spent', async () => {
    const { operations } = fakeOperations({
      GnomadVariantByRsid: async () => {
        vi.setSystemTime(Date.now() + CLINVAR_LOOKUP_BUDGET_MS);
        return new Response(JSON.stringify({ data: { variant } }));
      },
    });

    const record = await settle(() =>
      svc.getVariant('rs527413419', svc.resolveDatasetContext('gnomad_r4'), createMockContext(), {
        startedAt: Date.now(),
      }),
    );

    expect(record).toMatchObject({ variant_id: ID, clinvar_unavailable: true });
    expect(operations).toEqual(['GnomadVariantByRsid']);
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/44
  it('rejects a call cancelled before its ClinVar lookup', async () => {
    const controller = new AbortController();
    const { operations } = fakeOperations({
      GnomadVariantByRsid: async () => {
        controller.abort(new Error('client cancelled'));
        return new Response(JSON.stringify({ data: { variant } }), { status: 200 });
      },
    });

    const outcome = await settle(() =>
      svc.getVariant(
        'rs527413419',
        svc.resolveDatasetContext('gnomad_r4'),
        createMockContext({ signal: controller.signal }),
        { startedAt: Date.now() },
      ),
    );

    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).not.toHaveProperty('variant_id');
    expect(operations).toEqual(['GnomadVariantByRsid']);
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/44
  it.each([
    ['a coordinate ID', ID, { GnomadVariant: erroredCombined, GnomadVariantOnly: ok({ variant }) }],
    ['an rsID', 'rs527413419', { GnomadVariantByRsid: ok({ variant }) }],
  ])(
    'rejects %s cancelled during its ClinVar request instead of degrading it',
    async (_label, id, routes) => {
      const controller = new AbortController();
      const { operations } = fakeOperations({
        ...routes,
        GnomadClinvar: (init) => {
          queueMicrotask(() => controller.abort(new Error('client cancelled')));
          return hang(init);
        },
      });

      const outcome = await settle(() =>
        lookup(id, createMockContext({ signal: controller.signal })),
      );

      expect(outcome).toBeInstanceOf(Error);
      expect(outcome).not.toHaveProperty('variant_id');
      expect(operations.at(-1)).toBe('GnomadClinvar');
    },
  );
});

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/58
describe('GnomadService.liftoverCandidates — the best-effort liftover hint', () => {
  /** Live gnomAD liftover entries (GRCh37 source → GRCh38 target), captured 2026-11-01. */
  const PCSK9 = {
    source: { variant_id: '1-55505647-G-T' },
    liftover: { variant_id: '1-55039974-G-T' },
  };
  const r4 = svc.resolveDatasetContext('gnomad_r4');
  const r2 = svc.resolveDatasetContext('gnomad_r2_1');

  /** Fake gnomAD with `respond`, recording each request's query and variables. */
  function fakeLiftover(
    respond: (
      request: { query: string; variables: Record<string, unknown> },
      init: RequestInit | undefined,
    ) => Response | Promise<Response>,
  ) {
    const requests: { query: string; variables: Record<string, unknown> }[] = [];
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      requests.push(request);
      return respond(request, init);
    });
    return { fetch, requests };
  }

  /** A request that stays pending until its signal aborts, as a stalled upstream does. */
  const hang = (init: RequestInit | undefined) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    ['GRCh38 (gnomad_r4)', r4, '1-55505647-G-T', 'source_variant_id', 'GRCh37', '1-55039974-G-T'],
    [
      'GRCh37 (gnomad_r2_1)',
      r2,
      '1-55039974-G-T',
      'liftover_variant_id',
      'GRCh38',
      '1-55505647-G-T',
    ],
  ])(
    'on a %s dataset reads the ID as written for the other build and returns the side on the dataset build',
    async (_label, dsCtx, id, argument, idBuild, candidate) => {
      const { requests } = fakeLiftover(() => Response.json({ data: { l0: [PCSK9] } }));

      const lifted = await svc.liftoverCandidates([id], dsCtx, createMockContext());

      expect(lifted).toEqual(new Map([[id, [candidate]]]));
      expect(requests).toHaveLength(1);
      expect(requests[0]?.query).toContain(
        `l0: liftover(${argument}: $v0, reference_genome: $referenceGenome) { source { variant_id } liftover { variant_id } }`,
      );
      expect(requests[0]?.variables).toEqual({ v0: id, referenceGenome: idBuild });
    },
  );

  it('sends one alias per distinct coordinate ID, never an rsID, and keys only the IDs that lift', async () => {
    const { requests } = fakeLiftover(() => Response.json({ data: { l0: [PCSK9], l1: [] } }));

    const lifted = await svc.liftoverCandidates(
      ['1-55505647-G-T', 'rs11591147', '1-55505648-A-C', '1-55505647-G-T', 'RS1'],
      r4,
      createMockContext(),
    );

    expect(lifted).toEqual(new Map([['1-55505647-G-T', ['1-55039974-G-T']]]));
    expect(requests.map((request) => request.variables)).toEqual([
      { v0: '1-55505647-G-T', v1: '1-55505648-A-C', referenceGenome: 'GRCh37' },
    ]);
    expect(requests[0]?.query).not.toContain('$v2');
  });

  it('returns every distinct ID an entry list lifts to', async () => {
    const second = { source: PCSK9.source, liftover: { variant_id: '1-55039975-G-T' } };
    fakeLiftover(() => Response.json({ data: { l0: [PCSK9, second, PCSK9] } }));

    const lifted = await svc.liftoverCandidates(['1-55505647-G-T'], r4, createMockContext());

    expect(lifted.get('1-55505647-G-T')).toEqual(['1-55039974-G-T', '1-55039975-G-T']);
  });

  it('distrusts the whole reply when any entry names an ID other than the one its alias asked for', async () => {
    const foreign = {
      source: { variant_id: '2-1000-A-C' },
      liftover: { variant_id: '2-2000-A-C' },
    };
    fakeLiftover(() => Response.json({ data: { l0: [PCSK9], l1: [foreign] } }));

    const lifted = await svc.liftoverCandidates(
      ['1-55505647-G-T', '1-55505648-A-C'],
      r4,
      createMockContext(),
    );

    expect(lifted).toEqual(new Map());
  });

  it('sends at most 25 IDs per request and keys each candidate by its own ID', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `1-${55505600 + i}-A-C`);
    ids[27] = PCSK9.source.variant_id;
    const { requests } = fakeLiftover((request) => {
      const data: Record<string, (typeof PCSK9)[]> = {};
      for (const [key, value] of Object.entries(request.variables)) {
        if (key === 'referenceGenome') continue;
        data[`l${key.slice(1)}`] = value === PCSK9.source.variant_id ? [PCSK9] : [];
      }
      return Response.json({ data });
    });

    const lifted = await svc.liftoverCandidates(ids, r4, createMockContext());

    expect(lifted).toEqual(new Map([[PCSK9.source.variant_id, [PCSK9.liftover.variant_id]]]));
    expect(requests.map((request) => Object.keys(request.variables).length - 1)).toEqual([25, 5]);
    expect(requests[1]?.variables).toMatchObject({ v2: PCSK9.source.variant_id });
  });

  it.each([
    ['no IDs', []],
    ['only rsIDs', ['rs11591147', 'RS1']],
  ])('sends nothing for %s', async (_label, ids) => {
    const { fetch } = fakeLiftover(() => Response.json({ data: {} }));

    expect(await svc.liftoverCandidates(ids, r4, createMockContext())).toEqual(new Map());
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each<[string, (init: RequestInit | undefined) => Response | Promise<Response>, number]>([
    [
      'a GraphQL error on HTTP 200',
      () => Response.json({ errors: [{ message: 'Invalid variant ID' }], data: null }),
      1,
    ],
    // gnomAD sends its rate limit as an HTTP 400, and the fetch path retries every 400.
    [
      'an HTTP 400 through every retry',
      () => new Response(graphqlErrors('Bad request'), { status: 400 }),
      4,
    ],
    ['an HTTP 403', () => new Response('Forbidden', { status: 403 }), 1],
    [
      'an HTTP 500 through every retry',
      () => new Response(graphqlErrors('An unknown error occurred'), { status: 500 }),
      4,
    ],
    ['a payload off the response schema', () => Response.json({ data: { l0: null } }), 4],
    ['a stall past the call budget', (init) => hang(init), 2],
  ])('returns no candidates when gnomAD answers %s', async (_label, respond, fetches) => {
    const { fetch } = fakeLiftover((_request, init) => respond(init));
    const ctx = createMockContext();

    expect(await settle(() => svc.liftoverCandidates(['1-55505647-G-T'], r4, ctx))).toEqual(
      new Map(),
    );
    expect(fetch).toHaveBeenCalledTimes(fetches);
  });

  it('ends a stalled request at the call budget anchored on startedAt', async () => {
    fakeLiftover((_request, init) => hang(init));
    const startedAt = Date.now() - 30_000;
    let settled: unknown;
    void svc
      .liftoverCandidates(['1-55505647-G-T'], r4, createMockContext(), { startedAt })
      .then((value) => {
        settled = value;
      });

    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toEqual(new Map());
  });

  it('skips the request when the call budget is already spent', async () => {
    const { fetch } = fakeLiftover(() => Response.json({ data: { l0: [PCSK9] } }));

    const lifted = await svc.liftoverCandidates(['1-55505647-G-T'], r4, createMockContext(), {
      startedAt: Date.now() - UPSTREAM_CALL_BUDGET_MS,
    });

    expect(lifted).toEqual(new Map());
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a call cancelled before the lookup', async () => {
    const { fetch } = fakeLiftover(() => Response.json({ data: { l0: [PCSK9] } }));
    const controller = new AbortController();
    controller.abort(new Error('client cancelled'));

    await expect(
      svc.liftoverCandidates(
        ['1-55505647-G-T'],
        r4,
        createMockContext({ signal: controller.signal }),
      ),
    ).rejects.toThrow('client cancelled');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['an Error', () => new Error('client cancelled')],
    // A cancellation is the caller's whatever its reason's type, an McpError included.
    ['an McpError', () => new McpError(JsonRpcErrorCode.Timeout, 'client cancelled')],
  ])(
    'rejects a call cancelled with %s while the request is in flight instead of degrading it',
    async (_label, reason) => {
      const controller = new AbortController();
      const { fetch } = fakeLiftover((_request, init) => {
        queueMicrotask(() => controller.abort(reason()));
        return hang(init);
      });

      const outcome = await settle(() =>
        svc.liftoverCandidates(
          ['1-55505647-G-T'],
          r4,
          createMockContext({ signal: controller.signal }),
        ),
      );

      expect(outcome).toBeInstanceOf(Error);
      expect(outcome).toMatchObject({ message: 'client cancelled' });
      expect(fetch).toHaveBeenCalledOnce();
    },
  );
});

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/71
describe('GnomadService.getVariantCooccurrence — labelling and refusals at the fetch seam', () => {
  /** A live pair gnomAD holds pre-computed, with 17 samples heterozygous for both. */
  const PAIR = ['1-55505647-G-T', '1-55505651-C-T'];
  /** A live pair no sample carries together, so gnomAD computes it in the order sent. */
  const SINGLETONS = ['1-55505515-G-A', '1-55505537-C-G'];

  const cooccurrence = (variants: string[], service = svc) =>
    settle(() => service.getVariantCooccurrence(variants, createMockContext()));

  /** A successful result, failing the test with the error when the call was refused. */
  async function resolved(variants: string[]) {
    const outcome = await cooccurrence(variants);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }

  /** Every count's alternate alleles, summed per variant, from the genotype and from the haplotype counts. */
  function alleleTotals({
    genotype_counts: g,
    haplotype_counts: h,
  }: Pick<Awaited<ReturnType<typeof resolved>>, 'genotype_counts' | 'haplotype_counts'>) {
    return {
      first: {
        genotypes: g.het_ref + g.het_het + g.het_hom + 2 * (g.hom_ref + g.hom_het + g.hom_hom),
        haplotypes: h.alt_ref + h.alt_alt,
      },
      second: {
        genotypes: g.ref_het + g.het_het + g.hom_het + 2 * (g.ref_hom + g.het_hom + g.hom_hom),
        haplotypes: h.ref_alt + h.alt_alt,
      },
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('names each count of a live pair in gnomAD’s documented array order', async () => {
    const { requests } = fakeCooccurrenceFetch();

    const result = await resolved(PAIR);

    expect(result.variant_ids).toEqual(PAIR);
    expect(result).toMatchObject({
      dataset: 'gnomad_r2_1',
      reference_genome: 'GRCh37',
      p_compound_heterozygous: 0.9979097658252426,
    });
    expect(Object.entries(result.genotype_counts)).toEqual([
      ['ref_ref', 92584],
      ['ref_het', 1887],
      ['ref_hom', 14],
      ['het_ref', 2194],
      ['het_het', 17],
      ['het_hom', 0],
      ['hom_ref', 28],
      ['hom_het', 0],
      ['hom_hom', 0],
    ]);
    expect(Object.entries(result.haplotype_counts)).toEqual([
      ['ref_ref', 189249.04847395173],
      ['ref_alt', 1931.9515260482826],
      ['alt_ref', 2266.9515260482826],
      ['alt_alt', 0.04847395171724291],
    ]);
    expect(result.populations.map((population) => population.id)).toEqual([
      'afr',
      'amr',
      'asj',
      'eas',
      'fin',
      'nfe',
      'oth',
      'sas',
    ]);
    expect(result.populations[1]).toEqual({
      id: 'amr',
      p_compound_heterozygous: 0.9285025699368075,
      genotype_counts: {
        ref_ref: 14055,
        ref_het: 290,
        ref_hom: 1,
        het_ref: 180,
        het_het: 2,
        het_hom: 0,
        hom_ref: 1,
        hom_het: 0,
        hom_hom: 0,
      },
      haplotype_counts: {
        ref_ref: 28580.145562415993,
        ref_alt: 293.8544375840076,
        alt_ref: 183.85443758400763,
        alt_alt: 0.14556241599237624,
      },
    });
    expect(requests).toHaveLength(1);
    // fakeCooccurrenceFetch replays the whole capture whatever the document selects, so the selection is pinned here.
    expect(requests[0]?.query.replace(/\s+/g, ' ')).toContain(
      'variant_cooccurrence(variants: $variants, dataset: $dataset) { variant_ids genotype_counts haplotype_counts p_compound_heterozygous populations { id genotype_counts haplotype_counts p_compound_heterozygous } }',
    );
    expect(requests[0]?.variables).toEqual({ variants: PAIR, dataset: 'gnomad_r2_1' });
  });

  it.each([
    ['an indexed pair', ['1-55516888-G-GA', '1-55505647-G-T']],
    ['an indexed pair with het_het carriers', PAIR],
    ['a computed pair', SINGLETONS],
  ])(
    'labels %s so each variant’s alternate alleles agree across genotype and haplotype counts, overall and per group',
    async (_label, variants) => {
      fakeCooccurrenceFetch();

      const result = await resolved(variants);

      for (const counts of [result, ...result.populations]) {
        const totals = alleleTotals(counts);
        expect(totals.first.haplotypes).toBeCloseTo(totals.first.genotypes, 6);
        expect(totals.second.haplotypes).toBeCloseTo(totals.second.genotypes, 6);
      }
    },
  );

  it('reads an indexed pair sent reversed in gnomAD’s stored order, counts unchanged', async () => {
    const { requests } = fakeCooccurrenceFetch();
    const forward = await resolved(PAIR);

    const reversed = await resolved([...PAIR].reverse());

    expect(requests[1]?.variables.variants).toEqual(['1-55505651-C-T', '1-55505647-G-T']);
    expect(reversed.variant_ids).toEqual(PAIR);
    expect(reversed).toEqual(forward);
  });

  it('follows the order sent for a computed pair, so a carrier changes key with it', async () => {
    fakeCooccurrenceFetch();

    const forward = await resolved(SINGLETONS);
    const reversed = await resolved([...SINGLETONS].reverse());

    const group = (result: typeof forward, id: string) =>
      result.populations.find((population) => population.id === id)?.genotype_counts;
    expect(forward.variant_ids).toEqual(SINGLETONS);
    expect(group(forward, 'nfe')).toMatchObject({ ref_het: 1, het_ref: 0 });
    expect(group(forward, 'sas')).toMatchObject({ ref_het: 0, het_ref: 1 });
    expect(reversed.variant_ids).toEqual(['1-55505537-C-G', '1-55505515-G-A']);
    expect(group(reversed, 'nfe')).toMatchObject({ ref_het: 0, het_ref: 1 });
    expect(group(reversed, 'sas')).toMatchObject({ ref_het: 1, het_ref: 0 });
    expect(forward).toMatchObject({
      p_compound_heterozygous: 1,
      genotype_counts: { het_het: 0 },
    });
  });

  it('keeps a null probability null overall and in every group, never 0', async () => {
    fakeCooccurrenceFetch();

    const result = await resolved(['11-2181053-G-T', '11-2181054-C-T']);

    expect(result.p_compound_heterozygous).toBeNull();
    expect(result.populations.map((population) => population.p_compound_heterozygous)).toEqual(
      Array(8).fill(null),
    );
    expect(result.genotype_counts.ref_het).toBe(31);
  });

  it('asks for gnomad_r2_1 whatever the server’s default dataset', async () => {
    const { requests } = fakeCooccurrenceFetch();
    const service = new GnomadService({ ...getServerConfig(), defaultDataset: 'gnomad_r3' });

    await cooccurrence(PAIR, service);

    expect(requests[0]?.variables.dataset).toBe('gnomad_r2_1');
  });

  it.each([
    ['the same ID twice', ['1-55505647-G-T', '1-55505647-G-T'], 'Variants must be different'],
    [
      'an ID gnomAD lacks',
      ['1-55505647-G-T', '1-55505650-A-ACGTACGTACGT'],
      'Variant co-occurrence is only available for variants found in gnomAD',
    ],
    [
      'two GRCh38 IDs',
      ['1-55051215-G-GA', '1-55039974-G-T'],
      'Variant co-occurrence is only available for variants found in gnomAD',
    ],
    [
      'variants in different genes',
      ['1-55505647-G-T', '11-2181054-C-T'],
      'Variant co-occurrence is only available for variants that occur in the same gene',
    ],
    [
      'two intronic variants',
      ['1-55505742-G-A', '1-55505753-G-A'],
      'Variant co-occurrence is only available for coding or UTR variants that occur in the same gene',
    ],
    [
      'a genome-only variant',
      ['1-55505647-G-T', '1-55505452-T-G'],
      'Variant co-occurrence is only available for variants that appear in gnomAD exome samples',
    ],
    [
      'a variant above 5% exome AF',
      ['1-55505647-G-T', '1-55505668-C-T'],
      'Variant co-occurrence is only available for variants with a global allele frequency ≤ 5%',
    ],
  ])(
    'fails %s as cooccurrence_unavailable with gnomAD’s sentence after one request',
    async (_label, variants, sentence) => {
      const { fetch } = fakeCooccurrenceFetch();

      const outcome = await cooccurrence(variants);

      expect(outcome).toBeInstanceOf(McpError);
      expect(outcome).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: sentence,
        data: { reason: 'cooccurrence_unavailable', retryable: false },
      });
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ['Invalid variant ID'],
    ['A pair of variants is required'],
    ['Variant cooccurrence is not available for gnomAD v4'],
    [
      'Variants must be different',
      'Variant co-occurrence is only available for variants found in gnomAD',
    ],
    [`Variant co-occurrence is only available for ${'A'.repeat(1_000_000)};`],
  ])(
    'keeps any other GraphQL error (%s) a graphql_error after one request',
    async (...messages) => {
      const { fetch } = fakeCooccurrenceFetch(() =>
        Response.json({
          errors: messages.map((message) => ({ message })),
          data: { variant_cooccurrence: null },
        }),
      );

      const outcome = await cooccurrence(PAIR);

      expect(outcome).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: `gnomAD GraphQL error: ${messages.join('; ')}`,
        data: { reason: 'graphql_error', retryable: false },
      });
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it('fails a reply naming another pair as invalid_upstream_response, after every retry', async () => {
    const { fetch } = fakeCooccurrenceFetch(() => Response.json(liveCooccurrence(...PAIR)));

    const outcome = await cooccurrence(SINGLETONS);

    expect(outcome).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'invalid_upstream_response' },
    });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it.each([
    ['eight genotype counts', (c: Record<string, unknown[]>) => c.genotype_counts?.pop()],
    ['five haplotype counts', (c: Record<string, unknown[]>) => c.haplotype_counts?.push(0)],
    ['three variant_ids', (c: Record<string, unknown[]>) => c.variant_ids?.push('1-1-A-C')],
    [
      'a group with three haplotype counts',
      (c: Record<string, { haplotype_counts: unknown[] }[]>) =>
        c.populations?.[0]?.haplotype_counts.pop(),
    ],
  ])('fails a reply carrying %s as invalid_upstream_response', async (_label, corrupt) => {
    fakeCooccurrenceFetch(() => {
      const body = structuredClone(liveCooccurrence(...PAIR)) as {
        data: { variant_cooccurrence: never };
      };
      corrupt(body.data.variant_cooccurrence);
      return Response.json(body);
    });

    expect(await cooccurrence(PAIR)).toMatchObject({
      data: { reason: 'invalid_upstream_response' },
    });
  });

  it.each([[['M-3243-A-G', 'M-3244-G-A']], [['1-55505647-G-T', 'MT-3243-A-G']]])(
    'refuses %j as mitochondrial_unsupported before any fetch',
    async (variants) => {
      const fetch = vi.spyOn(globalThis, 'fetch');

      expect(await cooccurrence(variants)).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'mitochondrial_unsupported' },
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('rejects with the caller’s cancellation while the request is in flight', async () => {
    const controller = new AbortController();
    const { fetch } = fakeCooccurrenceFetch(
      (_request, init) =>
        new Promise<Response>((_resolve, reject) => {
          queueMicrotask(() => controller.abort(new Error('client cancelled')));
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );

    const outcome = await settle(() =>
      svc.getVariantCooccurrence(PAIR, createMockContext({ signal: controller.signal })),
    );

    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).not.toBeInstanceOf(McpError);
    expect(outcome).toMatchObject({ message: 'client cancelled' });
    expect(fetch).toHaveBeenCalledOnce();
  });
});

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/66
describe("GnomadService.clinvarVariantIds — gnomAD's ClinVar mapping for a gene", () => {
  /** Live `gene.clinvar_variants` entries (GRCh38, gnomAD ClinVar release 2026-10-11), captured 2026-11-03. */
  const BRCA1 = [
    { clinvar_variation_id: '4845640', variant_id: '17-43045713-AG-A' },
    { clinvar_variation_id: '4713084', variant_id: '17-43092191-CAT-C' },
    { clinvar_variation_id: '55393', variant_id: '17-43099814-G-A' },
  ];
  const MT_ND1 = [
    { clinvar_variation_id: '692328', variant_id: 'M-3307-A-T' },
    { clinvar_variation_id: '692329', variant_id: 'M-3308-T-AC' },
  ];
  const mapping = (clinvar_variants: unknown) =>
    Response.json({ data: { gene: { clinvar_variants } } });

  /** Fake gnomAD with `respond`, recording each request's query and variables. */
  function fakeMapping(respond: (init: RequestInit | undefined) => Response | Promise<Response>) {
    const requests: { query: string; variables: Record<string, unknown> }[] = [];
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return respond(init);
    });
    return { fetch, requests };
  }

  /** A request that stays pending until its signal aborts, as a stalled upstream does. */
  const hang = (init: RequestInit | undefined) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });

  const lookup = (gene: string, ctx = createMockContext(), startedAt = Date.now()) =>
    svc.clinvarVariantIds(gene, ctx, { startedAt });

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('maps each VariationID to its gnomAD ID with one GRCh38 gene request', async () => {
    const { requests } = fakeMapping(() => mapping(BRCA1));

    expect(await lookup('BRCA1')).toEqual({
      status: 'resolved',
      variantIds: new Map([
        ['4845640', '17-43045713-AG-A'],
        ['4713084', '17-43092191-CAT-C'],
        ['55393', '17-43099814-G-A'],
      ]),
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.query).toContain(
      'gene(gene_symbol: $gene, reference_genome: GRCh38) { clinvar_variants { clinvar_variation_id variant_id } }',
    );
    expect(requests[0]?.variables).toEqual({ gene: 'BRCA1' });
  });

  it('leaves out mitochondrial IDs, which gnomad_get_variant refuses', async () => {
    fakeMapping(() => mapping([...MT_ND1, BRCA1[1]]));

    expect(await lookup('MT-ND1')).toEqual({
      status: 'resolved',
      variantIds: new Map([['4713084', '17-43092191-CAT-C']]),
    });
  });

  it.each([
    ['a null list', null],
    ['an empty list', []],
  ])('reads %s as a mapping that holds no VariationID', async (_label, list) => {
    fakeMapping(() => mapping(list));

    expect(await lookup('BRCA1')).toEqual({ status: 'resolved', variantIds: new Map() });
  });

  it('answers gene_not_found, after one request, for a gene gnomAD does not hold', async () => {
    // gnomAD's live reply to an unknown symbol (HTTP 200).
    const { fetch } = fakeMapping(() =>
      Response.json({ errors: [{ message: 'Gene not found' }], data: { gene: null } }),
    );

    expect(await lookup('ZZNOTAGENE9')).toEqual({ status: 'gene_not_found' });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('retries "Service overloaded" inside an HTTP 200 and returns the mapping once it clears', async () => {
    let attempt = 0;
    const { fetch } = fakeMapping(() => {
      attempt += 1;
      return attempt === 1
        ? Response.json({
            errors: [{ message: 'Service overloaded' }],
            data: { gene: null },
          })
        : mapping(BRCA1);
    });

    const outcome = await settle(() => lookup('BRCA1'));

    expect(outcome).toMatchObject({ status: 'resolved' });
    expect((outcome as { variantIds: Map<string, string> }).variantIds.get('4713084')).toBe(
      '17-43092191-CAT-C',
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each<[string, (init: RequestInit | undefined) => Response | Promise<Response>, number]>([
    [
      'a GraphQL error on HTTP 200',
      () => Response.json({ errors: [{ message: 'Unknown field' }], data: null }),
      1,
    ],
    [
      '"Service overloaded" through every retry',
      () => Response.json({ errors: [{ message: 'Service overloaded' }], data: { gene: null } }),
      4,
    ],
    // gnomAD sends its rate limit as an HTTP 400, and the fetch path retries every 400.
    [
      'an HTTP 400 through every retry',
      () => new Response(graphqlErrors('Query rate limit exceeded.'), { status: 400 }),
      4,
    ],
    ['an HTTP 403', () => new Response('Forbidden', { status: 403 }), 1],
    ['an HTTP 404 through every retry', () => new Response('Not Found', { status: 404 }), 4],
    [
      'an HTTP 422 through every retry',
      () => new Response(graphqlErrors('Unprocessable'), { status: 422 }),
      4,
    ],
    [
      'an HTTP 429 with Retry-After through every retry',
      () => new Response('Too Many Requests', { status: 429, headers: { 'retry-after': '1' } }),
      4,
    ],
    [
      'an HTML page on HTTP 200 through every retry',
      () =>
        new Response('<!doctype html><html><body>maintenance</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      4,
    ],
    [
      'a connection reset through every retry',
      () => Promise.reject(Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' })),
      4,
    ],
    [
      'an HTTP 500 through every retry',
      () => new Response(graphqlErrors('An unknown error occurred'), { status: 500 }),
      4,
    ],
    [
      'a payload off the response schema',
      () => mapping([{ clinvar_variation_id: 4713084, variant_id: '17-43092191-CAT-C' }]),
      4,
    ],
    ['a stall past the call budget', (init) => hang(init), 2],
  ])('answers unavailable when gnomAD answers %s', async (_label, respond, fetches) => {
    const { fetch } = fakeMapping(respond);

    expect(await settle(() => lookup('BRCA1'))).toEqual({ status: 'unavailable' });
    expect(fetch).toHaveBeenCalledTimes(fetches);
  });

  it('ends a stalled request at the call budget anchored on startedAt', async () => {
    fakeMapping((init) => hang(init));
    let settled: unknown;
    void lookup('BRCA1', createMockContext(), Date.now() - 30_000).then((value) => {
      settled = value;
    });

    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toEqual({ status: 'unavailable' });
  });

  it('answers unavailable at the call budget while other requests hold every gnomAD slot', async () => {
    const { fetch } = fakeMapping((init) => hang(init));
    const r4 = svc.resolveDatasetContext('gnomad_r4');
    // Two stalled lookups hold both slots (GNOMAD_MAX_CONCURRENCY 2) past the mapping's budget.
    const holders = [
      svc.getGeneConstraint('PCSK9', r4, createMockContext()).catch((err: unknown) => err),
      svc.getGeneConstraint('BRCA1', r4, createMockContext()).catch((err: unknown) => err),
    ];
    try {
      let settled: unknown;
      void lookup('BRCA1', createMockContext(), Date.now() - 30_000).then(
        (value) => {
          settled = value;
        },
        (err: unknown) => {
          settled = err;
        },
      );

      await vi.advanceTimersByTimeAsync(14_999);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toEqual({ status: 'unavailable' });
      // The mapping never reached the upstream: only the two holders fetched.
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      // Release both slots on the shared service whatever the outcome, so no later test queues.
      await vi.advanceTimersByTimeAsync(60_000);
      await Promise.all(holders);
    }
  });

  it('starts no request once the call budget is spent', async () => {
    const { fetch } = fakeMapping(() => mapping(BRCA1));

    expect(
      await lookup('BRCA1', createMockContext(), Date.now() - UPSTREAM_CALL_BUDGET_MS),
    ).toEqual({ status: 'unavailable' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a call cancelled before the lookup', async () => {
    const { fetch } = fakeMapping(() => mapping(BRCA1));
    const controller = new AbortController();
    controller.abort(new Error('client cancelled'));

    await expect(lookup('BRCA1', createMockContext({ signal: controller.signal }))).rejects.toThrow(
      'client cancelled',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['an Error', () => new Error('client cancelled')],
    // A cancellation is the caller's whatever its reason's type, an McpError included.
    ['an McpError', () => new McpError(JsonRpcErrorCode.Timeout, 'client cancelled')],
  ])(
    'rejects a call cancelled with %s while the request is in flight instead of degrading it',
    async (_label, reason) => {
      const controller = new AbortController();
      const { fetch } = fakeMapping((init) => {
        queueMicrotask(() => controller.abort(reason()));
        return hang(init);
      });

      const outcome = await settle(() =>
        lookup('BRCA1', createMockContext({ signal: controller.signal })),
      );

      expect(outcome).toBeInstanceOf(Error);
      expect(outcome).toMatchObject({ message: 'client cancelled' });
      expect(outcome).not.toHaveProperty('status');
      expect(fetch).toHaveBeenCalledOnce();
    },
  );
});

/** A FAF figure to the eight decimals #64 states them in. */
const round8 = (value: number) => Math.round(value * 1e8) / 1e8;

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/64
describe("GnomadService.getVariant — the record's filtering allele frequency (#64)", () => {
  afterEach(() => vi.restoreAllMocks());

  type Record64 = NonNullable<Awaited<ReturnType<typeof svc.getVariant>>>;
  const rounded = <T extends { value: number }>(faf: T | null) =>
    faf && { ...faf, value: round8(faf.value) };
  /** The record's FAF fields, rounded; a callset the variant is not carried in reads 'not carried'. */
  const fafView = (record: Record64 | null) => ({
    faf95: rounded(record?.faf95 ?? null),
    exome: record?.callsets.exome ? rounded(record.callsets.exome.faf95) : 'not carried',
    genome: record?.callsets.genome ? rounded(record.callsets.genome.faf95) : 'not carried',
  });
  const lookup = (dataset: Dataset, variantId: string) => {
    const requests = fakeFafVariants();
    const record = svc.getVariant(
      variantId,
      svc.resolveDatasetContext(dataset),
      createMockContext(),
    );
    return { requests, record };
  };
  /** Serve one variant payload, as gnomAD answers this server's combined document. */
  const serveVariant = (variant: unknown) => serveData({ variant, clinvar_variant: null });
  const nfe = (value: number) => ({ value, group: 'nfe' });

  it.each([
    [
      'gnomad_r4',
      '1-55039974-G-T',
      { ...nfe(0.01649444), source: 'joint' },
      nfe(0.01651719),
      nfe(0.01542945),
    ],
    [
      'gnomad_r3',
      '1-55039974-G-T',
      { ...nfe(0.01542765), source: 'genome' },
      'not carried',
      nfe(0.01542765),
    ],
    [
      'gnomad_r2_1',
      '1-55505647-G-T',
      { ...nfe(0.01440023), source: 'exome' },
      nfe(0.01440023),
      nfe(0.01338745),
    ],
    [
      'gnomad_r2_1_non_cancer',
      '1-55505647-G-T',
      { ...nfe(0.01434385), source: 'exome' },
      nfe(0.01434385),
      nfe(0.01338745),
    ],
    [
      'gnomad_r2_1_controls',
      '1-55505647-G-T',
      { ...nfe(0.01481907), source: 'exome' },
      nfe(0.01481907),
      nfe(0.01258769),
    ],
    [
      'gnomad_r2_1_non_neuro',
      '1-55505647-G-T',
      { ...nfe(0.01401682), source: 'exome' },
      nfe(0.01401682),
      nfe(0.01322593),
    ],
    [
      'gnomad_r2_1_non_topmed',
      '1-55505647-G-T',
      { ...nfe(0.01435665), source: 'exome' },
      nfe(0.01435665),
      nfe(0.01226821),
    ],
    ['exac', '1-55505647-G-T', null, null, 'not carried'],
    // AC 0: gnomAD publishes the joint record, its FAF95 null.
    ['gnomad_r4', '1-55039866-G-A', null, null, 'not carried'],
  ] as const)(
    'reads the live %s record of %s',
    async (dataset, variantId, faf95, exome, genome) => {
      const { requests, record } = lookup(dataset, variantId);

      expect(fafView(await record)).toEqual({ faf95, exome, genome });
      // fakeFafVariants serves each record's faf95 whatever the document selects, so the selection is pinned here.
      const document = requests[0]?.query.replace(/\s+/g, ' ') ?? '';
      for (const callset of ['exome', 'genome', 'joint']) {
        expect(document).toMatch(
          new RegExp(`${callset} \\{[^}]*faf95 \\{ popmax popmax_population \\}`),
        );
      }
    },
  );

  it.each([
    ['gnomad_r4_non_ukb', 'r4_non_ukb', 'gnomad_r4', 'exome', 0.01651719],
    ['gnomad_r3_controls_and_biobanks', 'r3_cab', 'gnomad_r3', 'genome', 0.01542765],
    ['gnomad_r3_non_cancer', 'r3_non_cancer', 'gnomad_r3', 'genome', 0.01542765],
    ['gnomad_r3_non_neuro', 'r3_non_neuro', 'gnomad_r3', 'genome', 0.01542765],
    ['gnomad_r3_non_topmed', 'r3_non_topmed', 'gnomad_r3', 'genome', 0.01542765],
    ['gnomad_r3_non_v2', 'r3_non_v2', 'gnomad_r3', 'genome', 0.01542765],
  ] as const)(
    'relays no FAF on a %s record, whose live reply (%s) carries %s’s %s FAF95 %d',
    async (dataset, alias, parent, callset, parentFaf) => {
      const reply = fafVariant(alias) as Record<'exome' | 'genome', { faf95: { popmax: number } }>;
      // gnomAD's reply for the subset carries the parent's figure, beside the subset's own counts.
      expect(round8(reply[callset].faf95.popmax)).toBe(parentFaf);
      const subset = svc.resolveDatasetContext(dataset);
      expect(subset.parent).toBe(parent);
      fakeFafVariants();

      const record = await svc.getVariant(
        FAF_VARIANT_ALIASES[alias].variantId,
        subset,
        createMockContext(),
      );

      expect(record?.callsets[callset]?.ac).toBeGreaterThan(0);
      expect(fafView(record)).toEqual({
        faf95: null,
        exome: alias === 'r4_non_ukb' ? null : 'not carried',
        genome: null,
      });
    },
  );

  it('reads a published joint record’s null FAF95 as null, never a callset value', async () => {
    const live = fafVariant('r4') as { joint: Record<string, unknown> };
    serveVariant({
      ...live,
      joint: { ...live.joint, faf95: { popmax: null, popmax_population: null } },
    });

    const record = await svc.getVariant(
      '1-55039974-G-T',
      svc.resolveDatasetContext('gnomad_r4'),
      createMockContext(),
    );

    expect(fafView(record)).toEqual({
      faf95: null,
      exome: nfe(0.01651719),
      genome: nfe(0.01542945),
    });
  });

  it('takes the higher callset value, whichever callset carries it', async () => {
    const live = fafVariant('r2') as Record<'exome' | 'genome', Record<string, unknown>>;
    // The live callset FAFs swapped, so the genome carries the higher one.
    serveVariant({
      ...live,
      exome: { ...live.exome, faf95: live.genome.faf95 },
      genome: { ...live.genome, faf95: live.exome.faf95 },
    });

    const record = await svc.getVariant(
      '1-55505647-G-T',
      svc.resolveDatasetContext('gnomad_r2_1'),
      createMockContext(),
    );

    expect(fafView(record)).toEqual({
      faf95: { ...nfe(0.01440023), source: 'genome' },
      exome: nfe(0.01338745),
      genome: nfe(0.01440023),
    });
  });

  it('keeps a FAF95 whose group gnomAD leaves unnamed, with a null group', async () => {
    const live = fafVariant('r3') as { genome: Record<string, unknown> };
    serveVariant({
      ...live,
      genome: { ...live.genome, faf95: { popmax: 0.015427649999999996, popmax_population: null } },
    });

    const record = await svc.getVariant(
      '1-55039974-G-T',
      svc.resolveDatasetContext('gnomad_r3'),
      createMockContext(),
    );

    expect(fafView(record)).toEqual({
      faf95: { value: 0.01542765, group: null, source: 'genome' },
      exome: 'not carried',
      genome: { value: 0.01542765, group: null },
    });
  });

  it('reads a reply without faf95 (a document that predates it) as no FAF', async () => {
    serveVariant(minimalVariant('1-55039974-G-T'));

    const record = await svc.getVariant(
      '1-55039974-G-T',
      svc.resolveDatasetContext('gnomad_r3'),
      createMockContext(),
    );

    expect(fafView(record)).toEqual({ faf95: null, exome: 'not carried', genome: null });
  });
});

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/64
describe('GnomadService.listGeneVariants — faf95_max and the max_faf filter (#64)', () => {
  afterEach(() => vi.restoreAllMocks());

  const list = (
    dataset: Dataset,
    region: string,
    filters: { maxFaf?: number; passOnly?: boolean } = {},
  ) =>
    svc.listGeneVariants(
      { kind: 'region', value: region },
      filters,
      svc.resolveDatasetContext(dataset),
      createMockContext(),
    );
  const fafs = (rows: Awaited<ReturnType<typeof list>>) =>
    rows.map((row) => [
      row.variant_id,
      row.faf95_max == null ? null : round8(row.faf95_max),
      row.faf95_max_group,
    ]);

  it.each([
    ['gnomad_r4', '1-55039974-G-T', 0.01649444, 'nfe'],
    ['gnomad_r4_non_ukb', '1-55039974-G-T', 0.01458238, 'nfe'],
    ['gnomad_r3', '1-55039974-G-T', null, null],
    ['gnomad_r3_non_topmed', '1-55039974-G-T', null, null],
    ['gnomad_r2_1', '1-55505647-G-T', 0.01440023, 'nfe'],
    ['gnomad_r2_1_non_cancer', '1-55505647-G-T', 0.01434385, 'nfe'],
    ['exac', '1-55505647-G-T', null, null],
  ] as const)(
    'reads the live %s row of %s as faf95_max %s (%s)',
    async (dataset, variantId, value, group) => {
      fakeFafLists();
      const pos = variantId.split('-')[1];

      const rows = fafs(await list(dataset, `1-${pos}-${pos}`));
      expect(rows.find(([id]) => id === variantId)).toEqual([variantId, value, group]);
    },
  );

  it('reads the other allele at 1-55039974 on gnomad_r4 and gnomad_r4_non_ukb as null: gnomAD reports no FAF for it', async () => {
    fakeFafLists();

    for (const dataset of ['gnomad_r4', 'gnomad_r4_non_ukb'] as const) {
      expect(fafs(await list(dataset, '1-55039974-55039974'))).toEqual([
        ['1-55039974-G-T', dataset === 'gnomad_r4' ? 0.01649444 : 0.01458238, 'nfe'],
        ['1-55039974-G-A', null, null],
      ]);
    }
  });

  it('keeps a null-FAF row under any max_faf, drops a row above it, and keeps one equal to it', async () => {
    fakeFafLists();

    expect(fafs(await list('gnomad_r3', '1-55039974-55039974', { maxFaf: 0 }))).toEqual([
      ['1-55039974-G-T', null, null],
    ]);
    expect(fafs(await list('gnomad_r4', '1-55039974-55039974', { maxFaf: 0.0164944 }))).toEqual([
      ['1-55039974-G-A', null, null],
    ]);
    expect(fafs(await list('gnomad_r4', '1-55039974-55039974', { maxFaf: 0.01649444 }))).toEqual([
      ['1-55039974-G-T', 0.01649444, 'nfe'],
      ['1-55039974-G-A', null, null],
    ]);
  });

  it('under pass_only, reads a row without joint data from its passing callsets, as its counts', async () => {
    const live = fafRegionRow('gnomad_r2_1', '1-55505647-55505647') as Record<
      'exome' | 'genome',
      Record<string, unknown>
    >;
    // The live row with its exome call failed as RF, the filter gnomad_r2_1 applies.
    serveData({ region: { variants: [{ ...live, exome: { ...live.exome, filters: ['RF'] } }] } });

    expect(fafs(await list('gnomad_r2_1', '1-55505647-55505647', { passOnly: true }))).toEqual([
      ['1-55505647-G-T', 0.01338745, 'nfe'],
    ]);
    expect(fafs(await list('gnomad_r2_1', '1-55505647-55505647'))).toEqual([
      ['1-55505647-G-T', 0.01440023, 'nfe'],
    ]);
  });

  /** Every DatasetId with the `@include` flags its list documents carry. */
  const FLAGS = [
    ['gnomad_r4', true, false, false],
    ['gnomad_r4_non_ukb', false, true, false],
    ['gnomad_r3', false, false, false],
    ['gnomad_r3_controls_and_biobanks', false, false, false],
    ['gnomad_r3_non_cancer', false, false, false],
    ['gnomad_r3_non_neuro', false, false, false],
    ['gnomad_r3_non_topmed', false, false, false],
    ['gnomad_r3_non_v2', false, false, false],
    ['gnomad_r2_1', false, false, true],
    ['gnomad_r2_1_controls', false, false, true],
    ['gnomad_r2_1_non_neuro', false, false, true],
    ['gnomad_r2_1_non_cancer', false, false, true],
    ['gnomad_r2_1_non_topmed', false, false, true],
    ['exac', false, false, false],
  ] as const;

  it.each(FLAGS)(
    'sends %s list documents jointFafmax %s, callsetFafmax %s, callsetFaf95 %s',
    async (dataset, jointFafmax, callsetFafmax, callsetFaf95) => {
      const variables: Record<string, unknown>[] = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { variables: Record<string, unknown> };
        variables.push(request.variables);
        return Response.json({
          data: {
            region: { variants: [] },
            transcript: { chrom: '1', variants: [] },
            gene: { chrom: '1', variants: [] },
          },
        });
      });
      const dsCtx = svc.resolveDatasetContext(dataset);
      for (const target of [
        { kind: 'region', value: '1-55505647-55505647' },
        { kind: 'gene', value: 'PCSK9' },
        { kind: 'gene', value: 'ENSG00000169174' },
        { kind: 'transcript', value: 'ENST00000302118' },
      ] as const) {
        await svc.listGeneVariants(target, {}, dsCtx, createMockContext());
      }

      expect(variables).toHaveLength(4);
      for (const sent of variables) {
        expect(sent).toMatchObject({ dataset, jointFafmax, callsetFafmax, callsetFaf95 });
      }
    },
  );

  it.each([
    ['gnomad_r4', '1-55039974-55039974', ['joint.fafmax']],
    ['gnomad_r4_non_ukb', '1-55039974-55039974', ['exome.fafmax', 'genome.fafmax']],
    ['gnomad_r2_1', '1-55505647-55505647', ['exome.faf95', 'genome.faf95']],
    ['gnomad_r2_1_non_cancer', '1-55505647-55505647', ['exome.faf95', 'genome.faf95']],
    ['gnomad_r3', '1-55039974-55039974', []],
    ['gnomad_r3_non_topmed', '1-55039974-55039974', []],
    ['exac', '1-55505647-55505647', []],
  ] as const)(
    'selects on %s only the FAF fields its rows read',
    async (dataset, region, fields) => {
      const requests = fakeFafLists();

      await list(dataset, region);

      expect(requests).toHaveLength(1);
      expect(selectedFafFields(requests[0] as (typeof requests)[number])).toEqual(fields);
    },
  );
});

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/64
describe('GnomadService.listGeneVariants — the pruned FAF selection loses no row value (#64)', () => {
  afterEach(() => vi.restoreAllMocks());

  interface FullRow {
    exome: FullCallset | null;
    genome: FullCallset | null;
    joint: { ac: number | null; fafmax?: Fafmax | null } | null;
    variant_id: string;
  }
  interface Fafmax {
    faf95_max: number | null;
    faf95_max_gen_anc: string | null;
  }
  interface FullCallset {
    faf95?: { popmax: number | null; popmax_population: string | null } | null;
    fafmax?: Fafmax | null;
  }

  /**
   * #64's rule over a reply with every FAF field selected: `joint.fafmax` on a
   * row with joint data, else the highest callset `fafmax` or `faf95`.
   */
  function fullSelectionFaf(row: FullRow): [number | null, string | null] {
    if (row.joint?.ac != null) {
      const value = row.joint.fafmax?.faf95_max ?? null;
      return [value, value == null ? null : (row.joint.fafmax?.faf95_max_gen_anc ?? null)];
    }
    let best: [number, string | null] | null = null;
    for (const callset of [row.exome, row.genome]) {
      for (const [value, group] of [
        [callset?.fafmax?.faf95_max, callset?.fafmax?.faf95_max_gen_anc],
        [callset?.faf95?.popmax, callset?.faf95?.popmax_population],
      ] as const) {
        if (value != null && (best == null || value > best[0])) best = [value, group ?? null];
      }
    }
    return best ?? [null, null];
  }

  it.each([
    ['gnomad_r4', 4544, 1540, { jointFafmax: true, callsetFafmax: false, callsetFaf95: false }],
    [
      'gnomad_r4_non_ukb',
      3987,
      1004,
      { jointFafmax: false, callsetFafmax: true, callsetFaf95: false },
    ],
    ['gnomad_r2_1', 1429, 572, { jointFafmax: false, callsetFafmax: false, callsetFaf95: true }],
  ] as const)(
    'gives every PCSK9 row on %s (%i rows, %i with a FAF) the value the full selection gives',
    async (dataset, count, withFaf, flags) => {
      const requests = fakeFafLists();
      const reply = FAF_GENE_LISTS[`list-gene:${dataset}:PCSK9`];
      if (!reply) throw new Error(`No live PCSK9 list on ${dataset}`);
      const full = (reply.body as { data: { gene: { variants: FullRow[] } } }).data.gene.variants;

      const rows = await svc.listGeneVariants(
        { kind: 'gene', value: 'PCSK9' },
        {},
        svc.resolveDatasetContext(dataset),
        createMockContext(),
      );

      expect(requests[0]?.variables).toMatchObject(flags);
      expect(rows).toHaveLength(count);
      expect(rows.filter((row) => row.faf95_max != null)).toHaveLength(withFaf);
      expect(rows.map((row) => [row.variant_id, row.faf95_max, row.faf95_max_group])).toEqual(
        full.map((row) => [row.variant_id, ...fullSelectionFaf(row)]),
      );
    },
  );
});

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/65
describe("GnomadService.getVariant — HGVS and LOFTEE on the consequence's transcript (#65)", () => {
  afterEach(() => vi.restoreAllMocks());

  const lookup = (
    variantId: string,
    dataset: 'gnomad_r4' | 'gnomad_r2_1',
    variant: Record<string, unknown>,
  ) => {
    const sent = serveData({
      variant: {
        ...minimalVariant(variantId, dataset === 'gnomad_r4' ? 'GRCh38' : 'GRCh37'),
        ...variant,
      },
      clinvar_variant: null,
    });
    const record = svc.getVariant(
      variantId,
      svc.resolveDatasetContext(dataset),
      createMockContext(),
    );
    return { sent, record };
  };

  it('reads 9-21968220-C-A: LC on a minor CDKN2A isoform, nothing on its MANE Select, no curation', async () => {
    const { sent, record } = lookup('9-21968220-C-A', 'gnomad_r4', {
      transcript_consequences: CDKN2A_STOP_GAINED_R4,
      lof_curations: null,
    });

    expect(await record).toMatchObject({
      transcript_id: 'ENST00000579122',
      hgvsc: 'c.406G>T',
      hgvsp: 'p.Glu136Ter',
      lof: 'LC',
      lof_filter: 'END_TRUNC',
      lof_flags: 'PHYLOCSF_WEAK',
      lof_curations: [],
      primary_transcript: {
        transcript_id: 'ENST00000304494',
        lof: null,
        lof_filter: null,
        lof_flags: null,
      },
    });
    expect(sent[0]).toMatch(/\bhgvsc\s+hgvsp\s+lof\s+lof_filter\s+lof_flags\s*\}/);
    expect(sent[0]).toMatch(/\blof_curations \{ gene_id gene_symbol verdict flags project \}/);
  });

  it("reads 1-55516888-G-GA on gnomad_r2_1: LOFTEE's HC beside a Not LoF curation", async () => {
    const { record } = lookup('1-55516888-G-GA', 'gnomad_r2_1', {
      transcript_consequences: PCSK9_FRAMESHIFT_R2_1,
      lof_curations: PCSK9_FRAMESHIFT_R2_1_CURATIONS,
    });

    const result = await record;
    expect(result).toMatchObject({
      transcript_id: 'ENST00000452118',
      hgvsc: 'c.547_548insA',
      hgvsp: 'p.Gly183GlufsTer23',
      lof: 'HC',
      lof_filter: null,
      lof_flags: null,
    });
    expect(result?.lof_curations).toEqual([
      {
        gene_id: 'ENSG00000169174',
        gene_symbol: 'PCSK9',
        verdict: 'Not LoF',
        flags: [
          'Low Relative Mean Pext/Pext Does Not Support Splicing',
          'Minority Of Transcripts',
          'Weak Exon Conservation',
        ],
        project: 'metabolic_conditions_genes',
      },
    ]);
  });

  it("reads 11-2181088-G-T on gnomad_r2_1: the canonical primary transcript's LC and its END_TRUNC filter", async () => {
    const { record } = lookup('11-2181088-G-T', 'gnomad_r2_1', {
      transcript_consequences: INS_STOP_GAINED_R2_1,
    });

    expect((await record)?.primary_transcript).toEqual({
      transcript_id: 'ENST00000397262',
      is_mane_select: null,
      consequence: 'stop_gained',
      hgvsc: 'c.327C>A',
      hgvsp: 'p.Cys109Ter',
      lof: 'LC',
      lof_filter: 'END_TRUNC',
      lof_flags: null,
    });
  });

  it('reads a sparse curation, an entry without the LOFTEE detail keys, and no consequences as null, never invented', async () => {
    const { record } = lookup('1-55516888-G-GA', 'gnomad_r2_1', {
      transcript_consequences: PCSK9_FRAMESHIFT_R2_1.map(
        ({ lof_filter, lof_flags, ...entry }) => entry,
      ),
      lof_curations: [
        {
          gene_id: 'ENSG00000169174',
          gene_symbol: null,
          verdict: 'LoF',
          flags: null,
          project: 'metabolic_conditions_genes',
        },
      ],
    });
    const result = await record;
    expect(result).toMatchObject({ lof: 'HC', lof_filter: null, lof_flags: null });
    expect(result?.primary_transcript).toMatchObject({ lof_filter: null, lof_flags: null });
    expect(result?.lof_curations).toEqual([
      {
        gene_id: 'ENSG00000169174',
        gene_symbol: null,
        verdict: 'LoF',
        flags: [],
        project: 'metabolic_conditions_genes',
      },
    ]);
    vi.restoreAllMocks();

    // minimalVariant carries no lof_curations key and null consequences.
    const empty = await lookup('9-21968220-C-A', 'gnomad_r4', {}).record;
    expect(empty).toMatchObject({
      transcript_id: null,
      hgvsc: null,
      hgvsp: null,
      lof: null,
      lof_filter: null,
      lof_flags: null,
      lof_curations: [],
    });
  });
});

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/65
describe('GnomadService.listGeneVariants — lof, lof_confidence, and the annotations columns (#65)', () => {
  afterEach(() => vi.restoreAllMocks());

  const ANNOTATIONS = ['hgvsc', 'hgvsp', 'lof_filter', 'lof_flags', 'rsids'];
  const gene = (
    symbol: 'PCSK9' | 'INS',
    dataset: 'gnomad_r4' | 'gnomad_r2_1',
    filters: Parameters<typeof svc.listGeneVariants>[1] = {},
  ) =>
    svc.listGeneVariants(
      { kind: 'gene', value: symbol },
      filters,
      svc.resolveDatasetContext(dataset),
      createMockContext(),
    );
  const calls = (rows: { lof: string | null }[]) => {
    const counts: Record<string, number> = {};
    for (const row of rows) counts[String(row.lof)] = (counts[String(row.lof)] ?? 0) + 1;
    return counts;
  };

  it('reads every live PCSK9 gnomad_r4 row’s lof: 181 HC, 23 LC, 4,340 none, and no annotations column', async () => {
    const requests = fakeFafLists();

    const rows = await gene('PCSK9', 'gnomad_r4');

    expect(rows).toHaveLength(4544);
    expect(calls(rows)).toEqual({ HC: 181, LC: 23, null: 4340 });
    expect(requests[0]?.variables).toMatchObject({ annotations: false });
    expect(selectedTranscriptFields(requests[0] as (typeof requests)[number])).toEqual(['lof']);
    const keys = Object.keys(rows[0] ?? {});
    expect(keys.slice(-2)).toEqual(['consequence_transcript', 'lof']);
    expect(rows.some((row) => ANNOTATIONS.some((name) => name in row))).toBe(false);
  });

  it.each([
    ['PCSK9', 'gnomad_r4', 'HC', 181],
    ['PCSK9', 'gnomad_r4', 'LC', 23],
    ['INS', 'gnomad_r2_1', 'HC', 1],
    ['INS', 'gnomad_r2_1', 'LC', 9],
  ] as const)(
    'keeps the %s %s rows whose lof is %s (%i)',
    async (symbol, dataset, lofConfidence, total) => {
      fakeFafLists();

      const rows = await gene(symbol, dataset, { lofConfidence });

      expect(rows).toHaveLength(total);
      expect(rows.every((row) => row.lof === lofConfidence)).toBe(true);
    },
  );

  it('matches neither HC nor LC to the OS row or a null-lof row', async () => {
    fakeFafLists();
    const all = await gene('INS', 'gnomad_r2_1');
    expect(all).toHaveLength(223);
    expect(calls(all)).toEqual({ HC: 1, LC: 9, OS: 1, null: 212 });
    expect(all.find((row) => row.lof === 'OS')?.variant_id).toBe('11-2181230-G-GCAGGTCCTCTGCCTC');

    const called = [
      ...(await gene('INS', 'gnomad_r2_1', { lofConfidence: 'HC' })),
      ...(await gene('INS', 'gnomad_r2_1', { lofConfidence: 'LC' })),
    ];
    expect(called.map((row) => row.variant_id)).not.toContain('11-2181230-G-GCAGGTCCTCTGCCTC');
    expect(called).toHaveLength(10);
  });

  it('applies lof_confidence beside max_faf and consequence_class', async () => {
    fakeFafLists();

    const hc = await gene('PCSK9', 'gnomad_r4', { lofConfidence: 'HC', maxFaf: 0.0001 });
    expect(hc).toHaveLength(175);
    expect(hc.filter((row) => row.faf95_max == null)).toHaveLength(122);
    expect(
      await gene('PCSK9', 'gnomad_r4', { lofConfidence: 'LC', consequenceClass: 'missense' }),
    ).toEqual([]);
  });

  it('appends the five annotations columns after every default one, rsids pipe-joined', async () => {
    const requests = fakeFafLists();

    const rows = await gene('PCSK9', 'gnomad_r4', { annotations: true });

    expect(requests[0]?.variables).toMatchObject({ annotations: true });
    expect(selectedTranscriptFields(requests[0] as (typeof requests)[number])).toEqual([
      'lof',
      ...ANNOTATIONS,
    ]);
    expect(rows).toHaveLength(4544);
    expect(Object.keys(rows[0] ?? {}).slice(-7)).toEqual([
      'consequence_transcript',
      'lof',
      ...ANNOTATIONS,
    ]);
    const lc = rows.find((row) => row.variant_id === '1-55061512-G-T');
    expect(lc).toMatchObject({
      lof: 'LC',
      hgvsc: 'c.1819G>T',
      hgvsp: 'p.Glu607Ter',
      lof_filter: 'END_TRUNC',
      lof_flags: 'PHYLOCSF_WEAK',
    });
    const hc = rows.find((row) => row.variant_id === '1-55039870-G-A');
    expect(hc).toMatchObject({ lof: 'HC', lof_filter: null, rsids: 'rs1164872643' });
    expect(rows.find((row) => row.variant_id === '1-55039866-G-A')?.rsids).toBe('');
    expect(rows.filter((row) => row.rsids !== '')).toHaveLength(2081);
    expect(rows.filter((row) => row.lof_filter === 'END_TRUNC')).toHaveLength(23);
  });

  it('reads the region row 1-55505647-G-T with annotations as gnomAD sends it, and without them as absent', async () => {
    const sent: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const { variables } = JSON.parse(String(init?.body)) as {
        variables: Record<string, unknown>;
      };
      sent.push(variables);
      // gnomAD's two live replies to the same document, by its $annotations.
      const row = variables.annotations ? PCSK9_R2_1_REGION_ANNOTATED_ROW : PCSK9_R2_1_REGION_ROW;
      return Response.json({ data: { region: { variants: [row] } } });
    });
    const region = (annotations: boolean) =>
      svc.listGeneVariants(
        { kind: 'region', value: '1-55505647-55505647' },
        { annotations },
        svc.resolveDatasetContext('gnomad_r2_1'),
        createMockContext(),
      );

    const [annotated] = await region(true);
    const [plain] = await region(false);

    expect(sent.map((variables) => variables.annotations)).toEqual([true, false]);
    expect(annotated).toMatchObject({
      variant_id: '1-55505647-G-T',
      lof: null,
      hgvsc: 'c.137G>T',
      hgvsp: 'p.Arg46Leu',
      lof_filter: null,
      lof_flags: null,
      rsids: 'rs11591147',
    });
    expect(plain).toEqual(
      Object.fromEntries(
        Object.entries(annotated ?? {}).filter(([key]) => !ANNOTATIONS.includes(key)),
      ),
    );
  });

  it('declares $annotations on all four list documents and gates exactly the five fields on it', async () => {
    const requests: { query: string; variables: Record<string, unknown> }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({
        data: {
          region: { variants: [] },
          transcript: { chrom: '1', variants: [] },
          gene: { chrom: '1', variants: [] },
        },
      });
    });
    for (const target of [
      { kind: 'region', value: '1-55505647-55505647' },
      { kind: 'gene', value: 'PCSK9' },
      { kind: 'gene', value: 'ENSG00000169174' },
      { kind: 'transcript', value: 'ENST00000302118' },
    ] as const) {
      await svc.listGeneVariants(
        target,
        {},
        svc.resolveDatasetContext('gnomad_r4'),
        createMockContext(),
      );
    }

    expect(requests).toHaveLength(4);
    for (const request of requests) {
      expect(request.query).toContain('$annotations: Boolean!');
      expect(request.query.match(/@include\(if: \$annotations\)/g)).toHaveLength(5);
      expect(request.variables.annotations).toBe(false);
      expect(selectedTranscriptFields(request)).toEqual(['lof']);
    }
  });
});
