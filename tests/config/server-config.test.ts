/**
 * @fileoverview The definition-time reads of src/config/server-config.ts.
 * isCanvasEnabled() turns off only on an explicit CANVAS_PROVIDER_TYPE=none, since
 * the entrypoint defaults an unset value to duckdb after the definitions
 * evaluate. isClampLimitsEnabled() reads GNOMAD_CLAMP_LIMITS as on by default,
 * off for a false spelling, and falls back to its default on an invalid value,
 * which the full configuration read then rejects, naming the variable.
 * GNOMAD_DATASETS holds gnomAD's whole DatasetId enum, and GNOMAD_DEFAULT_DATASET
 * takes any of its values.
 * @module tests/config/server-config.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GNOMAD_DATASETS,
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

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/68
describe('GNOMAD_DATASETS', () => {
  /** gnomAD's DatasetId enum, as its GraphQL schema introspected on 2026-11-03. */
  const DATASET_ID = [
    'gnomad_r4',
    'gnomad_r4_non_ukb',
    'gnomad_r3',
    'gnomad_r3_controls_and_biobanks',
    'gnomad_r3_non_cancer',
    'gnomad_r3_non_neuro',
    'gnomad_r3_non_topmed',
    'gnomad_r3_non_v2',
    'gnomad_r2_1',
    'gnomad_r2_1_controls',
    'gnomad_r2_1_non_neuro',
    'gnomad_r2_1_non_cancer',
    'gnomad_r2_1_non_topmed',
    'exac',
  ];

  it('holds every value of gnomAD’s DatasetId enum, in its order', () => {
    expect([...GNOMAD_DATASETS]).toEqual(DATASET_ID);
  });

  it.each(DATASET_ID)('takes GNOMAD_DEFAULT_DATASET=%s', (dataset) => {
    vi.stubEnv('GNOMAD_DEFAULT_DATASET', dataset);
    expect(getServerConfig().defaultDataset).toBe(dataset);
  });

  it('rejects an unknown GNOMAD_DEFAULT_DATASET by name', () => {
    vi.stubEnv('GNOMAD_DEFAULT_DATASET', 'gnomad_r4_non_cancer');
    expect(() => getServerConfig()).toThrow(/GNOMAD_DEFAULT_DATASET/);
  });
});
