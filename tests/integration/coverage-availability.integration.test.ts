/**
 * @fileoverview Coverage uncertainty through the real service and both tool surfaces.
 * @module tests/integration/coverage-availability.integration.test
 */
import { readFileSync } from 'node:fs';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gnomadGetCoverage } from '@/mcp-server/tools/definitions/gnomad-get-coverage.tool.js';
import { initGnomadService } from '@/services/gnomad/gnomad-service.js';

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../fixtures/coverage-tracks/${name}.response.json`, import.meta.url),
      'utf8',
    ),
  );
}
function serve(body: unknown) {
  const errors: unknown[] = [];
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    try {
      expect(new URL(String(input)).origin).toBe('https://gnomad.broadinstitute.org');
      expect(JSON.parse(String(init?.body)).query).toContain('Coverage');
      return new Response(JSON.stringify(body));
    } catch (error) {
      errors.push(error);
      throw error;
    }
  });
  return { fetch, errors };
}

describe('coverage availability', () => {
  beforeEach(() => initGnomadService({} as never, {} as never));
  afterEach(() => vi.restoreAllMocks());

  it('characterizes observed exome metrics without inventing edge measurements', async () => {
    const fake = serve(fixture('gnomad_r4-55043800-55044600'));
    const result = await runToolContract(gnomadGetCoverage, { region: '1-55043800-55044600' });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      summaries: [
        {
          source: 'exome',
          positions: 287,
          mean_depth: 42.902486159082194,
          fraction_over_20: 0.9913937282229972,
        },
        { source: 'genome', positions: 801 },
      ],
    });
    expect(fake.fetch).toHaveBeenCalledTimes(1);
    expect(fake.errors).toEqual([]);
  });

  it.each([
    ['gnomad_r4-55043800-55044600', '1-55043800-55044600', 801, 287, 514],
    ['gnomad_r4-55043850-55044550', '1-55043850-55044550', 701, 237, 464],
  ] as const)(
    'discloses partial target coverage for %s',
    async (name, region, target, positions, missing) => {
      const fake = serve(fixture(name));
      const result = await runToolContract(gnomadGetCoverage, { region });
      expect(result.structuredContent).toMatchObject({
        summaries: [
          { source: 'exome', positions, target_positions: target, missing_positions: missing },
          { source: 'genome', target_positions: target, missing_positions: 0 },
        ],
        notice: expect.stringContaining(`${missing}`),
      });
      expect(JSON.stringify(result.content)).toContain(`${target}`);
      expect(JSON.stringify(result.content)).toContain(`${missing}`);
      expect(JSON.stringify(result.content)).toContain('unknown');
      expect(fake.errors).toEqual([]);
    },
  );

  it('discloses a supported empty exome even with a valid sibling, respecting source selection', async () => {
    serve(fixture('gnomad_r2_1-55503800-55504600'));
    const input = { region: '1-55503800-55504600', dataset: 'gnomad_r2_1' } as const;
    const all = await runToolContract(gnomadGetCoverage, input);
    expect(all.structuredContent).toMatchObject({
      summaries: [{ source: 'genome' }],
      notice: expect.stringContaining('exome'),
    });
    const genome = await runToolContract(gnomadGetCoverage, {
      ...input,
      coverage_source: 'genome',
    });
    expect(genome.structuredContent).not.toHaveProperty('notice');
    const exome = await runToolContract(gnomadGetCoverage, { ...input, coverage_source: 'exome' });
    expect(exome.structuredContent).toMatchObject({
      summaries: [],
      notice: expect.stringContaining('unknown'),
    });
    expect(JSON.stringify(exome.content)).toContain('unknown');
  });

  it.each([
    ['gnomad_r3', 'gnomad_r3-55043800-55044600', '1-55043800-55044600', 'exome'],
    ['exac', 'exac-55503800-55504600', '1-55503800-55504600', 'genome'],
  ] as const)(
    'distinguishes an explicitly requested unsupported %s track',
    async (dataset, name, region, source) => {
      serve(fixture(name));
      const result = await runToolContract(gnomadGetCoverage, {
        region,
        dataset,
        coverage_source: source,
      });
      expect(result.structuredContent).toMatchObject({
        summaries: [],
        notice: expect.stringContaining('not supported'),
      });
      expect(JSON.stringify(result.content)).toContain('not supported');
    },
  );

  it.each([null, [], undefined])(
    'discloses a sparse supported track without inventing a summary: %j',
    async (exome) => {
      const fake = serve({
        data: {
          region: {
            coverage: {
              exome,
              genome: [
                {
                  pos: 100,
                  mean: null,
                  median: null,
                  over_1: null,
                  over_5: null,
                  over_10: null,
                  over_15: null,
                  over_20: null,
                  over_25: null,
                  over_30: null,
                  over_50: null,
                  over_100: null,
                },
              ],
            },
          },
        },
      });
      const result = await runToolContract(gnomadGetCoverage, { region: '1-100-100' });
      expect(result.structuredContent).toMatchObject({
        summaries: [
          {
            source: 'genome',
            positions: 1,
            target_positions: 1,
            missing_positions: 0,
            mean_depth: null,
            fraction_over_20: null,
          },
        ],
        notice: expect.stringContaining('No exome coverage data'),
      });
      expect(JSON.stringify(result.content)).toContain('Not available');
      expect(JSON.stringify(result.content)).toContain('callability is unknown');
      expect(fake.errors).toEqual([]);
    },
  );
});
