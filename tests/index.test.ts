/**
 * @fileoverview Tests for the createApp() wiring in src/index.ts. Pins the
 * session posture the server declares in code, so the resolved mode cannot
 * drift back to depending on how the process was launched, and the DataCanvas
 * default (duckdb unless CANVAS_PROVIDER_TYPE says otherwise).
 * @module tests/index.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createApp } = vi.hoisted(() => ({ createApp: vi.fn() }));

vi.mock('@cyanheads/mcp-ts-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core')>()),
  createApp,
}));

describe('createApp wiring', () => {
  beforeEach(() => {
    // Each test re-runs src/index.ts against a fresh framework config module,
    // and a developer's ./.env never leaks into the resolved environment.
    vi.resetModules();
    createApp.mockClear();
    vi.spyOn(process, 'loadEnvFile').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // Importing src/index.ts loads the whole server graph, which can outlast the
  // default 5 s timeout when the suite runs under CPU contention.
  it('declares the stateless session posture in code', { timeout: 30_000 }, async () => {
    await import('@/index.js');

    expect(createApp).toHaveBeenCalledTimes(1);
    expect(createApp.mock.calls[0]?.[0]).toMatchObject({
      name: 'gnomad-genetics-mcp-server',
      sessionMode: 'stateless',
    });
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['placeholder', `\${CANVAS_PROVIDER_TYPE}`],
  ])(
    'defaults DataCanvas to duckdb when CANVAS_PROVIDER_TYPE is %s',
    { timeout: 30_000 },
    async (_label, value) => {
      vi.stubEnv('CANVAS_PROVIDER_TYPE', value);

      await import('@/index.js');
      const { config } = await import('@cyanheads/mcp-ts-core/config');

      expect(process.env.CANVAS_PROVIDER_TYPE).toBe('duckdb');
      expect(config.canvas.providerType).toBe('duckdb');
    },
  );

  it('keeps CANVAS_PROVIDER_TYPE=none disabled', { timeout: 30_000 }, async () => {
    vi.stubEnv('CANVAS_PROVIDER_TYPE', 'none');

    await import('@/index.js');
    const { config } = await import('@cyanheads/mcp-ts-core/config');

    expect(process.env.CANVAS_PROVIDER_TYPE).toBe('none');
    expect(config.canvas.providerType).toBe('none');
  });
});
