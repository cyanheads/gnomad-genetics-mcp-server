/**
 * @fileoverview Behavior tests for the gnomad_get_variant handler — batch
 * partial success: a resolved variant, an absent variant, a malformed ID, and a
 * service throw all coexist in one call. Stubs the service accessor so no
 * network is touched.
 * @module tests/tools/gnomad-get-variant.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { gnomadGetVariant } from '@/mcp-server/tools/definitions/gnomad-get-variant.tool.js';
import * as serviceModule from '@/services/gnomad/gnomad-service.js';
import { GnomadService } from '@/services/gnomad/gnomad-service.js';
import type { VariantRecord } from '@/services/gnomad/types.js';

/** Real service for genuine dataset/build derivation; network method overridden per-test. */
const realService = new GnomadService(getServerConfig());

function record(variantId: string): VariantRecord {
  return {
    variant_id: variantId,
    rsids: ['rs1'],
    reference_genome: 'GRCh38',
    dataset: 'gnomad_r4',
    ac: 10,
    an: 1000,
    af: 0.01,
    homozygote_count: 0,
    hemizygote_count: null,
    populations: [
      {
        id: 'nfe',
        source: 'exome',
        ac: 5,
        an: 500,
        af: 0.01,
        homozygote_count: 0,
        hemizygote_count: null,
      },
    ],
    source: ['exome'],
    flags: [],
    consequence: 'missense_variant',
    transcript_id: 'ENST1',
    gene_symbol: 'GENE1',
    in_silico: [{ id: 'revel_max', value: 0.5 }],
    clinvar: null,
  };
}

describe('gnomad_get_variant handler', () => {
  it('partitions a batch into found and failed with partial success', async () => {
    const fake = {
      resolveDatasetContext: () => ({ dataset: 'gnomad_r4', reference_genome: 'GRCh38' }) as const,
      getVariant: vi.fn(async (id: string) => {
        if (id === '1-100-A-T') return record(id);
        if (id === '1-200-A-T') return null; // absent in dataset
        throw new Error('upstream boom');
      }),
    };
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(fake as never);

    const ctx = createMockContext();
    const input = gnomadGetVariant.input.parse({
      variants: ['1-100-A-T', '1-200-A-T', '1-300-A-T', 'not-a-variant'],
    });
    const result = await gnomadGetVariant.handler(input, ctx as never);

    expect(result.dataset).toBe('gnomad_r4');
    expect(result.reference_genome).toBe('GRCh38');
    expect(result.found.map((v) => v.variant_id)).toEqual(['1-100-A-T']);
    // absent, service-throw, and malformed all land in failed[]
    expect(result.failed.map((f) => f.variant).sort()).toEqual(
      ['1-200-A-T', '1-300-A-T', 'not-a-variant'].sort(),
    );
    const malformed = result.failed.find((f) => f.variant === 'not-a-variant');
    expect(malformed?.error).toMatch(/Malformed ID/);
    // getVariant is never called for the malformed ID (rejected before the service)
    expect(fake.getVariant).toHaveBeenCalledTimes(3);
  });

  it('dispatches the batch concurrently instead of serially', async () => {
    let active = 0;
    let peak = 0;
    const fake = {
      resolveDatasetContext: () => ({ dataset: 'gnomad_r4', reference_genome: 'GRCh38' }) as const,
      getVariant: vi.fn(async (id: string) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active -= 1;
        return record(id);
      }),
    };
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(fake as never);

    const ctx = createMockContext();
    const ids = Array.from({ length: 5 }, (_, i) => `1-${100 + i}-A-T`);
    const result = await gnomadGetVariant.handler(
      gnomadGetVariant.input.parse({ variants: ids }),
      ctx as never,
    );

    // The fake carries no semaphore, so true concurrent dispatch peaks at the
    // full batch size; the old serial for-loop would have peaked at 1. This
    // guards the dispatch change itself — the live semaphore cap is exercised in
    // field-testing, which a mocked service cannot prove.
    expect(peak).toBe(5);
    expect(result.found.map((v) => v.variant_id)).toEqual(ids);
  });

  it('keeps found[]/failed[] in input order regardless of upstream resolution order', async () => {
    // Per-item delays deliberately invert the input order: the first input
    // resolves last, so resolution order is not input order.
    const delays: Record<string, number> = {
      '1-300-A-T': 30,
      rs100: 20,
      '1-200-A-T': 10,
      '1-100-A-T': 5,
    };
    const fake = {
      resolveDatasetContext: () => ({ dataset: 'gnomad_r4', reference_genome: 'GRCh38' }) as const,
      getVariant: vi.fn(async (id: string) => {
        await new Promise((r) => setTimeout(r, delays[id] ?? 0));
        if (id === '1-200-A-T') return null; // absent in dataset → failed[]
        return record(id);
      }),
    };
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(fake as never);

    const ctx = createMockContext();
    const input = gnomadGetVariant.input.parse({
      variants: ['1-300-A-T', 'not-a-variant', 'rs100', '1-100-A-T', '1-200-A-T'],
    });
    const result = await gnomadGetVariant.handler(input, ctx as never);

    // found[] and failed[] each follow input order, not the scrambled resolution
    // order (which would be not-a-variant, 1-100, 1-200, rs100, 1-300).
    expect(result.found.map((v) => v.variant_id)).toEqual(['1-300-A-T', 'rs100', '1-100-A-T']);
    expect(result.failed.map((f) => f.variant)).toEqual(['not-a-variant', '1-200-A-T']);
  });

  it('renders found and failed records in format() for content[] parity', async () => {
    const fake = {
      resolveDatasetContext: () => ({ dataset: 'gnomad_r4', reference_genome: 'GRCh38' }) as const,
      getVariant: vi.fn(async () => record('1-100-A-T')),
    };
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(fake as never);

    const ctx = createMockContext();
    const input = gnomadGetVariant.input.parse({ variants: ['1-100-A-T'] });
    const result = await gnomadGetVariant.handler(input, ctx as never);
    const text = (gnomadGetVariant.format?.(result) ?? [])
      .map((b) => ('text' in b ? b.text : ''))
      .join('');
    expect(text).toContain('1-100-A-T');
    expect(text).toContain('GENE1');
    expect(text).toContain('nfe');
  });

  it('rejects an incoherent dataset/reference_genome pair before any lookup', async () => {
    const getVariant = vi.fn(async () => record('1-100-A-T'));
    const fake = {
      resolveDatasetContext: realService.resolveDatasetContext.bind(realService),
      getVariant,
    };
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(fake as never);

    const ctx = createMockContext({ errors: gnomadGetVariant.errors });
    const input = gnomadGetVariant.input.parse({
      variants: ['1-100-A-T'],
      dataset: 'gnomad_r4',
      reference_genome: 'GRCh37',
    });
    await expect(gnomadGetVariant.handler(input, ctx as never)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'incoherent_build' },
    });
    expect(getVariant).not.toHaveBeenCalled();
  });

  it('preserves a sparse record (null af, no clinvar, no in-silico) without inventing data', async () => {
    const sparse: VariantRecord = {
      variant_id: '7-100-A-T',
      rsids: [],
      reference_genome: 'GRCh38',
      dataset: 'gnomad_r4',
      ac: 0,
      an: 0,
      af: null,
      homozygote_count: 0,
      hemizygote_count: null,
      populations: [],
      source: [],
      flags: [],
      consequence: null,
      transcript_id: null,
      gene_symbol: null,
      in_silico: [],
      clinvar: null,
    };
    const fake = {
      resolveDatasetContext: realService.resolveDatasetContext.bind(realService),
      getVariant: vi.fn(async () => sparse),
    };
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(fake as never);

    const ctx = createMockContext({ errors: gnomadGetVariant.errors });
    const input = gnomadGetVariant.input.parse({ variants: ['7-100-A-T'] });
    const result = await gnomadGetVariant.handler(input, ctx as never);

    expect(result.found).toHaveLength(1);
    expect(result.found[0]?.af).toBeNull();
    expect(result).toEqual(expect.schemaMatching(gnomadGetVariant.output));

    const text = (gnomadGetVariant.format?.(result) ?? [])
      .map((b) => ('text' in b ? b.text : ''))
      .join('');
    // Missing af and clinvar render as explicit unknowns, not fabricated values.
    expect(text).toContain('AF Not available');
    expect(text).toContain('ClinVar:** no entry');
  });

  it('accepts a full batch of 25 IDs but rejects 26 at parse time', () => {
    const ids25 = Array.from({ length: 25 }, (_, i) => `1-${100 + i}-A-T`);
    expect(() => gnomadGetVariant.input.parse({ variants: ids25 })).not.toThrow();

    const ids26 = Array.from({ length: 26 }, (_, i) => `1-${100 + i}-A-T`);
    expect(() => gnomadGetVariant.input.parse({ variants: ids26 })).toThrow();
  });

  it('rejects an empty variants array at parse time', () => {
    expect(() => gnomadGetVariant.input.parse({ variants: [] })).toThrow();
  });

  it('accepts an rsID in the batch and routes it to the service', async () => {
    const getVariant = vi.fn(async (id: string) => record(id));
    const fake = {
      resolveDatasetContext: realService.resolveDatasetContext.bind(realService),
      getVariant,
    };
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(fake as never);

    const ctx = createMockContext({ errors: gnomadGetVariant.errors });
    const input = gnomadGetVariant.input.parse({ variants: ['rs11591147'] });
    const result = await gnomadGetVariant.handler(input, ctx as never);

    expect(result.found).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
    expect(getVariant).toHaveBeenCalledWith('rs11591147', expect.anything(), expect.anything());
  });
});
