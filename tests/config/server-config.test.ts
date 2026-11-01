/**
 * @fileoverview The definition-time reads of src/config/server-config.ts.
 * isCanvasEnabled() turns off only on an explicit CANVAS_PROVIDER_TYPE=none, since
 * the entrypoint defaults an unset value to duckdb after the definitions
 * evaluate. isClampLimitsEnabled() reads GNOMAD_CLAMP_LIMITS as on by default,
 * off for a false spelling, and falls back to its default on an invalid value,
 * which the full configuration read then rejects, naming the variable.
 * @module tests/config/server-config.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getServerConfig,
  isCanvasEnabled,
  isClampLimitsEnabled,
  resetServerConfig,
} from '@/config/server-config.js';

afterEach(() => {
  vi.unstubAllEnvs();
  resetServerConfig();
});

describe('isCanvasEnabled', () => {
  it.each([undefined, '', '   ', `\${CANVAS_PROVIDER_TYPE}`, 'duckdb'])(
    'reads CANVAS_PROVIDER_TYPE=%j as on',
    (value) => {
      vi.stubEnv('CANVAS_PROVIDER_TYPE', value);
      expect(isCanvasEnabled()).toBe(true);
    },
  );

  it('reads CANVAS_PROVIDER_TYPE=none as off', () => {
    vi.stubEnv('CANVAS_PROVIDER_TYPE', 'none');
    expect(isCanvasEnabled()).toBe(false);
  });
});

describe('isClampLimitsEnabled', () => {
  it.each([undefined, '', `\${GNOMAD_CLAMP_LIMITS}`, 'true', '1', 'yes', 'on'])(
    'reads GNOMAD_CLAMP_LIMITS=%j as on, as the full read does',
    (value) => {
      vi.stubEnv('GNOMAD_CLAMP_LIMITS', value);
      expect(isClampLimitsEnabled()).toBe(true);
      expect(getServerConfig().clampLimits).toBe(true);
    },
  );

  it.each(['false', '0', 'no', 'off'])(
    'reads GNOMAD_CLAMP_LIMITS=%j as off, as the full read does',
    (value) => {
      vi.stubEnv('GNOMAD_CLAMP_LIMITS', value);
      expect(isClampLimitsEnabled()).toBe(false);
      expect(getServerConfig().clampLimits).toBe(false);
    },
  );

  it('falls back to on for an invalid value, which the full read rejects by name', () => {
    vi.stubEnv('GNOMAD_CLAMP_LIMITS', 'invalid');
    expect(isClampLimitsEnabled()).toBe(true);
    expect(() => getServerConfig()).toThrow(/GNOMAD_CLAMP_LIMITS/);
  });
});
