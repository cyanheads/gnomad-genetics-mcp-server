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
  return { variant: gnomadGetVariant, drop: gnomadDataframeDrop };
}

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

  it.each([
    ['GNOMAD_MAX_CONCURRENCY', 'abc'],
    ['GNOMAD_MAX_VARIANT_BATCH', '-1'],
    ['GNOMAD_DATAFRAME_DROP_ENABLED', 'invalid'],
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
