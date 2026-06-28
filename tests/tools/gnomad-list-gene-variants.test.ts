/**
 * @fileoverview Behavior tests for the gnomad_list_gene_variants handler across
 * its two surfaces: canvas-disabled (capped inline preview, spilled=false,
 * empty canvas_id, no-match + cap notices) and canvas-enabled (real spillover →
 * canvas table, spilled=true, canvas_id + table_name populated). Plus the
 * invalid_target and incoherent_build contracts. Stubs the service network
 * method and the canvas accessor; drives the real spillover() helper against a
 * fake CanvasInstance.
 * @module tests/tools/gnomad-list-gene-variants.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { gnomadListGeneVariants } from '@/mcp-server/tools/definitions/gnomad-list-gene-variants.tool.js';
import * as canvasAccessor from '@/services/canvas-accessor.js';
import * as serviceModule from '@/services/gnomad/gnomad-service.js';
import { GnomadService } from '@/services/gnomad/gnomad-service.js';
import type { GeneVariantRow } from '@/services/gnomad/types.js';

const realService = new GnomadService(getServerConfig());

function row(i: number): GeneVariantRow {
  return {
    variant_id: `1-${55000000 + i}-A-T`,
    af: i === 0 ? null : i / 1_000_000,
    ac: i,
    an: 1_000_000,
    consequence: 'missense_variant',
    consequence_class: 'missense',
    homozygote_count: 0,
    source: 'exome|genome',
    flags: '',
  };
}

/** Stub the service so listGeneVariants yields a fixed row set; real build derivation. */
function stubService(rows: GeneVariantRow[]) {
  const fake = {
    resolveDatasetContext: realService.resolveDatasetContext.bind(realService),
    listGeneVariants: vi.fn(async () => rows),
  };
  vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(fake as never);
  return fake;
}

/**
 * A fake CanvasInstance with a working registerTable so the real spillover()
 * helper drains, sentinels, and stages against it. query/describe/drop are
 * unused by this tool.
 */
function fakeCanvas() {
  const registered: Record<string, Record<string, unknown>[]> = {};
  const instance = {
    canvasId: 'cnv1234567',
    tenantId: 'default',
    isNew: true,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    async registerTable(
      name: string,
      rows: AsyncIterable<Record<string, unknown>> | Iterable<Record<string, unknown>>,
    ) {
      const collected: Record<string, unknown>[] = [];
      for await (const r of rows as AsyncIterable<Record<string, unknown>>) collected.push(r);
      registered[name] = collected;
      return {
        tableName: name,
        rowCount: collected.length,
        columns: Object.keys(collected[0] ?? {}),
      };
    },
  };
  const canvas = { acquire: vi.fn(async () => instance) };
  return { canvas, instance, registered };
}

describe('gnomad_list_gene_variants handler — canvas disabled', () => {
  it('returns spilled=false with an empty canvas_id when canvas is off', async () => {
    stubService([row(1), row(2)]);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const ctx = createMockContext({ errors: gnomadListGeneVariants.errors });
    const input = gnomadListGeneVariants.input.parse({ gene: 'PCSK9' });
    const result = await gnomadListGeneVariants.handler(input, ctx as never);

    expect(result.spilled).toBe(false);
    expect(result.canvas_id).toBe('');
    expect(result.table_name).toBe('');
    expect(result.total).toBe(2);
    expect(result.preview).toHaveLength(2);
  });

  it('caps the inline preview at 100 and notices the truncation when canvas is off', async () => {
    const rows = Array.from({ length: 150 }, (_, i) => row(i + 1));
    stubService(rows);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const ctx = createMockContext({ errors: gnomadListGeneVariants.errors });
    const input = gnomadListGeneVariants.input.parse({ gene: 'BRCA2' });
    const result = await gnomadListGeneVariants.handler(input, ctx as never);

    expect(result.total).toBe(150);
    expect(result.preview).toHaveLength(100);
    expect(getEnrichment(ctx).notice).toMatch(/showing 100 of 150/);
  });

  it('emits a no-match notice naming the filters when nothing matched', async () => {
    stubService([]);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const ctx = createMockContext({ errors: gnomadListGeneVariants.errors });
    const input = gnomadListGeneVariants.input.parse({
      gene: 'PCSK9',
      consequence_class: 'lof',
      max_af: 0.001,
    });
    const result = await gnomadListGeneVariants.handler(input, ctx as never);

    expect(result.total).toBe(0);
    const notice = getEnrichment(ctx).notice;
    expect(notice).toContain('No variants in gene "PCSK9"');
    expect(notice).toContain('consequence_class=lof');
    expect(notice).toContain('max_af=0.001');
  });
});

describe('gnomad_list_gene_variants handler — canvas enabled', () => {
  it('fits inline (spilled=false) but reports a canvas_id for a small result', async () => {
    stubService([row(1), row(2)]);
    const { canvas } = fakeCanvas();
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(canvas as never);

    const ctx = createMockContext({ errors: gnomadListGeneVariants.errors });
    const input = gnomadListGeneVariants.input.parse({ gene: 'PCSK9' });
    const result = await gnomadListGeneVariants.handler(input, ctx as never);

    expect(result.spilled).toBe(false);
    expect(result.canvas_id).toBe('cnv1234567');
    // A result that fits the preview budget stages no table.
    expect(result.table_name).toBe('');
    expect(result.total).toBe(2);
  });

  it('spills a large result to the canvas table and returns canvas_id + table_name', async () => {
    // ~1000 rows blow past the 60_000-char preview budget, forcing a real spill.
    const rows = Array.from({ length: 1000 }, (_, i) => row(i + 1));
    stubService(rows);
    const { canvas, registered } = fakeCanvas();
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(canvas as never);

    const ctx = createMockContext({ errors: gnomadListGeneVariants.errors });
    const input = gnomadListGeneVariants.input.parse({ gene: 'BRCA2' });
    const result = await gnomadListGeneVariants.handler(input, ctx as never);

    expect(result.spilled).toBe(true);
    expect(result.canvas_id).toBe('cnv1234567');
    expect(result.table_name).toBe('gene_variants');
    // The full set lands on the canvas table — not just the preview.
    expect(result.total).toBe(1000);
    expect(registered.gene_variants).toHaveLength(1000);
    // The inline preview is a strict, smaller sample of the full set.
    expect(result.preview.length).toBeGreaterThan(0);
    expect(result.preview.length).toBeLessThan(1000);
    expect(result).toEqual(expect.schemaMatching(gnomadListGeneVariants.output));
  });
});

describe('gnomad_list_gene_variants handler — input contracts', () => {
  it('throws ctx.fail("invalid_target") when no target is supplied', async () => {
    stubService([row(1)]);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const ctx = createMockContext({ errors: gnomadListGeneVariants.errors });
    const input = gnomadListGeneVariants.input.parse({});
    await expect(gnomadListGeneVariants.handler(input, ctx as never)).rejects.toMatchObject({
      data: { reason: 'invalid_target' },
    });
  });

  it('throws ctx.fail("invalid_target") when gene and region are both supplied', async () => {
    stubService([row(1)]);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const ctx = createMockContext({ errors: gnomadListGeneVariants.errors });
    const input = gnomadListGeneVariants.input.parse({
      gene: 'PCSK9',
      region: '1-55039447-55064852',
    });
    await expect(gnomadListGeneVariants.handler(input, ctx as never)).rejects.toMatchObject({
      data: { reason: 'invalid_target' },
    });
  });

  it('rejects an incoherent dataset/reference_genome pair before the upstream call', async () => {
    const fake = stubService([row(1)]);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const ctx = createMockContext({ errors: gnomadListGeneVariants.errors });
    const input = gnomadListGeneVariants.input.parse({
      gene: 'PCSK9',
      dataset: 'exac',
      reference_genome: 'GRCh38',
    });
    await expect(gnomadListGeneVariants.handler(input, ctx as never)).rejects.toMatchObject({
      data: { reason: 'incoherent_build' },
    });
    expect(fake.listGeneVariants).not.toHaveBeenCalled();
  });

  it('rejects a malformed region string at parse time', () => {
    expect(() => gnomadListGeneVariants.input.parse({ region: 'chr1:100-200' })).toThrow();
    expect(() => gnomadListGeneVariants.input.parse({ region: '1-100' })).toThrow();
  });

  it('accepts a well-formed region and resolves it to a region target', async () => {
    const fake = stubService([row(1)]);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const ctx = createMockContext({ errors: gnomadListGeneVariants.errors });
    const input = gnomadListGeneVariants.input.parse({ region: '13-32315474-32400266' });
    await gnomadListGeneVariants.handler(input, ctx as never);

    expect(fake.listGeneVariants).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'region', value: '13-32315474-32400266' }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('rejects an inverted region (start>stop) before any upstream call', async () => {
    // REGION_REGEX validates shape only, so an inverted region parses; the
    // service rejects start>stop in its region parse, failing fast as a
    // ValidationError instead of reaching gnomAD (which 500s and burns the retry
    // budget). Drive the real service so the guard actually runs.
    const real = new GnomadService(getServerConfig());
    const graphql = vi.spyOn(real as any, 'graphql');
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(real as never);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const ctx = createMockContext({ errors: gnomadListGeneVariants.errors });
    const input = gnomadListGeneVariants.input.parse({ region: '1-200-100' });
    await expect(gnomadListGeneVariants.handler(input, ctx as never)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_region' },
    });
    expect(graphql).not.toHaveBeenCalled();
  });
});
