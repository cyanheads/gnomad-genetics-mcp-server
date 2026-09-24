/**
 * @fileoverview Behavior tests for the gnomad_search_clinvar handler — the
 * second upstream service (NCBI E-utilities). The first blocks stub the ClinVar
 * service and cover canvas-disabled (a preview of the rows within the
 * 11,000-character budget, empty canvas_id, no-match + cap notices),
 * canvas-enabled staging (no canvas for a fit without canvas_id, a spill past
 * the budget, a supplied canvas_id that replaces or drops the table), the
 * Ensembl-ID short-circuit that touches no canvas, and format() rendering. The
 * contract-surface blocks run the real service behind a fake fetch through
 * runToolContract, covering result windows and their notices, the
 * upstream_unavailable contract, gnomAD-compatible identifiers, blank and
 * quoted significance filters, the quoted gene term, the notice/staging matrix
 * across every reachable response shape, and the ~24 KB response budget on the
 * heaviest real records.
 * @module tests/tools/gnomad-search-clinvar.test
 */

import { readFileSync } from 'node:fs';
import { JsonRpcErrorCode, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gnomadSearchClinvar } from '@/mcp-server/tools/definitions/gnomad-search-clinvar.tool.js';
import * as canvasAccessor from '@/services/canvas-accessor.js';
import * as clinvarModule from '@/services/clinvar/clinvar-service.js';
import { initClinVarService } from '@/services/clinvar/clinvar-service.js';
import type { ClinVarRow, ClinVarSearchResult } from '@/services/clinvar/types.js';

type CallToolResult = Awaited<ReturnType<typeof runToolContract>>;

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
    canonical_spdi: null,
    rsids: '',
    grch38_variant_id: null,
  };
}

/** Stub the ClinVar service so searchGene yields a fixed row set as one complete window. */
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
    stubClinvar(async () => Array.from({ length: 20 }, (_, i) => sized(i + 1, 550)));
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const ctx = createMockContext({ errors: gnomadSearchClinvar.errors });
    const input = gnomadSearchClinvar.input.parse({ gene: 'BRCA1' });
    const result = await gnomadSearchClinvar.handler(input, ctx as never);

    expect(result.total).toBe(20);
    expect(result.preview).toHaveLength(20);
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('previews the longest prefix within the budget and notices the truncation (#37)', async () => {
    const rows = [...Array.from({ length: 19 }, (_, i) => sized(i + 1, 550)), sized(20, 551)];
    stubClinvar(async () => rows);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const ctx = createMockContext({ errors: gnomadSearchClinvar.errors });
    const input = gnomadSearchClinvar.input.parse({ gene: 'BRCA1' });
    const result = await gnomadSearchClinvar.handler(input, ctx as never);

    expect(result.total).toBe(20);
    expect(result.preview).toEqual(rows.slice(0, 19));
    expect(getEnrichment(ctx).notice).toMatch(/showing 19 of 20 records/);
  });

  it('previews fewer heavy rows than light ones under the same budget (#37)', async () => {
    stubClinvar(async () => Array.from({ length: 18 }, (_, i) => sized(i + 1, 1_100)));
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const ctx = createMockContext({ errors: gnomadSearchClinvar.errors });
    const input = gnomadSearchClinvar.input.parse({ gene: 'BRCA1' });
    const result = await gnomadSearchClinvar.handler(input, ctx as never);

    expect(result.preview).toHaveLength(10);
    expect(getEnrichment(ctx).notice).toMatch(/showing 10 of 18 records/);
  });

  it('previews the same rows with the canvas disabled as the canvas-on spill does (#37)', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => row(i + 1));
    stubClinvar(async () => rows);
    const input = gnomadSearchClinvar.input.parse({ gene: 'BRCA1' });

    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);
    const off = await gnomadSearchClinvar.handler(
      input,
      createMockContext({ errors: gnomadSearchClinvar.errors }) as never,
    );
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(fakeCanvas().canvas as never);
    const on = await gnomadSearchClinvar.handler(
      input,
      createMockContext({ errors: gnomadSearchClinvar.errors }) as never,
    );

    expect(on.spilled).toBe(true);
    expect(off.preview).toEqual(on.preview);
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
    stubClinvar(async () => Array.from({ length: 20 }, (_, i) => sized(i + 1, 550)));
    const { canvas } = fakeCanvas();
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(canvas as never);

    const ctx = createMockContext({ errors: gnomadSearchClinvar.errors });
    const input = gnomadSearchClinvar.input.parse({ gene: 'LDLR' });
    const result = await gnomadSearchClinvar.handler(input, ctx as never);

    expect(result).toMatchObject({ spilled: false, canvas_id: '', total: 20 });
    expect(result.preview).toHaveLength(20);
    expect(canvas.acquire).not.toHaveBeenCalled();
  });

  it('spills one character past 11,000 and previews the rows under the budget (#37 boundary)', async () => {
    const rows = [...Array.from({ length: 19 }, (_, i) => sized(i + 1, 550)), sized(20, 551)];
    stubClinvar(async () => rows);
    const { canvas, tables } = fakeCanvas();
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(canvas as never);

    const ctx = createMockContext({ errors: gnomadSearchClinvar.errors });
    const input = gnomadSearchClinvar.input.parse({ gene: 'LDLR' });
    const result = await gnomadSearchClinvar.handler(input, ctx as never);

    expect(result).toMatchObject({ spilled: true, table_name: 'clinvar_variants', total: 20 });
    expect(result.preview).toHaveLength(19);
    expect(tables.clinvar_variants).toHaveLength(20);
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

describe('gnomad_search_clinvar format()', () => {
  const base = {
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
 * Route ESearch to a canned envelope and ESummary to a live fixture (LIVE by
 * default). Any other request rejects, so nothing reaches live NCBI.
 */
function fakeNcbi(
  esearch: Record<string, unknown>,
  missing: string[] = [],
  source: EsummaryFixture = LIVE,
) {
  const urls: URL[] = [];
  const absent = new Set(missing);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = fetchUrl(input);
    urls.push(url);
    if (url.pathname.endsWith('/esearch.fcgi')) {
      return new Response(JSON.stringify({ esearchresult: esearch }));
    }
    if (url.pathname.endsWith('/esummary.fcgi')) {
      return summaryFor((url.searchParams.get('id') ?? '').split(','), absent, source);
    }
    throw new Error('unmocked fetch');
  });
  return urls;
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

  it('reports the ESearch count and the next offset on the first default window', async () => {
    const urls = fakeNcbi({ count: '1571', idlist: ids(1_000_000, 500) });

    const result = await run({ gene: 'PCSK9' });

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

    const result = await run({ gene: 'PCSK9', offset: 1500 });

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

    const result = await run({ gene: 'PCSK9', clinical_significance: 'pathogenic', offset: 1500 });

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

  it.each([{ offset: -1 }, { limit: 0 }, { limit: 501 }, { offset: 1.5 }])(
    'rejects out-of-range window input %j with InvalidParams',
    async (window) => {
      const fetch = vi.spyOn(globalThis, 'fetch');
      const result = await runToolContract(gnomadSearchClinvar, { gene: 'PCSK9', ...window });

      expect(result.isError).toBe(true);
      expect((result.structuredContent as { error: { code: number } }).error.code).toBe(
        JsonRpcErrorCode.InvalidParams,
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    { offset: 0, limit: 1 },
    { offset: 0, limit: 500 },
  ])('accepts the window boundaries %j', async (window) => {
    const urls = fakeNcbi({ count: '0', idlist: [] });

    const result = await run({ gene: 'PCSK9', ...window });

    expect(result.isError).toBeFalsy();
    expect(urls[0]?.searchParams.get('retmax')).toBe(String(window.limit));
  });

  it('sends the significance phrase and review-status floor in the ESearch term', async () => {
    const urls = fakeNcbi({ count: '0', idlist: [] });

    await run({ gene: 'BRCA1', clinical_significance: 'pathogenic', min_review_stars: 3 });

    expect(urls[0]?.searchParams.get('term')).toBe(
      '"BRCA1"[gene] AND "pathogenic"[clinical_significance] AND ("practice guideline"[Review status] OR "reviewed by expert panel"[Review status])',
    );
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
      '"TTR"[gene] AND "pathogenic"[clinical_significance]',
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
      '"PCSK9"[gene] AND "pathogenic"[clinical_significance]',
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
  'To check population frequency, pass grch38_variant_id to gnomad_get_variant with a GRCh38 dataset (gnomad_r4 or gnomad_r3); prefer it over rsids, since one rsID can match several gnomAD variants.';
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
    // Canvas off, the preview is the prefix within the same budget a canvas-on spill uses.
    const capped = !enabled && cell.size === 'spill';
    const previewed = (result.structuredContent as { preview: ClinVarRow[] }).preview.length;
    if (capped) expect(previewed).toBeLessThan(shape.rows);
    const parts = [
      shape.completeness,
      capped
        ? `Canvas is disabled (set CANVAS_PROVIDER_TYPE=duckdb) — showing ${previewed} of ${shape.rows} records in this window. Enable the canvas to query every row with gnomad_dataframe_query.`
        : undefined,
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
    for (const part of parts) expect(text).toContain(part as string);
    // Both surfaces carry the same preview rows.
    const preview = sc.preview as ClinVarRow[];
    expect(text.match(/^### /gm)?.length ?? 0).toBe(preview.length);
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

  it.each(['enabled', 'disabled'] as const)(
    'keeps a full 500-record window of the heaviest real records under 24 KB with the canvas %s',
    async (mode) => {
      // The 24 longest real ESummary records captured from BRCA1/BRCA2 (normalized
      // rows of 1,128–1,250 JSON characters, about twice the average), then
      // re-keyed copies of them — a window a row-count cap would push past 24 KB.
      fakeNcbi(
        { count: '16064', idlist: [...HEAVY.result.uids, ...ids(9_600_000, 476)] },
        [],
        HEAVY,
      );
      const { canvas, tables } = fakeCanvas();
      vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(
        mode === 'enabled' ? (canvas as never) : undefined,
      );

      const result = await run({ gene: 'BRCA1' });

      const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
      expect(bytes).toBeLessThan(24_000);
      expect(bytes).toBeGreaterThan(15_000);
      const sc = result.structuredContent as { preview: ClinVarRow[]; total: number };
      expect(sc.total).toBe(500);
      expect(sc.preview.length).toBeLessThan(sc.total);
      for (const r of sc.preview) expect(JSON.stringify(r).length).toBeGreaterThan(1_100);
      if (mode === 'enabled') expect(tables.clinvar_variants).toHaveLength(sc.total);
    },
  );
});
