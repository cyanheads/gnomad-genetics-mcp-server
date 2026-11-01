/**
 * @fileoverview Import-time configuration reads must not validate or cache unrelated fields.
 * @module tests/tools/definition-config.test
 */
import { z } from '@cyanheads/mcp-ts-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function definitions() {
  const { gnomadGetVariant } = await import(
    '@/mcp-server/tools/definitions/gnomad-get-variant.tool.js'
  );
  const { gnomadDataframeDrop } = await import(
    '@/mcp-server/tools/definitions/gnomad-dataframe-drop.tool.js'
  );
  const { gnomadDataframeQuery } = await import(
    '@/mcp-server/tools/definitions/gnomad-dataframe-query.tool.js'
  );
  const { gnomadDataframeDescribe } = await import(
    '@/mcp-server/tools/definitions/gnomad-dataframe-describe.tool.js'
  );
  return {
    variant: gnomadGetVariant,
    drop: gnomadDataframeDrop,
    query: gnomadDataframeQuery,
    describe: gnomadDataframeDescribe,
  };
}

/** The disabledTool() reason on a definition; undefined when the tool is registered. */
const disabledReason = (definition: object) =>
  (definition as { __mcpDisabled?: { reason: string } }).__mcpDisabled?.reason;

describe('definition configuration', () => {
  it('characterizes schema and description agreement for an exported cap', async () => {
    vi.stubEnv('GNOMAD_MAX_VARIANT_BATCH', '2');
    const { variant } = await definitions();
    expect(z.toJSONSchema(variant.input)).toMatchObject({
      properties: { variants: { maxItems: 2 } },
    });
    expect(variant.input.shape.variants.description).toContain('2');
    expect(variant.input.safeParse({ variants: ['1-1-A-T', '1-2-A-T'] }).success).toBe(true);
    expect(variant.input.safeParse({ variants: ['1-1-A-T', '1-2-A-T', '1-3-A-T'] }).success).toBe(
      false,
    );
  });

  it.each([undefined, '', `\${CANVAS_PROVIDER_TYPE}`, 'duckdb'])(
    'registers the dataframe query and describe tools with CANVAS_PROVIDER_TYPE=%j',
    async (value) => {
      vi.stubEnv('CANVAS_PROVIDER_TYPE', value);
      const { query, describe, drop } = await definitions();
      expect(disabledReason(query)).toBeUndefined();
      expect(disabledReason(describe)).toBeUndefined();
      // The drop tool still follows its own gate, off by default.
      expect(disabledReason(drop)).toMatch(/drop is turned off/);
    },
  );

  it.each([undefined, 'true'])(
    'disables every dataframe tool with CANVAS_PROVIDER_TYPE=none and GNOMAD_DATAFRAME_DROP_ENABLED=%j',
    async (drop) => {
      vi.stubEnv('CANVAS_PROVIDER_TYPE', 'none');
      vi.stubEnv('GNOMAD_DATAFRAME_DROP_ENABLED', drop);
      const tools = await definitions();
      for (const tool of [tools.query, tools.describe, tools.drop]) {
        expect(disabledReason(tool)).toMatch(/DataCanvas is turned off/);
      }
    },
  );

  it('registers the drop tool when the canvas and its own gate are both on', async () => {
    vi.stubEnv('CANVAS_PROVIDER_TYPE', 'duckdb');
    vi.stubEnv('GNOMAD_DATAFRAME_DROP_ENABLED', 'true');
    const { drop } = await definitions();
    expect(disabledReason(drop)).toBeUndefined();
  });

  it('advertises no limit maximum on gnomad_dataframe_query, and 3,000 with GNOMAD_CLAMP_LIMITS=false', async () => {
    const over = { canvas_id: 'cnvquery01', sql: 'SELECT 1', limit: 3_001 };
    const clamping = (await definitions()).query.input;
    expect(z.toJSONSchema(clamping).properties?.limit).not.toHaveProperty('maximum');
    expect(clamping.safeParse(over).success).toBe(true);

    vi.resetModules();
    vi.stubEnv('GNOMAD_CLAMP_LIMITS', 'false');
    const strict = (await definitions()).query.input;
    expect(z.toJSONSchema(strict).properties?.limit).toMatchObject({ maximum: 3_000, default: 25 });
    expect(strict.safeParse(over).success).toBe(false);
  });

  it.each([
    ['GNOMAD_MAX_CONCURRENCY', 'abc'],
    ['GNOMAD_MAX_VARIANT_BATCH', '-1'],
    ['GNOMAD_DATAFRAME_DROP_ENABLED', 'invalid'],
    ['GNOMAD_CLAMP_LIMITS', 'invalid'],
  ])('defers invalid %s to full startup validation', async (name, value) => {
    vi.stubEnv(name, value);
    await expect(definitions()).resolves.toBeDefined();
    const { getServerConfig } = await import('@/config/server-config.js');
    expect(getServerConfig).toThrow(name);
  });

  it('does not seed the complete config cache while defining tools', async () => {
    await definitions();
    vi.stubEnv('GNOMAD_MAX_CONCURRENCY', '7');
    const { getServerConfig } = await import('@/config/server-config.js');
    expect(getServerConfig().maxConcurrency).toBe(7);
  });

  it.each(['', '   ', `\${GNOMAD_MAX_VARIANT_BATCH}`])(
    'uses schema defaults for blank or unsubstituted values: %j',
    async (value) => {
      vi.stubEnv('GNOMAD_MAX_VARIANT_BATCH', value);
      vi.stubEnv('GNOMAD_DATAFRAME_DROP_ENABLED', value);
      const { variant } = await definitions();
      expect(z.toJSONSchema(variant.input)).toMatchObject({
        properties: { variants: { maxItems: 25 } },
      });
      const { getServerConfig } = await import('@/config/server-config.js');
      expect(getServerConfig()).toMatchObject({ maxVariantBatch: 25, dataframeDropEnabled: false });
    },
  );
});
