/**
 * @fileoverview Canvas staging on a real in-memory DuckDB DataCanvas for the two
 * row-returning tools. A call whose rows fit inline without a canvas_id mints no
 * canvas, so repeated small lookups never exhaust the tenant cap; a supplied
 * canvas_id always leaves the named table holding exactly that call's rows —
 * replaced on a spill, replaced on a fit, removed on zero rows — while an
 * Ensembl-ID ClinVar call touches no canvas. Staged columns carry the declared
 * row-type schema on both the spill and the fit-with-canvas_id path, whatever
 * the preview rows hold. Upstream services (or NCBI's fetch boundary) are
 * stubbed; staging, spillover, and the dataframe tools run for real.
 * @module tests/integration/canvas-staging.integration.test
 */

import { readFileSync } from 'node:fs';
import {
  CanvasRegistry,
  DataCanvas,
  DEFAULT_CANVAS_REGISTRY_OPTIONS,
  DuckdbProvider,
} from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { gnomadDataframeDescribe } from '@/mcp-server/tools/definitions/gnomad-dataframe-describe.tool.js';
import { gnomadDataframeQuery } from '@/mcp-server/tools/definitions/gnomad-dataframe-query.tool.js';
import { gnomadListGeneVariants } from '@/mcp-server/tools/definitions/gnomad-list-gene-variants.tool.js';
import { gnomadSearchClinvar } from '@/mcp-server/tools/definitions/gnomad-search-clinvar.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import * as clinvarModule from '@/services/clinvar/clinvar-service.js';
import type { ClinVarRow } from '@/services/clinvar/types.js';
import * as gnomadModule from '@/services/gnomad/gnomad-service.js';
import { GnomadService } from '@/services/gnomad/gnomad-service.js';
import type { GeneVariantRow } from '@/services/gnomad/types.js';

type CallToolResult = Awaited<ReturnType<typeof runToolContract>>;

const LIVE_VARIANTS = JSON.parse(
  readFileSync(new URL('../fixtures/pcsk9-gene-variants.live.json', import.meta.url), 'utf8'),
) as GeneVariantRow[];

const realService = new GnomadService(getServerConfig());

let canvas: DataCanvas;

beforeEach(() => {
  const provider = new DuckdbProvider({
    defaultRowLimit: 1_000,
    exportRootPath: '/tmp/gnomad-canvas-tests',
    memoryLimitMb: 128,
    schemaSniffRows: 100,
  });
  const registry = new CanvasRegistry(provider, {
    ...DEFAULT_CANVAS_REGISTRY_OPTIONS,
    maxCanvasesPerTenant: 2,
    sweeperIntervalMs: 0,
  });
  canvas = new DataCanvas(provider, registry);
  setCanvas(canvas);
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  setCanvas(undefined);
  await canvas.shutdown(createMockContext({ tenantId: 'default' }));
});

/** Serve a fixed variant list from the gnomAD service, with the real build derivation. */
function serveVariants(rows: GeneVariantRow[]) {
  vi.spyOn(gnomadModule, 'getGnomadService').mockReturnValue({
    resolveDatasetContext: realService.resolveDatasetContext.bind(realService),
    listGeneVariants: async () => rows,
  } as never);
}

function clinvarRow(i: number): ClinVarRow {
  return {
    clinvar_variation_id: String(200000 + i),
    accession: `VCV000${200000 + i}`,
    title: `NM_174936.4(PCSK9):c.${i}G>T (p.Arg${i}Leu)`,
    obj_type: 'single nucleotide variant',
    clinical_significance: 'Likely pathogenic',
    review_status: 'criteria provided, multiple submitters, no conflicts',
    gold_stars: 2,
    last_evaluated: '2024-05-01',
    molecular_consequences: 'missense variant',
    protein_change: `R${i}L`,
    conditions: 'Hypercholesterolemia, autosomal dominant, 3',
    submission_count: 3,
    canonical_spdi: `NC_000001.11:${55039000 + i}:G:T`,
    rsids: `rs${9000 + i}`,
    grch38_variant_id: `1-${55039001 + i}-G-T`,
  };
}

/** Serve one complete ClinVar window. */
function serveClinvar(rows: ClinVarRow[]) {
  vi.spyOn(clinvarModule, 'getClinVarService').mockReturnValue({
    searchGene: async () => ({
      rows,
      totalFound: rows.length,
      truncated: false,
      nextOffset: null,
      unavailableIds: [],
    }),
  } as never);
}

const call = <T extends typeof gnomadListGeneVariants | typeof gnomadSearchClinvar>(
  definition: T,
  input: Record<string, unknown>,
) => runToolContract(definition, input as never, { context: { tenantId: 'default' } });

const sc = (result: CallToolResult) => result.structuredContent as Record<string, unknown>;

async function stagedCount(canvasId: string, table: string): Promise<number> {
  const queried = await gnomadDataframeQuery.handler(
    gnomadDataframeQuery.input.parse({
      canvas_id: canvasId,
      sql: `SELECT count(*) AS n FROM ${table}`,
    }),
    createMockContext({ tenantId: 'default', errors: gnomadDataframeQuery.errors }),
  );
  return Number(queried.rows[0]?.n);
}

async function stagedTables(canvasId: string): Promise<string[]> {
  const described = await gnomadDataframeDescribe.handler(
    gnomadDataframeDescribe.input.parse({ canvas_id: canvasId }),
    createMockContext({ tenantId: 'default', errors: gnomadDataframeDescribe.errors }),
  );
  return described.tables.map((t) => t.name);
}

describe('canvas staging against a real DuckDB canvas', () => {
  it('never mints a canvas for fit-inline calls, so a cap of 2 is never exhausted (#35)', async () => {
    serveVariants(LIVE_VARIANTS.slice(0, 12));
    for (let i = 0; i < 5; i += 1) {
      const result = await call(gnomadListGeneVariants, { region: '1-55039974-55039980' });
      expect(result.isError).toBeFalsy();
      expect(sc(result)).toMatchObject({
        canvas_id: '',
        table_name: '',
        spilled: false,
        total: 12,
      });
    }
    serveClinvar([clinvarRow(1), clinvarRow(2)]);
    for (let i = 0; i < 3; i += 1) {
      const result = await call(gnomadSearchClinvar, { gene: 'PCSK9' });
      expect(sc(result)).toMatchObject({ canvas_id: '', table_name: '' });
    }

    // Both slots are still free: two spills mint, a third is refused by the cap.
    serveVariants(LIVE_VARIANTS);
    for (let i = 0; i < 2; i += 1) {
      const result = await call(gnomadListGeneVariants, { gene: 'PCSK9' });
      expect(sc(result)).toMatchObject({ spilled: true, table_name: 'gene_variants' });
    }
    const refused = await call(gnomadListGeneVariants, { gene: 'PCSK9' });
    expect(refused.isError).toBe(true);
    expect(
      (refused.structuredContent as { error: { data: { reason: string } } }).error.data.reason,
    ).toBe('canvas_capacity_exhausted');
  });

  it.each([
    {
      name: 'gnomad_list_gene_variants',
      definition: gnomadListGeneVariants,
      table: 'gene_variants',
      serveSpill: () => serveVariants(LIVE_VARIANTS),
      spillCount: LIVE_VARIANTS.length,
      serveFit: () => serveVariants(LIVE_VARIANTS.slice(0, 12)),
      fitCount: 12,
      serveZero: () => serveVariants([]),
      input: { gene: 'PCSK9' },
    },
    {
      name: 'gnomad_search_clinvar',
      definition: gnomadSearchClinvar,
      table: 'clinvar_variants',
      serveSpill: () => serveClinvar(Array.from({ length: 60 }, (_, i) => clinvarRow(i + 1))),
      spillCount: 60,
      serveFit: () => serveClinvar([clinvarRow(1), clinvarRow(2)]),
      fitCount: 2,
      serveZero: () => serveClinvar([]),
      input: { gene: 'PCSK9' },
    },
  ])(
    '$name: spill → reuse with a fitting result → zero-row reuse replaces, then removes, the table (#35, #21)',
    async ({ definition, table, serveSpill, spillCount, serveFit, fitCount, serveZero, input }) => {
      serveSpill();
      const spilled = await call(definition, input);
      const canvasId = sc(spilled).canvas_id as string;
      expect(sc(spilled)).toMatchObject({ spilled: true, table_name: table, total: spillCount });
      expect(canvasId).toMatch(/^[A-Za-z0-9_-]{10}$/);
      expect(sc(spilled).notice).toContain(`table "${table}" (canvas_id ${canvasId})`);
      expect(await stagedCount(canvasId, table)).toBe(spillCount);

      serveFit();
      const reused = await call(definition, { ...input, canvas_id: canvasId });
      expect(sc(reused)).toMatchObject({
        canvas_id: canvasId,
        table_name: table,
        spilled: false,
        total: fitCount,
      });
      expect(sc(reused).notice).toMatch(/gnomad_dataframe_describe.*then gnomad_dataframe_query/);
      expect(await stagedCount(canvasId, table)).toBe(fitCount);

      serveZero();
      const emptied = await call(definition, { ...input, canvas_id: canvasId });
      expect(sc(emptied)).toMatchObject({ canvas_id: canvasId, table_name: '', total: 0 });
      expect(sc(emptied).notice).not.toMatch(/gnomad_dataframe_describe/);
      expect(await stagedTables(canvasId)).not.toContain(table);
      await expect(stagedCount(canvasId, table)).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'missing_table' },
      });
    },
  );

  it('spills without canvas_id onto a fresh canvas that holds every row', async () => {
    serveVariants(LIVE_VARIANTS);
    const result = await call(gnomadListGeneVariants, { gene: 'PCSK9' });
    const canvasId = sc(result).canvas_id as string;
    expect((sc(result).preview as unknown[]).length).toBeLessThan(LIVE_VARIANTS.length);
    expect(await stagedTables(canvasId)).toEqual(['gene_variants']);
    expect(await stagedCount(canvasId, 'gene_variants')).toBe(LIVE_VARIANTS.length);
  });

  it('leaves the canvas untouched when an ENSG id arrives with a canvas_id (#33)', async () => {
    serveClinvar(Array.from({ length: 60 }, (_, i) => clinvarRow(i + 1)));
    const spilled = await call(gnomadSearchClinvar, { gene: 'PCSK9' });
    const canvasId = sc(spilled).canvas_id as string;

    const ensg = await call(gnomadSearchClinvar, { gene: 'ENSG00000169174', canvas_id: canvasId });

    expect(ensg.isError).toBeFalsy();
    expect(sc(ensg)).toMatchObject({ canvas_id: '', table_name: '', total: 0 });
    expect(await stagedTables(canvasId)).toContain('clinvar_variants');
    expect(await stagedCount(canvasId, 'clinvar_variants')).toBe(60);
  });

  it('returns the ENSG guidance for an unknown canvas_id instead of canvas_not_found (#33)', async () => {
    const ensg = await call(gnomadSearchClinvar, {
      gene: 'ENSG00000169174',
      canvas_id: 'AAAAAAAAAA',
    });

    expect(ensg.isError).toBeFalsy();
    expect(sc(ensg)).toMatchObject({ canvas_id: '', table_name: '', total: 0 });
    expect(sc(ensg).notice).toMatch(/HGNC symbol/);
  });
});

/* ------------------------------------------------------------------------- */
/* Staged column types come from the row type, never from the preview sample. */
/* ------------------------------------------------------------------------- */

type Column = { name: string; type: string; nullable?: boolean | undefined };

async function columnsOf(canvasId: string, table: string): Promise<Column[]> {
  const instance = await canvas.acquire(canvasId, createMockContext({ tenantId: 'default' }));
  const info = (await instance.describe()).find((t) => t.name === table);
  if (!info) throw new Error(`table ${table} is not staged`);
  return info.columns.map(({ name, type, nullable }) => ({ name, type, nullable }));
}

async function sql(canvasId: string, statement: string): Promise<Record<string, unknown>> {
  const queried = await gnomadDataframeQuery.handler(
    gnomadDataframeQuery.input.parse({ canvas_id: canvasId, sql: statement }),
    createMockContext({ tenantId: 'default', errors: gnomadDataframeQuery.errors }),
  );
  return queried.rows[0] ?? {};
}

const GENE_VARIANT_COLUMNS: Column[] = [
  { name: 'variant_id', type: 'VARCHAR', nullable: false },
  { name: 'af', type: 'DOUBLE', nullable: true },
  { name: 'ac', type: 'BIGINT', nullable: false },
  { name: 'an', type: 'BIGINT', nullable: false },
  { name: 'consequence', type: 'VARCHAR', nullable: true },
  { name: 'consequence_class', type: 'VARCHAR', nullable: false },
  { name: 'homozygote_count', type: 'BIGINT', nullable: false },
  { name: 'source', type: 'VARCHAR', nullable: false },
  { name: 'flags', type: 'VARCHAR', nullable: false },
];

const CLINVAR_COLUMNS: Column[] = [
  { name: 'clinvar_variation_id', type: 'VARCHAR', nullable: false },
  { name: 'accession', type: 'VARCHAR', nullable: false },
  { name: 'title', type: 'VARCHAR', nullable: false },
  { name: 'obj_type', type: 'VARCHAR', nullable: false },
  { name: 'clinical_significance', type: 'VARCHAR', nullable: true },
  { name: 'review_status', type: 'VARCHAR', nullable: true },
  { name: 'gold_stars', type: 'BIGINT', nullable: false },
  { name: 'last_evaluated', type: 'VARCHAR', nullable: true },
  { name: 'molecular_consequences', type: 'VARCHAR', nullable: false },
  { name: 'protein_change', type: 'VARCHAR', nullable: false },
  { name: 'conditions', type: 'VARCHAR', nullable: false },
  { name: 'submission_count', type: 'BIGINT', nullable: false },
  { name: 'canonical_spdi', type: 'VARCHAR', nullable: true },
  { name: 'rsids', type: 'VARCHAR', nullable: false },
  { name: 'grch38_variant_id', type: 'VARCHAR', nullable: true },
];

/** The fixture's rows with a fractional AF — real values the table must keep. */
const FRACTIONAL = LIVE_VARIANTS.filter((r) => r.af != null && !Number.isInteger(r.af));

/** `count` real rows re-keyed, with a null AF (first half) or a zero AF (second half). */
function zeroAfRows(count: number): GeneVariantRow[] {
  return Array.from({ length: count }, (_, i) => ({
    ...(LIVE_VARIANTS[i % LIVE_VARIANTS.length] as GeneVariantRow),
    variant_id: `1-${60_000_000 + i}-A-T`,
    af: i < count / 2 ? null : 0,
    ac: 0,
  }));
}

const ESUMMARY = JSON.parse(
  readFileSync(new URL('../fixtures/clinvar-esummary.live.json', import.meta.url), 'utf8'),
) as { result: Record<string, unknown> & { uids: string[] } };

/**
 * Serve a `count`-record ClinVar window through the real ClinVarService: the
 * fixture's ten live records first, then the live 2878 record re-keyed. Any
 * other request rejects.
 */
function serveNcbi(count: number) {
  const live = ESUMMARY.result.uids.filter((id) => id !== '999999999');
  const idlist = Array.from({ length: count }, (_, i) => live[i] ?? String(8_000_000 + i));
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith('/esearch.fcgi')) {
      return Response.json({ esearchresult: { count: String(count), idlist } });
    }
    if (url.pathname.endsWith('/esummary.fcgi')) {
      const uids = (url.searchParams.get('id') ?? '').split(',');
      const result: Record<string, unknown> = { uids };
      for (const id of uids) {
        result[id] = ESUMMARY.result[id] ?? {
          ...(ESUMMARY.result['2878'] as Record<string, unknown>),
          uid: id,
          accession: `VCV${id.padStart(9, '0')}`,
        };
      }
      return Response.json({ result });
    }
    throw new Error('unmocked fetch');
  });
}

describe('staged column types (#35, #37)', () => {
  it('stages the live PCSK9 rows with every row field as a column of its declared type', async () => {
    serveVariants(LIVE_VARIANTS);
    const result = await call(gnomadListGeneVariants, { gene: 'PCSK9' });
    const canvasId = sc(result).canvas_id as string;

    expect(GENE_VARIANT_COLUMNS.map((c) => c.name)).toEqual(Object.keys(LIVE_VARIANTS[0] ?? {}));
    const typed = (columns: Column[]) => columns.map(({ name, type }) => ({ name, type }));
    expect(typed(await columnsOf(canvasId, 'gene_variants'))).toEqual(typed(GENE_VARIANT_COLUMNS));
    const counts = await sql(
      canvasId,
      'SELECT count(*) FILTER (WHERE af > 0) AS af_pos FROM gene_variants',
    );
    expect(Number(counts.af_pos)).toBe(FRACTIONAL.length);
  });

  it('keeps af DOUBLE when a spill preview holds only null and zero AFs', async () => {
    const rows = [...zeroAfRows(120), ...FRACTIONAL];
    serveVariants(rows);
    const result = await call(gnomadListGeneVariants, { gene: 'KCNQ1' });
    const canvasId = sc(result).canvas_id as string;
    const preview = sc(result).preview as GeneVariantRow[];

    expect(sc(result)).toMatchObject({ spilled: true, total: rows.length });
    // The preview and its sentinel carry no fractional AF — a sample would read af as BIGINT.
    expect(preview.length).toBeLessThan(119);
    expect(preview.every((r) => r.af === null || r.af === 0)).toBe(true);
    expect(await columnsOf(canvasId, 'gene_variants')).toEqual(GENE_VARIANT_COLUMNS);
    const counts = await sql(
      canvasId,
      'SELECT count(*) FILTER (WHERE af > 0) AS af_pos, count(*) FILTER (WHERE ac > 0) AS ac_pos, count(*) FILTER (WHERE af IS NULL) AS af_null FROM gene_variants',
    );
    expect(Number(counts.af_pos)).toBe(FRACTIONAL.length);
    expect(Number(counts.ac_pos)).toBe(FRACTIONAL.length);
    expect(Number(counts.af_null)).toBe(60);
    const sample = FRACTIONAL[0] as GeneVariantRow;
    const kept = await sql(
      canvasId,
      `SELECT af FROM gene_variants WHERE variant_id = '${sample.variant_id}'`,
    );
    expect(kept.af).toBe(sample.af);
  });

  it.each([
    { label: 'zero', rows: zeroAfRows(20).slice(10) },
    { label: 'null', rows: zeroAfRows(20).slice(0, 10) },
  ])('keeps af DOUBLE on a fitting reuse whose AFs are all $label', async ({ rows }) => {
    serveVariants(LIVE_VARIANTS);
    const spilled = await call(gnomadListGeneVariants, { gene: 'PCSK9' });
    const canvasId = sc(spilled).canvas_id as string;

    serveVariants(rows);
    const reused = await call(gnomadListGeneVariants, { region: '1-1-2', canvas_id: canvasId });

    expect(sc(reused)).toMatchObject({ spilled: false, table_name: 'gene_variants', total: 10 });
    expect(await columnsOf(canvasId, 'gene_variants')).toEqual(GENE_VARIANT_COLUMNS);
    expect(Number((await sql(canvasId, 'SELECT count(*) AS n FROM gene_variants')).n)).toBe(10);
  });

  it.each([
    { path: 'spill', count: 60, reuse: false },
    { path: 'fit with canvas_id', count: 10, reuse: true },
  ])(
    'stages real ClinVar rows with the declared column schema ($path)',
    async ({ count, reuse }) => {
      clinvarModule.initClinVarService({} as never, {} as never);
      let canvasId: string | undefined;
      if (reuse) {
        serveVariants(LIVE_VARIANTS);
        canvasId = sc(await call(gnomadListGeneVariants, { gene: 'PCSK9' })).canvas_id as string;
      }
      serveNcbi(count);

      const result = await call(gnomadSearchClinvar, {
        gene: 'PCSK9',
        ...(canvasId && { canvas_id: canvasId }),
      });

      expect(result.isError).toBeFalsy();
      expect(sc(result)).toMatchObject({
        table_name: 'clinvar_variants',
        spilled: !reuse,
        total: count,
      });
      const staged = sc(result).canvas_id as string;
      const realRow = (sc(result).preview as ClinVarRow[])[0] ?? {};
      expect(CLINVAR_COLUMNS.map((c) => c.name)).toEqual(Object.keys(realRow));
      expect(await columnsOf(staged, 'clinvar_variants')).toEqual(CLINVAR_COLUMNS);
      const counts = await sql(
        staged,
        'SELECT count(*) FILTER (WHERE gold_stars >= 0) AS rated, count(*) FILTER (WHERE grch38_variant_id IS NULL) AS no_id, sum(submission_count) AS scvs FROM clinvar_variants',
      );
      expect(Number(counts.rated)).toBe(count);
      expect(Number(counts.no_id)).toBeGreaterThan(0);
      expect(Number(counts.scvs)).toBeGreaterThan(0);
    },
  );
});
