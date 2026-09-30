/**
 * @fileoverview Behavior tests for the gnomad_dataframe_query handler — server-side
 * paging over the capped rows the canvas query returns: offset/limit slicing, the
 * 10,000-character row-JSON budget, the row cap (total null), row_too_large, input
 * bounds, and parity between structuredContent and the format() text. Stubs the
 * canvas accessor with a fake instance whose query() returns a fixed result.
 * @module tests/tools/gnomad-dataframe-query.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { gnomadDataframeQuery } from '@/mcp-server/tools/definitions/gnomad-dataframe-query.tool.js';
import * as canvasAccessor from '@/services/canvas-accessor.js';

/** A well-formed canvas ID — the minted `^[A-Za-z0-9_-]{10}$` shape CanvasIdSchema advertises. */
const CANVAS_ID = 'cnvquery01';

/** Characters of row JSON one page may carry. */
const PAGE_CHARS = 10_000;

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

/** Build a canvas whose acquired instance returns a fixed query result. */
function stubCanvas(rows: Row[], opts: { columns?: string[]; truncated?: boolean } = {}) {
  const query = vi.fn(async () => ({
    rows,
    rowCount: rows.length,
    columns: opts.columns ?? Object.keys(rows[0] ?? {}),
    ...(opts.truncated && { truncated: true }),
  }));
  const instance = { canvasId: CANVAS_ID, query };
  const canvas = { acquire: vi.fn(async () => instance) };
  vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(canvas as never);
  return { canvas, instance, query };
}

/** `count` rows `{ n }` in order. */
const numbered = (count: number): Row[] => Array.from({ length: count }, (_, n) => ({ n }));

/** A row whose JSON is exactly `chars` characters: `{"s":"…"}` is 8 characters plus the padding. */
const sized = (chars: number, tag = 'x'): Row => ({ s: tag.repeat(chars - 8) });

const rowChars = (rows: Row[]) => rows.reduce((sum, row) => sum + JSON.stringify(row).length, 0);

async function runPage(input: { offset?: number; limit?: number; sql?: string } = {}) {
  const ctx = createMockContext({ errors: gnomadDataframeQuery.errors });
  return (await gnomadDataframeQuery.handler(
    gnomadDataframeQuery.input.parse({ canvas_id: CANVAS_ID, sql: 'SELECT n FROM t', ...input }),
    ctx as never,
  )) as Page;
}

/** Follow next_offset from 0 until it is null, collecting every page. */
async function walk(limit?: number): Promise<Page[]> {
  const pages: Page[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = await runPage({ offset, ...(limit !== undefined && { limit }) });
    pages.push(page);
    offset = page.next_offset;
  }
  return pages;
}

const textOf = (content: unknown) =>
  (content as { type: string; text?: string }[]).map((block) => block.text ?? '').join('\n');

describe('gnomad_dataframe_query paging', () => {
  it('returns the first 100 rows by default with the exact total and next_offset', async () => {
    const { query } = stubCanvas(numbered(250));

    const page = await runPage();

    expect(page.rows).toEqual(numbered(100));
    expect(page).toMatchObject({
      columns: ['n'],
      offset: 0,
      returned: 100,
      total: 250,
      truncated: true,
      next_offset: 100,
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith('SELECT n FROM t', { signal: expect.any(AbortSignal) });
  });

  it('returns the tail page with truncated false and next_offset null', async () => {
    stubCanvas(numbered(4544));

    const page = await runPage({ offset: 4500 });

    expect(page.rows).toEqual(numbered(4544).slice(4500));
    expect(page).toMatchObject({
      offset: 4500,
      returned: 44,
      total: 4544,
      truncated: false,
      next_offset: null,
    });
  });

  it.each([
    [100, 3],
    [500, 1],
    [7, 36],
  ])(
    'walks next_offset at limit %i across every row with no gap or duplicate',
    async (limit, pageCount) => {
      stubCanvas(numbered(250));

      const pages = await walk(limit);

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

  it('ends a page before its row JSON passes 10,000 characters', async () => {
    stubCanvas(Array.from({ length: 30 }, () => sized(1_000)));

    const page = await runPage();

    expect(rowChars(page.rows)).toBe(PAGE_CHARS);
    expect(page).toMatchObject({ returned: 10, total: 30, truncated: true, next_offset: 10 });
  });

  it('keeps a row that lands exactly on the budget and cuts the one after it', async () => {
    stubCanvas([sized(4_000, 'a'), sized(6_000, 'b'), sized(9, 'c')]);

    const first = await runPage();
    expect(first.rows).toEqual([sized(4_000, 'a'), sized(6_000, 'b')]);
    expect(first).toMatchObject({ returned: 2, truncated: true, next_offset: 2 });

    const second = await runPage({ offset: 2 });
    expect(second.rows).toEqual([sized(9, 'c')]);
    expect(second).toMatchObject({ returned: 1, truncated: false, next_offset: null });
  });

  it('walks variable-width rows through budget-cut pages with no gap or duplicate', async () => {
    const rows = Array.from({ length: 120 }, (_, n) => ({ n, pad: 'x'.repeat((n % 9) * 230) }));
    stubCanvas(rows);

    const pages = await walk();

    expect(pages.flatMap((page) => page.rows)).toEqual(rows);
    expect(pages.length).toBeGreaterThan(2);
    for (const [i, page] of pages.entries()) {
      expect(rowChars(page.rows)).toBeLessThanOrEqual(PAGE_CHARS);
      const next = pages[i + 1];
      // Each cut page is maximal: the next row would have pushed it over the budget.
      if (next && page.returned < 100) {
        expect(rowChars([...page.rows, next.rows[0] as Row])).toBeGreaterThan(PAGE_CHARS);
      }
    }
  });

  it('reports total null above the row cap and stops next_offset at the cap', async () => {
    stubCanvas(numbered(1_000), { truncated: true });

    const pages = await walk(500);

    expect(pages.flatMap((page) => page.rows)).toEqual(numbered(1_000));
    expect(pages.map((page) => page.total)).toEqual([null, null]);
    expect(pages.map((page) => page.truncated)).toEqual([true, true]);
    expect(pages.map((page) => page.next_offset)).toEqual([500, null]);
  });

  it('keeps truncated true on an offset past the cap of a result above the cap', async () => {
    stubCanvas(numbered(1_000), { truncated: true });

    const page = await runPage({ offset: 1_200 });

    expect(page).toMatchObject({
      rows: [],
      offset: 1_200,
      returned: 0,
      total: null,
      truncated: true,
      next_offset: null,
    });
  });

  it('returns an empty page for an offset past the last row', async () => {
    stubCanvas(numbered(44));

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
    stubCanvas([], { columns: ['variant_id', 'af'] });

    const page = await runPage();

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

describe('gnomad_dataframe_query row_too_large', () => {
  it('fails the first page when its first row is over the budget, returning no rows', async () => {
    stubCanvas([sized(200_016), sized(20)]);

    const result = await runToolContract(
      gnomadDataframeQuery,
      { canvas_id: CANVAS_ID, sql: "SELECT repeat('x', 200000) AS big" },
      { context: { tenantId: 'default' } },
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'row_too_large',
          offset: 0,
          row_chars: 200_016,
          recovery: { hint: expect.stringMatching(/narrower projection/) },
        },
      },
    });
    expect(textOf(result.content)).toContain('200016 characters');
    expect(textOf(result.content)).not.toContain('xxxxxxxxxx');
  });

  it('fails at the offset where an oversized row starts a later page', async () => {
    stubCanvas([sized(20, 'a'), sized(20, 'b'), sized(PAGE_CHARS + 1), sized(20, 'c')]);

    const first = await runPage();
    expect(first).toMatchObject({ returned: 2, truncated: true, next_offset: 2 });

    await expect(runPage({ offset: 2 })).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'row_too_large', offset: 2, row_chars: PAGE_CHARS + 1 },
    });
  });

  it('accepts a single row of exactly 10,000 characters', async () => {
    stubCanvas([sized(PAGE_CHARS), sized(20)]);

    const page = await runPage();

    expect(page).toMatchObject({ returned: 1, truncated: true, next_offset: 1 });
  });
});

describe('gnomad_dataframe_query input and contract', () => {
  it('defaults offset to 0 and limit to 100', () => {
    expect(
      gnomadDataframeQuery.input.parse({ canvas_id: CANVAS_ID, sql: 'SELECT 1' }),
    ).toMatchObject({ offset: 0, limit: 100 });
  });

  it.each([{ limit: 0 }, { limit: 501 }, { limit: 2.5 }, { offset: -1 }, { offset: 1.5 }])(
    'rejects out-of-range paging input %o at the tool boundary',
    async (bounds) => {
      const result = await runToolContract(
        gnomadDataframeQuery,
        { canvas_id: CANVAS_ID, sql: 'SELECT 1', ...bounds },
        { context: { tenantId: 'default' } },
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
    },
  );

  it('accepts the limit bounds 1 and 500', () => {
    for (const limit of [1, 500]) {
      expect(
        gnomadDataframeQuery.input.parse({ canvas_id: CANVAS_ID, sql: 'SELECT 1', limit }).limit,
      ).toBe(limit);
    }
  });

  it('rejects a canvas_id outside the minted shape, or empty sql, at parse time', () => {
    expect(() => gnomadDataframeQuery.input.parse({ canvas_id: '', sql: 'SELECT 1' })).toThrow();
    expect(() =>
      gnomadDataframeQuery.input.parse({ canvas_id: 'cnvq', sql: 'SELECT 1' }),
    ).toThrow();
    expect(() => gnomadDataframeQuery.input.parse({ canvas_id: CANVAS_ID, sql: '' })).toThrow();
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

  it('throws ctx.fail("canvas_disabled") when DataCanvas is off', async () => {
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const ctx = createMockContext({ errors: gnomadDataframeQuery.errors });
    const input = gnomadDataframeQuery.input.parse({ canvas_id: CANVAS_ID, sql: 'SELECT 1' });
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
    stubCanvas(rows);

    const result = await runToolContract(
      gnomadDataframeQuery,
      { canvas_id: CANVAS_ID, sql: 'SELECT variant_id, af FROM gene_variants', offset: 20 },
      { context: { tenantId: 'default' } },
    );

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as unknown as Page;
    expect(structured.rows).toEqual(rows.slice(20, 120));
    const text = textOf(result.content);
    const rowLines = text.split('\n').filter((line) => line.startsWith('- {'));
    expect(rowLines).toEqual(structured.rows.map((row) => `- ${JSON.stringify(row)}`));
    expect(text).toContain('**columns:** variant_id, af');
    expect(text).toContain('**offset:** 20');
    expect(text).toContain('**returned:** 100');
    expect(text).toContain('**total:** 150');
    expect(text).toContain('**truncated:** true');
    expect(text).toContain('**next_offset:** 120');
  });

  it('renders total null, a cap note, and next_offset null on the last page above the cap', async () => {
    stubCanvas(numbered(300), { truncated: true });

    const result = await runToolContract(
      gnomadDataframeQuery,
      { canvas_id: CANVAS_ID, sql: 'SELECT n FROM t', offset: 200 },
      { context: { tenantId: 'default' } },
    );

    const text = textOf(result.content);
    expect(text.split('\n').filter((line) => line.startsWith('- {'))).toHaveLength(100);
    expect(text).toContain('**total:** null');
    expect(text).toContain('**truncated:** true');
    expect(text).toContain('**next_offset:** null');
    expect(text).toMatch(/row cap/);
  });

  it('renders an empty page without row lines', async () => {
    stubCanvas([], { columns: ['a'] });

    const result = await runToolContract(
      gnomadDataframeQuery,
      { canvas_id: CANVAS_ID, sql: 'SELECT a FROM t' },
      { context: { tenantId: 'default' } },
    );

    const text = textOf(result.content);
    expect(text.split('\n').filter((line) => line.startsWith('- {'))).toEqual([]);
    expect(text).toContain('**returned:** 0');
    expect(text).toContain('**total:** 0');
    expect(text).toContain('**next_offset:** null');
  });
});
