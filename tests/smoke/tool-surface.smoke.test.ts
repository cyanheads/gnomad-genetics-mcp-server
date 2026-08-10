/**
 * @fileoverview Offline smoke test for the complete eight-tool MCP surface.
 * Confirms every definition loads, has a unique public name, advertises input
 * and output contracts, and keeps build identity on every gnomAD data response.
 * @module tests/smoke/tool-surface.smoke.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
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
});
