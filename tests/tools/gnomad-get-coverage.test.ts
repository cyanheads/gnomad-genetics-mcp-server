/**
 * @fileoverview Behavior tests for the gnomad_get_coverage handler — both-track
 * happy path, the coverage_source filter, the invalid_target contract (zero or
 * two targets), the incoherent_build pair rejection, and the empty-coverage
 * notice. Stubs the network method; uses the real dataset/build derivation and
 * target resolution.
 * @module tests/tools/gnomad-get-coverage.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { gnomadGetCoverage } from '@/mcp-server/tools/definitions/gnomad-get-coverage.tool.js';
import * as serviceModule from '@/services/gnomad/gnomad-service.js';
import { GnomadService } from '@/services/gnomad/gnomad-service.js';
import type { CoverageSummary } from '@/services/gnomad/types.js';

const realService = new GnomadService(getServerConfig());

function summary(source: 'exome' | 'genome'): CoverageSummary {
  return {
    source,
    positions: 100,
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

  it('renders depth and per-threshold fractions in format()', () => {
    const text = (
      gnomadGetCoverage.format?.({
        target: 'PCSK9',
        target_kind: 'gene',
        summaries: [summary('exome')],
        dataset: 'gnomad_r4',
        reference_genome: 'GRCh38',
      }) ?? []
    )
      .map((b) => ('text' in b ? b.text : ''))
      .join('');
    expect(text).toContain('exome');
    expect(text).toContain('45.2');
    expect(text).toContain('20×=95.0%');
  });
});
