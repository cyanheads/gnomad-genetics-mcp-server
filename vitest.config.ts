/**
 * @fileoverview Vitest config for the consumer server. Uses Vitest 4 `projects`
 * so you can split suites (unit/smoke/integration/fuzz) and run each with
 * `--project <name>` as the surface grows. Extends the framework's base config
 * for shared `resolve`, `ssr`, and coverage settings.
 *
 * @module vitest.config
 */

import coreConfig from '@cyanheads/mcp-ts-core/vitest.config';
import { defineConfig, mergeConfig } from 'vitest/config';

const alias = { '@/': new URL('./src/', import.meta.url).pathname };

/**
 * Vitest 5.1's forks pool calls `child.channel.unref()`, which Bun's child-process
 * IPC channel lacks, so under `bun --bun` no fork starts. Bun runs each file on its
 * own worker thread instead; Node keeps the base config's forks. Threads inherit the
 * coordinator's time zone, so a test that switches TZ or spawns its own worker thread
 * would need forks; none here does.
 */
const bunPool = process.versions.bun ? { pool: 'threads' as const } : {};

export default mergeConfig(
  coreConfig,
  defineConfig({
    resolve: { alias },
    test: {
      ...bunPool,
      projects: [
        {
          extends: true,
          test: {
            name: 'unit',
            include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
            exclude: ['tests/smoke/**', 'tests/integration/**', 'tests/fuzz/**'],
          },
        },
        {
          extends: true,
          test: {
            name: 'smoke',
            include: ['tests/smoke/**/*.test.ts'],
          },
        },
        {
          extends: true,
          test: {
            name: 'fuzz',
            include: ['tests/fuzz/**/*.test.ts'],
            testTimeout: 15_000,
          },
        },
        {
          extends: true,
          test: {
            name: 'integration',
            include: ['tests/integration/**/*.test.ts'],
            maxWorkers: 1,
            testTimeout: 30_000,
          },
        },
      ],
    },
  }),
);
