/**
 * @fileoverview gnomad://gene/{dataset}/{gene}/constraint — the same constraint
 * record gnomad_get_gene_constraint returns. The gene segment is a symbol or
 * Ensembl gene ID. Mirrors the scalar tool for clients that support injectable
 * resource context.
 * @module mcp-server/resources/definitions/gene-constraint.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { GNOMAD_DATASETS } from '@/config/server-config.js';
import { getGnomadService } from '@/services/gnomad/gnomad-service.js';
import type { Dataset } from '@/services/gnomad/types.js';

export const geneConstraintResource = resource('gnomad://gene/{dataset}/{gene}/constraint', {
  description:
    'gnomAD loss-of-function constraint for a gene — pLI, LOEUF (oe_lof_upper) with CI, observed/expected ratios, and Z-scores. Mirrors gnomad_get_gene_constraint. The gene segment is an HGNC symbol or Ensembl gene ID.',
  name: 'gnomAD gene constraint',
  mimeType: 'application/json',
  params: z.object({
    dataset: z
      .enum(GNOMAD_DATASETS)
      .describe('gnomAD dataset segment: gnomad_r4, gnomad_r3, gnomad_r2_1, or exac.'),
    gene: z.string().describe('Gene — HGNC symbol (PCSK9) or Ensembl gene ID (ENSG00000169174).'),
  }),
  errors: [
    {
      reason: 'gene_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No gene matched the symbol or Ensembl ID in this build.',
      recovery:
        'Check the symbol spelling or resolve a stable Ensembl gene ID via ensembl_lookup_gene, then retry.',
    },
  ],

  async handler(params, ctx) {
    const svc = getGnomadService();
    const dsCtx = svc.resolveDatasetContext(params.dataset as Dataset);
    const constraint = await svc.getGeneConstraint(params.gene, dsCtx, ctx);
    if (!constraint) {
      throw ctx.fail(
        'gene_not_found',
        `Gene "${params.gene}" not found in ${dsCtx.reference_genome}.`,
        {
          ...ctx.recoveryFor('gene_not_found'),
        },
      );
    }
    return constraint;
  },
});
