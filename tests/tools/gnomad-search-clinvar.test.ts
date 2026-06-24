/**
 * @fileoverview Behavior tests for the gnomad_search_clinvar handler — the
 * second upstream service (NCBI E-utilities). Covers canvas-disabled (capped
 * preview, spilled=false, empty canvas_id, no-match + cap notices), canvas-
 * enabled spill (real spillover → canvas table), the ncbi_unreachable contract
 * surfaced when the service throws ServiceUnavailable, and format() rendering.
 * Stubs the ClinVar service and the canvas accessor.
 * @module tests/tools/gnomad-search-clinvar.test
 */

import { JsonRpcErrorCode, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { gnomadSearchClinvar } from '@/mcp-server/tools/definitions/gnomad-search-clinvar.tool.js';
import * as canvasAccessor from '@/services/canvas-accessor.js';
import * as clinvarModule from '@/services/clinvar/clinvar-service.js';
import type { ClinVarRow } from '@/services/clinvar/types.js';

function row(i: number): ClinVarRow {
  return {
    clinvar_variation_id: String(100000 + i),
    accession: `VCV00${100000 + i}`,
    title: `NM_000527.5(LDLR):c.${i}G>A (p.Gly${i}Ser)`,
    obj_type: 'single nucleotide variant',
    clinical_significance: 'Pathogenic',
    review_status: 'criteria provided, single submitter',
    gold_stars: 1,
    last_evaluated: '2023-01-01',
    molecular_consequences: 'missense_variant',
    protein_change: `G${i}S`,
    conditions: 'Familial hypercholesterolemia',
    submission_count: 2,
  };
}

/** Stub the ClinVar service so searchGene yields a fixed row set. */
function stubClinvar(impl: () => Promise<ClinVarRow[]>) {
  const fake = { searchGene: vi.fn(impl) };
  vi.spyOn(clinvarModule, 'getClinVarService').mockReturnValue(fake as never);
  return fake;
}

/** Fake CanvasInstance with a working registerTable for the real spillover() helper. */
function fakeCanvas() {
  const registered: Record<string, Record<string, unknown>[]> = {};
  const instance = {
    canvasId: 'cnvclinvar',
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
  return { canvas: { acquire: vi.fn(async () => instance) }, instance, registered };
}

describe('gnomad_search_clinvar handler — canvas disabled', () => {
  it('returns spilled=false with an empty canvas_id', async () => {
    stubClinvar(async () => [row(1), row(2)]);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const ctx = createMockContext({ errors: gnomadSearchClinvar.errors });
    const input = gnomadSearchClinvar.input.parse({ gene: 'LDLR' });
    const result = await gnomadSearchClinvar.handler(input, ctx as never);

    expect(result.spilled).toBe(false);
    expect(result.canvas_id).toBe('');
    expect(result.total).toBe(2);
    expect(result.preview).toHaveLength(2);
  });

  it('caps the preview at 100 and notices the truncation', async () => {
    const rows = Array.from({ length: 130 }, (_, i) => row(i + 1));
    stubClinvar(async () => rows);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const ctx = createMockContext({ errors: gnomadSearchClinvar.errors });
    const input = gnomadSearchClinvar.input.parse({ gene: 'BRCA1' });
    const result = await gnomadSearchClinvar.handler(input, ctx as never);

    expect(result.total).toBe(130);
    expect(result.preview).toHaveLength(100);
    expect(getEnrichment(ctx).notice).toMatch(/showing 100 of 130/);
  });

  it('emits a no-match notice naming the filters', async () => {
    stubClinvar(async () => []);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const ctx = createMockContext({ errors: gnomadSearchClinvar.errors });
    const input = gnomadSearchClinvar.input.parse({
      gene: 'LDLR',
      clinical_significance: 'pathogenic',
      min_review_stars: 2,
    });
    const result = await gnomadSearchClinvar.handler(input, ctx as never);

    expect(result.total).toBe(0);
    const notice = getEnrichment(ctx).notice;
    expect(notice).toContain('No ClinVar records for "LDLR"');
    expect(notice).toContain('clinical_significance=pathogenic');
    expect(notice).toContain('min_review_stars=2');
  });
});

describe('gnomad_search_clinvar handler — canvas enabled', () => {
  it('spills a large result to the clinvar_variants table', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => row(i + 1));
    stubClinvar(async () => rows);
    const { canvas, registered } = fakeCanvas();
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(canvas as never);

    const ctx = createMockContext({ errors: gnomadSearchClinvar.errors });
    const input = gnomadSearchClinvar.input.parse({ gene: 'BRCA2' });
    const result = await gnomadSearchClinvar.handler(input, ctx as never);

    expect(result.spilled).toBe(true);
    expect(result.canvas_id).toBe('cnvclinvar');
    expect(result.table_name).toBe('clinvar_variants');
    expect(result.total).toBe(1000);
    expect(registered.clinvar_variants).toHaveLength(1000);
    expect(result).toEqual(expect.schemaMatching(gnomadSearchClinvar.output));
  });
});

describe('gnomad_search_clinvar handler — upstream failure', () => {
  it('surfaces the ncbi_unreachable reason when the service is unavailable', async () => {
    stubClinvar(async () => {
      throw serviceUnavailable('NCBI returned HTML instead of JSON — likely rate-limited.');
    });
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const ctx = createMockContext({ errors: gnomadSearchClinvar.errors });
    const input = gnomadSearchClinvar.input.parse({ gene: 'LDLR' });
    // The handler does not catch — the service's ServiceUnavailable bubbles, and
    // the framework classifies it against the ncbi_unreachable contract code.
    await expect(gnomadSearchClinvar.handler(input, ctx as never)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  });
});

describe('gnomad_search_clinvar format()', () => {
  it('renders the star rating, significance, and conditions', () => {
    const text = (
      gnomadSearchClinvar.format?.({
        preview: [row(42)],
        canvas_id: '',
        table_name: '',
        spilled: false,
        total: 1,
      }) ?? []
    )
      .map((b) => ('text' in b ? b.text : ''))
      .join('');
    expect(text).toContain('Pathogenic');
    expect(text).toContain('1★');
    expect(text).toContain('Familial hypercholesterolemia');
  });

  it('rejects min_review_stars outside 0–4 at parse time', () => {
    expect(() => gnomadSearchClinvar.input.parse({ gene: 'LDLR', min_review_stars: 5 })).toThrow();
  });
});
