/**
 * @fileoverview The shared `limit` count input and its clamp, tabled once here;
 * each paged tool's own suite proves only its wiring. GNOMAD_CLAMP_LIMITS, read
 * when a schema is built, picks the mode: clamping (the default) advertises a
 * default and a minimum with no maximum and lowers an over-cap value to the cap
 * with a notice, a log line, and a lazily created counter; strict advertises the
 * cap as the maximum and rejects anything above it.
 * @module tests/tools/count-limit.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { ATTR_MCP_TOOL_NAME } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CountLimit, clampLimit, limitSchema } from '@/mcp-server/tools/count-limit.js';

const { counter, createCounter } = vi.hoisted(() => {
  const counter = { add: vi.fn() };
  return { counter, createCounter: vi.fn(() => counter) };
});

vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  createCounter,
}));

const SPEC: CountLimit = { tool: 'gnomad_dataframe_query', default: 25, cap: 3_000 };
const LEAD = 'Maximum rows on the page.';
const WHOLE_NUMBER = 'Send limit as a whole number, such as 25.';

/** `limit` built with GNOMAD_CLAMP_LIMITS set to `mode`, wrapped as a tool input. */
function inputFor(mode: string | undefined) {
  vi.stubEnv('GNOMAD_CLAMP_LIMITS', mode);
  return z.object({ limit: limitSchema(SPEC, LEAD) });
}

beforeEach(() => {
  counter.add.mockClear();
  createCounter.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('limitSchema', () => {
  it('advertises a default and a minimum but no maximum while clamping', () => {
    const input = inputFor(undefined);

    expect(z.toJSONSchema(input).properties?.limit).toEqual({
      type: 'number',
      multipleOf: 1,
      minimum: 1,
      default: 25,
      description: `${LEAD} Default 25; a value above 3,000 is clamped to 3,000, with a notice.`,
    });
  });

  it('advertises the cap as the maximum with GNOMAD_CLAMP_LIMITS=false', () => {
    const input = inputFor('false');

    expect(z.toJSONSchema(input).properties?.limit).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: 3_000,
      default: 25,
      description: `${LEAD} Default 25; at most 3,000.`,
    });
  });

  it.each<[unknown, boolean, boolean]>([
    [1, true, true],
    [3_000, true, true],
    [3_001, true, false],
    [1e9, true, false],
    [0, false, false],
    [-5, false, false],
  ])('parses limit %j: clamping %s, strict %s', (value, clamping, strict) => {
    expect(inputFor(undefined).safeParse({ limit: value }).success).toBe(clamping);
    expect(inputFor('false').safeParse({ limit: value }).success).toBe(strict);
  });

  it.each([2.5, 20.000000000000004])(
    'rejects the fraction %j in both modes with one whole-number issue',
    (value) => {
      for (const mode of [undefined, 'false']) {
        const result = inputFor(mode).safeParse({ limit: value });
        expect(result.success).toBe(false);
        expect(result.error?.issues.map((issue) => issue.message)).toEqual([WHOLE_NUMBER]);
      }
    },
  );

  it('fills the default when limit is omitted, in both modes', () => {
    expect(inputFor(undefined).parse({}).limit).toBe(25);
    expect(inputFor('false').parse({}).limit).toBe(25);
  });
});

describe('clampLimit', () => {
  it.each([1, 3_000])('passes %i through with no notice, log line, or count', (requested) => {
    const ctx = createMockContext();
    const info = vi.spyOn(ctx.log, 'info');

    expect(clampLimit(ctx, SPEC, requested)).toEqual({ applied: requested });
    expect(info).not.toHaveBeenCalled();
    expect(counter.add).not.toHaveBeenCalled();
  });

  it('lowers an over-cap value to the cap with a notice, a log line, and one count', () => {
    const ctx = createMockContext();
    const info = vi.spyOn(ctx.log, 'info');

    expect(clampLimit(ctx, SPEC, 5_000)).toEqual({
      applied: 3_000,
      notice: 'Requested limit 5000 was clamped to the cap of 3000.',
    });
    expect(info).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith('Clamped limit to its cap', {
      tool: 'gnomad_dataframe_query',
      requested: 5_000,
      applied: 3_000,
    });
    expect(counter.add).toHaveBeenCalledOnce();
    expect(counter.add).toHaveBeenCalledWith(1, { [ATTR_MCP_TOOL_NAME]: 'gnomad_dataframe_query' });
  });

  it('lowers an over-cap value to the cap whatever GNOMAD_CLAMP_LIMITS reads at call time', () => {
    // The mode is read once, when a schema is built; a schema built clamping still reaches here.
    vi.stubEnv('GNOMAD_CLAMP_LIMITS', 'false');

    expect(clampLimit(createMockContext(), SPEC, 5_000)).toMatchObject({ applied: 3_000 });
  });

  it('creates its counter on the first clamp, not at import or for a value within the cap', async () => {
    vi.resetModules();
    const fresh = await import('@/mcp-server/tools/count-limit.js');
    const ctx = createMockContext();

    fresh.clampLimit(ctx, SPEC, 25);
    expect(createCounter).not.toHaveBeenCalled();

    fresh.clampLimit(ctx, SPEC, 4_000);
    fresh.clampLimit(ctx, SPEC, 9_000);
    expect(createCounter).toHaveBeenCalledOnce();
    expect(createCounter).toHaveBeenCalledWith(
      'gnomad.input.limit_clamped',
      expect.any(String),
      '{requests}',
    );
    expect(counter.add).toHaveBeenCalledTimes(2);
  });
});
