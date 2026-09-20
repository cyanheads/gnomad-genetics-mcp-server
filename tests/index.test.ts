/**
 * @fileoverview Tests for the createApp() wiring in src/index.ts. Pins the
 * session posture the server declares in code, so the resolved mode cannot
 * drift back to depending on how the process was launched.
 * @module tests/index.test
 */

import { describe, expect, it, vi } from 'vitest';

const { createApp } = vi.hoisted(() => ({ createApp: vi.fn() }));

vi.mock('@cyanheads/mcp-ts-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core')>()),
  createApp,
}));

describe('createApp wiring', () => {
  it('declares the stateless session posture in code', async () => {
    await import('@/index.js');

    expect(createApp).toHaveBeenCalledTimes(1);
    expect(createApp.mock.calls[0]?.[0]).toMatchObject({
      name: 'gnomad-genetics-mcp-server',
      sessionMode: 'stateless',
    });
  });
});
