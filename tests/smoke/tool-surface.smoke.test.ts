/**
 * @fileoverview Offline smoke test for the complete nine-tool MCP surface.
 * Confirms every definition loads, has a unique public name, advertises input
 * and output contracts, keeps build identity on every gnomAD data response, and
 * keeps each definition's server-authored text under its byte ceiling.
 * @module tests/smoke/tool-surface.smoke.test
 */

import { type AnyToolDefinition, z } from '@cyanheads/mcp-ts-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gnomadDataframeDescribe } from '@/mcp-server/tools/definitions/gnomad-dataframe-describe.tool.js';
import { gnomadDataframeDrop } from '@/mcp-server/tools/definitions/gnomad-dataframe-drop.tool.js';
import { gnomadDataframeQuery } from '@/mcp-server/tools/definitions/gnomad-dataframe-query.tool.js';
import { gnomadGetCoverage } from '@/mcp-server/tools/definitions/gnomad-get-coverage.tool.js';
import { gnomadGetGeneConstraint } from '@/mcp-server/tools/definitions/gnomad-get-gene-constraint.tool.js';
import { gnomadGetVariant } from '@/mcp-server/tools/definitions/gnomad-get-variant.tool.js';
import { gnomadGetVariantCooccurrence } from '@/mcp-server/tools/definitions/gnomad-get-variant-cooccurrence.tool.js';
import { gnomadListGeneVariants } from '@/mcp-server/tools/definitions/gnomad-list-gene-variants.tool.js';
import { gnomadSearchClinvar } from '@/mcp-server/tools/definitions/gnomad-search-clinvar.tool.js';
import { serverAuthoredBytes } from '../helpers/definition-bytes.js';

const tools = [
  gnomadGetVariant,
  gnomadListGeneVariants,
  gnomadGetGeneConstraint,
  gnomadGetCoverage,
  gnomadGetVariantCooccurrence,
  gnomadSearchClinvar,
  gnomadDataframeQuery,
  gnomadDataframeDescribe,
  gnomadDataframeDrop,
];

describe('nine-tool surface', () => {
  it('loads every expected definition exactly once with schemas and annotations', () => {
    expect(tools.map((definition) => definition.name)).toEqual([
      'gnomad_get_variant',
      'gnomad_list_gene_variants',
      'gnomad_get_gene_constraint',
      'gnomad_get_coverage',
      'gnomad_get_variant_cooccurrence',
      'gnomad_search_clinvar',
      'gnomad_dataframe_query',
      'gnomad_dataframe_describe',
      'gnomad_dataframe_drop',
    ]);
    expect(new Set(tools.map((definition) => definition.name)).size).toBe(9);

    for (const definition of tools) {
      expect(definition.description.length).toBeGreaterThan(40);
      expect(z.toJSONSchema(definition.input)).toMatchObject({ type: 'object' });
      expect(z.toJSONSchema(definition.output)).toMatchObject({ type: 'object' });
      expect(definition.annotations).toBeDefined();
    }
  });

  it('advertises dataset and reference build on every gnomAD-derived output', () => {
    for (const definition of [
      gnomadGetVariant,
      gnomadListGeneVariants,
      gnomadGetGeneConstraint,
      gnomadGetCoverage,
      gnomadGetVariantCooccurrence,
    ]) {
      const schema = z.toJSONSchema(definition.output) as {
        properties?: Record<string, unknown>;
      };
      expect(schema.properties).toHaveProperty('dataset');
      expect(schema.properties).toHaveProperty('reference_genome');
    }
  });

  it('attributes every gnomAD-backed tool in client-facing metadata', () => {
    for (const definition of [
      gnomadGetVariant,
      gnomadListGeneVariants,
      gnomadGetGeneConstraint,
      gnomadGetCoverage,
      gnomadGetVariantCooccurrence,
    ]) {
      expect(definition.description).toContain(
        'Data source: gnomAD (Broad Institute) — https://gnomad.broadinstitute.org/',
      );
    }
    expect(gnomadSearchClinvar.description).not.toContain('Data source: gnomAD');
  });
});

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/72
describe('row tool listings name the dataframe tools only while the canvas is on (#72)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  /** Both row tools as tools/list carries them, defined fresh under the stubbed environment. */
  async function listings() {
    vi.resetModules();
    const { gnomadListGeneVariants: list } = await import(
      '@/mcp-server/tools/definitions/gnomad-list-gene-variants.tool.js'
    );
    const { gnomadSearchClinvar: clinvar } = await import(
      '@/mcp-server/tools/definitions/gnomad-search-clinvar.tool.js'
    );
    return [list, clinvar].map((definition) => ({
      name: definition.name,
      description: definition.description,
      listing: JSON.stringify({
        description: definition.description,
        input: z.toJSONSchema(definition.input),
        output: z.toJSONSchema(definition.output),
        enrichment: Object.values(definition.enrichment ?? {}).map((field) =>
          z.toJSONSchema(field as z.ZodType),
        ),
      }),
    }));
  }

  it('names no gnomad_dataframe_ tool in either listing with CANVAS_PROVIDER_TYPE=none', async () => {
    vi.stubEnv('CANVAS_PROVIDER_TYPE', 'none');
    for (const { name, listing } of await listings()) {
      expect(listing, name).not.toContain('gnomad_dataframe_');
    }
  });

  it.each([undefined, '', `\${CANVAS_PROVIDER_TYPE}`, 'duckdb'])(
    'names gnomad_dataframe_describe and gnomad_dataframe_query in both descriptions with CANVAS_PROVIDER_TYPE=%j',
    async (value) => {
      vi.stubEnv('CANVAS_PROVIDER_TYPE', value);
      for (const { name, description } of await listings()) {
        expect(description, name).toContain('gnomad_dataframe_describe');
        expect(description, name).toContain('gnomad_dataframe_query');
      }
    },
  );
});

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/83
describe('server-authored definition bytes stay within each tool ceiling (#83)', () => {
  /** serverAuthoredBytes of each definition on the trimmed surface, canvas on and the drop tool enabled. */
  const MEASURED_BYTES: Record<string, number> = {
    gnomad_get_variant: 11_030,
    gnomad_list_gene_variants: 13_608,
    gnomad_get_gene_constraint: 5_625,
    gnomad_get_coverage: 5_156,
    gnomad_get_variant_cooccurrence: 4_242,
    gnomad_search_clinvar: 6_302,
    gnomad_dataframe_query: 2_199,
    gnomad_dataframe_describe: 489,
    gnomad_dataframe_drop: 429,
  };
  // Every ceiling is its measured figure plus 100 bytes, one short clause of slack; a larger edit re-measures.
  const HEADROOM_BYTES = 100;

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  /** All nine definitions as tools/list carries them with every tool listed, defined fresh under that environment. */
  async function listedDefinitions(): Promise<AnyToolDefinition[]> {
    vi.stubEnv('CANVAS_PROVIDER_TYPE', 'duckdb');
    vi.stubEnv('GNOMAD_DATAFRAME_DROP_ENABLED', 'true');
    vi.resetModules();
    const [variant, list, constraint, coverage, cooccurrence, clinvar, query, describeTable, drop] =
      await Promise.all([
        import('@/mcp-server/tools/definitions/gnomad-get-variant.tool.js'),
        import('@/mcp-server/tools/definitions/gnomad-list-gene-variants.tool.js'),
        import('@/mcp-server/tools/definitions/gnomad-get-gene-constraint.tool.js'),
        import('@/mcp-server/tools/definitions/gnomad-get-coverage.tool.js'),
        import('@/mcp-server/tools/definitions/gnomad-get-variant-cooccurrence.tool.js'),
        import('@/mcp-server/tools/definitions/gnomad-search-clinvar.tool.js'),
        import('@/mcp-server/tools/definitions/gnomad-dataframe-query.tool.js'),
        import('@/mcp-server/tools/definitions/gnomad-dataframe-describe.tool.js'),
        import('@/mcp-server/tools/definitions/gnomad-dataframe-drop.tool.js'),
      ]);
    return [
      variant.gnomadGetVariant,
      list.gnomadListGeneVariants,
      constraint.gnomadGetGeneConstraint,
      coverage.gnomadGetCoverage,
      cooccurrence.gnomadGetVariantCooccurrence,
      clinvar.gnomadSearchClinvar,
      query.gnomadDataframeQuery,
      describeTable.gnomadDataframeDescribe,
      drop.gnomadDataframeDrop,
    ];
  }

  it('sets a ceiling for exactly the nine tools', async () => {
    expect((await listedDefinitions()).map((definition) => definition.name).sort()).toEqual(
      Object.keys(MEASURED_BYTES).sort(),
    );
  });

  it.each(Object.entries(MEASURED_BYTES))(
    '%s stays at or under its measured %i bytes plus the headroom',
    async (name, measured) => {
      const definition = (await listedDefinitions()).find((entry) => entry.name === name);
      expect(definition, name).toBeDefined();
      expect(serverAuthoredBytes(definition as AnyToolDefinition)).toBeLessThanOrEqual(
        measured + HEADROOM_BYTES,
      );
    },
  );
});
