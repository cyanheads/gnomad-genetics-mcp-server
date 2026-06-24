/**
 * @fileoverview Behavior tests for the gnomad_dataframe_drop handler — the opt-in
 * mutator. Drops a named canvas table (true when it existed, false when it did
 * not) and fails with the canvas_disabled contract when DataCanvas is off. The
 * exported definition is wrapped by disabledTool() when the gate is off, but the
 * handler stays callable, so these exercise the real drop logic. Stubs the
 * canvas accessor.
 * @module tests/tools/gnomad-dataframe-drop.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { gnomadDataframeDrop } from '@/mcp-server/tools/definitions/gnomad-dataframe-drop.tool.js';
import * as canvasAccessor from '@/services/canvas-accessor.js';

/** Build a canvas whose acquired instance's drop() returns the given result. */
function stubCanvas(dropResult: boolean) {
  const drop = vi.fn(async () => dropResult);
  const instance = { canvasId: 'cnvdrop', drop };
  const canvas = { acquire: vi.fn(async () => instance) };
  vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(canvas as never);
  return { canvas, instance, drop };
}

describe('gnomad_dataframe_drop handler', () => {
  it('reports dropped=true when the table existed', async () => {
    const { drop } = stubCanvas(true);

    const ctx = createMockContext({ errors: gnomadDataframeDrop.errors });
    const input = gnomadDataframeDrop.input.parse({
      canvas_id: 'cnvdrop',
      table_name: 'gene_variants',
    });
    const result = await gnomadDataframeDrop.handler(input, ctx as never);

    expect(result.dropped).toBe(true);
    expect(drop).toHaveBeenCalledWith('gene_variants');
  });

  it('reports dropped=false when no such table exists', async () => {
    stubCanvas(false);

    const ctx = createMockContext({ errors: gnomadDataframeDrop.errors });
    const input = gnomadDataframeDrop.input.parse({
      canvas_id: 'cnvdrop',
      table_name: 'nonexistent',
    });
    const result = await gnomadDataframeDrop.handler(input, ctx as never);

    expect(result.dropped).toBe(false);
  });

  it('throws ctx.fail("canvas_disabled") when DataCanvas is off', async () => {
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const ctx = createMockContext({ errors: gnomadDataframeDrop.errors });
    const input = gnomadDataframeDrop.input.parse({
      canvas_id: 'cnvdrop',
      table_name: 'gene_variants',
    });
    await expect(gnomadDataframeDrop.handler(input, ctx as never)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'canvas_disabled' },
    });
  });

  it('rejects an empty canvas_id or table_name at parse time', () => {
    expect(() =>
      gnomadDataframeDrop.input.parse({ canvas_id: '', table_name: 'gene_variants' }),
    ).toThrow();
    expect(() =>
      gnomadDataframeDrop.input.parse({ canvas_id: 'cnvdrop', table_name: '' }),
    ).toThrow();
  });

  it('renders distinct text for dropped vs. not-found in format()', () => {
    const droppedText = (gnomadDataframeDrop.format?.({ dropped: true }) ?? [])
      .map((b) => ('text' in b ? b.text : ''))
      .join('');
    const missingText = (gnomadDataframeDrop.format?.({ dropped: false }) ?? [])
      .map((b) => ('text' in b ? b.text : ''))
      .join('');
    expect(droppedText).toContain('Table dropped');
    expect(missingText).toContain('No such table');
  });
});
