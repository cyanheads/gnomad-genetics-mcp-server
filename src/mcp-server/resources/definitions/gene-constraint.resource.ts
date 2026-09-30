/**
 * @fileoverview gnomad://gene/{dataset}/{gene}/constraint — the same constraint
 * record gnomad_get_gene_constraint returns, constraint_release included. The
 * gene segment is a symbol or Ensembl gene ID. Mirrors the scalar tool for
 * clients that support injectable resource context.
 * @module mcp-server/resources/definitions/gene-constraint.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { GNOMAD_DATASETS } from '@/config/server-config.js';
import { getGnomadService } from '@/services/gnomad/gnomad-service.js';
import type { Dataset } from '@/services/gnomad/types.js';

export const geneConstraintResource = resource('gnomad://gene/{dataset}/{gene}/constraint', {
  description:
    'gnomAD loss-of-function constraint for a gene — pLI, LOEUF (oe_lof_upper) with CI, observed/expected ratios, and Z-scores, with constraint_release naming the release they come from. Mirrors gnomad_get_gene_constraint: the exac segment serves ExAC r0.3 constraint (pLI, Z-scores, and counts only), and gnomad_r3 serves the GRCh38 gnomAD v4.1.2 table because gnomAD publishes no v3 constraint. The gene segment is an HGNC symbol or Ensembl gene ID.\nData source: gnomAD (Broad Institute) — https://gnomad.broadinstitute.org/',
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
    {
      reason: 'invalid_constraint_data',
      code: JsonRpcErrorCode.ValidationError,
      when: 'gnomAD returned constraint metrics outside their valid ranges, such as a pLI above 1.',
      recovery:
        'Treat this gene’s constraint as unavailable rather than estimating it: gnomAD returns the same out-of-range metrics on every read. The GRCh37 tables (dataset segment gnomad_r2_1 or exac) are a separate source for the same gene.',
      thrownBy: 'service',
    },
    {
      reason: 'graphql_error',
      code: JsonRpcErrorCode.ValidationError,
      when: 'gnomAD rejected the constraint query with a GraphQL error.',
      recovery:
        'Check the gene segment and the dataset segment before reading again: gnomAD rejected this query as sent, so the same read fails again.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'gnomAD stayed unavailable or throttled through every retry.',
      recovery:
        'gnomAD is degraded or throttling; wait a few seconds and read the resource again. gnomAD is a community-funded API — keep request volume low.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'Every attempt to reach gnomAD timed out.',
      recovery: 'gnomAD did not answer in time; wait a few seconds, then read the resource again.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_access',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'gnomAD refused the request (access denied).',
      recovery:
        'Do not retry: gnomAD is refusing requests from this server. Tell the user the lookup is blocked upstream and point them to https://gnomad.broadinstitute.org/.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_upstream_response',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'gnomAD kept answering with a response that failed validation.',
      recovery:
        'Wait a few seconds and read the resource again; gnomAD returned a response this server could not validate.',
      thrownBy: 'service',
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
      );
    }
    return constraint;
  },
});
