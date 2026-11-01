/**
 * @fileoverview Behavior tests for the gnomad_dataframe_query handler against a
 * real in-memory DuckDB canvas: offset/limit paging, the 4,000,000-character
 * row-JSON ceiling, the bound on what a page reads from the engine, the row cap
 * (total null), row_too_large, result column names as a direct query returns
 * them, the limit clamp and its notice, input bounds, and parity between
 * structuredContent and the format() text.
 * @module tests/tools/gnomad-dataframe-query.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import {
  CanvasInstance,
  CanvasRegistry,
  DataCanvas,
  DEFAULT_CANVAS_REGISTRY_OPTIONS,
  DuckdbProvider,
} from '@cyanheads/mcp-ts-core/canvas';
import { config } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gnomadDataframeQuery } from '@/mcp-server/tools/definitions/gnomad-dataframe-query.tool.js';
import * as canvasAccessor from '@/services/canvas-accessor.js';

/** Characters of row JSON one page may carry. */
const CEILING = 4_000_000;

/** The row cap the handler pages up to; the provider below is built with it, as a server's is. */
const ROW_CAP = config.canvas.defaultRowLimit;

type Row = Record<string, unknown>;

interface Page {
  columns: string[];
  next_offset: number | null;
  offset: number;
  returned: number;
  rows: Row[];
  total: number | null;
  truncated: boolean;
}

const context = () => createMockContext({ tenantId: 'default' });

let canvas: DataCanvas;
let instance: CanvasInstance;

beforeEach(async () => {
  const provider = new DuckdbProvider({
    defaultRowLimit: ROW_CAP,
    exportRootPath: '/tmp/gnomad-canvas-tests',
    memoryLimitMb: 256,
    schemaSniffRows: 100,
  });
  canvas = new DataCanvas(
    provider,
    new CanvasRegistry(provider, { ...DEFAULT_CANVAS_REGISTRY_OPTIONS, sweeperIntervalMs: 0 }),
  );
  canvasAccessor.setCanvas(canvas);
  instance = await canvas.acquire(undefined, context());
});

afterEach(async () => {
  vi.restoreAllMocks();
  canvasAccessor.setCanvas(undefined);
  await canvas.shutdown(context());
});

/** Stage `count` rows `{ n }` as table `numbers`. */
async function stageNumbers(count: number) {
  await instance.registerTable(
    'numbers',
    Array.from({ length: count }, (_, n) => ({ n })),
    { schema: [{ name: 'n', type: 'INTEGER', nullable: false }] },
  );
}

/** `count` rows `{ n }` in order, from `from`. */
const numbered = (count: number, from = 0): Row[] =>
  Array.from({ length: count }, (_, i) => ({ n: from + i }));

/**
 * SQL whose rows are `{ s }`, in order, each exactly `widths[i]` characters of
 * JSON: `{"s":"…"}` is 8 characters plus the padding.
 */
const sizedSql = (widths: number[]) =>
  `SELECT repeat(tag, w - 8) AS s FROM (VALUES ${widths.map((w, i) => `(${i}, ${w}, '${'abcdefghij'[i % 10]}')`).join(', ')}) AS v(i, w, tag) ORDER BY i`;

const rowChars = (rows: Row[]) => rows.reduce((sum, row) => sum + JSON.stringify(row).length, 0);

async function runPage(input: { offset?: number; limit?: number; sql?: string } = {}) {
  return (await gnomadDataframeQuery.handler(
    gnomadDataframeQuery.input.parse({
      canvas_id: instance.canvasId,
      sql: 'SELECT n FROM numbers ORDER BY n',
      ...input,
    }),
    createMockContext({ tenantId: 'default', errors: gnomadDataframeQuery.errors }),
  )) as Page;
}

/** Follow next_offset from 0 until it is null, collecting every page. */
async function walk(input: { limit?: number; sql?: string } = {}): Promise<Page[]> {
  const pages: Page[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = await runPage({ ...input, offset });
    pages.push(page);
    offset = page.next_offset;
  }
  return pages;
}

/** Every canvas read the calls after this make: the rows each asked for and the rows it got back. */
function recordReads() {
  const spy = vi.spyOn(CanvasInstance.prototype, 'query');
  return () =>
    Promise.all(
      spy.mock.calls.map(async ([, options], i) => ({
        rowLimit: options?.rowLimit,
        rows: (await (spy.mock.results[i] as { value: Promise<{ rows: Row[] }> }).value).rows,
      })),
    );
}

const contract = (input: { sql: string; offset?: number; limit?: number }) =>
  runToolContract(
    gnomadDataframeQuery,
    { canvas_id: instance.canvasId, ...input },
    { context: { tenantId: 'default' } },
  );

const textOf = (content: unknown) =>
  (content as { type: string; text?: string }[]).map((block) => block.text ?? '').join('\n');

describe('gnomad_dataframe_query paging', () => {
  it('returns the first 25 rows by default with the exact total and next_offset', async () => {
    await stageNumbers(250);

    const page = await runPage();

    expect(page.rows).toEqual(numbered(25));
    expect(page).toMatchObject({
      columns: ['n'],
      offset: 0,
      returned: 25,
      total: 250,
      truncated: true,
      next_offset: 25,
    });
  });

  it('returns the tail page with truncated false and next_offset null', async () => {
    await stageNumbers(4544);

    const page = await runPage({ offset: 4500, limit: 100 });

    expect(page.rows).toEqual(numbered(44, 4500));
    expect(page).toMatchObject({
      offset: 4500,
      returned: 44,
      total: 4544,
      truncated: false,
      next_offset: null,
    });
  });

  it.each([
    [25, 10],
    [100, 3],
    [500, 1],
    [7, 36],
  ])(
    'walks next_offset at limit %i across every row with no gap or duplicate',
    async (limit, pageCount) => {
      await stageNumbers(250);

      const pages = await walk({ limit });

      expect(pages).toHaveLength(pageCount);
      expect(pages.flatMap((page) => page.rows)).toEqual(numbered(250));
      for (const [i, page] of pages.entries()) {
        const isLast = i === pages.length - 1;
        expect(page.total).toBe(250);
        expect(page.returned).toBe(page.rows.length);
        expect(page.truncated).toBe(!isLast);
        expect(page.next_offset).toBe(isLast ? null : page.offset + page.returned);
      }
    },
  );

  it('ends a page before a row that would take its row JSON past 4,000,000 characters', async () => {
    const page = await runPage({ sql: sizedSql([1_500_000, 1_500_000, 1_500_000]) });

    expect(rowChars(page.rows)).toBe(3_000_000);
    expect(page).toMatchObject({ returned: 2, total: 3, truncated: true, next_offset: 2 });
  });

  it('keeps rows totaling exactly 4,000,000 characters and ends before one more', async () => {
    const exact = await runPage({ sql: sizedSql([1_000_000, 3_000_000, 9]) });
    expect(rowChars(exact.rows)).toBe(CEILING);
    expect(exact).toMatchObject({ returned: 2, truncated: true, next_offset: 2 });

    const over = await runPage({ sql: sizedSql([1_000_000, 3_000_001, 9]) });
    expect(rowChars(over.rows)).toBe(1_000_000);
    expect(over).toMatchObject({ returned: 1, truncated: true, next_offset: 1 });

    const rest = await runPage({ sql: sizedSql([1_000_000, 3_000_001, 9]), offset: 1 });
    expect(rowChars(rest.rows)).toBe(3_000_010);
    expect(rest).toMatchObject({ returned: 2, truncated: false, next_offset: null });
  });

  it('holds the ceiling on row JSON as returned when DuckDB counts the rows narrower', async () => {
    // DuckDB counts each emoji as one character; the returned row JSON carries it as two.
    const sql = "SELECT i, repeat('😀', 1500000) AS s FROM (VALUES (0), (1)) AS v(i) ORDER BY i";

    const first = await runPage({ sql });
    expect(first.rows.map((row) => row.i)).toEqual([0]);
    expect(rowChars(first.rows)).toBeLessThanOrEqual(CEILING);
    expect(first).toMatchObject({ returned: 1, total: 2, truncated: true, next_offset: 1 });

    const rest = await runPage({ sql, offset: 1 });
    expect(rest.rows.map((row) => row.i)).toEqual([1]);
    expect(rest).toMatchObject({ returned: 1, truncated: false, next_offset: null });
  });

  it('walks variable-width rows through ceiling-cut pages with no gap or duplicate', async () => {
    const widths = Array.from({ length: 8 }, (_, i) => (i % 3) * 1_400_000 + 20);
    const pages = await walk({ sql: sizedSql(widths) });

    expect(pages.flatMap((page) => page.rows).map((row) => JSON.stringify(row).length)).toEqual(
      widths,
    );
    expect(pages.length).toBeGreaterThan(2);
    for (const [i, page] of pages.entries()) {
      expect(rowChars(page.rows)).toBeLessThanOrEqual(CEILING);
      const next = pages[i + 1];
      // Each cut page is maximal: the next row would have pushed it over the ceiling.
      if (next) expect(rowChars([...page.rows, next.rows[0] as Row])).toBeGreaterThan(CEILING);
    }
  });

  it('reports total null above the row cap and stops next_offset at the cap', async () => {
    await stageNumbers(ROW_CAP + 250);

    const pages = await walk({ limit: 3_000 });

    expect(pages.flatMap((page) => page.rows)).toEqual(numbered(ROW_CAP));
    expect(pages.every((page) => page.total === null && page.truncated)).toBe(true);
    expect(pages.at(-1)?.next_offset).toBeNull();
    expect(pages.slice(0, -1).map((page) => page.next_offset)).toEqual(
      pages.slice(1).map((page) => page.offset),
    );
  });

  it('keeps truncated true on an offset past the cap of a result above the cap', async () => {
    await stageNumbers(ROW_CAP + 250);

    const page = await runPage({ offset: ROW_CAP + 200 });

    expect(page).toMatchObject({
      rows: [],
      offset: ROW_CAP + 200,
      returned: 0,
      total: null,
      truncated: true,
      next_offset: null,
    });
  });

  it('returns an empty page for an offset past the last row', async () => {
    await stageNumbers(44);

    const page = await runPage({ offset: 44 });

    expect(page).toMatchObject({
      rows: [],
      columns: ['n'],
      offset: 44,
      returned: 0,
      total: 44,
      truncated: false,
      next_offset: null,
    });
  });

  it('returns an empty page with its columns when the SQL matches no rows', async () => {
    const page = await runPage({ sql: 'SELECT 1 AS variant_id, 0.5 AS af WHERE false' });

    expect(page).toMatchObject({
      rows: [],
      columns: ['variant_id', 'af'],
      offset: 0,
      returned: 0,
      total: 0,
      truncated: false,
      next_offset: null,
    });
  });
});

describe('gnomad_dataframe_query engine reads', () => {
  it('a page reads only the rows it returns', async () => {
    await stageNumbers(5_000);
    const reads = recordReads();

    const page = await runPage({ offset: 2_000, limit: 5 });

    expect(page.rows).toEqual(numbered(5, 2_000));
    const made = await reads();
    expect(made.length).toBeGreaterThan(0);
    for (const read of made) {
      expect(read.rowLimit).toBeLessThanOrEqual(5);
      expect(read.rows.length).toBeLessThanOrEqual(5);
    }
  });

  it('a row past the ceiling never leaves the engine', async () => {
    await stageNumbers(3);
    const sql =
      "SELECT n, CASE WHEN n = 1 THEN repeat('x', 4000000) ELSE '' END AS pad FROM numbers ORDER BY n";
    const reads = recordReads();

    const first = await runPage({ sql, limit: 3 });
    expect(first.rows).toEqual([{ n: 0, pad: '' }]);
    expect(first).toMatchObject({ returned: 1, truncated: true, next_offset: 1 });
    await expect(runPage({ sql, offset: 1, limit: 3 })).rejects.toMatchObject({
      data: { reason: 'row_too_large', offset: 1, row_chars: 4_000_016 },
    });

    for (const read of await reads()) expect(rowChars(read.rows)).toBeLessThan(CEILING);
  });

  it('a ceiling-cut page never evaluates rows past offset + limit', async () => {
    await stageNumbers(9_000);
    // Rows from 8,000 on fail if evaluated; the page asks for 5 rows and the ceiling cuts it at 3.
    const sql =
      "SELECT n, CASE WHEN n = 3 THEN repeat('x', 4000000) WHEN n >= 8000 THEN error('read past the page') ELSE '' END AS pad FROM numbers";

    const page = await runPage({ sql, limit: 5 });

    expect(page.rows).toEqual([
      { n: 0, pad: '' },
      { n: 1, pad: '' },
      { n: 2, pad: '' },
    ]);
    expect(page).toMatchObject({ returned: 3, truncated: true, next_offset: 3 });
  });

  it('every column counts toward the ceiling, whatever the columns are named', async () => {
    await stageNumbers(2);
    const wide = Array.from(
      { length: 5 },
      (_, i) => `CASE WHEN n = 1 THEN repeat('w', 900000) ELSE '' END AS c${i}`,
    );
    // Wide columns sit first and last, so leaving out either end column lets row 1 out.
    const sql = `SELECT ${wide[0]}, n, 1 AS page_chars, 1 AS PAGE_CHARS_, 1 AS page_row, ${wide.slice(1).join(', ')} FROM numbers ORDER BY n`;
    const reads = recordReads();

    const first = await runPage({ sql });
    expect(first.rows.map((row) => row.n)).toEqual([0]);
    expect(first).toMatchObject({ returned: 1, truncated: true, next_offset: 1 });
    await expect(runPage({ sql, offset: 1 })).rejects.toMatchObject({
      data: { reason: 'row_too_large', offset: 1 },
    });

    for (const read of await reads()) expect(rowChars(read.rows)).toBeLessThan(CEILING);
  });
});

describe('gnomad_dataframe_query result column names', () => {
  beforeEach(async () => {
    await instance.registerTable(
      't',
      [
        { n: 1, s: 'x' },
        { n: 2, s: 'y' },
      ],
      {
        schema: [
          { name: 'n', type: 'INTEGER', nullable: false },
          { name: 's', type: 'VARCHAR', nullable: false },
        ],
      },
    );
  });

  it.each<[string, string, string[], Row[]]>([
    [
      'duplicate names',
      'SELECT n AS a, s AS a FROM t ORDER BY n',
      ['a', 'a'],
      [
        { a: 1, 'a:1': 'x' },
        { a: 2, 'a:1': 'y' },
      ],
    ],
    [
      'names that differ only by case',
      'SELECT n AS R, s AS r FROM t ORDER BY n',
      ['R', 'r'],
      [
        { R: 1, r: 'x' },
        { R: 2, r: 'y' },
      ],
    ],
    [
      'a duplicate beside the name DuckDB would rename it to',
      'SELECT 1 AS a, 2 AS a, 3 AS a_1',
      ['a', 'a', 'a_1'],
      [{ a: 1, 'a:1': 2, a_1: 3 }],
    ],
    [
      'a column joined in twice',
      'SELECT * FROM t JOIN t AS u USING (n) ORDER BY n',
      ['n', 's', 's'],
      [
        { n: 1, s: 'x', 's:1': 'x' },
        { n: 2, s: 'y', 's:1': 'y' },
      ],
    ],
  ])('returns %s as a direct canvas query does', async (_label, sql, columns, rows) => {
    const page = await runPage({ sql });

    expect(page.columns).toEqual(columns);
    expect(page.rows).toEqual(rows);
    const direct = await instance.query(sql);
    expect({ columns: page.columns, rows: page.rows }).toEqual({
      columns: direct.columns,
      rows: direct.rows,
    });
  });
});

describe('gnomad_dataframe_query row_too_large', () => {
  it('fails the first page when its first row is over the ceiling, returning no rows', async () => {
    const result = await contract({ sql: "SELECT repeat('x', 4000000) AS big" });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'row_too_large',
          offset: 0,
          row_chars: 4_000_010,
          recovery: { hint: expect.stringMatching(/narrower projection/) },
        },
      },
    });
    expect(textOf(result.content)).toContain('4000010 characters');
    expect(textOf(result.content)).not.toContain('xxxxxxxxxx');
  });

  it('fails at the offset where an oversized row starts a later page', async () => {
    const sql = sizedSql([20, 20, CEILING + 1, 20]);

    const first = await runPage({ sql });
    expect(first).toMatchObject({ returned: 2, truncated: true, next_offset: 2 });

    await expect(runPage({ sql, offset: 2 })).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'row_too_large', offset: 2, row_chars: CEILING + 1 },
    });
  });

  it('accepts a single row of exactly 4,000,000 characters', async () => {
    const page = await runPage({ sql: sizedSql([CEILING, 20]) });

    expect(page).toMatchObject({ returned: 1, truncated: true, next_offset: 1 });
  });
});

describe('gnomad_dataframe_query input and contract', () => {
  it('defaults offset to 0 and limit to 25', () => {
    expect(
      gnomadDataframeQuery.input.parse({ canvas_id: instance.canvasId, sql: 'SELECT 1' }),
    ).toMatchObject({ offset: 0, limit: 25 });
  });

  it('advertises limit with a default and a minimum but no maximum', () => {
    const { limit } = z.toJSONSchema(gnomadDataframeQuery.input).properties ?? {};

    expect(limit).toMatchObject({ default: 25, minimum: 1 });
    expect(limit).not.toHaveProperty('maximum');
  });

  it.each([{ limit: 0 }, { limit: 2.5 }, { offset: -1 }, { offset: 1.5 }])(
    'rejects out-of-range paging input %o at the tool boundary',
    async (bounds) => {
      const result = await contract({ sql: 'SELECT 1', ...bounds });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
    },
  );

  it('clamps a limit above 3,000 to the cap, with the notice on both surfaces', async () => {
    await stageNumbers(3_500);

    const result = await contract({ sql: 'SELECT n FROM numbers ORDER BY n', limit: 5_000 });

    expect(result.isError).toBeFalsy();
    const notice = 'Requested limit 5000 was clamped to the cap of 3000.';
    expect(result.structuredContent).toMatchObject({
      returned: 3_000,
      total: 3_500,
      truncated: true,
      next_offset: 3_000,
      notice,
    });
    expect(textOf(result.content)).toContain(notice);
  });

  it('adds no notice for a limit at the cap', async () => {
    await stageNumbers(3_500);
    const ctx = createMockContext({ tenantId: 'default', errors: gnomadDataframeQuery.errors });

    const page = await gnomadDataframeQuery.handler(
      gnomadDataframeQuery.input.parse({
        canvas_id: instance.canvasId,
        sql: 'SELECT n FROM numbers ORDER BY n',
        limit: 3_000,
      }),
      ctx,
    );

    expect(page.returned).toBe(3_000);
    expect(getEnrichment(ctx)).toEqual({});
  });

  it('returns BIGINT values as strings and an INTEGER cast as a number', async () => {
    await stageNumbers(250);

    const page = await runPage({
      sql: 'SELECT count(*) AS big, CAST(count(*) AS INTEGER) AS small FROM numbers',
    });

    expect(page.rows).toEqual([{ big: '250', small: 250 }]);
  });

  it('rejects a canvas_id outside the minted shape, or empty sql, at parse time', () => {
    expect(() => gnomadDataframeQuery.input.parse({ canvas_id: '', sql: 'SELECT 1' })).toThrow();
    expect(() =>
      gnomadDataframeQuery.input.parse({ canvas_id: 'cnvq', sql: 'SELECT 1' }),
    ).toThrow();
    expect(() =>
      gnomadDataframeQuery.input.parse({ canvas_id: instance.canvasId, sql: '' }),
    ).toThrow();
  });

  it('no longer declares row_count on the output', () => {
    expect(Object.keys(gnomadDataframeQuery.output.shape).sort()).toEqual([
      'columns',
      'next_offset',
      'offset',
      'returned',
      'rows',
      'total',
      'truncated',
    ]);
  });

  it('says each page re-runs the SQL and needs a unique ORDER BY for stable paging', () => {
    expect(gnomadDataframeQuery.description).toMatch(/each page re-runs the SQL/i);
    expect(gnomadDataframeQuery.description).toMatch(/ORDER BY/);
  });

  it('says BIGINT values arrive as strings and a cast to INTEGER returns a number', () => {
    expect(gnomadDataframeQuery.description).toMatch(/BIGINT values.*arrive as JSON strings/);
    expect(gnomadDataframeQuery.description).toContain('CAST(col AS INTEGER) returns a number');
  });

  it('throws ctx.fail("canvas_disabled") when DataCanvas is off', async () => {
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const ctx = createMockContext({ errors: gnomadDataframeQuery.errors });
    const input = gnomadDataframeQuery.input.parse({
      canvas_id: instance.canvasId,
      sql: 'SELECT 1',
    });
    await expect(gnomadDataframeQuery.handler(input, ctx as never)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'canvas_disabled' },
    });
  });
});

describe('gnomad_dataframe_query surface parity', () => {
  it('renders every page row in order plus every paging field in content[]', async () => {
    const rows = Array.from({ length: 150 }, (_, n) => ({
      variant_id: `1-${1000 + n}-A-T`,
      af: n % 3 === 0 ? null : n / 1000,
    }));
    await instance.registerTable('gene_variants', rows, {
      schema: [
        { name: 'variant_id', type: 'VARCHAR', nullable: false },
        { name: 'af', type: 'DOUBLE' },
      ],
    });

    const result = await contract({
      sql: 'SELECT variant_id, af FROM gene_variants ORDER BY variant_id',
      offset: 20,
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as unknown as Page;
    expect(structured.rows).toEqual(rows.slice(20, 45));
    const text = textOf(result.content);
    const rowLines = text.split('\n').filter((line) => line.startsWith('- {'));
    expect(rowLines).toEqual(structured.rows.map((row) => `- ${JSON.stringify(row)}`));
    expect(text).toContain('**columns:** variant_id, af');
    expect(text).toContain('**offset:** 20');
    expect(text).toContain('**returned:** 25');
    expect(text).toContain('**total:** 150');
    expect(text).toContain('**truncated:** true');
    expect(text).toContain('**next_offset:** 45');
  });

  it('renders total null, a cap note, and next_offset null on the last page above the cap', async () => {
    await stageNumbers(ROW_CAP + 250);

    const result = await contract({
      sql: 'SELECT n FROM numbers ORDER BY n',
      offset: ROW_CAP - 100,
      limit: 100,
    });

    const text = textOf(result.content);
    expect(text.split('\n').filter((line) => line.startsWith('- {'))).toHaveLength(100);
    expect(text).toContain('**total:** null');
    expect(text).toContain('**truncated:** true');
    expect(text).toContain('**next_offset:** null');
    expect(text).toMatch(/row cap/);
  });

  it('renders an empty page without row lines', async () => {
    const result = await contract({ sql: 'SELECT 1 AS a WHERE false' });

    const text = textOf(result.content);
    expect(text.split('\n').filter((line) => line.startsWith('- {'))).toEqual([]);
    expect(text).toContain('**returned:** 0');
    expect(text).toContain('**total:** 0');
    expect(text).toContain('**next_offset:** null');
  });
});
