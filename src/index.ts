#!/usr/bin/env node
/**
 * @fileoverview gnomad-genetics-mcp-server entry point — human population
 * genetics over the gnomAD GraphQL API (allele frequencies by ancestry, gene
 * loss-of-function constraint, variant catalogs, coverage) plus optional
 * ClinVar curation depth. Wires the gnomAD + ClinVar services and the DataCanvas
 * accessor in setup(), then registers the full tool / resource / prompt surface.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { variantTriagePrompt } from './mcp-server/prompts/definitions/variant-triage.prompt.js';
import { geneConstraintResource } from './mcp-server/resources/definitions/gene-constraint.resource.js';
import { variantResource } from './mcp-server/resources/definitions/variant.resource.js';
import { gnomadDataframeDescribe } from './mcp-server/tools/definitions/gnomad-dataframe-describe.tool.js';
import { gnomadDataframeDrop } from './mcp-server/tools/definitions/gnomad-dataframe-drop.tool.js';
import { gnomadDataframeQuery } from './mcp-server/tools/definitions/gnomad-dataframe-query.tool.js';
import { gnomadGetCoverage } from './mcp-server/tools/definitions/gnomad-get-coverage.tool.js';
import { gnomadGetGeneConstraint } from './mcp-server/tools/definitions/gnomad-get-gene-constraint.tool.js';
import { gnomadGetVariant } from './mcp-server/tools/definitions/gnomad-get-variant.tool.js';
import { gnomadListGeneVariants } from './mcp-server/tools/definitions/gnomad-list-gene-variants.tool.js';
import { gnomadSearchClinvar } from './mcp-server/tools/definitions/gnomad-search-clinvar.tool.js';
import { setCanvas } from './services/canvas-accessor.js';
import { initClinVarService } from './services/clinvar/clinvar-service.js';
import { initGnomadService } from './services/gnomad/gnomad-service.js';

await createApp({
  name: 'gnomad-genetics-mcp-server',
  title: 'gnomad-genetics-mcp-server',
  tools: [
    gnomadGetVariant,
    gnomadGetGeneConstraint,
    gnomadListGeneVariants,
    gnomadGetCoverage,
    gnomadSearchClinvar,
    gnomadDataframeQuery,
    gnomadDataframeDescribe,
    gnomadDataframeDrop,
  ],
  resources: [variantResource, geneConstraintResource],
  prompts: [variantTriagePrompt],
  instructions:
    'Population genetics over gnomAD. dataset (gnomad_r4 default, GRCh38) and reference_genome are distinct, coherent parameters — keep the build aligned with ensembl coordinates; both are echoed in output. Per-ancestry allele frequencies are never collapsed to a single global AF. An absent variant is uninterpretable without gnomad_get_coverage — confirm the position is callable before concluding true absence (the gnomad_variant_triage prompt chains this). gnomad_list_gene_variants and gnomad_search_clinvar stage large results on a DataCanvas (set CANVAS_PROVIDER_TYPE=duckdb) queryable via gnomad_dataframe_query. The gnomAD API is community-funded and rate-limited — calls are concurrency-capped and back off.',
  setup(core) {
    setCanvas(core.canvas);
    initGnomadService(core.config, core.storage);
    initClinVarService(core.config, core.storage);
  },
});
