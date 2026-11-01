/**
 * @fileoverview GNOMAD_NORMALIZE_IDS parsing — on by default and for a blank
 * value, off only for an explicit false spelling, and an invalid value fails
 * the configuration read setup() makes, naming the variable.
 * @module tests/config/normalize-ids.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig, resetServerConfig } from '@/config/server-config.js';
import { initGnomadService } from '@/services/gnomad/gnomad-service.js';

afterEach(() => {
  vi.unstubAllEnvs();
  resetServerConfig();
});

function withNormalizeIds(value: string | undefined): void {
  vi.stubEnv('GNOMAD_NORMALIZE_IDS', value);
  resetServerConfig();
}

describe('GNOMAD_NORMALIZE_IDS', () => {
  it.each([undefined, '', 'true', '1', 'yes', 'on'])('reads %j as on', (value) => {
    withNormalizeIds(value);
    expect(getServerConfig().normalizeIds).toBe(true);
  });

  it.each(['false', '0', 'no', 'off'])('reads %j as off', (value) => {
    withNormalizeIds(value);
    expect(getServerConfig().normalizeIds).toBe(false);
  });

  it.each(['maybe', 'nope'])(
    'fails the startup configuration read on %j, naming the variable',
    (value) => {
      withNormalizeIds(value);
      expect(() => getServerConfig()).toThrow(/GNOMAD_NORMALIZE_IDS/);
      // setup() initializes the service from the same read, so startup stops there.
      expect(() => initGnomadService({} as never, {} as never)).toThrow(/GNOMAD_NORMALIZE_IDS/);
    },
  );
});
