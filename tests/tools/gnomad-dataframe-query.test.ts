/**
 * @fileoverview Behavior tests for the gnomad_dataframe_query handler — runs SQL
 * against an acquired canvas instance, passes through the truncated flag, and
 * fails with the canvas_disabled contract when DataCanvas is off. Stubs the
 * canvas accessor with a fake instance whose query() returns a fixed result.
 * @module tests/tools/gnomad-dataframe-query.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { gnomadDataframeQuery } from '@/mcp-server/tools/definitions/gnomad-dataframe-query.tool.js';
import * as canvasAccessor from '@/services/canvas-accessor.js';

/** Build a canvas whose acquired instance returns a fixed query result. */
function stubCanvas(queryResult: {
  rows: Record<string, unknown>[];
  rowCount: number;
  columns: string[];
  truncated?: boolean;
}) {
  const query = vi.fn(async () => queryResult);
  const instance = { canvasId: 'cnvq', query };
  const canvas = { acquire: vi.fn(async () => instance) };
  vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(canvas as never);
  return { canvas, instance, query };
}

describe('gnomad_dataframe_query handler', () => {
  it('returns rows, row_count, and columns from the canvas query', async () => {
    const { query } = stubCanvas({
      rows: [{ variant_id: '1-100-A-T', af: 0.01 }],
      rowCount: 1,
      columns: ['variant_id', 'af'],
    });

    const ctx = createMockContext({ errors: gnomadDataframeQuery.errors });
    const input = gnomadDataframeQuery.input.parse({
      canvas_id: 'cnvq',
      sql: 'SELECT variant_id, af FROM gene_variants ORDER BY af DESC',
    });
    const result = await gnomadDataframeQuery.handler(input, ctx as never);

    expect(result.row_count).toBe(1);
    expect(result.columns).toEqual(['variant_id', 'af']);
    expect(result.truncated).toBe(false);
    expect(query).toHaveBeenCalledWith(input.sql, expect.objectContaining({ signal: ctx.signal }));
  });

  it('passes through truncated=true when the result was clipped at the row cap', async () => {
    stubCanvas({
      rows: Array.from({ length: 3 }, (_, i) => ({ n: i })),
      rowCount: 3,
      columns: ['n'],
      truncated: true,
    });

    const ctx = createMockContext({ errors: gnomadDataframeQuery.errors });
    const input = gnomadDataframeQuery.input.parse({ canvas_id: 'cnvq', sql: 'SELECT n FROM t' });
    const result = await gnomadDataframeQuery.handler(input, ctx as never);

    expect(result.truncated).toBe(true);
  });

  it('throws ctx.fail("canvas_disabled") when DataCanvas is off', async () => {
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const ctx = createMockContext({ errors: gnomadDataframeQuery.errors });
    const input = gnomadDataframeQuery.input.parse({ canvas_id: 'cnvq', sql: 'SELECT 1' });
    await expect(gnomadDataframeQuery.handler(input, ctx as never)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'canvas_disabled' },
    });
  });

  it('rejects an empty canvas_id or empty sql at parse time', () => {
    expect(() => gnomadDataframeQuery.input.parse({ canvas_id: '', sql: 'SELECT 1' })).toThrow();
    expect(() => gnomadDataframeQuery.input.parse({ canvas_id: 'cnvq', sql: '' })).toThrow();
  });

  it('renders the row count, columns, and a truncated marker in format()', () => {
    const text = (
      gnomadDataframeQuery.format?.({
        rows: [{ a: 1 }],
        row_count: 1,
        columns: ['a'],
        truncated: true,
      }) ?? []
    )
      .map((b) => ('text' in b ? b.text : ''))
      .join('');
    expect(text).toContain('1 row(s)');
    expect(text).toContain('[a]');
    expect(text).toContain('(truncated)');
  });
});
