/**
 * @fileoverview Behavior tests for the gnomad_get_coverage handler — both-track
 * happy path, the coverage_source filter, the invalid_target contract (zero or
 * two targets), the incoherent_build pair rejection, the empty-coverage
 * notice, and format(). Most cases stub the network method and use the real
 * dataset/build derivation and target resolution; the bucket-resolution cases
 * run the real service against live gnomAD responses faked at the fetch seam.
 * @module tests/tools/gnomad-get-coverage.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig, resetServerConfig } from '@/config/server-config.js';
import { gnomadGetCoverage } from '@/mcp-server/tools/definitions/gnomad-get-coverage.tool.js';
import * as serviceModule from '@/services/gnomad/gnomad-service.js';
import { GnomadService } from '@/services/gnomad/gnomad-service.js';
import type { CoverageSummary } from '@/services/gnomad/types.js';
import { fakeCoverage, LIVE_COVERAGE } from '../helpers/fake-gnomad-coverage.js';

const realService = new GnomadService(getServerConfig());

function textOf(result: { content: unknown[] }): string {
  return (result.content as { type: string; text?: string }[])
    .map((block) => block.text ?? '')
    .join('\n');
}

function summary(source: 'exome' | 'genome'): CoverageSummary {
  return {
    source,
    positions: 100,
    target_positions: 100,
    missing_positions: 0,
    bucket_count: 100,
    bucket_size: 1,
    mean_depth: 45.2,
    median_depth: 44,
    fraction_over_1: 1,
    fraction_over_5: 0.99,
    fraction_over_10: 0.98,
    fraction_over_15: 0.97,
    fraction_over_20: 0.95,
    fraction_over_25: 0.9,
    fraction_over_30: 0.85,
    fraction_over_50: 0.5,
    fraction_over_100: 0.1,
  };
}

/** Wire the service fake with a real dataset/build derivation. */
function stubService(getCoverage: () => Promise<CoverageSummary[]>) {
  const fake = {
    resolveDatasetContext: realService.resolveDatasetContext.bind(realService),
    getCoverage: vi.fn(getCoverage),
  };
  vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(fake as never);
  return fake;
}

describe('gnomad_get_coverage handler', () => {
  it('returns both tracks for a gene target', async () => {
    stubService(async () => [summary('exome'), summary('genome')]);

    const ctx = createMockContext({ errors: gnomadGetCoverage.errors });
    const input = gnomadGetCoverage.input.parse({ gene: 'PCSK9' });
    const result = await gnomadGetCoverage.handler(input, ctx as never);

    expect(result.target).toBe('PCSK9');
    expect(result.target_kind).toBe('gene');
    expect(result.summaries.map((s) => s.source)).toEqual(['exome', 'genome']);
    expect(result.dataset).toBe('gnomad_r4');
    expect(result).toEqual(expect.schemaMatching(gnomadGetCoverage.output));
  });

  it('narrows to a single track when coverage_source is set', async () => {
    stubService(async () => [summary('exome'), summary('genome')]);

    const ctx = createMockContext({ errors: gnomadGetCoverage.errors });
    const input = gnomadGetCoverage.input.parse({ gene: 'PCSK9', coverage_source: 'genome' });
    const result = await gnomadGetCoverage.handler(input, ctx as never);

    expect(result.summaries).toHaveLength(1);
    expect(result.summaries[0]?.source).toBe('genome');
  });

  it('accepts a region target and echoes the resolved region', async () => {
    stubService(async () => [summary('exome')]);

    const ctx = createMockContext({ errors: gnomadGetCoverage.errors });
    const input = gnomadGetCoverage.input.parse({ region: '1-55039447-55064852' });
    const result = await gnomadGetCoverage.handler(input, ctx as never);

    expect(result.target_kind).toBe('region');
    expect(result.target).toBe('1-55039447-55064852');
  });

  it('throws ctx.fail("invalid_target") when no target is supplied', async () => {
    stubService(async () => [summary('exome')]);

    const ctx = createMockContext({ errors: gnomadGetCoverage.errors });
    const input = gnomadGetCoverage.input.parse({});
    await expect(gnomadGetCoverage.handler(input, ctx as never)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_target' },
    });
  });

  it('throws ctx.fail("invalid_target") when two targets are supplied', async () => {
    stubService(async () => [summary('exome')]);

    const ctx = createMockContext({ errors: gnomadGetCoverage.errors });
    const input = gnomadGetCoverage.input.parse({
      gene: 'PCSK9',
      transcript_id: 'ENST00000302118',
    });
    await expect(gnomadGetCoverage.handler(input, ctx as never)).rejects.toMatchObject({
      data: { reason: 'invalid_target' },
    });
  });

  it('treats an empty-string region as no target (form-client payload)', async () => {
    stubService(async () => [summary('exome')]);

    const ctx = createMockContext({ errors: gnomadGetCoverage.errors });
    // Form clients send region: '' rather than omitting it — it must not count as a target.
    const input = gnomadGetCoverage.input.parse({ region: '' });
    await expect(gnomadGetCoverage.handler(input, ctx as never)).rejects.toMatchObject({
      data: { reason: 'invalid_target' },
    });
  });

  it('rejects an incoherent dataset/reference_genome pair', async () => {
    const fake = stubService(async () => [summary('exome')]);

    const ctx = createMockContext({ errors: gnomadGetCoverage.errors });
    const input = gnomadGetCoverage.input.parse({
      gene: 'PCSK9',
      dataset: 'gnomad_r2_1',
      reference_genome: 'GRCh38',
    });
    await expect(gnomadGetCoverage.handler(input, ctx as never)).rejects.toMatchObject({
      data: { reason: 'incoherent_build' },
    });
    expect(fake.getCoverage).not.toHaveBeenCalled();
  });

  it('emits a notice and an empty summary list when no coverage data exists', async () => {
    stubService(async () => []);

    const ctx = createMockContext({ errors: gnomadGetCoverage.errors });
    const input = gnomadGetCoverage.input.parse({ gene: 'PCSK9' });
    const result = await gnomadGetCoverage.handler(input, ctx as never);

    expect(result.summaries).toEqual([]);
    const notice = getEnrichment(ctx).notice;
    expect(notice).toMatch(/No .*coverage data/);
    expect(notice).toContain('PCSK9');
  });

  it('renders "No coverage data available" in format() for an empty result', () => {
    const text = (
      gnomadGetCoverage.format?.({
        target: 'PCSK9',
        target_kind: 'gene',
        summaries: [],
        dataset: 'gnomad_r4',
        reference_genome: 'GRCh38',
      }) ?? []
    )
      .map((b) => ('text' in b ? b.text : ''))
      .join('');
    expect(text).toContain('No coverage data available');
  });

  it('renders positions, bucket resolution, depth, and per-threshold fractions in format()', () => {
    const text = (
      gnomadGetCoverage.format?.({
        target: 'PCSK9',
        target_kind: 'gene',
        summaries: [summary('exome'), { ...summary('genome'), bucket_count: 7, bucket_size: 15 }],
        dataset: 'gnomad_r4',
        reference_genome: 'GRCh38',
      }) ?? []
    )
      .map((b) => ('text' in b ? b.text : ''))
      .join('');
    expect(text).toBe(
      [
        '**Coverage — gene:** PCSK9',
        '**Dataset:** gnomad_r4 (GRCh38)',
        '',
        '### exome (100 positions)',
        '**Target bases:** 100 | **Missing bases:** 0 (callability unknown)',
        '**Buckets:** 100 × 1 bp',
        '**Mean depth:** 45.2 | **Median depth:** 44.0',
        '**Frac ≥:** 1×=100.0% 5×=99.0% 10×=98.0% 15×=97.0% 20×=95.0% 25×=90.0% 30×=85.0% 50×=50.0% 100×=10.0%',
        '',
        '### genome (100 positions)',
        '**Target bases:** 100 | **Missing bases:** 0 (callability unknown)',
        '**Buckets:** 7 × 15 bp — depths and fractions average the buckets, not single bases',
        '**Mean depth:** 45.2 | **Median depth:** 44.0',
        '**Frac ≥:** 1×=100.0% 5×=99.0% 10×=98.0% 15×=97.0% 20×=95.0% 25×=90.0% 30×=85.0% 50×=50.0% 100×=10.0%',
      ].join('\n'),
    );
  });
});

describe('gnomad_get_coverage over live gnomAD coverage buckets (#45)', () => {
  afterEach(() => vi.restoreAllMocks());

  /** Run the real service, with gnomAD answered from a live response at the fetch seam. */
  function useRealService(envelopeKey: string) {
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(realService);
    return fakeCoverage(LIVE_COVERAGE[envelopeKey]);
  }

  it('reports PCSK9 over its exons ±75 bp at 15 bp resolution on both surfaces', async () => {
    useRealService('gene:PCSK9');

    const result = await runToolContract(gnomadGetCoverage, {
      gene: 'PCSK9',
      coverage_source: 'genome',
    });

    expect(result.isError).toBeFalsy();
    const output = gnomadGetCoverage.output.parse(result.structuredContent);
    expect(output.summaries).toEqual([
      expect.objectContaining({
        source: 'genome',
        positions: 7811,
        bucket_count: 535,
        bucket_size: 15,
        median_depth: 33,
        mean_depth: expect.closeTo(32.49755523382596, 9),
        fraction_over_20: expect.closeTo(0.9690093457943999, 9),
      }),
    ]);
    expect(textOf(result)).toBe(
      [
        '**Coverage — gene:** PCSK9',
        '**Dataset:** gnomad_r4 (GRCh38)',
        '',
        '### genome (7811 positions)',
        '**Target bases:** 7811 | **Missing bases:** 0 (callability unknown)',
        '**Buckets:** 535 × 15 bp — depths and fractions average the buckets, not single bases',
        '**Mean depth:** 32.5 | **Median depth:** 33.0',
        '**Frac ≥:** 1×=99.5% 5×=99.5% 10×=99.5% 15×=99.5% 20×=96.9% 25×=87.6% 30×=70.6% 50×=3.1% 100×=1.0%',
      ].join('\n'),
    );
  });

  it('keeps a single-position region at one 1 bp bucket per track', async () => {
    useRealService('region:1-55039974-55039974');

    const result = await runToolContract(gnomadGetCoverage, { region: '1-55039974-55039974' });

    expect(result.isError).toBeFalsy();
    expect(gnomadGetCoverage.output.parse(result.structuredContent)).toEqual({
      target: '1-55039974-55039974',
      target_kind: 'region',
      summaries: [
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
      ],
      dataset: 'gnomad_r4',
      reference_genome: 'GRCh38',
    });
    expect(textOf(result)).toBe(
      [
        '**Coverage — region:** 1-55039974-55039974',
        '**Dataset:** gnomad_r4 (GRCh38)',
        '',
        '### exome (1 positions)',
        '**Target bases:** 1 | **Missing bases:** 0 (callability unknown)',
        '**Buckets:** 1 × 1 bp',
        '**Mean depth:** 56.1 | **Median depth:** 31.0',
        '**Frac ≥:** 1×=100.0% 5×=100.0% 10×=98.0% 15×=97.0% 20×=96.0% 25×=91.0% 30×=62.0% 50×=32.0% 100×=19.0%',
        '',
        '### genome (1 positions)',
        '**Target bases:** 1 | **Missing bases:** 0 (callability unknown)',
        '**Buckets:** 1 × 1 bp',
        '**Mean depth:** 35.6 | **Median depth:** 34.0',
        '**Frac ≥:** 1×=100.0% 5×=100.0% 10×=100.0% 15×=100.0% 20×=100.0% 25×=94.0% 30×=80.0% 50×=9.0% 100×=1.0%',
      ].join('\n'),
    );
  });

  it('notices an empty result when every bucket falls outside the exons', async () => {
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(realService);
    fakeCoverage({
      data: {
        transcript: {
          chrom: '1',
          exons: [{ start: 1076, stop: 1080 }],
          coverage: {
            exome: [],
            genome: [
              {
                pos: 9000,
                mean: 0,
                median: 0,
                over_1: 0,
                over_5: 0,
                over_10: 0,
                over_15: 0,
                over_20: 0,
                over_25: 0,
                over_30: 0,
                over_50: 0,
                over_100: 0,
              },
            ],
          },
        },
      },
    });

    const result = await runToolContract(gnomadGetCoverage, { transcript_id: 'ENST00000302118' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      summaries: [],
      notice: expect.stringMatching(
        /^No exome coverage data for transcript "ENST00000302118" in gnomad_r4\./,
      ),
    });
    expect(textOf(result)).toContain('_No coverage data available._');
  });
});

describe('gnomad_get_coverage blank transcript_id (#31)', () => {
  it.each([
    [{ gene: 'PCSK9' }, { kind: 'gene', value: 'PCSK9' }],
    [{ region: '1-55039447-55064852' }, { kind: 'region', value: '1-55039447-55064852' }],
  ])('treats a whitespace-only transcript_id beside %j as omitted', async (other, target) => {
    const fake = stubService(async () => [summary('exome')]);

    const result = await runToolContract(gnomadGetCoverage, { ...other, transcript_id: '   ' });

    expect(result.isError).toBeFalsy();
    expect(fake.getCoverage).toHaveBeenCalledWith(target, expect.anything(), expect.anything());
    expect(result.structuredContent).toMatchObject({ target: target.value });
  });

  it('rejects a whitespace-only transcript_id alone as no target', async () => {
    const fake = stubService(async () => [summary('exome')]);

    const result = await runToolContract(gnomadGetCoverage, { transcript_id: ' \t ' });

    expect(result.isError).toBe(true);
    expect(
      (result.structuredContent as { error: { data: { reason: string } } }).error.data.reason,
    ).toBe('invalid_target');
    expect(fake.getCoverage).not.toHaveBeenCalled();
  });

  it('trims a padded transcript_id before the upstream call', async () => {
    const fake = stubService(async () => [summary('genome')]);

    await runToolContract(gnomadGetCoverage, { transcript_id: ' ENST00000302118 ' });

    expect(fake.getCoverage).toHaveBeenCalledWith(
      { kind: 'transcript', value: 'ENST00000302118' },
      expect.anything(),
      expect.anything(),
    );
  });
});

describe('gnomad_get_coverage blank gene (#31)', () => {
  it.each(['', '   ', '\t'])('treats gene %j beside a region as omitted', async (gene) => {
    const fake = stubService(async () => [summary('exome')]);

    const result = await runToolContract(gnomadGetCoverage, {
      gene,
      region: '1-55039974-55039980',
    });

    expect(result.isError).toBeFalsy();
    expect(fake.getCoverage).toHaveBeenCalledWith(
      { kind: 'region', value: '1-55039974-55039980' },
      expect.anything(),
      expect.anything(),
    );
    expect(result.structuredContent).toMatchObject({ target_kind: 'region' });
  });

  it.each(['', '   '])('rejects gene %j alone as no target', async (gene) => {
    const fake = stubService(async () => [summary('exome')]);

    const result = await runToolContract(gnomadGetCoverage, { gene });

    expect(result.isError).toBe(true);
    expect(
      (result.structuredContent as { error: { data: { reason: string } } }).error.data.reason,
    ).toBe('invalid_target');
    expect(fake.getCoverage).not.toHaveBeenCalled();
  });

  it('still rejects a non-blank one-character gene at parse time', async () => {
    const fake = stubService(async () => [summary('exome')]);

    const result = await runToolContract(gnomadGetCoverage, {
      gene: 'A',
      region: '1-55039974-55039980',
    });

    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error: { code: number } }).error.code).toBe(
      JsonRpcErrorCode.InvalidParams,
    );
    expect(fake.getCoverage).not.toHaveBeenCalled();
  });

  it('trims a padded gene before the upstream call', async () => {
    const fake = stubService(async () => [summary('exome')]);

    await runToolContract(gnomadGetCoverage, { gene: ' PCSK9 ' });

    expect(fake.getCoverage).toHaveBeenCalledWith(
      { kind: 'gene', value: 'PCSK9' },
      expect.anything(),
      expect.anything(),
    );
  });
});

/** The recovery hint gnomad_get_coverage declares for a reason. */
const declaredRecovery = (reason: string) =>
  gnomadGetCoverage.errors?.find((entry) => entry.reason === reason)?.recovery;

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/62
describe('gnomad_get_coverage identifier normalization (#62)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetServerConfig();
    vi.restoreAllMocks();
  });

  /** A transcript or gene answer with coverage, for whatever ID gnomAD was sent. */
  const FEATURE = {
    chrom: '1',
    exons: [{ start: 100, stop: 110 }],
    coverage: { exome: [], genome: [] },
  };

  it.each([
    ['enst00000302118', 'ENST00000302118'],
    ['ENST00000302118.5', 'ENST00000302118'],
  ])(
    'sends transcript %s as %s and echoes it as the target on both surfaces',
    async (id, canonical) => {
      vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(realService);
      const requests = fakeCoverage({ data: { transcript: FEATURE } });

      const result = await runToolContract(gnomadGetCoverage, { transcript_id: id });

      expect(result.isError).toBeFalsy();
      expect(requests[0]?.variables).toMatchObject({ transcriptId: canonical });
      expect(result.structuredContent).toMatchObject({
        target: canonical,
        target_kind: 'transcript',
      });
      expect(textOf(result)).toContain(`**Coverage — transcript:** ${canonical}`);
      expect(textOf(result)).not.toContain(id);
    },
  );

  it('sends a versioned Ensembl gene ID by stable ID, unversioned', async () => {
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(realService);
    const requests = fakeCoverage({ data: { gene: FEATURE } });

    const result = await runToolContract(gnomadGetCoverage, { gene: 'ENSG00000169174.12' });

    expect(result.structuredContent).toMatchObject({ target: 'ENSG00000169174' });
    expect(requests[0]?.variables).toMatchObject({ gene: 'ENSG00000169174' });
    expect(requests[0]?.query).toContain('gene_id: $gene');
  });

  it('resolves a chr-prefixed colon region with thousands separators to chrom-start-stop', async () => {
    const fake = stubService(async () => [summary('exome')]);

    const result = await runToolContract(gnomadGetCoverage, {
      region: 'chr1:55,039,447-55,064,852',
    });

    expect(result.isError).toBeFalsy();
    expect(fake.getCoverage).toHaveBeenCalledWith(
      { kind: 'region', value: '1-55039447-55064852' },
      expect.anything(),
      expect.anything(),
    );
    expect(result.structuredContent).toMatchObject({ target: '1-55039447-55064852' });
  });

  it('still resolves the gene beside a blank region', async () => {
    const fake = stubService(async () => [summary('exome')]);

    const result = await runToolContract(gnomadGetCoverage, { gene: 'PCSK9', region: '' });

    expect(result.isError).toBeFalsy();
    expect(fake.getCoverage).toHaveBeenCalledWith(
      { kind: 'gene', value: 'PCSK9' },
      expect.anything(),
      expect.anything(),
    );
  });

  it('rejects a colon region at the schema with GNOMAD_NORMALIZE_IDS=false', async () => {
    vi.stubEnv('GNOMAD_NORMALIZE_IDS', 'false');
    resetServerConfig();
    const fake = stubService(async () => [summary('exome')]);

    const result = await runToolContract(gnomadGetCoverage, { region: 'chr1:55039447-55064852' });

    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error: { code: number } }).error.code).toBe(
      JsonRpcErrorCode.InvalidParams,
    );
    expect(fake.getCoverage).not.toHaveBeenCalled();
  });
});

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/56
describe('gnomad_get_coverage unknown gene or transcript (#56)', () => {
  afterEach(() => vi.restoreAllMocks());

  const useRealService = (envelope: unknown) => {
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(realService);
    return fakeCoverage(envelope);
  };

  it.each([
    [
      { gene: 'NOTAGENE123' },
      'gene_not_found',
      { errors: [{ message: 'Gene not found' }], data: { gene: null } },
      'Gene "NOTAGENE123" not found in GRCh38.',
    ],
    [
      { transcript_id: 'NM_174936.4' },
      'transcript_not_found',
      { errors: [{ message: 'Transcript not found' }], data: { transcript: null } },
      'Transcript "NM_174936.4" not found in GRCh38.',
    ],
    [
      { transcript_id: 'ENST99999999999' },
      'transcript_not_found',
      { errors: [{ message: 'Transcript not found' }], data: { transcript: null } },
      'Transcript "ENST99999999999" not found in GRCh38.',
    ],
    [
      { gene: 'NOTAGENE123', dataset: 'gnomad_r2_1' },
      'gene_not_found',
      { errors: [{ message: 'Gene not found' }], data: { gene: null } },
      'Gene "NOTAGENE123" not found in GRCh37.',
    ],
  ] as const)(
    'fails %j as %s with the declared recovery on both surfaces',
    async (input, reason, envelope, message) => {
      const requests = useRealService(envelope);

      const result = await runToolContract(gnomadGetCoverage, input);

      expect(result.isError).toBe(true);
      const recovery = declaredRecovery(reason);
      expect(recovery).toBeDefined();
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.NotFound,
          message,
          data: { reason, recovery: { hint: recovery } },
        },
      });
      expect(textOf(result)).toContain(message);
      expect(textOf(result)).toContain(recovery ?? '');
      expect(requests).toHaveLength(1);
    },
  );

  it('keeps the callability notice for a known transcript with empty coverage tracks', async () => {
    useRealService({
      data: {
        transcript: {
          chrom: '1',
          exons: [{ start: 1076, stop: 1080 }],
          coverage: { exome: [], genome: [] },
        },
      },
    });

    const result = await runToolContract(gnomadGetCoverage, { transcript_id: 'ENST00000302118' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      summaries: [],
      notice: expect.stringContaining('callability is unknown, not measured zero depth'),
    });
  });

  it('never raises a not-found reason for a region target', async () => {
    useRealService({ data: { region: null } });

    const result = await runToolContract(gnomadGetCoverage, { region: '1-55039447-55064852' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ summaries: [], target_kind: 'region' });
  });
});
