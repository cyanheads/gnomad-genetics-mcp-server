/**
 * @fileoverview Offline smoke test for the complete eight-tool MCP surface.
 * Confirms every definition loads, has a unique public name, advertises input
 * and output contracts, and keeps build identity on every gnomAD data response.
 * @module tests/smoke/tool-surface.smoke.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gnomadDataframeDescribe } from '@/mcp-server/tools/definitions/gnomad-dataframe-describe.tool.js';
import { gnomadDataframeDrop } from '@/mcp-server/tools/definitions/gnomad-dataframe-drop.tool.js';
import { gnomadDataframeQuery } from '@/mcp-server/tools/definitions/gnomad-dataframe-query.tool.js';
import { gnomadGetCoverage } from '@/mcp-server/tools/definitions/gnomad-get-coverage.tool.js';
import { gnomadGetGeneConstraint } from '@/mcp-server/tools/definitions/gnomad-get-gene-constraint.tool.js';
import { gnomadGetVariant } from '@/mcp-server/tools/definitions/gnomad-get-variant.tool.js';
import { gnomadListGeneVariants } from '@/mcp-server/tools/definitions/gnomad-list-gene-variants.tool.js';
import { gnomadSearchClinvar } from '@/mcp-server/tools/definitions/gnomad-search-clinvar.tool.js';

const tools = [
  gnomadGetVariant,
  gnomadListGeneVariants,
  gnomadGetGeneConstraint,
  gnomadGetCoverage,
  gnomadSearchClinvar,
  gnomadDataframeQuery,
  gnomadDataframeDescribe,
  gnomadDataframeDrop,
];

describe('eight-tool surface', () => {
  it('loads every expected definition exactly once with schemas and annotations', () => {
    expect(tools.map((definition) => definition.name)).toEqual([
      'gnomad_get_variant',
      'gnomad_list_gene_variants',
      'gnomad_get_gene_constraint',
      'gnomad_get_coverage',
      'gnomad_search_clinvar',
      'gnomad_dataframe_query',
      'gnomad_dataframe_describe',
      'gnomad_dataframe_drop',
    ]);
    expect(new Set(tools.map((definition) => definition.name)).size).toBe(8);

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
