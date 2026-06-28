/**
 * @fileoverview Regression for the GNOMAD_MAX_VARIANT_BATCH wiring — the env var
 * must drive the gnomad_get_variant batch cap (advertised input schema AND
 * parse-time validation), not a hard-coded 25. The override is set BEFORE the
 * tool is imported so the module-load config read sees it; Vitest isolates this
 * file, so the change does not leak into other suites.
 * @module tests/tools/gnomad-get-variant.batch-config.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { afterAll, expect, test } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';

const previous = process.env.GNOMAD_MAX_VARIANT_BATCH;

afterAll(() => {
  if (previous === undefined) delete process.env.GNOMAD_MAX_VARIANT_BATCH;
  else process.env.GNOMAD_MAX_VARIANT_BATCH = previous;
  resetServerConfig();
});

const batch = (n: number) => Array.from({ length: n }, (_, i) => `1-${1000 + i}-A-T`);

test('GNOMAD_MAX_VARIANT_BATCH drives the accepted batch size and advertised maxItems', async () => {
  process.env.GNOMAD_MAX_VARIANT_BATCH = '30';
  resetServerConfig();
  const { gnomadGetVariant } = await import(
    '@/mcp-server/tools/definitions/gnomad-get-variant.tool.js'
  );

  // The previously hard-coded cap of 25 would reject 26; the configured 30 accepts it.
  expect(gnomadGetVariant.input.safeParse({ variants: batch(26) }).success).toBe(true);
  expect(gnomadGetVariant.input.safeParse({ variants: batch(30) }).success).toBe(true);
  expect(gnomadGetVariant.input.safeParse({ variants: batch(31) }).success).toBe(false);

  // The cap clients see in tools/list reflects the configured value, not 25.
  const json = z.toJSONSchema(gnomadGetVariant.input) as {
    properties: { variants: { maxItems?: number } };
  };
  expect(json.properties.variants.maxItems).toBe(30);

  // …and the configured value is woven into the field description.
  expect(gnomadGetVariant.input.shape.variants.description).toContain('30');
});
