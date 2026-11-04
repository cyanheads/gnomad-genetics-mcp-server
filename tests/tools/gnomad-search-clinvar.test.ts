/**
 * @fileoverview Behavior tests for the gnomad_search_clinvar handler — the
 * second upstream service (NCBI E-utilities). The first blocks stub the ClinVar
 * service and cover canvas-disabled (every row of the window inline, empty
 * canvas_id, no-match notice), canvas-enabled staging (no canvas for a fit
 * without canvas_id, a spill past the budget, a supplied canvas_id that
 * replaces or drops the table), the Ensembl-ID short-circuit that touches no
 * canvas, and format() rendering. The contract-surface blocks run the real
 * service behind a fake fetch through runToolContract, covering result windows
 * and their notices, the limit default, clamp, and strict mode, the gene and
 * filter echo, descriptions gated on the canvas, the upstream_unavailable
 * contract, gnomAD-compatible identifiers, mapped, blank, and quoted
 * significance filters, the quoted gene term, the notice/staging matrix across
 * every reachable response shape, the ~24 KB canvas-on response budget on the
 * heaviest real records, and ClinVar's no-date placeholder and blank germline
 * values on both surfaces and as SQL NULL on a real DuckDB canvas.
 * @module tests/tools/gnomad-search-clinvar.test
 */

import { readFileSync } from 'node:fs';
import { z } from '@cyanheads/mcp-ts-core';
import {
  CanvasRegistry,
  DataCanvas,
  DEFAULT_CANVAS_REGISTRY_OPTIONS,
  DuckdbProvider,
} from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig, resetServerConfig } from '@/config/server-config.js';
import { gnomadSearchClinvar } from '@/mcp-server/tools/definitions/gnomad-search-clinvar.tool.js';
import * as canvasAccessor from '@/services/canvas-accessor.js';
import * as clinvarModule from '@/services/clinvar/clinvar-service.js';
import { initClinVarService } from '@/services/clinvar/clinvar-service.js';
import type { ClinVarRow, ClinVarSearchResult } from '@/services/clinvar/types.js';
import * as gnomadModule from '@/services/gnomad/gnomad-service.js';
import { initGnomadService } from '@/services/gnomad/gnomad-service.js';
import { UPSTREAM_CALL_BUDGET_MS } from '@/services/upstream-deadline.js';

type CallToolResult = Awaited<ReturnType<typeof runToolContract>>;
type SchemaProperties = { properties: Record<string, Record<string, unknown>> };

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
    oncogenicity_classification: null,
    oncogenicity_review_status: null,
    oncogenicity_last_evaluated: null,
    oncogenicity_conditions: '',
    clinical_impact_classification: null,
    clinical_impact_review_status: null,
    clinical_impact_last_evaluated: null,
    clinical_impact_conditions: '',
    submission_count: 2,
    canonical_spdi: null,
    rsids: '',
    grch38_variant_id: null,
  };
}

/**
 * Stub the ClinVar service so searchGene yields a fixed row set as one complete
 * window, and gnomAD's ClinVar mapping so it holds none of those synthetic
 * VariationIDs: their null grch38_variant_id stays null, with no notice.
 */
function stubClinvar(impl: () => Promise<ClinVarRow[]>) {
  const fake = {
    searchGene: vi.fn(async (): Promise<ClinVarSearchResult> => {
      const rows = await impl();
      return {
        rows,
        totalFound: rows.length,
        truncated: false,
        nextOffset: null,
        unavailableIds: [],
      };
    }),
  };
  vi.spyOn(clinvarModule, 'getClinVarService').mockReturnValue(fake as never);
  vi.spyOn(gnomadModule, 'getGnomadService').mockReturnValue({
    clinvarVariantIds: async () => ({ status: 'resolved', variantIds: new Map() }),
  } as never);
  return fake;
}

/** A row padded (via conditions) to exactly `chars` characters of JSON — the unit the preview budget counts. */
function sized(i: number, chars: number): ClinVarRow {
  const base = { ...row(i), conditions: '' };
  const pad = chars - JSON.stringify(base).length;
  if (pad < 0) throw new Error(`row ${i} is already longer than ${chars} chars`);
  return { ...base, conditions: 'x'.repeat(pad) };
}

const MINTED = 'cnvMinted1';
const REUSED = 'cnvReused1';

/**
 * A fake DataCanvas whose instances keep registered tables in memory, so the
 * real spillover() helper drains, sentinels, and stages against it, and a
 * supplied canvas_id resolves to the same table map. acquire(undefined) mints
 * MINTED; acquire(id) resolves id.
 */
function fakeCanvas() {
  const tables: Record<string, Record<string, unknown>[]> = {};
  const dropped: string[] = [];
  const instance = (canvasId: string) => ({
    canvasId,
    tenantId: 'default',
    isNew: canvasId === MINTED,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    async registerTable(
      name: string,
      rows: AsyncIterable<Record<string, unknown>> | Iterable<Record<string, unknown>>,
    ) {
      const collected: Record<string, unknown>[] = [];
      for await (const r of rows as AsyncIterable<Record<string, unknown>>) collected.push(r);
      tables[name] = collected;
      return {
        tableName: name,
        rowCount: collected.length,
        columns: Object.keys(collected[0] ?? {}),
      };
    },
    async drop(name: string) {
      dropped.push(name);
      const existed = name in tables;
      delete tables[name];
      return existed;
    },
  });
  const canvas = { acquire: vi.fn(async (id?: string) => instance(id ?? MINTED)) };
  return { canvas, tables, dropped };
}

// A window with a null grch38_variant_id reaches gnomAD's ClinVar mapping; every block fakes its fetch.
beforeEach(() => {
  initGnomadService({} as never, {} as never);
});

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

  it('previews every row of a window that fits the 11,000-character budget, however many (#37)', async () => {
    stubClinvar(async () => Array.from({ length: 10 }, (_, i) => sized(i + 1, 1_100)));
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const ctx = createMockContext({ errors: gnomadSearchClinvar.errors });
    const input = gnomadSearchClinvar.input.parse({ gene: 'BRCA1' });
    const result = await gnomadSearchClinvar.handler(input, ctx as never);

    expect(result.total).toBe(10);
    expect(result.preview).toHaveLength(10);
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('returns every row one character past the budget, with no notice (#59)', async () => {
    const rows = [...Array.from({ length: 9 }, (_, i) => sized(i + 1, 1_100)), sized(10, 1_101)];
    stubClinvar(async () => rows);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const ctx = createMockContext({ errors: gnomadSearchClinvar.errors });
    const input = gnomadSearchClinvar.input.parse({ gene: 'BRCA1' });
    const result = await gnomadSearchClinvar.handler(input, ctx as never);

    expect(result).toMatchObject({ total: 10, spilled: false, canvas_id: '', table_name: '' });
    expect(result.preview).toEqual(rows);
    expect(getEnrichment(ctx).notice).toBeUndefined();
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

describe('gnomad_search_clinvar handler — Ensembl gene ID', () => {
  it('short-circuits an ENSG id with a targeted notice and no NCBI call', async () => {
    // ClinVar's [gene] index resolves HGNC symbols only — an ENSG id would
    // return a bare empty. The tool names the real cause and never queries NCBI.
    const fake = stubClinvar(async () => [row(1)]); // would return a row IF called
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const ctx = createMockContext({ errors: gnomadSearchClinvar.errors });
    const input = gnomadSearchClinvar.input.parse({ gene: 'ENSG00000169174' });
    const result = await gnomadSearchClinvar.handler(input, ctx as never);

    expect(fake.searchGene).not.toHaveBeenCalled();
    expect(result.total).toBe(0);
    expect(result.preview).toEqual([]);
    const notice = getEnrichment(ctx).notice;
    expect(notice).toMatch(/HGNC symbol/);
    expect(notice).toMatch(/not indexed by ClinVar/);
    expect(notice).toContain('ENSG00000169174');
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/62
  it.each(['true', 'false'])(
    'short-circuits a versioned ENSG id the same way with GNOMAD_NORMALIZE_IDS=%s',
    async (normalizeIds) => {
      vi.stubEnv('GNOMAD_NORMALIZE_IDS', normalizeIds);
      resetServerConfig();
      const fake = stubClinvar(async () => [row(1)]);
      vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

      const result = await runToolContract(gnomadSearchClinvar, { gene: 'ENSG00000169174.12' });

      vi.unstubAllEnvs();
      resetServerConfig();
      expect(fake.searchGene).not.toHaveBeenCalled();
      expect(result.structuredContent).toMatchObject({
        total: 0,
        notice:
          'ClinVar search needs an HGNC symbol; Ensembl gene IDs (ENSG…) are not indexed by ClinVar. Resolve "ENSG00000169174.12" to its symbol (e.g. via ensembl_lookup_gene) and retry.',
      });
    },
  );

  it('renders no disabled-canvas text for an ENSG id with the canvas enabled (#33)', async () => {
    vi.restoreAllMocks();
    const fake = stubClinvar(async () => [row(1)]);
    const { canvas } = fakeCanvas();
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(canvas as never);

    const result = await runToolContract(gnomadSearchClinvar, { gene: 'ENSG00000012048' });

    expect(fake.searchGene).not.toHaveBeenCalled();
    expect(canvas.acquire).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({
      preview: [],
      canvas_id: '',
      table_name: '',
      spilled: false,
      total: 0,
      total_found: 0,
      truncated: false,
      next_offset: null,
      unavailable_ids: [],
    });
    const notice = (result.structuredContent as { notice: string }).notice;
    expect(notice).toBe(
      'ClinVar search needs an HGNC symbol; Ensembl gene IDs (ENSG…) are not indexed by ClinVar. Resolve "ENSG00000012048" to its symbol (e.g. via ensembl_lookup_gene) and retry.',
    );
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).not.toMatch(/disabled/i);
    expect(text).toContain('**Staged:** no canvas table for this call.');
    expect(text).not.toMatch(/gnomad_dataframe_(describe|query)/);
  });

  it('leaves a supplied canvas untouched for an ENSG id — it searched nothing (#33, #35)', async () => {
    vi.restoreAllMocks();
    const fake = stubClinvar(async () => [row(1)]);
    const { canvas, tables, dropped } = fakeCanvas();
    tables.clinvar_variants = [row(1)];
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(canvas as never);

    const result = await runToolContract(gnomadSearchClinvar, {
      gene: 'ENSG00000012048',
      canvas_id: REUSED,
    });

    expect(result.isError).toBeFalsy();
    expect(fake.searchGene).not.toHaveBeenCalled();
    expect(canvas.acquire).not.toHaveBeenCalled();
    expect(dropped).toEqual([]);
    expect(tables.clinvar_variants).toEqual([row(1)]);
    expect(result.structuredContent).toMatchObject({
      preview: [],
      canvas_id: '',
      table_name: '',
      spilled: false,
      total: 0,
      total_found: 0,
    });
    expect((result.structuredContent as { notice: string }).notice).toMatch(
      /HGNC symbol.*ENSG00000012048/,
    );
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('**Staged:** no canvas table for this call.');
    expect(text).toContain('Resolve "ENSG00000012048" to its symbol');
  });

  it('queries normally for an HGNC symbol', async () => {
    const fake = stubClinvar(async () => [row(1), row(2)]);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const ctx = createMockContext({ errors: gnomadSearchClinvar.errors });
    const input = gnomadSearchClinvar.input.parse({ gene: 'PCSK9' });
    const result = await gnomadSearchClinvar.handler(input, ctx as never);

    expect(fake.searchGene).toHaveBeenCalledOnce();
    expect(result.total).toBe(2);
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });
});

describe('gnomad_search_clinvar handler — canvas enabled', () => {
  it('spills a large result to the clinvar_variants table', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => row(i + 1));
    stubClinvar(async () => rows);
    const { canvas, tables } = fakeCanvas();
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(canvas as never);

    const ctx = createMockContext({ errors: gnomadSearchClinvar.errors });
    const input = gnomadSearchClinvar.input.parse({ gene: 'BRCA2' });
    const result = await gnomadSearchClinvar.handler(input, ctx as never);

    expect(result.spilled).toBe(true);
    expect(result.canvas_id).toBe(MINTED);
    expect(result.table_name).toBe('clinvar_variants');
    expect(result.total).toBe(1000);
    expect(tables.clinvar_variants).toHaveLength(1000);
    expect(result).toEqual(expect.schemaMatching(gnomadSearchClinvar.output));
  });

  it('acquires no canvas for a window that fits inline without canvas_id (#35)', async () => {
    stubClinvar(async () => [row(1), row(2)]);
    const { canvas } = fakeCanvas();
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(canvas as never);

    const ctx = createMockContext({ errors: gnomadSearchClinvar.errors });
    const input = gnomadSearchClinvar.input.parse({ gene: 'LDLR' });
    const result = await gnomadSearchClinvar.handler(input, ctx as never);

    expect(canvas.acquire).not.toHaveBeenCalled();
    expect(result).toMatchObject({ spilled: false, canvas_id: '', table_name: '', total: 2 });
  });

  it('fits a window of exactly 11,000 preview characters inline (#37 boundary)', async () => {
    stubClinvar(async () => Array.from({ length: 10 }, (_, i) => sized(i + 1, 1_100)));
    const { canvas } = fakeCanvas();
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(canvas as never);

    const ctx = createMockContext({ errors: gnomadSearchClinvar.errors });
    const input = gnomadSearchClinvar.input.parse({ gene: 'LDLR' });
    const result = await gnomadSearchClinvar.handler(input, ctx as never);

    expect(result).toMatchObject({ spilled: false, canvas_id: '', total: 10 });
    expect(result.preview).toHaveLength(10);
    expect(canvas.acquire).not.toHaveBeenCalled();
  });

  it('spills one character past 11,000 and previews the rows under the budget (#37 boundary)', async () => {
    const rows = [...Array.from({ length: 9 }, (_, i) => sized(i + 1, 1_100)), sized(10, 1_101)];
    stubClinvar(async () => rows);
    const { canvas, tables } = fakeCanvas();
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(canvas as never);

    const ctx = createMockContext({ errors: gnomadSearchClinvar.errors });
    const input = gnomadSearchClinvar.input.parse({ gene: 'LDLR' });
    const result = await gnomadSearchClinvar.handler(input, ctx as never);

    expect(result).toMatchObject({ spilled: true, table_name: 'clinvar_variants', total: 10 });
    expect(result.preview).toHaveLength(9);
    expect(tables.clinvar_variants).toHaveLength(10);
  });

  it('replaces the named table when a supplied canvas_id gets a window that fits (#35)', async () => {
    const { canvas, tables } = fakeCanvas();
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(canvas as never);
    tables.clinvar_variants = Array.from({ length: 500 }, (_, i) => row(i + 1));
    stubClinvar(async () => [row(7), row(8)]);

    const ctx = createMockContext({ errors: gnomadSearchClinvar.errors });
    const input = gnomadSearchClinvar.input.parse({ gene: 'LDLR', canvas_id: REUSED });
    const result = await gnomadSearchClinvar.handler(input, ctx as never);

    expect(canvas.acquire).toHaveBeenCalledWith(REUSED, ctx);
    expect(result).toMatchObject({
      spilled: false,
      canvas_id: REUSED,
      table_name: 'clinvar_variants',
      total: 2,
    });
    expect(tables.clinvar_variants).toEqual([row(7), row(8)]);
  });

  it('leaves no stale table when a supplied canvas_id gets zero rows (#35)', async () => {
    const { canvas, tables, dropped } = fakeCanvas();
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(canvas as never);
    tables.clinvar_variants = [row(1)];
    stubClinvar(async () => []);

    const ctx = createMockContext({ errors: gnomadSearchClinvar.errors });
    const input = gnomadSearchClinvar.input.parse({ gene: 'LDLR', canvas_id: REUSED });
    const result = await gnomadSearchClinvar.handler(input, ctx as never);

    expect(dropped).toEqual(['clinvar_variants']);
    expect(tables.clinvar_variants).toBeUndefined();
    expect(result).toMatchObject({ canvas_id: REUSED, table_name: '', spilled: false, total: 0 });
  });
});

describe('gnomad_search_clinvar handler — upstream failure', () => {
  it('lets a service ServiceUnavailable bubble unchanged', async () => {
    stubClinvar(async () => {
      throw serviceUnavailable('NCBI ClinVar is unavailable or rate-limited.', {
        reason: 'upstream_unavailable',
      });
    });
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const ctx = createMockContext({ errors: gnomadSearchClinvar.errors });
    const input = gnomadSearchClinvar.input.parse({ gene: 'LDLR' });
    // The handler does not catch — the service's error reaches the framework as thrown.
    await expect(gnomadSearchClinvar.handler(input, ctx as never)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unavailable' },
    });
  });
});

/** The #70 echo of a search with no filters. */
const NO_FILTERS = {
  gene: 'LDLR',
  filters: { clinical_significance: null, min_review_stars: null },
};

describe('gnomad_search_clinvar format()', () => {
  const base = {
    ...NO_FILTERS,
    canvas_id: '',
    table_name: '',
    spilled: false,
    total: 1,
    total_found: 1,
    truncated: false,
    next_offset: null,
    unavailable_ids: [],
  };
  const render = (result: Parameters<NonNullable<typeof gnomadSearchClinvar.format>>[0]) =>
    (gnomadSearchClinvar.format?.(result) ?? []).map((b) => ('text' in b ? b.text : '')).join('');

  it('renders the star rating, significance, and conditions', () => {
    const text = render({ ...base, preview: [row(42)] });
    expect(text).toContain('Pathogenic');
    expect(text).toContain('1★');
    expect(text).toContain('Familial hypercholesterolemia');
  });

  it('renders unknown identifiers honestly instead of inventing them', () => {
    const text = render({ ...base, preview: [row(42)] });
    expect(text).toContain('**GRCh38 variant ID:** Not available');
    expect(text).toContain('**rsIDs:** none');
    expect(text).toContain('**Canonical SPDI:** Not available');
  });

  it('renders the window fields for a truncated window', () => {
    const text = render({
      ...base,
      preview: [],
      total: 0,
      total_found: 1571,
      truncated: true,
      next_offset: 500,
      unavailable_ids: ['5', '9'],
    });
    expect(text).toContain('**Total found:** 1571 | **Truncated:** yes | **Next offset:** 500');
    expect(text).toContain('**Unavailable IDs:** 5, 9');
  });

  it('rejects min_review_stars outside 0–4 at parse time', () => {
    expect(() => gnomadSearchClinvar.input.parse({ gene: 'LDLR', min_review_stars: 5 })).toThrow();
  });
});

/* ------------------------------------------------------------------------- */
/* Contract surface — the real ClinVarService behind a fake fetch boundary.   */
/* ------------------------------------------------------------------------- */

type EsummaryFixture = { result: Record<string, unknown> & { uids: string[] } };

const LIVE = JSON.parse(
  readFileSync(new URL('../fixtures/clinvar-esummary.live.json', import.meta.url), 'utf8'),
) as EsummaryFixture;

/** The 24 longest real ESummary records (BRCA1, captured 2026-09-23), `allele_freq_set` trimmed. */
const HEAVY = JSON.parse(
  readFileSync(new URL('../fixtures/clinvar-esummary-heavy.live.json', import.meta.url), 'utf8'),
) as EsummaryFixture;

/**
 * Real BRCA1 records whose germline block carries ClinVar's `1/01/01 00:00`
 * no-date placeholder (captured 2026-10-31), `allele_freq_set` trimmed:
 * 4852577 and 4849514 with a blank description and review status, 1687128
 * Pathogenic, 54221 "not provided".
 */
const PLACEHOLDER = JSON.parse(
  readFileSync(
    new URL('../fixtures/clinvar-esummary-placeholder.live.json', import.meta.url),
    'utf8',
  ),
) as EsummaryFixture;

/**
 * Real records carrying a germline and a somatic classification (captured
 * 2026-11-03), `allele_freq_set` trimmed: KRAS 3116215 (clinical impact Tier I -
 * Strong) and TP53 4880485 (Likely oncogenic).
 */
const SOMATIC = JSON.parse(
  readFileSync(new URL('../fixtures/clinvar-esummary-somatic.live.json', import.meta.url), 'utf8'),
) as EsummaryFixture;

/**
 * The real BRCA1 record 4713084 (`c.3338_3339del`, a Microsatellite with no
 * rsID; captured 2026-11-03), whose canonical SPDI drops the anchor base, so
 * no ID derives from it.
 */
const INDEL = JSON.parse(
  readFileSync(new URL('../fixtures/clinvar-esummary-indel.live.json', import.meta.url), 'utf8'),
) as EsummaryFixture;

function fetchUrl(input: string | URL | Request): URL {
  if (input instanceof URL) return input;
  if (input instanceof Request) return new URL(input.url);
  return new URL(input);
}

/**
 * Canned ESummary body for the requested UIDs. Fixture UIDs return their live
 * record; any other UID returns a fixture record re-keyed to that UID — the
 * 2878 record from LIVE, or the source's records in rotation — except UIDs in
 * `missing`, which are left out of `result` entirely.
 */
function summaryFor(
  ids: string[],
  missing: ReadonlySet<string>,
  source: EsummaryFixture,
): Response {
  const fillers = source === LIVE ? ['2878'] : source.result.uids;
  const result: Record<string, unknown> = { uids: ids };
  for (const id of ids) {
    if (missing.has(id)) continue;
    const filler = fillers[Number(id) % fillers.length] ?? '2878';
    result[id] = source.result[id] ?? {
      ...(source.result[filler] as Record<string, unknown>),
      uid: id,
      accession: `VCV${id.padStart(9, '0')}`,
    };
  }
  return new Response(JSON.stringify({ result }));
}

/**
 * Live `gene.clinvar_variants` entries of gnomAD's ClinVar mapping (GRCh38,
 * ClinVar release 2026-10-11), captured 2026-11-03 and trimmed to the
 * VariationIDs these tests use: BRCA1 (4713084, the PLACEHOLDER records
 * 1687128 and 54221, HEAVY's 4845640, 4842661, and 4800824), TTR, and MT-ND1,
 * whose IDs are all mitochondrial.
 */
const GNOMAD_MAPPING = JSON.parse(
  readFileSync(
    new URL('../fixtures/gnomad-clinvar-variant-ids.live.json', import.meta.url),
    'utf8',
  ),
) as Record<string, { clinvar_variation_id: string; variant_id: string }[]>;

const GNOMAD_ORIGIN = new URL(getServerConfig().gnomadApiBaseUrl).origin;

/** gnomAD's reply to the ClinVar-mapping request for one gene. */
type GnomadRoute = (gene: string, init: RequestInit | undefined) => Response | Promise<Response>;

/**
 * gnomAD's mapping as captured; a gene the capture lacks answers an empty
 * list, so the synthetic VariationIDs these tests use stay unmapped.
 */
const capturedMapping: GnomadRoute = (gene) =>
  Response.json({ data: { gene: { clinvar_variants: GNOMAD_MAPPING[gene] ?? [] } } });

/**
 * Route ESearch to a canned envelope, ESummary to a live fixture (LIVE by
 * default), and gnomAD's ClinVar-mapping request to `gnomad` (the captured
 * mapping by default). Any other request rejects, so nothing reaches live
 * NCBI or gnomAD. `urls` logs the NCBI requests, `genes` the gene of each
 * gnomAD request.
 */
function fakeUpstreams(
  esearch: Record<string, unknown>,
  {
    missing = [],
    source = LIVE,
    gnomad = capturedMapping,
  }: { gnomad?: GnomadRoute; missing?: string[]; source?: EsummaryFixture } = {},
) {
  const urls: URL[] = [];
  const genes: string[] = [];
  const absent = new Set(missing);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = fetchUrl(input);
    if (url.origin === GNOMAD_ORIGIN) {
      const { query, variables } = JSON.parse(String(init?.body)) as {
        query: string;
        variables: { gene: string };
      };
      if (!query.includes('GnomadGeneClinvarVariantIds')) throw new Error('unmocked gnomAD query');
      genes.push(variables.gene);
      return gnomad(variables.gene, init);
    }
    urls.push(url);
    if (url.pathname.endsWith('/esearch.fcgi')) {
      return new Response(JSON.stringify({ esearchresult: esearch }));
    }
    if (url.pathname.endsWith('/esummary.fcgi')) {
      return summaryFor((url.searchParams.get('id') ?? '').split(','), absent, source);
    }
    throw new Error('unmocked fetch');
  });
  return { urls, genes };
}

/** {@link fakeUpstreams} with the captured gnomAD mapping, returning the NCBI request log. */
function fakeNcbi(
  esearch: Record<string, unknown>,
  missing: string[] = [],
  source: EsummaryFixture = LIVE,
) {
  return fakeUpstreams(esearch, { missing, source }).urls;
}

/** Run the tool contract under fake timers so NCBI pacing never costs wall-clock time. */
async function run(input: Parameters<typeof runToolContract<typeof gnomadSearchClinvar>>[1]) {
  vi.useFakeTimers();
  let settled = false;
  const pending = runToolContract(gnomadSearchClinvar, input).finally(() => {
    settled = true;
  });
  for (let i = 0; i < 200 && !settled; i += 1) await vi.advanceTimersByTimeAsync(1000);
  return pending;
}

/** `count` synthetic VariationIDs starting at `from`. */
function ids(from: number, count: number): string[] {
  return Array.from({ length: count }, (_, i) => String(from + i));
}

function textOf(result: CallToolResult): string {
  return result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
}

describe('gnomad_search_clinvar contract surface (real service, fake NCBI)', () => {
  beforeEach(() => {
    // Earlier blocks stub getClinVarService without restoring it.
    vi.restoreAllMocks();
    initClinVarService({} as never, {} as never);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders the window rows on both surfaces', async () => {
    fakeNcbi({ count: '2', idlist: ['2878', '4880644'] });

    const result = await runToolContract(gnomadSearchClinvar, { gene: 'PCSK9' });

    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc).toMatchObject({ canvas_id: '', table_name: '', spilled: false, total: 2 });
    expect(
      (sc.preview as { clinvar_variation_id: string }[]).map((r) => r.clinvar_variation_id),
    ).toEqual(['2878', '4880644']);
    const text = textOf(result);
    expect(text).toContain('## ClinVar — 2 record(s)');
    expect(text).toContain('**VariationID:** 2878');
    expect(text).toContain('Showing 2 preview row(s):');
  });

  it('carries the no-match notice in structuredContent and the content trailer', async () => {
    fakeNcbi({ count: '0', idlist: [] });

    const result = await runToolContract(gnomadSearchClinvar, { gene: 'NOSUCHGENE' });

    const notice = (result.structuredContent as { notice?: string }).notice;
    expect(notice).toContain('No ClinVar records for "NOSUCHGENE"');
    expect(notice).toContain('verify the gene symbol');
    expect(textOf(result)).toContain('No ClinVar records for "NOSUCHGENE"');
  });

  it('surfaces an unreachable NCBI as upstream_unavailable with the NCBI retry hint', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('down', { status: 503 }));

    const pending = runToolContract(gnomadSearchClinvar, { gene: 'PCSK9' });
    for (let i = 0; i < 12; i += 1) await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;

    expect(result.isError).toBe(true);
    const error = (
      result.structuredContent as { error: { code: number; data: Record<string, unknown> } }
    ).error;
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data.reason).toBe('upstream_unavailable');
    expect((error.data.recovery as { hint: string }).hint).toMatch(
      /NCBI is degraded or throttling/,
    );
    expect(textOf(result)).toContain('Recovery: NCBI is degraded or throttling');
  });

  it('declares the reason an unreachable NCBI actually emits, with the same recovery text', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('fetch failed: connect ECONNREFUSED 127.0.0.1:9'),
    );

    const pending = runToolContract(gnomadSearchClinvar, { gene: 'PCSK9' });
    for (let i = 0; i < 12; i += 1) await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;

    const data = (result.structuredContent as { error: { data: Record<string, unknown> } }).error
      .data;
    const declared = (gnomadSearchClinvar.errors ?? []).map((e) => e.reason);
    expect(declared).toContain(data.reason);
    expect(declared).not.toContain('ncbi_unreachable');
    const entry = gnomadSearchClinvar.errors?.find((e) => e.reason === data.reason);
    expect(entry).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      thrownBy: 'service',
    });
    expect((data.recovery as { hint: string }).hint).toBe(entry?.recovery);
  });
});

describe('gnomad_search_clinvar result windows (#28)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    initClinVarService({} as never, {} as never);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reports the ESearch count and the next offset on a first window of 500', async () => {
    const urls = fakeNcbi({ count: '1571', idlist: ids(1_000_000, 500) });

    const result = await run({ gene: 'PCSK9', limit: 500 });

    expect(result.isError).toBeFalsy();
    expect(urls[0]?.searchParams.get('retstart')).toBe('0');
    expect(urls[0]?.searchParams.get('retmax')).toBe('500');
    // 500 IDs → ten 50-ID ESummary batches.
    expect(urls.filter((u) => u.pathname.endsWith('/esummary.fcgi'))).toHaveLength(10);
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc).toMatchObject({
      total: 500,
      total_found: 1571,
      truncated: true,
      next_offset: 500,
      unavailable_ids: [],
    });
    expect(sc.notice).toMatch(/1571/);
    expect(sc.notice).toMatch(/offset[= ]500/);
    const text = textOf(result);
    expect(text).toContain('**Total found:** 1571');
    expect(text).toContain('**Next offset:** 500');
    expect(text).toContain('**Truncated:** yes');
    expect(text).toContain('**Unavailable IDs:** none');
  });

  it('passes offset and limit through as retstart and retmax', async () => {
    const urls = fakeNcbi({ count: '1571', idlist: ids(2_000_000, 20) });

    const result = await run({ gene: 'PCSK9', offset: 500, limit: 20 });

    expect(urls[0]?.searchParams.get('retstart')).toBe('500');
    expect(urls[0]?.searchParams.get('retmax')).toBe('20');
    expect(result.structuredContent).toMatchObject({
      total: 20,
      total_found: 1571,
      truncated: true,
      next_offset: 520,
    });
  });

  it('closes the last window with truncated=false and next_offset=null', async () => {
    fakeNcbi({ count: '1571', idlist: ids(3_000_000, 71) });

    const result = await run({ gene: 'PCSK9', offset: 1500, limit: 500 });

    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc).toMatchObject({ total: 71, total_found: 1571, truncated: false, next_offset: null });
    expect(sc.notice).not.toMatch(/offset/);
    const text = textOf(result);
    expect(text).toContain('**Truncated:** no');
    expect(text).toContain('**Next offset:** none');
  });

  it('keeps total_found and drops the gene-symbol hint when offset is past the end', async () => {
    fakeNcbi({ count: '1571', idlist: [] });

    const result = await run({ gene: 'PCSK9', offset: 5000 });

    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc).toMatchObject({
      total: 0,
      preview: [],
      total_found: 1571,
      truncated: false,
      next_offset: null,
    });
    expect(sc.notice).toMatch(/offset 5000 is past the end/);
    expect(sc.notice).not.toMatch(/verify the gene symbol/);
    expect(textOf(result)).toMatch(/offset 5000 is past the end/);
  });

  it('points a filtered-empty window at next_offset instead of the no-records notice', async () => {
    // Every candidate in this window is the Benign/Likely benign 2878 record.
    fakeNcbi({ count: '1200', idlist: ids(4_000_000, 10) });

    const result = await run({
      gene: 'PCSK9',
      clinical_significance: 'pathogenic',
      limit: 10,
    });

    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc).toMatchObject({ total: 0, total_found: 1200, truncated: true, next_offset: 10 });
    expect(sc.notice).toMatch(/offset[= ]10\b/);
    expect(sc.notice).not.toMatch(/No ClinVar records/);
    expect(sc.notice).not.toMatch(/verify the gene symbol/);
  });

  it('names a filtered-empty last window as the end of the list, not a no-match', async () => {
    fakeNcbi({ count: '1571', idlist: ids(8_000_000, 71) });

    const result = await run({
      gene: 'PCSK9',
      clinical_significance: 'pathogenic',
      offset: 1500,
      limit: 500,
    });

    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc).toMatchObject({ total: 0, total_found: 1571, truncated: false, next_offset: null });
    expect(sc.notice).toMatch(/candidates 1501–1571 of 1571/);
    expect(sc.notice).toMatch(/last window/);
    expect(sc.notice).not.toMatch(/No ClinVar records/);
  });

  it('drops the gene-symbol hint when candidates exist but none pass the filters', async () => {
    fakeNcbi({ count: '3', idlist: ids(5_000_000, 3) });

    const result = await run({ gene: 'PCSK9', clinical_significance: 'pathogenic' });

    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc).toMatchObject({ total: 0, total_found: 3, next_offset: null });
    expect(sc.notice).toMatch(
      /No ClinVar records for "PCSK9" matching clinical_significance=pathogenic/,
    );
    expect(sc.notice).not.toMatch(/verify the gene symbol/);
  });

  it('lists error-keyed and missing ESummary UIDs as unavailable instead of blank rows', async () => {
    fakeNcbi({ count: '3', idlist: ['2878', '999999999', '12345678'] }, ['12345678']);

    const result = await run({ gene: 'PCSK9' });

    const sc = result.structuredContent as Record<string, unknown>;
    expect(
      (sc.preview as { clinvar_variation_id: string }[]).map((r) => r.clinvar_variation_id),
    ).toEqual(['2878']);
    expect(sc).toMatchObject({ total: 1, unavailable_ids: ['999999999', '12345678'] });
    expect(textOf(result)).toContain('**Unavailable IDs:** 999999999, 12345678');
  });

  it('accepts the largest offset ESearch takes as retstart', async () => {
    const urls = fakeNcbi({ count: '1571', idlist: [] });

    const result = await run({ gene: 'PCSK9', offset: 2_147_483_647 });

    expect(urls[0]?.searchParams.get('retstart')).toBe('2147483647');
    expect(result.structuredContent).toMatchObject({ total: 0, total_found: 1571 });
    expect((result.structuredContent as { notice: string }).notice).toMatch(/past the end/);
  });

  it.each([
    { offset: -1 },
    { limit: 0 },
    { offset: 1.5 },
    // ESearch retstart is a signed 32-bit integer; past it NCBI answers 200 with an empty body.
    { offset: 2_147_483_648 },
  ])('rejects out-of-range window input %j with InvalidParams', async (window) => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const result = await runToolContract(gnomadSearchClinvar, { gene: 'PCSK9', ...window });

    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error: { code: number } }).error.code).toBe(
      JsonRpcErrorCode.InvalidParams,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { offset: 0, limit: 1 },
    { offset: 0, limit: 1500 },
  ])('accepts the window boundaries %j without a clamp notice', async (window) => {
    const urls = fakeNcbi({ count: '0', idlist: [] });

    const result = await run({ gene: 'PCSK9', ...window });

    expect(result.isError).toBeFalsy();
    expect(urls[0]?.searchParams.get('retmax')).toBe(String(window.limit));
    expect((result.structuredContent as { notice: string }).notice).not.toMatch(/clamped/);
  });

  it('sends the significance property clause and review-status floor in the ESearch term (#67)', async () => {
    const urls = fakeNcbi({ count: '0', idlist: [] });

    await run({ gene: 'BRCA1', clinical_significance: 'pathogenic', min_review_stars: 3 });

    expect(urls[0]?.searchParams.get('term')).toBe(
      '"BRCA1"[gene] AND (clinsig_pathogenic[prop] OR clinsig_likely_pathogenic[prop] OR clinsig_pathogenic_low_penetrance[prop] OR clinsig_likely_pathogenic_low_penetrance[prop]) AND ("practice guideline"[Review status] OR "reviewed by expert panel"[Review status])',
    );
  });

  it('searches VUS through the property clause and keeps the Uncertain significance rows (#67)', async () => {
    // 4759136 and 2610176 are Uncertain significance in the live fixture; 2878 is Benign/Likely benign.
    const urls = fakeNcbi({ count: '777', idlist: ['4759136', '2878', '2610176'] });

    const result = await run({ gene: 'PCSK9', clinical_significance: 'VUS', limit: 3 });

    expect(urls[0]?.searchParams.get('term')).toBe(
      '"PCSK9"[gene] AND (clinsig_vus[prop] OR clinsig_vus_high[prop] OR clinsig_vus_mid[prop] OR clinsig_vus_low[prop])',
    );
    const sc = result.structuredContent as { preview: ClinVarRow[]; total_found: number };
    expect(sc.total_found).toBe(777);
    expect(sc.preview.map((r) => [r.clinvar_variation_id, r.clinical_significance])).toEqual([
      ['4759136', 'Uncertain significance'],
      ['2610176', 'Uncertain significance'],
    ]);
    const text = textOf(result);
    expect(text.match(/^\*\*Variant:\*\* /gm)).toHaveLength(2);
    expect(text).toContain('**VariationID:** 4759136 ');
    expect(text).toContain('**VariationID:** 2610176 ');
    expect(text).toContain('**Filters:** clinical_significance=vus');
  });

  it('carries the completeness part before the identifier part in one notice', async () => {
    fakeNcbi({ count: '900', idlist: ['2878', ...ids(6_000_000, 9)] });

    const result = await run({ gene: 'PCSK9', limit: 10 });

    const notice = (result.structuredContent as { notice: string }).notice;
    const completeness = notice.search(/offset[= ]10\b/);
    const identifiers = notice.search(/grch38_variant_id/);
    expect(completeness).toBeGreaterThanOrEqual(0);
    expect(identifiers).toBeGreaterThan(completeness);
    expect(notice).toMatch(/gnomad_get_variant/);
  });
});

describe('gnomad_search_clinvar limit (#63)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    initClinVarService({} as never, {} as never);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fetches a window of 10 records when limit is omitted', async () => {
    const urls = fakeNcbi({ count: '1571', idlist: ids(1_100_000, 10) });

    const result = await run({ gene: 'PCSK9' });

    expect(urls[0]?.searchParams.get('retmax')).toBe('10');
    expect(urls.filter((u) => u.pathname.endsWith('/esummary.fcgi'))).toHaveLength(1);
    expect(result.structuredContent).toMatchObject({
      total: 10,
      total_found: 1571,
      truncated: true,
      next_offset: 10,
    });
  });

  it('clamps a limit above 1,500 to the cap, with the notice on both surfaces', async () => {
    const urls = fakeNcbi({ count: '16107', idlist: ['2878', '4880644'] });

    const result = await run({ gene: 'BRCA1', limit: 5000 });

    expect(result.isError).toBeFalsy();
    expect(urls[0]?.searchParams.get('retmax')).toBe('1500');
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc).toMatchObject({ truncated: true, next_offset: 1500 });
    expect(sc.notice).toBe(
      'Requested limit 5000 was clamped to the cap of 1500. This window covers ClinVar candidates 1–1500 of 16107 for "BRCA1"; continue with offset=1500 for the next window. To check population frequency, pass grch38_variant_id to gnomad_get_variant with a GRCh38 dataset (gnomad_r4, gnomad_r3, or one of their subsets); prefer it over rsids, since one rsID can match several gnomAD variants.',
    );
    const text = textOf(result);
    expect(text).toContain('Requested limit 5000 was clamped to the cap of 1500.');
    expect(text).toContain('**Next offset:** 1500');
  });

  it('still rejects a fractional limit with InvalidParams', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const result = await runToolContract(gnomadSearchClinvar, { gene: 'PCSK9', limit: 2.5 });

    expect((result.structuredContent as { error: { code: number } }).error.code).toBe(
      JsonRpcErrorCode.InvalidParams,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('advertises a default of 10 and no maximum', () => {
    const limit = (z.toJSONSchema(gnomadSearchClinvar.input) as SchemaProperties).properties.limit;
    expect(limit).toMatchObject({ default: 10, minimum: 1 });
    expect(limit).not.toHaveProperty('maximum');
  });

  describe('with GNOMAD_CLAMP_LIMITS=false', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    it('advertises a maximum of 1,500 and rejects 1501 with InvalidParams', async () => {
      vi.stubEnv('GNOMAD_CLAMP_LIMITS', 'false');
      vi.resetModules();
      const { gnomadSearchClinvar: strict } = await import(
        '@/mcp-server/tools/definitions/gnomad-search-clinvar.tool.js'
      );
      const fetch = vi.spyOn(globalThis, 'fetch');

      const result = await runToolContract(strict, { gene: 'PCSK9', limit: 1501 });

      expect((result.structuredContent as { error: { code: number } }).error.code).toBe(
        JsonRpcErrorCode.InvalidParams,
      );
      expect(fetch).not.toHaveBeenCalled();
      expect((z.toJSONSchema(strict.input) as SchemaProperties).properties.limit).toMatchObject({
        default: 10,
        maximum: 1500,
      });
    });
  });
});

describe('gnomad_search_clinvar with the canvas off pages without skipping rows (#59)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    initClinVarService({} as never, {} as never);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns every row of a window past the preview budget, and next_offset follows it', async () => {
    fakeNcbi({ count: '1571', idlist: ids(1_200_000, 60) });

    const result = await run({ gene: 'PCSK9', limit: 60 });

    const sc = result.structuredContent as Record<string, unknown>;
    const preview = sc.preview as ClinVarRow[];
    expect(preview.map((r) => r.clinvar_variation_id)).toEqual(ids(1_200_000, 60));
    expect(sc).toMatchObject({
      total: 60,
      spilled: false,
      canvas_id: '',
      table_name: '',
      next_offset: 60,
    });
    expect(sc.notice).not.toMatch(/CANVAS_PROVIDER_TYPE|showing \d+ of/);
    const text = textOf(result);
    expect(text.match(/^\*\*Variant:\*\* /gm)).toHaveLength(60);
    expect(text).not.toContain('CANVAS_PROVIDER_TYPE');
  });
});

describe('gnomad_search_clinvar gene and filter echo (#70)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    initClinVarService({} as never, {} as never);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('echoes the gene and the normalized filters on both surfaces', async () => {
    fakeNcbi({ count: '0', idlist: [] });

    const result = await run({
      gene: 'PCSK9',
      clinical_significance: 'likely_pathogenic',
      min_review_stars: 2,
      offset: 20,
      limit: 30,
    });

    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.gene).toBe('PCSK9');
    // Row filters only: offset and limit never appear.
    expect(sc.filters).toEqual({ clinical_significance: 'likely pathogenic', min_review_stars: 2 });
    expect(textOf(result)).toContain(
      '**Gene:** PCSK9 | **Filters:** clinical_significance=likely pathogenic, min_review_stars=2',
    );
  });

  it.each([
    ['omitted', {}],
    ['blank', { clinical_significance: '  ' }],
  ])('echoes %s filters as null and renders none', async (_label, filters) => {
    fakeNcbi({ count: '0', idlist: [] });

    const result = await run({ gene: 'PCSK9', ...filters });

    expect((result.structuredContent as { filters: unknown }).filters).toEqual({
      clinical_significance: null,
      min_review_stars: null,
    });
    expect(textOf(result)).toContain('**Gene:** PCSK9 | **Filters:** none');
  });

  it('echoes the gene and filters for an Ensembl ID it searched nothing for', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');

    const result = await runToolContract(gnomadSearchClinvar, {
      gene: 'ENSG00000169174',
      clinical_significance: 'pathogenic',
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({
      gene: 'ENSG00000169174',
      filters: { clinical_significance: 'pathogenic', min_review_stars: null },
    });
    expect(textOf(result)).toContain(
      '**Gene:** ENSG00000169174 | **Filters:** clinical_significance=pathogenic',
    );
  });

  it('escapes Markdown in the echoed gene and significance in content[] only', async () => {
    fakeNcbi({ count: '0', idlist: [] });

    const result = await run({ gene: 'PCSK9*[x]', clinical_significance: 'risk *factor*' });

    expect(result.structuredContent).toMatchObject({
      gene: 'PCSK9*[x]',
      filters: { clinical_significance: 'risk *factor*', min_review_stars: null },
    });
    expect(textOf(result)).toContain(
      '**Gene:** PCSK9\\*\\[x\\] | **Filters:** clinical_significance=risk \\*factor\\*',
    );
  });
});

describe('gnomad_search_clinvar descriptions follow the canvas gate (#72)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  /** Every advertised string of the tools/list entry: description, input, output, and enrichment schemas. */
  async function advertised() {
    vi.resetModules();
    const { gnomadSearchClinvar: definition } = await import(
      '@/mcp-server/tools/definitions/gnomad-search-clinvar.tool.js'
    );
    return JSON.stringify([
      definition.description,
      z.toJSONSchema(definition.input),
      z.toJSONSchema(definition.output.extend(definition.enrichment ?? {})),
    ]);
  }

  it('names no gnomad_dataframe_ tool with CANVAS_PROVIDER_TYPE=none', async () => {
    vi.stubEnv('CANVAS_PROVIDER_TYPE', 'none');
    const surface = await advertised();
    expect(surface).not.toContain('gnomad_dataframe_');
    expect(surface).not.toMatch(/capped/i);
  });

  it.each([undefined, 'duckdb'])(
    'names gnomad_dataframe_describe and gnomad_dataframe_query with CANVAS_PROVIDER_TYPE=%s',
    async (value) => {
      vi.stubEnv('CANVAS_PROVIDER_TYPE', value);
      const surface = await advertised();
      expect(surface).toContain('gnomad_dataframe_describe');
      expect(surface).toContain('gnomad_dataframe_query');
    },
  );
});

describe('gnomad_search_clinvar gnomAD-compatible identifiers (#29)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    initClinVarService({} as never, {} as never);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns the SPDI, rsID, and GRCh38 variant ID on both surfaces', async () => {
    fakeNcbi({ count: '2', idlist: ['2878', '7'] });

    const result = await run({ gene: 'PCSK9' });

    const [pcsk9, haplotype] = (result.structuredContent as { preview: ClinVarRow[] }).preview;
    expect(pcsk9).toMatchObject({
      canonical_spdi: 'NC_000001.11:55039973:G:T',
      rsids: 'rs11591147',
      grch38_variant_id: '1-55039974-G-T',
    });
    expect(haplotype).toMatchObject({ canonical_spdi: null, rsids: '', grch38_variant_id: null });
    const text = textOf(result);
    expect(text).toContain('**GRCh38 variant ID:** 1-55039974-G-T');
    expect(text).toContain('**rsIDs:** rs11591147');
    expect(text).toContain('**Canonical SPDI:** NC_000001.11:55039973:G:T');
    const notice = (result.structuredContent as { notice: string }).notice;
    expect(notice).toMatch(/grch38_variant_id/);
    expect(notice).toMatch(/gnomad_get_variant/);
  });

  it('adds no identifier pointer when no row carries an identifier', async () => {
    fakeNcbi({ count: '2', idlist: ['7', '4682935'] });

    const result = await run({ gene: 'NUBPL' });

    expect((result.structuredContent as { notice?: string }).notice).toBeUndefined();
  });

  it('stages the identifier columns on the canvas table', async () => {
    fakeNcbi({ count: '600', idlist: ids(7_000_000, 300) });
    const { canvas, tables } = fakeCanvas();
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(canvas as never);

    const result = await run({ gene: 'PCSK9', limit: 300 });

    expect((result.structuredContent as { spilled: boolean }).spilled).toBe(true);
    expect(tables.clinvar_variants?.[0]).toMatchObject({
      canonical_spdi: 'NC_000001.11:55039973:G:T',
      rsids: 'rs11591147',
      grch38_variant_id: '1-55039974-G-T',
    });
  });
});

describe('gnomad_search_clinvar blank clinical_significance (#31)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    initClinVarService({} as never, {} as never);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(['   ', '', '\t\n'])('treats %j as an omitted filter', async (blank) => {
    const urls = fakeNcbi({ count: '0', idlist: [] });

    const result = await run({ gene: 'TTR', clinical_significance: blank });

    expect(urls[0]?.searchParams.get('term')).toBe('"TTR"[gene]');
    const notice = (result.structuredContent as { notice: string }).notice;
    expect(notice).toBe(
      'No ClinVar records for "TTR". Broaden the filters or verify the gene symbol.',
    );
  });

  it('trims a padded significance before sending it', async () => {
    const urls = fakeNcbi({ count: '0', idlist: [] });

    const result = await run({ gene: 'TTR', clinical_significance: ' pathogenic ' });

    expect(urls[0]?.searchParams.get('term')).toBe(
      '"TTR"[gene] AND (clinsig_pathogenic[prop] OR clinsig_likely_pathogenic[prop] OR clinsig_pathogenic_low_penetrance[prop] OR clinsig_likely_pathogenic_low_penetrance[prop])',
    );
    expect((result.structuredContent as { notice: string }).notice).toContain(
      'clinical_significance=pathogenic.',
    );
  });
});

describe('gnomad_search_clinvar quoted input (#28, #40)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    initClinVarService({} as never, {} as never);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('applies a double-quoted significance to the term and the post-filter alike', async () => {
    // 4880644 is a Pathogenic record in the live fixture.
    const urls = fakeNcbi({ count: '1', idlist: ['4880644'] });

    const result = await run({ gene: 'PCSK9', clinical_significance: '"pathogenic"' });

    expect(urls[0]?.searchParams.get('term')).toBe(
      '"PCSK9"[gene] AND (clinsig_pathogenic[prop] OR clinsig_likely_pathogenic[prop] OR clinsig_pathogenic_low_penetrance[prop] OR clinsig_likely_pathogenic_low_penetrance[prop])',
    );
    const sc = result.structuredContent as { preview: ClinVarRow[]; total: number };
    expect(sc.total).toBe(1);
    expect(sc.preview[0]?.clinical_significance).toMatch(/pathogenic/i);
    expect(textOf(result)).toContain('**VariationID:** 4880644');
  });

  it('treats a significance of only quotes as no filter on both the term and the rows', async () => {
    const urls = fakeNcbi({ count: '2', idlist: ['2878', '4880644'] });

    const result = await run({ gene: 'PCSK9', clinical_significance: '""' });

    expect(urls[0]?.searchParams.get('term')).toBe('"PCSK9"[gene]');
    expect((result.structuredContent as { total: number }).total).toBe(2);
  });

  it.each([
    ['PCSK9)', '"PCSK9)"[gene]'],
    ['((', '"(("[gene]'],
    ['PCSK9 OR', '"PCSK9 OR"[gene]'],
    ['PCSK9"[gene] OR "BRCA1', '"PCSK9[gene] OR BRCA1"[gene]'],
    ['HLA-A', '"HLA-A"[gene]'],
  ])('keeps gene %j inside the [gene] field as %s', async (gene, term) => {
    const urls = fakeNcbi({ count: '0', idlist: [] });

    const result = await run({ gene, limit: 3 });

    expect(urls[0]?.searchParams.get('term')).toBe(term);
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc).toMatchObject({ total: 0, total_found: 0 });
    expect(sc.notice).toBe(
      `No ClinVar records for "${gene}". Broaden the filters or verify the gene symbol.`,
    );
    expect(textOf(result)).toContain('**Total found:** 0');
  });

  it('answers a gene of only quotes with no match and no NCBI request', async () => {
    // NCBI ignores an empty quoted phrase and falls back to all of ClinVar.
    const urls = fakeNcbi({ count: '2696146', idlist: ['2878'] });

    const result = await run({ gene: '""' });

    expect(urls).toHaveLength(0);
    expect(result.structuredContent).toMatchObject({
      preview: [],
      total: 0,
      total_found: 0,
      truncated: false,
      next_offset: null,
    });
    expect((result.structuredContent as { notice: string }).notice).toMatch(
      /verify the gene symbol/,
    );
  });
});

describe('gnomad_search_clinvar format() staged line', () => {
  it('renders the staged canvas_id and table for a spilled window', () => {
    const text = (
      gnomadSearchClinvar.format?.({
        ...NO_FILTERS,
        preview: [],
        canvas_id: 'cnvclinvar',
        table_name: 'clinvar_variants',
        spilled: true,
        total: 500,
        total_found: 1571,
        truncated: true,
        next_offset: 500,
        unavailable_ids: [],
      }) ?? []
    )
      .map((b) => ('text' in b ? b.text : ''))
      .join('');
    expect(text).toContain('**Spilled:** yes');
    expect(text).toContain('canvas_id `cnvclinvar`, table `clinvar_variants`');
    expect(text).toContain('## ClinVar — 500 record(s)');
  });
});

describe('gnomad_search_clinvar format() staged line (#21, #33)', () => {
  const render = (result: Parameters<NonNullable<typeof gnomadSearchClinvar.format>>[0]) =>
    (gnomadSearchClinvar.format?.(result) ?? []).map((b) => ('text' in b ? b.text : '')).join('');
  const base = {
    ...NO_FILTERS,
    preview: [row(1)],
    spilled: false,
    total: 1,
    total_found: 1,
    truncated: false,
    next_offset: null,
    unavailable_ids: [],
  };

  it('renders an empty canvas_id as the neutral line, never as a disabled canvas', () => {
    const text = render({ ...base, canvas_id: '', table_name: '' });
    expect(text).toContain('**Staged:** no canvas table for this call.');
    expect(text).not.toMatch(/disabled/i);
  });

  it('names describe before query on a staged table, spilled or not', () => {
    for (const spilled of [true, false]) {
      const text = render({ ...base, spilled, canvas_id: REUSED, table_name: 'clinvar_variants' });
      expect(text).toContain(
        `**Staged:** canvas_id \`${REUSED}\`, table \`clinvar_variants\` — inspect with gnomad_dataframe_describe, then query with gnomad_dataframe_query.`,
      );
    }
  });
});

/* ------------------------------------------------------------------------- */
/* Notice composition and staging across every reachable response shape.     */
/* ------------------------------------------------------------------------- */

const IDENTIFIERS =
  'To check population frequency, pass grch38_variant_id to gnomad_get_variant with a GRCh38 dataset (gnomad_r4, gnomad_r3, or one of their subsets); prefer it over rsids, since one rsID can match several gnomAD variants.';
const NEUTRAL = '**Staged:** no canvas table for this call.';
const clinvarPointer = (n: number, id: string) =>
  `Staged this window's ${n} record(s) in table "clinvar_variants" (canvas_id ${id}). Call gnomad_dataframe_describe for its columns, then gnomad_dataframe_query to run SQL over the staged window.`;
const clinvarStagedLine = (id: string) =>
  `**Staged:** canvas_id \`${id}\`, table \`clinvar_variants\` — inspect with gnomad_dataframe_describe, then query with gnomad_dataframe_query.`;

type WindowKind = 'truncated' | 'last' | 'past-end' | 'no-candidates' | 'no-candidates-filtered';
type Size = 'spill' | 'fit' | 'zero';

/** The NCBI envelope, tool input, and completeness notice for one (size × window) shape. */
const shapes: Record<
  Size,
  Partial<
    Record<
      WindowKind,
      {
        esearch: Record<string, unknown>;
        input: Record<string, unknown>;
        rows: number;
        completeness?: string;
      }
    >
  >
> = {
  spill: {
    truncated: {
      esearch: { count: '1571', idlist: ids(9_000_000, 30) },
      input: { limit: 30 },
      rows: 30,
      completeness:
        'This window covers ClinVar candidates 1–30 of 1571 for "PCSK9"; continue with offset=30 for the next window.',
    },
    last: { esearch: { count: '30', idlist: ids(9_100_000, 30) }, input: { limit: 30 }, rows: 30 },
  },
  fit: {
    truncated: {
      esearch: { count: '1571', idlist: ids(9_200_000, 3) },
      input: { limit: 3 },
      rows: 3,
      completeness:
        'This window covers ClinVar candidates 1–3 of 1571 for "PCSK9"; continue with offset=3 for the next window.',
    },
    last: { esearch: { count: '3', idlist: ids(9_300_000, 3) }, input: { limit: 3 }, rows: 3 },
  },
  zero: {
    truncated: {
      esearch: { count: '1200', idlist: ids(9_400_000, 10) },
      input: { clinical_significance: 'pathogenic', limit: 10 },
      rows: 0,
      completeness:
        'No records matching clinical_significance=pathogenic among ClinVar candidates 1–10 of 1200 for "PCSK9". Continue with offset=10.',
    },
    last: {
      esearch: { count: '3', idlist: ids(9_500_000, 3) },
      input: { clinical_significance: 'pathogenic' },
      rows: 0,
      completeness:
        'No ClinVar records for "PCSK9" matching clinical_significance=pathogenic. Broaden the filters.',
    },
    'past-end': {
      esearch: { count: '1571', idlist: [] },
      input: { offset: 5000 },
      rows: 0,
      completeness:
        'offset 5000 is past the end of the 1571 ClinVar records for "PCSK9"; use an offset below 1571.',
    },
    // No candidates at all: the no-records notice wins whatever the offset.
    'no-candidates': {
      esearch: { count: '0', idlist: [] },
      input: { offset: 500 },
      rows: 0,
      completeness:
        'No ClinVar records for "PCSK9". Broaden the filters or verify the gene symbol.',
    },
    'no-candidates-filtered': {
      esearch: { count: '0', idlist: [] },
      input: { clinical_significance: 'xyzzy', offset: 100 },
      rows: 0,
      completeness:
        'No ClinVar records for "PCSK9" matching clinical_significance=xyzzy. Broaden the filters or verify the gene symbol.',
    },
  },
};

interface ClinvarCell {
  canvas: 'disabled' | 'enabled';
  canvasId?: string;
  label: string;
  size: Size;
  window: WindowKind;
}

const clinvarMatrix: ClinvarCell[] = (['disabled', 'enabled'] as const).flatMap((canvas) =>
  (['spill', 'fit', 'zero'] as const).flatMap((size) =>
    (Object.keys(shapes[size]) as WindowKind[]).flatMap((window) =>
      [undefined, REUSED].map((canvasId) => ({
        label: `${canvas} × ${size} × ${window} window × ${canvasId ? 'canvas_id' : 'no canvas_id'}`,
        canvas,
        size,
        window,
        ...(canvasId && { canvasId }),
      })),
    ),
  ),
);

describe('gnomad_search_clinvar notice and staging matrix (#21, #33, #35)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    initClinVarService({} as never, {} as never);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('covers all 36 reachable cells', () => {
    expect(clinvarMatrix).toHaveLength(36);
  });

  it.each(clinvarMatrix.map((cell) => [cell.label, cell] as const))('%s', async (_label, cell) => {
    const shape = shapes[cell.size][cell.window];
    if (!shape) throw new Error(`unreachable cell ${cell.label}`);
    fakeNcbi(shape.esearch);
    const { canvas, dropped } = fakeCanvas();
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(
      cell.canvas === 'enabled' ? (canvas as never) : undefined,
    );

    const result = await run({
      gene: 'PCSK9',
      ...shape.input,
      ...(cell.canvasId && { canvas_id: cell.canvasId }),
    });

    expect(result.isError).toBeFalsy();
    const enabled = cell.canvas === 'enabled';
    const acquires = enabled && (cell.size === 'spill' || cell.canvasId !== undefined);
    const canvasId = acquires ? (cell.canvasId ?? MINTED) : '';
    const staged = acquires && shape.rows > 0;
    // Canvas off, the preview is every row of the window (#59).
    const previewed = (result.structuredContent as { preview: ClinVarRow[] }).preview.length;
    if (!enabled) expect(previewed).toBe(shape.rows);
    const parts = [
      shape.completeness,
      staged ? clinvarPointer(shape.rows, canvasId) : undefined,
      shape.rows > 0 ? IDENTIFIERS : undefined,
    ].filter(Boolean);

    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc).toMatchObject({
      canvas_id: canvasId,
      table_name: staged ? 'clinvar_variants' : '',
      spilled: enabled && cell.size === 'spill',
      total: shape.rows,
    });
    expect(sc.notice).toBe(parts.length ? parts.join(' ') : undefined);
    if (acquires) expect(canvas.acquire).toHaveBeenCalledWith(cell.canvasId, expect.anything());
    else expect(canvas.acquire).not.toHaveBeenCalled();
    expect(dropped).toEqual(acquires && !staged ? ['clinvar_variants'] : []);

    const text = textOf(result);
    expect(text).toContain(
      staged
        ? clinvarStagedLine(canvasId)
        : canvasId
          ? `**Staged:** no canvas table for this call (canvas_id \`${canvasId}\`).`
          : NEUTRAL,
    );
    expect(text).not.toMatch(/Canvas disabled\*\*/);
    expect(text).not.toContain('CANVAS_PROVIDER_TYPE');
    for (const part of parts) expect(text).toContain(part as string);
    // Both surfaces carry the same preview rows.
    const preview = sc.preview as ClinVarRow[];
    expect(text.match(/^\*\*Variant:\*\* /gm)?.length ?? 0).toBe(preview.length);
    for (const r of preview) expect(text).toContain(`**VariationID:** ${r.clinvar_variation_id} `);
  });
});

describe('gnomad_search_clinvar response budget (#37)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    initClinVarService({} as never, {} as never);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps a full 500-record window of the heaviest real records under 24 KB with the canvas enabled', async () => {
    // The 24 longest real ESummary records captured from BRCA1/BRCA2 (normalized
    // rows of 1,128–1,250 JSON characters, about twice the average), then
    // re-keyed copies of them — a window a row-count cap would push past 24 KB.
    fakeNcbi({ count: '16064', idlist: [...HEAVY.result.uids, ...ids(9_600_000, 476)] }, [], HEAVY);
    const { canvas, tables } = fakeCanvas();
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(canvas as never);

    const result = await run({ gene: 'BRCA1', limit: 500 });

    const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    expect(bytes).toBeLessThan(24_000);
    expect(bytes).toBeGreaterThan(15_000);
    const sc = result.structuredContent as { preview: ClinVarRow[]; total: number };
    expect(sc.total).toBe(500);
    expect(sc.preview.length).toBeLessThan(sc.total);
    for (const r of sc.preview) expect(JSON.stringify(r).length).toBeGreaterThan(1_100);
    expect(tables.clinvar_variants).toHaveLength(sc.total);
  });
});

/* ------------------------------------------------------------------------- */
/* ClinVar's no-date placeholder and blank germline values (#61).             */
/* ------------------------------------------------------------------------- */

/**
 * Every row a real record, none re-keyed: the placeholder fixture's four,
 * HEAVY's 4845640 (Likely pathogenic, placeholder date), LIVE's 2878 (a real
 * `2026/02/03 00:00` date), then HEAVY's other 23, which all carry a real
 * date and classification.
 */
const MIXED: EsummaryFixture = {
  result: {
    ...HEAVY.result,
    ...PLACEHOLDER.result,
    '2878': LIVE.result['2878'],
    uids: [
      ...PLACEHOLDER.result.uids,
      '4845640',
      '2878',
      ...HEAVY.result.uids.filter((id) => id !== '4845640'),
    ],
  },
};
/** The six records under test, a window that fits inline. */
const FIT_IDS = MIXED.result.uids.slice(0, 6);

/** The content[] block format() renders for one preview row, newline-terminated. */
function rowBlock(text: string, uid: string): string {
  const block = text
    .split('\n**Variant:** ')
    .find((b) => b.includes(`\n**VariationID:** ${uid} |`));
  if (!block) throw new Error(`no rendered row for VariationID ${uid}`);
  return `${block}\n`;
}

describe('gnomad_search_clinvar no-date placeholder and blank germline values (#61)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    initClinVarService({} as never, {} as never);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('carries null in structuredContent and renders Not available in content[]', async () => {
    fakeNcbi({ count: '6', idlist: FIT_IDS }, [], MIXED);

    const result = await run({ gene: 'BRCA1' });

    expect(result.isError).toBeFalsy();
    const { preview } = result.structuredContent as { preview: ClinVarRow[] };
    expect(
      preview.map((r) => [
        r.clinvar_variation_id,
        r.clinical_significance,
        r.review_status,
        r.gold_stars,
        r.last_evaluated,
      ]),
    ).toEqual([
      ['4852577', null, null, 0, null],
      ['4849514', null, null, 0, null],
      ['1687128', 'Pathogenic', 'no assertion criteria provided', 0, null],
      ['54221', 'not provided', 'no classification provided', 0, null],
      ['4845640', 'Likely pathogenic', 'criteria provided, single submitter', 1, null],
      [
        '2878',
        'Benign/Likely benign',
        'criteria provided, multiple submitters, no conflicts',
        2,
        '2026/02/03 00:00',
      ],
    ]);

    const text = textOf(result);
    const blank =
      '**Significance:** Not available (0★) | **Review:** Not available | **Last evaluated:** Not available';
    expect(rowBlock(text, '4852577')).toContain(`\n${blank}\n`);
    expect(rowBlock(text, '4849514')).toContain(`\n${blank}\n`);
    expect(rowBlock(text, '1687128')).toContain(
      '\n**Significance:** Pathogenic (0★) | **Review:** no assertion criteria provided | **Last evaluated:** Not available\n',
    );
    expect(rowBlock(text, '54221')).toContain(
      '\n**Significance:** not provided (0★) | **Review:** no classification provided | **Last evaluated:** Not available\n',
    );
    expect(rowBlock(text, '4845640')).toContain(
      '\n**Significance:** Likely pathogenic (1★) | **Review:** criteria provided, single submitter | **Last evaluated:** Not available\n',
    );
    expect(rowBlock(text, '2878')).toContain(
      '\n**Significance:** Benign/Likely benign (2★) | **Review:** criteria provided, multiple submitters, no conflicts | **Last evaluated:** 2026/02/03 00:00\n',
    );
    expect(text).not.toContain('1/01/01');
  });
});

describe('gnomad_search_clinvar staged nulls on a real DuckDB canvas (#61)', () => {
  let canvas: DataCanvas;
  const tenant = () => createMockContext({ tenantId: 'default' });

  beforeAll(async () => {
    const provider = new DuckdbProvider({
      defaultRowLimit: 1_000,
      exportRootPath: '/tmp/gnomad-canvas-tests',
      memoryLimitMb: 128,
      schemaSniffRows: 100,
    });
    canvas = new DataCanvas(
      provider,
      new CanvasRegistry(provider, { ...DEFAULT_CANVAS_REGISTRY_OPTIONS, sweeperIntervalMs: 0 }),
    );
    // Open one canvas so this hook, not a test's timeout, pays the native DuckDB load.
    await canvas.acquire(undefined, tenant());
  }, 60_000);
  afterAll(async () => {
    await canvas.shutdown(tenant());
  });
  beforeEach(() => {
    vi.restoreAllMocks();
    initClinVarService({} as never, {} as never);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(canvas);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { path: 'spill', ids: MIXED.result.uids, reuse: false },
    { path: 'fit with canvas_id', ids: FIT_IDS, reuse: true },
  ])('holds SQL NULL, never the placeholder or a blank string ($path)', async ({ ids, reuse }) => {
    const canvasId = reuse ? (await canvas.acquire(undefined, tenant())).canvasId : undefined;
    fakeNcbi({ count: String(ids.length), idlist: ids }, [], MIXED);

    // Real timers: staging runs on native DuckDB, and the one NCBI pacing gap is ~0.3 s.
    const result = await runToolContract(
      gnomadSearchClinvar,
      { gene: 'BRCA1', ...(canvasId && { canvas_id: canvasId }) },
      { context: { tenantId: 'default' } },
    );

    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc).toMatchObject({
      table_name: 'clinvar_variants',
      spilled: !reuse,
      total: ids.length,
    });
    const staged = await canvas.acquire(sc.canvas_id as string, tenant());
    const counts = await staged.query(
      "SELECT count(*) AS n, count(*) FILTER (WHERE last_evaluated IS NULL) AS no_date, count(*) FILTER (WHERE clinical_significance IS NULL) AS no_significance, count(*) FILTER (WHERE review_status IS NULL) AS no_review, count(*) FILTER (WHERE last_evaluated = '1/01/01 00:00' OR clinical_significance = '' OR review_status = '') AS placeholders FROM clinvar_variants",
    );
    // No date: the four placeholder-fixture records and 4845640. No germline
    // classification: 4852577 and 4849514.
    expect(
      Object.fromEntries(Object.entries(counts.rows[0] ?? {}).map(([k, v]) => [k, Number(v)])),
    ).toEqual({ n: ids.length, no_date: 5, no_significance: 2, no_review: 2, placeholders: 0 });
    const picked = await staged.query(
      "SELECT clinvar_variation_id, clinical_significance, review_status, last_evaluated FROM clinvar_variants WHERE clinvar_variation_id IN ('4852577', '54221', '2878') ORDER BY clinvar_variation_id",
    );
    expect(picked.rows).toEqual([
      {
        clinvar_variation_id: '2878',
        clinical_significance: 'Benign/Likely benign',
        review_status: 'criteria provided, multiple submitters, no conflicts',
        last_evaluated: '2026/02/03 00:00',
      },
      {
        clinvar_variation_id: '4852577',
        clinical_significance: null,
        review_status: null,
        last_evaluated: null,
      },
      {
        clinvar_variation_id: '54221',
        clinical_significance: 'not provided',
        review_status: 'no classification provided',
        last_evaluated: null,
      },
    ]);

    // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/76
    // Only 4849514 carries an oncogenicity and only 4852577 a clinical-impact
    // classification; every other record's somatic blocks are blank.
    const somatic = await staged.query(
      "SELECT count(*) FILTER (WHERE oncogenicity_classification IS NULL AND oncogenicity_review_status IS NULL AND oncogenicity_last_evaluated IS NULL) AS no_oncogenicity, count(*) FILTER (WHERE clinical_impact_classification IS NULL AND clinical_impact_review_status IS NULL AND clinical_impact_last_evaluated IS NULL) AS no_impact, count(*) FILTER (WHERE oncogenicity_last_evaluated = '1/01/01 00:00' OR clinical_impact_last_evaluated = '1/01/01 00:00' OR oncogenicity_classification = '' OR clinical_impact_classification = '' OR oncogenicity_review_status = '' OR clinical_impact_review_status = '' OR oncogenicity_last_evaluated = '' OR clinical_impact_last_evaluated = '') AS placeholders FROM clinvar_variants",
    );
    expect(
      Object.fromEntries(Object.entries(somatic.rows[0] ?? {}).map(([k, v]) => [k, Number(v)])),
    ).toEqual({ no_oncogenicity: ids.length - 1, no_impact: ids.length - 1, placeholders: 0 });
    const somaticPicked = await staged.query(
      "SELECT clinvar_variation_id, oncogenicity_classification, oncogenicity_review_status, oncogenicity_last_evaluated, oncogenicity_conditions, clinical_impact_classification, clinical_impact_review_status, clinical_impact_last_evaluated, clinical_impact_conditions FROM clinvar_variants WHERE clinvar_variation_id IN ('4849514', '4852577') ORDER BY clinvar_variation_id",
    );
    expect(somaticPicked.rows).toEqual([
      {
        clinvar_variation_id: '4849514',
        oncogenicity_classification: 'Likely oncogenic',
        oncogenicity_review_status: 'no assertion criteria provided',
        oncogenicity_last_evaluated: null,
        oncogenicity_conditions: 'Ovarian cancer',
        clinical_impact_classification: null,
        clinical_impact_review_status: null,
        clinical_impact_last_evaluated: null,
        clinical_impact_conditions: '',
      },
      {
        clinvar_variation_id: '4852577',
        oncogenicity_classification: null,
        oncogenicity_review_status: null,
        oncogenicity_last_evaluated: null,
        oncogenicity_conditions: '',
        clinical_impact_classification: 'Tier III - Unknown',
        clinical_impact_review_status: 'no assertion criteria provided',
        clinical_impact_last_evaluated: null,
        clinical_impact_conditions: 'Familial cancer of breast',
      },
    ]);
  });
});

/* ------------------------------------------------------------------------- */
/* ClinVar's oncogenicity and clinical-impact classifications (#76).          */
/* ------------------------------------------------------------------------- */

/**
 * 4849514 (oncogenicity only), 4852577 (clinical impact only), KRAS 3116215
 * (germline beside clinical impact), TP53 4880485 (germline beside
 * oncogenicity), and 2878 (germline only) — every record real.
 */
const SOMATIC_MIX: EsummaryFixture = {
  result: {
    ...PLACEHOLDER.result,
    ...SOMATIC.result,
    '2878': LIVE.result['2878'],
    uids: ['4849514', '4852577', '3116215', '4880485', '2878'],
  },
};

const SOMATIC_FIELDS = [
  'oncogenicity_classification',
  'oncogenicity_review_status',
  'oncogenicity_last_evaluated',
  'oncogenicity_conditions',
  'clinical_impact_classification',
  'clinical_impact_review_status',
  'clinical_impact_last_evaluated',
  'clinical_impact_conditions',
] as const;

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/76
describe('gnomad_search_clinvar oncogenicity and clinical-impact classifications (#76)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    initClinVarService({} as never, {} as never);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('carries every somatic field in structuredContent beside the germline ones', async () => {
    fakeNcbi({ count: '5', idlist: SOMATIC_MIX.result.uids }, [], SOMATIC_MIX);

    const result = await run({ gene: 'BRCA1' });

    expect(result.isError).toBeFalsy();
    const { preview } = result.structuredContent as { preview: ClinVarRow[] };
    expect(
      preview.map((r) => [
        r.clinvar_variation_id,
        r.clinical_significance,
        ...SOMATIC_FIELDS.map((field) => r[field]),
      ]),
    ).toEqual([
      [
        '4849514',
        null,
        'Likely oncogenic',
        'no assertion criteria provided',
        null,
        'Ovarian cancer',
        null,
        null,
        null,
        '',
      ],
      [
        '4852577',
        null,
        null,
        null,
        null,
        '',
        'Tier III - Unknown',
        'no assertion criteria provided',
        null,
        'Familial cancer of breast',
      ],
      [
        '3116215',
        'Conflicting classifications of pathogenicity',
        null,
        null,
        null,
        '',
        'Tier I - Strong',
        'criteria provided, single submitter',
        '2024/10/24 00:00',
        'Papillary thyroid carcinoma; Low grade glioma; Pilocytic astrocytoma',
      ],
      [
        '4880485',
        'Likely pathogenic',
        'Likely oncogenic',
        'criteria provided, single submitter',
        '2026/10/16 00:00',
        'Neoplasm',
        null,
        null,
        null,
        '',
      ],
      ['2878', 'Benign/Likely benign', null, null, null, '', null, null, null, ''],
    ]);
  });

  it('renders a line for each classification a row carries, and none for a germline-only row', async () => {
    fakeNcbi({ count: '5', idlist: SOMATIC_MIX.result.uids }, [], SOMATIC_MIX);

    const result = await run({ gene: 'BRCA1' });

    const text = textOf(result);
    const oncogenicity = rowBlock(text, '4849514');
    expect(oncogenicity).toContain(
      '\n**Oncogenicity:** Likely oncogenic | **Review:** no assertion criteria provided | **Last evaluated:** Not available | **Conditions:** Ovarian cancer\n',
    );
    expect(oncogenicity).not.toContain('**Clinical impact:**');
    const impact = rowBlock(text, '4852577');
    expect(impact).toContain(
      '\n**Clinical impact:** Tier III - Unknown | **Review:** no assertion criteria provided | **Last evaluated:** Not available | **Conditions:** Familial cancer of breast\n',
    );
    expect(impact).not.toContain('**Oncogenicity:**');
    const both = rowBlock(text, '3116215');
    expect(both).toContain(
      '\n**Significance:** Conflicting classifications of pathogenicity (1★) | **Review:** criteria provided, conflicting classifications | **Last evaluated:** 2025/11/11 00:00\n',
    );
    expect(both).toContain(
      '\n**Clinical impact:** Tier I - Strong | **Review:** criteria provided, single submitter | **Last evaluated:** 2024/10/24 00:00 | **Conditions:** Papillary thyroid carcinoma; Low grade glioma; Pilocytic astrocytoma\n',
    );
    expect(rowBlock(text, '4880485')).toContain(
      '\n**Oncogenicity:** Likely oncogenic | **Review:** criteria provided, single submitter | **Last evaluated:** 2026/10/16 00:00 | **Conditions:** Neoplasm\n',
    );
    const germline = rowBlock(text, '2878');
    expect(germline).not.toContain('**Oncogenicity:**');
    expect(germline).not.toContain('**Clinical impact:**');
    expect(text).not.toContain('1/01/01');
  });
});

describe('gnomad_search_clinvar format() somatic lines (#76)', () => {
  const render = (preview: ClinVarRow[]) =>
    (
      gnomadSearchClinvar.format?.({
        ...NO_FILTERS,
        preview,
        canvas_id: '',
        table_name: '',
        spilled: false,
        total: preview.length,
        total_found: preview.length,
        truncated: false,
        next_offset: null,
        unavailable_ids: [],
      }) ?? []
    )
      .map((b) => ('text' in b ? b.text : ''))
      .join('');

  it('renders a somatic line whenever any of its fields is set, so content[] drops no value', () => {
    const text = render([
      { ...row(1), clinical_impact_review_status: 'criteria provided, single submitter' },
      { ...row(2), oncogenicity_conditions: 'Glioma' },
    ]);
    expect(rowBlock(text, '100001')).toContain(
      '\n**Clinical impact:** Not available | **Review:** criteria provided, single submitter | **Last evaluated:** Not available | **Conditions:** Not available\n',
    );
    expect(rowBlock(text, '100002')).toContain(
      '\n**Oncogenicity:** Not available | **Review:** Not available | **Last evaluated:** Not available | **Conditions:** Glioma\n',
    );
  });

  it('escapes Markdown in somatic values', () => {
    const text = render([
      {
        ...row(1),
        oncogenicity_classification: 'Likely *oncogenic*',
        oncogenicity_conditions: '[x]',
      },
    ]);
    expect(text).toContain('**Oncogenicity:** Likely \\*oncogenic\\* | ');
    expect(text).toContain('**Conditions:** \\[x\\]');
  });
});

/* ------------------------------------------------------------------------- */
/* grch38_variant_id filled from gnomAD's ClinVar mapping (#66).              */
/* ------------------------------------------------------------------------- */

/**
 * Real BRCA1 records, every one a single allele with no SPDI-derived ID except
 * 2878 (PCSK9, derived 1-55039974-G-T): 4713084, 1687128 (deletion), and 54221
 * (insertion), which gnomAD's mapping holds; 4852577 (duplication), which it
 * lacks; and 4682935 (copy-number loss), which ClinVar's VCF cannot express.
 */
const FILL: EsummaryFixture = {
  result: {
    ...PLACEHOLDER.result,
    ...INDEL.result,
    '2878': LIVE.result['2878'],
    '4682935': LIVE.result['4682935'],
    uids: ['4713084', '1687128', '54221', '4852577', '4682935', '2878'],
  },
};

/** VariationID → grch38_variant_id for each preview row. */
const idsOf = (result: CallToolResult) =>
  Object.fromEntries(
    (result.structuredContent as { preview: ClinVarRow[] }).preview.map((r) => [
      r.clinvar_variation_id,
      r.grch38_variant_id,
    ]),
  );

const UNAVAILABLE = (n: number) =>
  `gnomAD's ClinVar mapping for "BRCA1" failed or ran out of time, so ${n} row(s) without an SPDI-derived grch38_variant_id keep it null. A later call can fill them once gnomAD answers; when the call's time budget ran out, a smaller limit leaves the mapping more of that budget.`;

/** A request that stays pending until its signal aborts, as a stalled upstream does. */
const hang = (init: RequestInit | undefined) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  });

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/66
describe("gnomad_search_clinvar fills grch38_variant_id from gnomAD's ClinVar mapping (#66)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    initClinVarService({} as never, {} as never);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fills each null ID the mapping holds by VariationID, on both surfaces', async () => {
    const { genes } = fakeUpstreams({ count: '6', idlist: FILL.result.uids }, { source: FILL });

    const result = await run({ gene: 'BRCA1' });

    expect(result.isError).toBeFalsy();
    expect(genes).toEqual(['BRCA1']);
    expect(idsOf(result)).toEqual({
      '4713084': '17-43092191-CAT-C',
      '1687128': '17-43074377-CCCAGA-C',
      '54221': '17-43094167-T-TTC',
      '4852577': null,
      '4682935': null,
      '2878': '1-55039974-G-T',
    });
    const text = textOf(result);
    expect(rowBlock(text, '4713084')).toContain(
      '\n**GRCh38 variant ID:** 17-43092191-CAT-C | **rsIDs:** none | ',
    );
    expect(rowBlock(text, '4852577')).toContain('\n**GRCh38 variant ID:** Not available | ');
    expect((result.structuredContent as { notice: string }).notice).toBe(IDENTIFIERS);
  });

  it('never overwrites a derived ID, even when the mapping holds another for its VariationID', async () => {
    fakeUpstreams(
      { count: '2', idlist: ['2878', '4713084'] },
      {
        source: FILL,
        gnomad: () =>
          Response.json({
            data: {
              gene: {
                clinvar_variants: [
                  ...(GNOMAD_MAPPING.BRCA1 ?? []),
                  { clinvar_variation_id: '2878', variant_id: '1-55039974-G-A' },
                ],
              },
            },
          }),
      },
    );

    const result = await run({ gene: 'BRCA1' });

    expect(idsOf(result)).toEqual({ '2878': '1-55039974-G-T', '4713084': '17-43092191-CAT-C' });
  });

  it('points at grch38_variant_id when the window’s only IDs are filled ones', async () => {
    // Neither record carries an rsID, so before the fill the window had no identifier at all.
    fakeUpstreams({ count: '2', idlist: ['4713084', '4852577'] }, { source: FILL });

    const result = await run({ gene: 'BRCA1' });

    expect(idsOf(result)).toEqual({ '4713084': '17-43092191-CAT-C', '4852577': null });
    expect((result.structuredContent as { notice: string }).notice).toBe(IDENTIFIERS);
    expect(textOf(result)).toContain(IDENTIFIERS);
  });

  it('asks gnomAD for the symbol NCBI searched', async () => {
    const { genes } = fakeUpstreams({ count: '1', idlist: ['4713084'] }, { source: FILL });

    const result = await run({ gene: ' "BRCA1" ' });

    expect(genes).toEqual(['BRCA1']);
    expect(idsOf(result)).toEqual({ '4713084': '17-43092191-CAT-C' });
  });

  it.each([
    ['a window with no null ID', { gene: 'PCSK9' }, { count: '1', idlist: ['2878'] }],
    ['an empty window', { gene: 'BRCA1' }, { count: '0', idlist: [] }],
    ['an Ensembl gene ID', { gene: 'ENSG00000012048' }, { count: '1', idlist: ['4713084'] }],
  ])('sends no gnomAD request for %s', async (_label, input, esearch) => {
    const { genes } = fakeUpstreams(esearch, { source: FILL });

    const result = await run(input);

    expect(result.isError).toBeFalsy();
    expect(genes).toEqual([]);
  });

  it.each<[string, GnomadRoute, string]>([
    [
      'an HTTP 503 through every retry',
      () => new Response('Service Unavailable', { status: 503 }),
      UNAVAILABLE(2),
    ],
    [
      'a GraphQL error',
      () => Response.json({ errors: [{ message: 'Unknown field' }], data: null }),
      UNAVAILABLE(2),
    ],
    [
      'Gene not found',
      () => Response.json({ errors: [{ message: 'Gene not found' }], data: { gene: null } }),
      'gnomAD has no GRCh38 gene "BRCA1" to map ClinVar records from, so 2 row(s) without an SPDI-derived grch38_variant_id keep it null.',
    ],
  ])(
    'returns the rows with their nulls and a notice when gnomAD answers %s',
    async (_label, gnomad, mapping) => {
      fakeUpstreams(
        { count: '3', idlist: ['4713084', '1687128', '2878'] },
        { source: FILL, gnomad },
      );

      const result = await run({ gene: 'BRCA1' });

      expect(result.isError).toBeFalsy();
      expect(idsOf(result)).toEqual({
        '4713084': null,
        '1687128': null,
        '2878': '1-55039974-G-T',
      });
      const notice = (result.structuredContent as { notice: string }).notice;
      expect(notice).toBe(`${mapping} ${IDENTIFIERS}`);
      expect(textOf(result)).toContain(mapping);
    },
  );

  it('places the mapping notice after the staged table and before the identifier pointer', async () => {
    fakeUpstreams(
      { count: '3', idlist: ['4713084', '1687128', '2878'] },
      { source: FILL, gnomad: () => new Response('Service Unavailable', { status: 503 }) },
    );
    const { canvas } = fakeCanvas();
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(canvas as never);

    const result = await run({ gene: 'BRCA1', limit: 5000, canvas_id: REUSED });

    expect((result.structuredContent as { notice: string }).notice).toBe(
      [
        'Requested limit 5000 was clamped to the cap of 1500.',
        clinvarPointer(3, REUSED),
        UNAVAILABLE(2),
        IDENTIFIERS,
      ].join(' '),
    );
  });

  it('starts no gnomAD request once NCBI has spent the call budget the handler started', async () => {
    const { genes } = fakeUpstreams({ count: '2', idlist: ['4713084', '2878'] }, { source: FILL });
    const ncbi = vi.mocked(globalThis.fetch).getMockImplementation();
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      // The summary answers only once the whole 45 s budget has passed.
      if (fetchUrl(input).pathname.endsWith('/esummary.fcgi')) {
        vi.setSystemTime(Date.now() + UPSTREAM_CALL_BUDGET_MS);
      }
      return (ncbi as typeof fetch)(input, init);
    });

    const result = await run({ gene: 'BRCA1' });

    expect(result.isError).toBeFalsy();
    expect(genes).toEqual([]);
    expect(idsOf(result)).toEqual({ '4713084': null, '2878': '1-55039974-G-T' });
    expect((result.structuredContent as { notice: string }).notice).toBe(
      `${UNAVAILABLE(1)} ${IDENTIFIERS}`,
    );
  });

  it('stages the filled IDs in the clinvar_variants table', async () => {
    fakeUpstreams({ count: '6', idlist: FILL.result.uids }, { source: FILL });
    const { canvas, tables } = fakeCanvas();
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(canvas as never);

    const result = await run({ gene: 'BRCA1', canvas_id: REUSED });

    expect((result.structuredContent as { table_name: string }).table_name).toBe(
      'clinvar_variants',
    );
    expect(
      Object.fromEntries(
        (tables.clinvar_variants ?? []).map((r) => [r.clinvar_variation_id, r.grch38_variant_id]),
      ),
    ).toEqual(idsOf(result));
    expect(tables.clinvar_variants?.[0]).toMatchObject({ grch38_variant_id: '17-43092191-CAT-C' });
  });

  it('rejects a call cancelled during the gnomAD request instead of degrading it', async () => {
    const controller = new AbortController();
    const { genes } = fakeUpstreams(
      { count: '2', idlist: ['4713084', '2878'] },
      {
        source: FILL,
        gnomad: (_gene, init) => {
          queueMicrotask(() => controller.abort(new Error('client cancelled')));
          return hang(init);
        },
      },
    );
    vi.useFakeTimers();
    const ctx = createMockContext({
      errors: gnomadSearchClinvar.errors,
      signal: controller.signal,
    });
    const input = gnomadSearchClinvar.input.parse({ gene: 'BRCA1' });

    const outcome = Promise.resolve()
      .then(() => gnomadSearchClinvar.handler(input, ctx as never))
      .catch((err: unknown) => err);
    for (let i = 0; i < 20; i += 1) await vi.advanceTimersByTimeAsync(1000);

    expect(await outcome).toBeInstanceOf(Error);
    expect(await outcome).toMatchObject({ message: 'client cancelled' });
    expect(genes).toEqual(['BRCA1']);
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });
});
