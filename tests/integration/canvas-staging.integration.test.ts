/**
 * @fileoverview Canvas staging on a real in-memory DuckDB DataCanvas for the two
 * row-returning tools. A call whose rows fit inline without a canvas_id mints no
 * canvas, so repeated small lookups never exhaust the tenant cap; a supplied
 * canvas_id always leaves the named table holding exactly that call's rows —
 * replaced on a spill, replaced on a fit, removed on zero rows — while an
 * Ensembl-ID ClinVar call and a list page past offset 0 touch no canvas.
 * Staged columns carry the declared row-type schema on both the spill and the
 * fit-with-canvas_id path, whatever the preview rows hold, and a call's
 * annotations and populations shape; a call cancelled after gnomAD answers, or
 * after staging acquires its canvas, stages no table on either path, and one
 * cancelled before staging mints no canvas. Upstream services (or
 * NCBI's or gnomAD's fetch boundary) are stubbed; staging, spillover, and the
 * dataframe tools run for real.
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
import type { AnnotatedGeneVariantRow, GeneVariantRow } from '@/services/gnomad/types.js';
import { fakeFafLists, fakePopulationLists, POPULATION_LISTS } from '../helpers/live-faf.js';
import type { LiveReply } from '../helpers/live-subsets.js';

type CallToolResult = Awaited<ReturnType<typeof runToolContract>>;

/**
 * The first 120 rows of the server's live gnomad_r4 PCSK9 list with annotations; the fixture's _about names the capture.
 * It predates gene_id and gene_symbol (#82), which every row of the list carries ahead of transcript_id.
 */
const LIVE_ANNOTATED_VARIANTS = (
  JSON.parse(
    readFileSync(new URL('../fixtures/pcsk9-gene-variants.live.json', import.meta.url), 'utf8'),
  ) as { rows: AnnotatedGeneVariantRow[] }
).rows.map(
  (row) =>
    Object.fromEntries(
      Object.entries(row).flatMap(([key, value]) =>
        key === 'transcript_id'
          ? [
              ['gene_id', 'ENSG00000169174'],
              ['gene_symbol', 'PCSK9'],
              [key, value],
            ]
          : [[key, value]],
      ),
    ) as AnnotatedGeneVariantRow,
);
/** The same rows in the default shape, as the capture's call without annotations returned them. */
const LIVE_VARIANTS: GeneVariantRow[] = LIVE_ANNOTATED_VARIANTS.map(
  ({ hgvsc, hgvsp, lof_filter, lof_flags, rsids, ...row }) => row,
);

const realService = new GnomadService(getServerConfig());

let canvas: DataCanvas;
let registry: CanvasRegistry;

beforeEach(() => {
  const provider = new DuckdbProvider({
    defaultRowLimit: 1_000,
    exportRootPath: '/tmp/gnomad-canvas-tests',
    memoryLimitMb: 128,
    schemaSniffRows: 100,
  });
  registry = new CanvasRegistry(provider, {
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
    oncogenicity_classification: null,
    oncogenicity_review_status: null,
    oncogenicity_last_evaluated: null,
    oncogenicity_conditions: '',
    clinical_impact_classification: null,
    clinical_impact_review_status: null,
    clinical_impact_last_evaluated: null,
    clinical_impact_conditions: '',
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

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/59
  it('stages only at offset 0: later pages mint no canvas and leave a supplied table as it was', async () => {
    serveVariants(LIVE_VARIANTS);
    const first = await call(gnomadListGeneVariants, { gene: 'PCSK9' });
    const canvasId = sc(first).canvas_id as string;
    expect(sc(first)).toMatchObject({ table_name: 'gene_variants', next_offset: 25 });
    expect(sc(first).preview).toEqual(LIVE_VARIANTS.slice(0, 25));

    // A later page re-fetches a target that now returns other rows, naming the staged canvas.
    serveVariants(LIVE_VARIANTS.slice(0, 40));
    const later = await call(gnomadListGeneVariants, {
      gene: 'PCSK9',
      offset: 25,
      canvas_id: canvasId,
    });
    expect(sc(later)).toMatchObject({
      canvas_id: '',
      table_name: '',
      spilled: false,
      total: 40,
      next_offset: null,
    });
    expect(sc(later).preview).toEqual(LIVE_VARIANTS.slice(25, 40));
    expect(await stagedCount(canvasId, 'gene_variants')).toBe(LIVE_VARIANTS.length);

    // Three more later pages with no canvas_id mint nothing: the second of the tenant's two slots is still free.
    serveVariants(LIVE_VARIANTS);
    for (const offset of [25, 50, 500]) {
      const page = await call(gnomadListGeneVariants, { gene: 'PCSK9', offset });
      expect(page.isError).toBeFalsy();
      expect(sc(page)).toMatchObject({
        canvas_id: '',
        table_name: '',
        total: LIVE_VARIANTS.length,
      });
    }
    const second = await call(gnomadListGeneVariants, { gene: 'PCSK9' });
    expect(second.isError).toBeFalsy();
    expect(sc(second).canvas_id).not.toBe(canvasId);
    expect(await stagedCount(sc(second).canvas_id as string, 'gene_variants')).toBe(
      LIVE_VARIANTS.length,
    );
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
  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/75
  { name: 'hemizygote_count', type: 'BIGINT', nullable: true },
  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/64
  { name: 'faf95_max', type: 'DOUBLE', nullable: true },
  { name: 'faf95_max_group', type: 'VARCHAR', nullable: true },
  { name: 'source', type: 'VARCHAR', nullable: false },
  { name: 'flags', type: 'VARCHAR', nullable: false },
  { name: 'exome_filters', type: 'VARCHAR', nullable: true },
  { name: 'genome_filters', type: 'VARCHAR', nullable: true },
  { name: 'qc_status', type: 'VARCHAR', nullable: false },
  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/82
  { name: 'gene_id', type: 'VARCHAR', nullable: true },
  { name: 'gene_symbol', type: 'VARCHAR', nullable: true },
  { name: 'transcript_id', type: 'VARCHAR', nullable: true },
  { name: 'consequence_transcript', type: 'VARCHAR', nullable: true },
  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/65
  { name: 'lof', type: 'VARCHAR', nullable: true },
];

/** An annotations call's table: every default column, then the five opt-in ones (#65). */
const ANNOTATED_GENE_VARIANT_COLUMNS: Column[] = [
  ...GENE_VARIANT_COLUMNS,
  { name: 'hgvsc', type: 'VARCHAR', nullable: true },
  { name: 'hgvsp', type: 'VARCHAR', nullable: true },
  { name: 'lof_filter', type: 'VARCHAR', nullable: true },
  { name: 'lof_flags', type: 'VARCHAR', nullable: true },
  { name: 'rsids', type: 'VARCHAR', nullable: false },
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
  { name: 'oncogenicity_classification', type: 'VARCHAR', nullable: true },
  { name: 'oncogenicity_review_status', type: 'VARCHAR', nullable: true },
  { name: 'oncogenicity_last_evaluated', type: 'VARCHAR', nullable: true },
  { name: 'oncogenicity_conditions', type: 'VARCHAR', nullable: false },
  { name: 'clinical_impact_classification', type: 'VARCHAR', nullable: true },
  { name: 'clinical_impact_review_status', type: 'VARCHAR', nullable: true },
  { name: 'clinical_impact_last_evaluated', type: 'VARCHAR', nullable: true },
  { name: 'clinical_impact_conditions', type: 'VARCHAR', nullable: false },
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
    // gnomAD's ClinVar mapping for the gene holds none of these records, so their null IDs stay null.
    if (url.href === getServerConfig().gnomadApiBaseUrl) {
      return Response.json({ data: { gene: { clinvar_variants: [] } } });
    }
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
    expect(typed(await columnsOf(canvasId, 'gene_variants'))).toEqual(typed(GENE_VARIANT_COLUMNS));
    const counts = await sql(
      canvasId,
      'SELECT count(*) FILTER (WHERE af > 0) AS af_pos FROM gene_variants',
    );
    expect(Number(counts.af_pos)).toBe(FRACTIONAL.length);
    // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/57
    // Every one of the fixture's 120 rows sits on PCSK9's MANE Select transcript.
    const transcripts = await sql(
      canvasId,
      "SELECT count(*) FILTER (WHERE consequence_transcript = 'mane_select') AS mane, count(*) FILTER (WHERE transcript_id = 'ENST00000302118') AS on_mane FROM gene_variants",
    );
    expect([transcripts.mane, transcripts.on_mane].map(Number)).toEqual([120, 120]);
    // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/82
    const genes = await sql(
      canvasId,
      "SELECT count(*) FILTER (WHERE gene_id = 'ENSG00000169174' AND gene_symbol = 'PCSK9') AS pcsk9 FROM gene_variants",
    );
    expect(Number(genes.pcsk9)).toBe(120);
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/82
  it("stages each region row's gene, so a query counts pLoF variants per gene", async () => {
    /**
     * Rows of the three kinds gnomad_r4 serves across 1-55010000-55045000 (live
     * 2026-11-24 UTC): on BSND's transcript, on PCSK9's, and with no transcript
     * consequence; IDs and counts constructed, gene fields as gnomAD names them.
     */
    const kinds = [
      ['ENST00000651561', 'ENSG00000162399', 'BSND', 'splice_donor_variant'],
      ['ENST00000302118', 'ENSG00000169174', 'PCSK9', 'stop_gained'],
      [null, null, null, null],
    ] as const;
    const variants = Array.from({ length: 45 }, (_, i) => {
      const [transcript_id, gene_id, gene_symbol, lof] = kinds[i % 3] as (typeof kinds)[number];
      return {
        variant_id: `1-${55_010_000 + i}-C-A`,
        consequence: lof && i % 2 === 0 ? lof : transcript_id && 'intron_variant',
        transcript_id,
        gene_id,
        gene_symbol,
        flags: [],
        exome: { ac: 1, an: 1_000, af: 0.001, homozygote_count: 0, filters: [] },
        genome: null,
        joint: null,
      };
    });
    vi.spyOn(gnomadModule, 'getGnomadService').mockReturnValue(realService);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({ data: { region: { variants } } }),
    );

    const result = await call(gnomadListGeneVariants, { region: '1-55010000-55045000' });
    const canvasId = sc(result).canvas_id as string;

    expect(sc(result)).toMatchObject({ spilled: true, table_name: 'gene_variants', total: 45 });
    expect(await columnsOf(canvasId, 'gene_variants')).toEqual(GENE_VARIANT_COLUMNS);
    const perGene = await gnomadDataframeQuery.handler(
      gnomadDataframeQuery.input.parse({
        canvas_id: canvasId,
        sql: "SELECT gene_symbol, gene_id, count(*) FILTER (WHERE consequence_class = 'lof') AS lof, count(*) AS n FROM gene_variants GROUP BY gene_symbol, gene_id ORDER BY gene_symbol NULLS LAST",
      }),
      createMockContext({ tenantId: 'default', errors: gnomadDataframeQuery.errors }),
    );
    expect(
      perGene.rows.map((row) => [row.gene_symbol, row.gene_id, row.lof, row.n].map(String)),
    ).toEqual([
      ['BSND', 'ENSG00000162399', '8', '15'],
      ['PCSK9', 'ENSG00000169174', '7', '15'],
      ['null', 'null', '0', '15'],
    ]);
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/64
  it('stages the live FAF columns with their values', async () => {
    serveVariants(LIVE_VARIANTS);
    const result = await call(gnomadListGeneVariants, { gene: 'PCSK9' });
    const canvasId = sc(result).canvas_id as string;

    // 33 of the fixture's 120 rows carry a FAF95, every one with its group.
    const counts = await sql(
      canvasId,
      'SELECT count(*) FILTER (WHERE faf95_max IS NOT NULL) AS faf, count(*) FILTER (WHERE faf95_max_group IS NOT NULL) AS grp FROM gene_variants',
    );
    expect([counts.faf, counts.grp].map(Number)).toEqual([33, 33]);
    expect(
      await sql(
        canvasId,
        "SELECT faf95_max, faf95_max_group FROM gene_variants WHERE variant_id = '1-55039768-C-T'",
      ),
    ).toEqual({ faf95_max: 2.9e-7, faf95_max_group: 'nfe' });
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/54
  it('stages the live QC columns, and only passing rows under pass_only', async () => {
    serveVariants(LIVE_VARIANTS);
    const all = await call(gnomadListGeneVariants, { gene: 'PCSK9' });
    const canvasId = sc(all).canvas_id as string;

    // The fixture's 120 rows: 59 fail QC in every callset carrying them, 61 pass.
    expect(sc(all)).toMatchObject({ spilled: true, total: 120, qc_filtered: 59 });
    const counts = await sql(
      canvasId,
      "SELECT count(*) FILTER (WHERE qc_status = 'filtered') AS filtered, count(*) FILTER (WHERE exome_filters IS NULL) AS no_exome, count(*) FILTER (WHERE genome_filters IS NULL) AS no_genome FROM gene_variants",
    );
    expect([counts.filtered, counts.no_exome, counts.no_genome].map(Number)).toEqual([59, 2, 97]);
    expect(
      await sql(
        canvasId,
        "SELECT exome_filters, genome_filters, qc_status FROM gene_variants WHERE variant_id = '1-55039766-G-T'",
      ),
    ).toEqual({ exome_filters: 'AC0|AS_VQSR', genome_filters: null, qc_status: 'filtered' });
    expect(
      await sql(
        canvasId,
        "SELECT exome_filters, genome_filters, qc_status FROM gene_variants WHERE variant_id = '1-55039793-C-T'",
      ),
    ).toEqual({ exome_filters: 'AC0', genome_filters: '', qc_status: 'pass' });

    const passOnly = await call(gnomadListGeneVariants, {
      gene: 'PCSK9',
      pass_only: true,
      canvas_id: canvasId,
    });
    expect(sc(passOnly)).toMatchObject({ total: 61, qc_filtered: 59 });
    expect((sc(passOnly).preview as GeneVariantRow[]).every((r) => r.qc_status === 'pass')).toBe(
      true,
    );
    const staged = await sql(
      canvasId,
      "SELECT count(*) AS n, count(*) FILTER (WHERE qc_status <> 'pass') AS not_pass FROM gene_variants",
    );
    expect([staged.n, staged.not_pass].map(Number)).toEqual([61, 0]);
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
      // Rows without an SPDI-derived ID reach gnomAD's ClinVar mapping through the real service.
      vi.spyOn(gnomadModule, 'getGnomadService').mockReturnValue(realService);
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

/** gnomad_dataframe_describe's columns for gene_variants on a canvas. */
async function described(canvasId: string) {
  const result = await runToolContract(
    gnomadDataframeDescribe,
    { canvas_id: canvasId },
    { context: { tenantId: 'default' } },
  );
  const { tables } = result.structuredContent as {
    tables: { name: string; columns: { name: string; type: string }[] }[];
  };
  return tables.find((t) => t.name === 'gene_variants')?.columns;
}
const typed = (columns: Column[]) => columns.map(({ name, type }) => ({ name, type }));

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/65
describe('the gene_variants table takes each call’s annotations shape (#65)', () => {
  it('describes an annotations table as the default columns then the five, and a repeat call without it replaces the table', async () => {
    serveVariants(LIVE_ANNOTATED_VARIANTS);
    const annotated = await call(gnomadListGeneVariants, { gene: 'PCSK9', annotations: true });
    const canvasId = sc(annotated).canvas_id as string;

    expect(sc(annotated)).toMatchObject({ spilled: true, table_name: 'gene_variants', total: 120 });
    expect(ANNOTATED_GENE_VARIANT_COLUMNS.map((c) => c.name)).toEqual(
      Object.keys(LIVE_ANNOTATED_VARIANTS[0] ?? {}),
    );
    expect(await described(canvasId)).toEqual(typed(ANNOTATED_GENE_VARIANT_COLUMNS));
    expect(await columnsOf(canvasId, 'gene_variants')).toEqual(ANNOTATED_GENE_VARIANT_COLUMNS);
    const staged = await sql(
      canvasId,
      "SELECT count(*) FILTER (WHERE rsids <> '') AS with_rsid, count(*) FILTER (WHERE hgvsc IS NOT NULL) AS with_hgvsc, count(*) FILTER (WHERE hgvsp IS NULL) AS no_hgvsp FROM gene_variants",
    );
    expect(staged).toMatchObject({ with_rsid: '42', with_hgvsc: '120', no_hgvsp: '120' });

    serveVariants(LIVE_VARIANTS);
    const repeat = await call(gnomadListGeneVariants, { gene: 'PCSK9', canvas_id: canvasId });

    expect(sc(repeat)).toMatchObject({ canvas_id: canvasId, table_name: 'gene_variants' });
    expect(await described(canvasId)).toEqual(typed(GENE_VARIANT_COLUMNS));
    expect(await columnsOf(canvasId, 'gene_variants')).toEqual(GENE_VARIANT_COLUMNS);
    expect(Number((await sql(canvasId, 'SELECT count(*) AS n FROM gene_variants')).n)).toBe(120);
  });

  it('stages a default call with lof and none of the five', async () => {
    serveVariants(LIVE_VARIANTS);
    const result = await call(gnomadListGeneVariants, { gene: 'PCSK9' });
    const canvasId = sc(result).canvas_id as string;

    const names = (await described(canvasId))?.map((c) => c.name) ?? [];
    expect(names.at(-1)).toBe('lof');
    for (const name of ['hgvsc', 'hgvsp', 'lof_filter', 'lof_flags', 'rsids']) {
      expect(names).not.toContain(name);
    }
  });
});

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/81
describe('a call without populations stages the gene_variants table it staged before #81', () => {
  /** MD5 of every staged row's JSON in variant_id order, and the row count — DuckDB's own reading of the table. */
  async function digestOf(canvasId: string) {
    const instance = await canvas.acquire(canvasId, createMockContext({ tenantId: 'default' }));
    const { rows } = await instance.query(
      'SELECT md5(string_agg(to_json(t)::VARCHAR, chr(10) ORDER BY variant_id)) AS digest, count(*) AS n FROM gene_variants t',
    );
    return { digest: rows[0]?.digest, n: Number(rows[0]?.n) };
  }

  /** Digests captured from the server before #81, over gnomAD's live PCSK9 and INS lists through the real service. */
  it.each([
    [{ gene: 'PCSK9' }, 4544, '5c6347c71f28583286da4e5f05bfa4bd'],
    [
      { gene: 'PCSK9', dataset: 'gnomad_r2_1', pass_only: true },
      1197,
      '7e23b2c22fdc9bce6d1ade3897102067',
    ],
    [
      { gene: 'INS', dataset: 'gnomad_r2_1', annotations: true },
      223,
      '022e07563164d360b3ba76dec7b94d22',
    ],
  ] as const)('stages %j row for row', async (input, n, digest) => {
    fakeFafLists();
    vi.spyOn(gnomadModule, 'getGnomadService').mockReturnValue(realService);

    const result = await call(gnomadListGeneVariants, input);
    const canvasId = sc(result).canvas_id as string;

    expect(sc(result)).toMatchObject({ spilled: true, table_name: 'gene_variants' });
    expect(await columnsOf(canvasId, 'gene_variants')).toEqual(
      'annotations' in input ? ANNOTATED_GENE_VARIANT_COLUMNS : GENE_VARIANT_COLUMNS,
    );
    expect(await digestOf(canvasId)).toEqual({ digest, n });
  });
});

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/81
describe("a populations call stages each of its dataset's groups ×3 after every other column (#81)", () => {
  /** Each release's groups on its list rows as of 2026-11-24 (#81's table), alphabetical. */
  const GROUPS = {
    gnomad_r4: ['afr', 'ami', 'amr', 'asj', 'eas', 'fin', 'mid', 'nfe', 'remaining', 'sas'],
    gnomad_r3: ['afr', 'ami', 'amr', 'asj', 'eas', 'fin', 'mid', 'nfe', 'oth', 'sas'],
    gnomad_r2_1: ['afr', 'amr', 'asj', 'eas', 'fin', 'nfe', 'oth', 'sas'],
    exac: ['afr', 'amr', 'eas', 'fin', 'nfe', 'oth', 'sas'],
  } as const;
  const groupColumns = (groups: readonly string[]): Column[] =>
    groups.flatMap((group) => [
      { name: `ac_${group}`, type: 'BIGINT', nullable: true },
      { name: `an_${group}`, type: 'BIGINT', nullable: true },
      { name: `af_${group}`, type: 'DOUBLE', nullable: true },
    ]);

  /** gnomAD's live populations lists through the real service, and a fresh canvas their few rows stage on. */
  async function serveLive() {
    fakePopulationLists();
    vi.spyOn(gnomadModule, 'getGnomadService').mockReturnValue(realService);
    return (await canvas.acquire(undefined, createMockContext({ tenantId: 'default' }))).canvasId;
  }

  interface RawRecord {
    ac: number | null;
    an: number | null;
    filters?: string[];
    populations?: { id: string; ac: number; an: number }[];
  }
  interface RawRow {
    exome: RawRecord | null;
    genome: RawRecord | null;
    joint: RawRecord | null;
    variant_id: string;
  }
  /**
   * SUM(af_<group>) over the rows a call stages, from the raw records by #81's
   * rule: joint where it carries an AC, else the carried callsets (the passing
   * ones under pass_only, which drops a row none passed); a group's af is its
   * summed ac/an, skipped when an is 0 as SQL skips its NULL.
   */
  function oracleSum(key: string, group: string, passOnly: boolean): number {
    const reply = POPULATION_LISTS[key];
    if (!reply) throw new Error(`No live list ${key}`);
    const rows = (reply.body as { data: { gene: { variants: RawRow[] } } }).data.gene.variants;
    let sum = 0;
    for (const row of rows) {
      const carried = [row.exome, row.genome].filter((r): r is RawRecord => r?.ac != null);
      const passing = carried.filter((r) => r.filters?.length === 0);
      if (passOnly && passing.length === 0) continue;
      const records = row.joint?.ac != null ? [row.joint] : passOnly ? passing : carried;
      const entries = records.flatMap((r) => r.populations ?? []).filter((p) => p.id === group);
      const ac = entries.reduce((s, p) => s + p.ac, 0);
      const an = entries.reduce((s, p) => s + p.an, 0);
      if (an > 0) sum += ac / an;
    }
    return sum;
  }

  it.each([
    ['gnomad_r4', GROUPS.gnomad_r4, 30, 'oth'],
    ['gnomad_r4_non_ukb', GROUPS.gnomad_r4, 30, 'oth'],
    ['gnomad_r3', GROUPS.gnomad_r3, 30, 'remaining'],
    ['gnomad_r3_non_v2', GROUPS.gnomad_r3, 30, 'remaining'],
    ['gnomad_r2_1', GROUPS.gnomad_r2_1, 24, 'remaining'],
    ['gnomad_r2_1_non_cancer', GROUPS.gnomad_r2_1, 24, 'remaining'],
    ['exac', GROUPS.exac, 21, 'remaining'],
  ] as const)(
    'describes a %s table as the default columns then %j ×3 (%i), with no "" or %s column',
    async (dataset, groups, count, foreign) => {
      const canvasId = await serveLive();

      const result = await call(gnomadListGeneVariants, {
        gene: 'PCSK9',
        dataset,
        populations: true,
        canvas_id: canvasId,
      });

      expect(sc(result)).toMatchObject({ canvas_id: canvasId, table_name: 'gene_variants' });
      const expected = [...GENE_VARIANT_COLUMNS, ...groupColumns(groups)];
      expect(await described(canvasId)).toEqual(typed(expected));
      expect(await columnsOf(canvasId, 'gene_variants')).toEqual(expected);
      const names = ((await described(canvasId)) ?? []).map((c) => c.name);
      expect(names.slice(GENE_VARIANT_COLUMNS.length)).toHaveLength(count);
      const absent = ['', foreign].flatMap((id) => [`ac_${id}`, `an_${id}`, `af_${id}`]);
      expect(names.filter((name) => absent.includes(name))).toEqual([]);
    },
  );

  it('describes an annotations and populations table as the default columns, the five, then the groups; a repeat call without either replaces it', async () => {
    const canvasId = await serveLive();

    await call(gnomadListGeneVariants, {
      gene: 'PCSK9',
      dataset: 'gnomad_r2_1',
      annotations: true,
      populations: true,
      canvas_id: canvasId,
    });
    expect(await described(canvasId)).toEqual(
      typed([...ANNOTATED_GENE_VARIANT_COLUMNS, ...groupColumns(GROUPS.gnomad_r2_1)]),
    );

    await call(gnomadListGeneVariants, {
      gene: 'PCSK9',
      dataset: 'gnomad_r2_1',
      canvas_id: canvasId,
    });
    expect(await described(canvasId)).toEqual(typed(GENE_VARIANT_COLUMNS));
    expect(Number((await sql(canvasId, 'SELECT count(*) AS n FROM gene_variants')).n)).toBe(5);
  });

  it.each([
    ['gnomad_r4', 'CFTR', false],
    ['gnomad_r4', 'PCSK9', false],
    ['gnomad_r4', 'PCSK9', true],
    ['gnomad_r4_non_ukb', 'PCSK9', true],
    ['gnomad_r2_1', 'PCSK9', false],
    ['gnomad_r2_1', 'PCSK9', true],
  ] as const)(
    'answers SELECT SUM(af_asj), SUM(af_nfe) over %s %s (pass_only %s) as the raw records do',
    async (dataset, gene, passOnly) => {
      const canvasId = await serveLive();
      const key = `list-gene:${dataset}:${gene}`;

      await call(gnomadListGeneVariants, {
        gene,
        dataset,
        populations: true,
        canvas_id: canvasId,
        ...(passOnly && { pass_only: true }),
      });
      const sums = await sql(
        canvasId,
        'SELECT SUM(af_asj) AS asj, SUM(af_nfe) AS nfe FROM gene_variants',
      );

      const oracle = { asj: oracleSum(key, 'asj', passOnly), nfe: oracleSum(key, 'nfe', passOnly) };
      expect(oracle.asj + oracle.nfe).toBeGreaterThan(0);
      expect(Number(sums.asj)).toBeCloseTo(oracle.asj, 15);
      expect(Number(sums.nfe)).toBeCloseTo(oracle.nfe, 15);
    },
  );

  /** The live gnomad_r2_1 PCSK9 list: five rows, every one summing an exome and a genome record. */
  const R2_PCSK9 = 'list-gene:gnomad_r2_1:PCSK9';

  /**
   * POPULATION_LISTS with the `key` list's rows served `copies` times over,
   * each copy's positions 1,000,000 bases past the last, so one call carries
   * more rows than any capture holds.
   */
  function repeated(key: string, copies: number): Record<string, LiveReply> {
    const reply = POPULATION_LISTS[key];
    if (!reply) throw new Error(`No live list ${key}`);
    const body = structuredClone(reply.body) as { data: { gene: { variants: RawRow[] } } };
    const rows = body.data.gene.variants;
    body.data.gene.variants = Array.from({ length: copies }, (_, copy) =>
      rows.map((row) => {
        const [chrom, pos, ...alleles] = row.variant_id.split('-');
        const variant_id = [chrom, Number(pos) + copy * 1_000_000, ...alleles].join('-');
        return { ...structuredClone(row), variant_id };
      }),
    ).flat();
    return { ...POPULATION_LISTS, [key]: { ...reply, body } };
  }

  it('spills a populations list past the 14,000-character budget without canvas_id, describing its groups and answering SUM(af_asj) as the raw records do', async () => {
    fakePopulationLists(repeated(R2_PCSK9, 5));
    vi.spyOn(gnomadModule, 'getGnomadService').mockReturnValue(realService);

    const result = await call(gnomadListGeneVariants, {
      gene: 'PCSK9',
      dataset: 'gnomad_r2_1',
      populations: true,
    });
    const canvasId = sc(result).canvas_id as string;

    expect(sc(result)).toMatchObject({ spilled: true, table_name: 'gene_variants', total: 25 });
    expect(canvasId).not.toBe('');
    const expected = [...GENE_VARIANT_COLUMNS, ...groupColumns(GROUPS.gnomad_r2_1)];
    expect(await described(canvasId)).toEqual(typed(expected));
    expect(await columnsOf(canvasId, 'gene_variants')).toEqual(expected);
    const sums = await sql(
      canvasId,
      'SELECT count(*) AS n, SUM(af_asj) AS asj, SUM(af_nfe) AS nfe FROM gene_variants',
    );
    const oracle = {
      asj: 5 * oracleSum(R2_PCSK9, 'asj', false),
      nfe: 5 * oracleSum(R2_PCSK9, 'nfe', false),
    };
    expect(oracle.asj).toBeGreaterThan(0);
    expect(Number(sums.n)).toBe(25);
    expect(Number(sums.asj)).toBeCloseTo(oracle.asj, 14);
    expect(Number(sums.nfe)).toBeCloseTo(oracle.nfe, 14);
  });

  /**
   * Serve the real service over `copies` repeats of the R2_PCSK9 rows, with the
   * caller cancelling either once gnomAD has answered (`answer`, so staging
   * starts on an aborted signal) or once staging has acquired its canvas
   * (`acquire`, so only the table write sees the abort). Returns the list call
   * and the abort reason it must reject with.
   */
  function listCancelled(copies: number, at: 'answer' | 'acquire') {
    fakePopulationLists(repeated(R2_PCSK9, copies));
    const controller = new AbortController();
    const cancelled = new Error('client cancelled');
    vi.spyOn(gnomadModule, 'getGnomadService').mockReturnValue({
      resolveDatasetContext: realService.resolveDatasetContext.bind(realService),
      listGeneVariants: async (...args: Parameters<GnomadService['listGeneVariants']>) => {
        const rows = await realService.listGeneVariants(...args);
        if (at === 'answer') controller.abort(cancelled);
        return rows;
      },
    } as never);
    if (at === 'acquire') {
      const acquire = canvas.acquire.bind(canvas);
      vi.spyOn(canvas, 'acquire').mockImplementation(async (...args) => {
        const instance = await acquire(...args);
        controller.abort(cancelled);
        return instance;
      });
    }
    const list = (canvasId?: string) =>
      gnomadListGeneVariants.handler(
        gnomadListGeneVariants.input.parse({
          gene: 'PCSK9',
          dataset: 'gnomad_r2_1',
          populations: true,
          canvas_id: canvasId,
        }),
        createMockContext({
          tenantId: 'default',
          signal: controller.signal,
          errors: gnomadListGeneVariants.errors,
        }),
      );
    return { list, cancelled };
  }

  it.each([
    ['fits, so it is written to the supplied canvas_id', 1],
    ['spills', 5],
  ] as const)(
    "rejects with the caller's abort and stages no table when cancelled after gnomAD answers: a list that %s",
    async (_path, copies) => {
      const { list, cancelled } = listCancelled(copies, 'answer');
      const { canvasId } = await canvas.acquire(
        undefined,
        createMockContext({ tenantId: 'default' }),
      );

      await expect(list(canvasId)).rejects.toBe(cancelled);
      expect(await stagedTables(canvasId)).toEqual([]);
    },
  );

  it.each([
    ['fits, so it is written to the supplied canvas_id', 1],
    ['spills', 5],
  ] as const)(
    "rejects with the caller's abort and stages no table when cancelled after staging acquires the canvas: a list that %s",
    async (_path, copies) => {
      const { canvasId } = await canvas.acquire(
        undefined,
        createMockContext({ tenantId: 'default' }),
      );
      const { list, cancelled } = listCancelled(copies, 'acquire');

      await expect(list(canvasId)).rejects.toBe(cancelled);
      expect(await stagedTables(canvasId)).toEqual([]);
    },
  );

  it("mints no canvas when a list that would spill without canvas_id is cancelled after gnomAD answers, so the cancel doesn't spend a tenant slot", async () => {
    const { list, cancelled } = listCancelled(5, 'answer');

    await expect(list()).rejects.toBe(cancelled);
    expect(registry.countForTenant('default')).toBe(0);
  });
});
