/**
 * @fileoverview Behavior tests for the gnomad_dataframe_describe handler — maps
 * the canvas instance's describe() output (TableInfo[]) into the tool's
 * tables[] shape, and fails with the canvas_disabled contract when DataCanvas
 * is off. Stubs the canvas accessor.
 * @module tests/tools/gnomad-dataframe-describe.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { gnomadDataframeDescribe } from '@/mcp-server/tools/definitions/gnomad-dataframe-describe.tool.js';
import * as canvasAccessor from '@/services/canvas-accessor.js';

/** Build a canvas whose acquired instance returns a fixed describe() result. */
function stubCanvas(
  tables: Array<{ name: string; rowCount: number; columns: { name: string; type: string }[] }>,
) {
  const instance = { canvasId: 'cnvd', describe: vi.fn(async () => tables) };
  const canvas = { acquire: vi.fn(async () => instance) };
  vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(canvas as never);
  return { canvas, instance };
}

describe('gnomad_dataframe_describe handler', () => {
  it('maps canvas tables, row counts, and column schemas', async () => {
    stubCanvas([
      {
        name: 'gene_variants',
        rowCount: 1000,
        columns: [
          { name: 'variant_id', type: 'VARCHAR' },
          { name: 'af', type: 'DOUBLE' },
        ],
      },
    ]);

    const ctx = createMockContext({ errors: gnomadDataframeDescribe.errors });
    const input = gnomadDataframeDescribe.input.parse({ canvas_id: 'cnvd' });
    const result = await gnomadDataframeDescribe.handler(input, ctx as never);

    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]).toMatchObject({ name: 'gene_variants', row_count: 1000 });
    expect(result.tables[0]?.columns).toEqual([
      { name: 'variant_id', type: 'VARCHAR' },
      { name: 'af', type: 'DOUBLE' },
    ]);
    expect(result).toEqual(expect.schemaMatching(gnomadDataframeDescribe.output));
  });

  it('returns an empty tables array for a canvas with nothing staged', async () => {
    stubCanvas([]);

    const ctx = createMockContext({ errors: gnomadDataframeDescribe.errors });
    const input = gnomadDataframeDescribe.input.parse({ canvas_id: 'cnvd' });
    const result = await gnomadDataframeDescribe.handler(input, ctx as never);

    expect(result.tables).toEqual([]);
  });

  it('throws ctx.fail("canvas_disabled") when DataCanvas is off', async () => {
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const ctx = createMockContext({ errors: gnomadDataframeDescribe.errors });
    const input = gnomadDataframeDescribe.input.parse({ canvas_id: 'cnvd' });
    await expect(gnomadDataframeDescribe.handler(input, ctx as never)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'canvas_disabled' },
    });
  });

  it('renders "No tables staged" in format() for an empty canvas', () => {
    const text = (gnomadDataframeDescribe.format?.({ tables: [] }) ?? [])
      .map((b) => ('text' in b ? b.text : ''))
      .join('');
    expect(text).toContain('No tables staged');
  });

  it('renders table name, row count, and columns in format()', () => {
    const text = (
      gnomadDataframeDescribe.format?.({
        tables: [
          {
            name: 'gene_variants',
            row_count: 5,
            columns: [{ name: 'af', type: 'DOUBLE' }],
          },
        ],
      }) ?? []
    )
      .map((b) => ('text' in b ? b.text : ''))
      .join('');
    expect(text).toContain('gene_variants');
    expect(text).toContain('5 rows');
    expect(text).toContain('af:DOUBLE');
  });
});
