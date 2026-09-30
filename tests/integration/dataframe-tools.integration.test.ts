/**
 * @fileoverview Offline integration tests for the dataframe tool trio against
 * a real in-memory DuckDB DataCanvas. Verifies the read-only SQL gate, schema
 * discoverability, idempotent missing/already-dropped table behavior, and
 * gnomad_dataframe_query paging — next_offset walks, the row-JSON budget, and the
 * provider row cap (1,000 here) — without mocking project-owned canvas accessors
 * or handlers.
 * @module tests/integration/dataframe-tools.integration.test
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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gnomadDataframeDescribe } from '@/mcp-server/tools/definitions/gnomad-dataframe-describe.tool.js';
import { gnomadDataframeDrop } from '@/mcp-server/tools/definitions/gnomad-dataframe-drop.tool.js';
import { gnomadDataframeQuery } from '@/mcp-server/tools/definitions/gnomad-dataframe-query.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';

const context = () => createMockContext({ tenantId: 'default' });

let canvas: DataCanvas;
let canvasId: string;

beforeEach(async () => {
  const provider = new DuckdbProvider({
    defaultRowLimit: 1_000,
    exportRootPath: '/tmp/gnomad-canvas-tests',
    memoryLimitMb: 128,
    schemaSniffRows: 100,
  });
  const registry = new CanvasRegistry(provider, {
    ...DEFAULT_CANVAS_REGISTRY_OPTIONS,
    sweeperIntervalMs: 0,
  });
  canvas = new DataCanvas(provider, registry);
  setCanvas(canvas);
  const instance = await canvas.acquire(undefined, context());
  canvasId = instance.canvasId;
  await instance.registerTable('gene_variants', [
    { variant_id: '1-100-A-T', af: 0.001, consequence_class: 'missense' },
    { variant_id: '1-101-G-GA', af: null, consequence_class: 'lof' },
  ]);
});

afterEach(async () => {
  setCanvas(undefined);
  await canvas.shutdown(context());
});

describe('gnomad dataframe tools with a real canvas', () => {
  it('describe exposes the same table and columns that query can reach', async () => {
    const describeCtx = createMockContext({
      tenantId: 'default',
      errors: gnomadDataframeDescribe.errors,
    });
    const described = await gnomadDataframeDescribe.handler(
      gnomadDataframeDescribe.input.parse({ canvas_id: canvasId }),
      describeCtx,
    );

    const table = described.tables.find((candidate) => candidate.name === 'gene_variants');
    expect(table?.row_count).toBe(2);
    expect(table?.columns.map((column) => column.name)).toEqual([
      'variant_id',
      'af',
      'consequence_class',
    ]);

    const queryCtx = createMockContext({
      tenantId: 'default',
      errors: gnomadDataframeQuery.errors,
    });
    const queried = await gnomadDataframeQuery.handler(
      gnomadDataframeQuery.input.parse({
        canvas_id: canvasId,
        sql: 'SELECT variant_id, af FROM gene_variants ORDER BY variant_id',
      }),
      queryCtx,
    );

    expect(queried.columns).toEqual(['variant_id', 'af']);
    expect(queried.rows).toEqual([
      { variant_id: '1-100-A-T', af: 0.001 },
      { variant_id: '1-101-G-GA', af: null },
    ]);
    expect(
      queried.columns.every((column) => table?.columns.some((item) => item.name === column)),
    ).toBe(true);
  });

  it.each([
    "INSERT INTO gene_variants VALUES ('1-102-A-G', 0.1, 'other')",
    "UPDATE gene_variants SET consequence_class = 'other'",
    'DELETE FROM gene_variants',
    'DROP TABLE gene_variants',
    'CREATE TABLE copied AS SELECT * FROM gene_variants',
  ])('rejects mutating SQL: %s', async (sql) => {
    const ctx = createMockContext({
      tenantId: 'default',
      errors: gnomadDataframeQuery.errors,
    });

    await expect(
      gnomadDataframeQuery.handler(
        gnomadDataframeQuery.input.parse({ canvas_id: canvasId, sql }),
        ctx,
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'non_select_statement' },
    });

    const instance = await canvas.acquire(canvasId, context());
    expect(
      (await instance.describe()).find((table) => table.name === 'gene_variants')?.rowCount,
    ).toBe(2);
  });

  it('rejects file-reading table functions even inside a SELECT', async () => {
    const ctx = createMockContext({
      tenantId: 'default',
      errors: gnomadDataframeQuery.errors,
    });

    await expect(
      gnomadDataframeQuery.handler(
        gnomadDataframeQuery.input.parse({
          canvas_id: canvasId,
          sql: "SELECT * FROM read_csv_auto('/tmp/private.csv')",
        }),
        ctx,
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'denied_function' },
    });
  });

  it.each([
    ['a trailing semicolon', 'SELECT 1 AS one;', [{ one: 1 }]],
    [
      'a CTE',
      'WITH v AS (SELECT variant_id FROM gene_variants) SELECT variant_id FROM v ORDER BY variant_id',
      [{ variant_id: '1-100-A-T' }, { variant_id: '1-101-G-GA' }],
    ],
    [
      'a trailing -- comment',
      'SELECT variant_id FROM gene_variants ORDER BY variant_id -- ranked',
      [{ variant_id: '1-100-A-T' }, { variant_id: '1-101-G-GA' }],
    ],
    [
      "DuckDB's FROM-first form",
      'FROM gene_variants SELECT variant_id ORDER BY variant_id',
      [{ variant_id: '1-100-A-T' }, { variant_id: '1-101-G-GA' }],
    ],
  ])('runs a read-only statement with %s', async (_label, sql, rows) => {
    const result = await gnomadDataframeQuery.handler(
      gnomadDataframeQuery.input.parse({ canvas_id: canvasId, sql }),
      createMockContext({ tenantId: 'default', errors: gnomadDataframeQuery.errors }),
    );
    expect(result.rows).toEqual(rows);
  });

  it('runs a bare FROM-first statement over every staged row', async () => {
    const result = await gnomadDataframeQuery.handler(
      gnomadDataframeQuery.input.parse({ canvas_id: canvasId, sql: 'FROM gene_variants' }),
      createMockContext({ tenantId: 'default', errors: gnomadDataframeQuery.errors }),
    );
    expect(result.columns).toEqual(['variant_id', 'af', 'consequence_class']);
    expect(result.rows.map((row) => row.variant_id).sort()).toEqual(['1-100-A-T', '1-101-G-GA']);
  });

  it.each([
    ['DROP TABLE never_staged', JsonRpcErrorCode.ValidationError, 'non_select_statement'],
    ['SELECT 1; SELECT 2', JsonRpcErrorCode.ValidationError, 'multi_statement'],
    ['SELECT * FROM never_staged', JsonRpcErrorCode.NotFound, 'missing_table'],
  ])('rejects %s through the canvas gate', async (sql, code, reason) => {
    await expect(
      gnomadDataframeQuery.handler(
        gnomadDataframeQuery.input.parse({ canvas_id: canvasId, sql }),
        createMockContext({ tenantId: 'default', errors: gnomadDataframeQuery.errors }),
      ),
    ).rejects.toMatchObject({ code, data: { reason } });
  });

  it('pages a gate-passing statement like any other SELECT', async () => {
    const result = await gnomadDataframeQuery.handler(
      gnomadDataframeQuery.input.parse({
        canvas_id: canvasId,
        sql: 'SELECT variant_id FROM gene_variants ORDER BY variant_id -- ranked',
        limit: 1,
      }),
      createMockContext({ tenantId: 'default', errors: gnomadDataframeQuery.errors }),
    );
    expect(result).toMatchObject({
      rows: [{ variant_id: '1-100-A-T' }],
      offset: 0,
      returned: 1,
      total: 2,
      truncated: true,
      next_offset: 1,
    });
  });

  it('reports missing and already-dropped tables without claiming a mutation occurred', async () => {
    const ctx = createMockContext({
      tenantId: 'default',
      errors: gnomadDataframeDrop.errors,
    });
    const input = gnomadDataframeDrop.input.parse({
      canvas_id: canvasId,
      table_name: 'gene_variants',
    });

    expect(await gnomadDataframeDrop.handler(input, ctx)).toEqual({ dropped: true });
    expect(await gnomadDataframeDrop.handler(input, ctx)).toEqual({ dropped: false });
    expect(
      await gnomadDataframeDrop.handler(
        gnomadDataframeDrop.input.parse({
          canvas_id: canvasId,
          table_name: 'never_staged',
        }),
        ctx,
      ),
    ).toEqual({ dropped: false });

    const described = await gnomadDataframeDescribe.handler(
      gnomadDataframeDescribe.input.parse({ canvas_id: canvasId }),
      createMockContext({ tenantId: 'default', errors: gnomadDataframeDescribe.errors }),
    );
    expect(described.tables).toEqual([]);
  });
});

/** Rows past the fixture's 1,000-row cap, so the cap is reachable without range(). */
const NUMBERS = 1_250;

/** Characters of row JSON one page may carry. */
const PAGE_CHARS = 10_000;

const rowChars = (rows: Record<string, unknown>[]) =>
  rows.reduce((sum, row) => sum + JSON.stringify(row).length, 0);

const textOf = (content: unknown) =>
  (content as { type: string; text?: string }[]).map((block) => block.text ?? '').join('\n');

async function queryPage(sql: string, paging: { offset?: number; limit?: number } = {}) {
  return await gnomadDataframeQuery.handler(
    gnomadDataframeQuery.input.parse({ canvas_id: canvasId, sql, ...paging }),
    createMockContext({ tenantId: 'default', errors: gnomadDataframeQuery.errors }),
  );
}

/** Follow next_offset from 0 until it is null. */
async function walkPages(sql: string, limit?: number) {
  const pages: Awaited<ReturnType<typeof queryPage>>[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = await queryPage(sql, { offset, ...(limit !== undefined && { limit }) });
    pages.push(page);
    offset = page.next_offset;
  }
  return pages;
}

describe('gnomad_dataframe_query paging over a real canvas', () => {
  beforeEach(async () => {
    const instance = await canvas.acquire(canvasId, context());
    await instance.registerTable(
      'numbers',
      Array.from({ length: NUMBERS }, (_, n) => ({ n })),
      { schema: [{ name: 'n', type: 'INTEGER', nullable: false }] },
    );
  });

  it('walks a result under the cap page by page with an exact total', async () => {
    const pages = await walkPages('SELECT n FROM numbers WHERE n < 750 ORDER BY n');

    expect(pages.map((page) => page.returned)).toEqual([100, 100, 100, 100, 100, 100, 100, 50]);
    expect(pages.flatMap((page) => page.rows)).toEqual(
      Array.from({ length: 750 }, (_, n) => ({ n })),
    );
    expect(pages.every((page) => page.total === 750)).toBe(true);
    expect(pages.at(-1)).toMatchObject({ offset: 700, truncated: false, next_offset: null });
    expect(pages.slice(0, -1).every((page) => page.truncated)).toBe(true);
  });

  it.each([
    [undefined, 10],
    [500, 2],
    [333, 4],
  ])(
    'walks a result above the cap at limit %s up to the cap, then stops',
    async (limit, pageCount) => {
      const pages = await walkPages('SELECT n FROM numbers ORDER BY n', limit);

      expect(pages).toHaveLength(pageCount);
      expect(pages.flatMap((page) => page.rows)).toEqual(
        Array.from({ length: 1_000 }, (_, n) => ({ n })),
      );
      expect(pages.every((page) => page.total === null && page.truncated)).toBe(true);
      expect(pages.at(-1)?.next_offset).toBeNull();
      expect(pages.slice(0, -1).map((page) => page.next_offset)).toEqual(
        pages.slice(1).map((page) => page.offset),
      );
    },
  );

  it('cuts variable-width pages at the character budget without a gap or duplicate', async () => {
    const sql = "SELECT n, repeat('x', (n % 9) * 230) AS pad FROM numbers WHERE n < 300 ORDER BY n";
    const pages = await walkPages(sql);

    expect(pages.flatMap((page) => page.rows.map((row) => row.n))).toEqual(
      Array.from({ length: 300 }, (_, n) => n),
    );
    expect(pages.length).toBeGreaterThan(3);
    for (const [i, page] of pages.entries()) {
      expect(rowChars(page.rows)).toBeLessThanOrEqual(PAGE_CHARS);
      const next = pages[i + 1];
      if (next) {
        expect(page.returned).toBeLessThan(100);
        expect(rowChars([...page.rows, next.rows[0] as Record<string, unknown>])).toBeGreaterThan(
          PAGE_CHARS,
        );
      }
    }
  });

  it('honors a SQL LIMIT as the whole result', async () => {
    const page = await queryPage('SELECT n FROM numbers ORDER BY n LIMIT 100');

    expect(page.rows).toEqual(Array.from({ length: 100 }, (_, n) => ({ n })));
    expect(page).toMatchObject({ returned: 100, total: 100, truncated: false, next_offset: null });
  });

  it('returns an empty page past the last row, and past the cap of a capped result', async () => {
    expect(await queryPage('SELECT n FROM numbers WHERE n < 750', { offset: 750 })).toMatchObject({
      rows: [],
      columns: ['n'],
      returned: 0,
      total: 750,
      truncated: false,
      next_offset: null,
    });
    expect(await queryPage('SELECT n FROM numbers', { offset: 1_100 })).toMatchObject({
      rows: [],
      returned: 0,
      total: null,
      truncated: true,
      next_offset: null,
    });
  });

  it('fails with row_too_large on an oversized first row and returns no rows', async () => {
    await expect(queryPage("SELECT repeat('x', 200000) AS big")).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'row_too_large', offset: 0 },
    });
  });

  it('pages up to an oversized row, then fails with row_too_large at its offset', async () => {
    const sql =
      "SELECT n, CASE WHEN n = 5 THEN repeat('x', 20000) ELSE 'a' END AS pad FROM numbers WHERE n < 10 ORDER BY n";

    const first = await queryPage(sql);
    expect(first.rows.map((row) => row.n)).toEqual([0, 1, 2, 3, 4]);
    expect(first).toMatchObject({ total: 10, truncated: true, next_offset: 5 });

    await expect(queryPage(sql, { offset: 5 })).rejects.toMatchObject({
      data: { reason: 'row_too_large', offset: 5 },
    });
    expect((await queryPage(sql, { offset: 6 })).rows.map((row) => row.n)).toEqual([6, 7, 8, 9]);
  });

  it('keeps a full SELECT * page of live gnomAD rows under 24 KB on both surfaces', async () => {
    const live = JSON.parse(
      readFileSync(new URL('../fixtures/pcsk9-gene-variants.live.json', import.meta.url), 'utf8'),
    ) as Record<string, unknown>[];
    const instance = await canvas.acquire(canvasId, context());
    await instance.drop('gene_variants');
    // The column types gnomad_list_gene_variants stages with (BIGINT counts read back as strings).
    await instance.registerTable('gene_variants', live, {
      schema: [
        { name: 'variant_id', type: 'VARCHAR', nullable: false },
        { name: 'af', type: 'DOUBLE' },
        { name: 'ac', type: 'BIGINT', nullable: false },
        { name: 'an', type: 'BIGINT', nullable: false },
        { name: 'consequence', type: 'VARCHAR' },
        { name: 'consequence_class', type: 'VARCHAR', nullable: false },
        { name: 'homozygote_count', type: 'BIGINT', nullable: false },
        { name: 'source', type: 'VARCHAR', nullable: false },
        { name: 'flags', type: 'VARCHAR', nullable: false },
      ],
    });

    const result = await runToolContract(
      gnomadDataframeQuery,
      { canvas_id: canvasId, sql: 'SELECT * FROM gene_variants ORDER BY variant_id' },
      { context: { tenantId: 'default' } },
    );

    expect(result.isError).toBeFalsy();
    const page = result.structuredContent as {
      rows: Record<string, unknown>[];
      returned: number;
      next_offset: number | null;
      total: number | null;
    };
    expect(page.total).toBe(live.length);
    expect(page.returned).toBeGreaterThan(0);
    expect(page.returned).toBeLessThan(100);
    expect(page.next_offset).toBe(page.returned);
    expect(rowChars(page.rows)).toBeLessThanOrEqual(PAGE_CHARS);
    expect(JSON.stringify(result).length).toBeLessThan(24_000);

    const rowLines = textOf(result.content)
      .split('\n')
      .filter((line) => line.startsWith('- {'));
    expect(rowLines).toEqual(page.rows.map((row) => `- ${JSON.stringify(row)}`));
  });
});
