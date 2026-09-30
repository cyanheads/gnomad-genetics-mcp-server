/**
 * @fileoverview gnomad_get_gene_constraint — loss-of-function constraint for a
 * gene: pLI, LOEUF (oe_lof_upper) with CI, observed/expected for LoF/missense/
 * synonymous, and the three Z-scores, labeled with the constraint release they
 * come from. The metric that weights a candidate LoF variant. By gene symbol or
 * Ensembl gene ID.
 * @module mcp-server/tools/definitions/gnomad-get-gene-constraint.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getGnomadService } from '@/services/gnomad/gnomad-service.js';
import { datasetField, geneField, referenceGenomeField } from '../shared-schemas.js';

/** The note format() adds where a dataset's constraint differs from what its name suggests. */
const RELEASE_NOTES: Partial<Record<string, string>> = {
  gnomad_r3: 'gnomAD publishes no v3 constraint; gnomad_r3 serves the GRCh38 gnomAD v4.1.2 table',
  exac: 'ExAC publishes pLI, Z-scores, and observed/expected counts only — no ratios, LOEUF, or flags',
};

export const gnomadGetGeneConstraint = tool('gnomad_get_gene_constraint', {
  title: 'gnomad-genetics-mcp-server: get gene constraint',
  description:
    'Fetch gnomAD loss-of-function constraint for a gene — pLI (probability of LoF intolerance; >0.9 intolerant), LOEUF (oe_lof_upper, the headline metric) plus its lower bound, observed/expected ratios for LoF, missense, and synonymous variation, and the three Z-scores. This is the orthogonal axis to allele frequency: a loss-of-function variant matters far more in a gene intolerant to being broken. Accepts an HGNC symbol (PCSK9) or an Ensembl gene ID (ENSG00000169174). constraint_release names the release the metrics come from: gnomAD v4.1.2 for gnomad_r4 and gnomad_r3 (gnomAD publishes no v3 constraint), gnomAD v2.1.1 for gnomad_r2_1, and ExAC r0.3 for exac. gnomAD recommends LOEUF < 0.45 to call a gene LoF-intolerant on v4.1.2 and LOEUF < 0.35 on v2.1.1. ExAC r0.3 publishes only pLI, the Z-scores, and observed/expected counts, so on exac the ratios and LOEUF are null, constraint_flags is empty, and pLI is the intolerance measure. Many genes have null constraint (sparse upstream) — null fields are reported as such, never fabricated. Echoes the effective dataset and reference build.\nData source: gnomAD (Broad Institute) — https://gnomad.broadinstitute.org/',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    gene: geneField,
    dataset: datasetField,
    reference_genome: referenceGenomeField,
  }),
  output: z.object({
    gene_id: z.string().describe('Ensembl gene ID resolved for the gene.'),
    symbol: z.string().describe('HGNC gene symbol.'),
    dataset: z.string().describe('Effective gnomAD dataset.'),
    reference_genome: z.string().describe('Effective reference build.'),
    constraint_release: z
      .string()
      .describe(
        'Constraint release the metrics come from: gnomAD v4.1.2 for gnomad_r4 and gnomad_r3 (gnomAD publishes no v3 constraint, so gnomad_r3 serves the GRCh38 table), gnomAD v2.1.1 for gnomad_r2_1, ExAC r0.3 for exac.',
      ),
    pli: z
      .number()
      .min(0)
      .max(1)
      .nullable()
      .describe('pLI — probability of LoF intolerance; >0.9 intolerant. Null when unavailable.'),
    oe_lof: z
      .number()
      .nonnegative()
      .nullable()
      .describe('Non-negative observed/expected LoF ratio. Null when unavailable.'),
    oe_lof_lower: z
      .number()
      .nonnegative()
      .nullable()
      .describe('LOEUF confidence-interval lower bound. Null when unavailable.'),
    oe_lof_upper: z
      .number()
      .nonnegative()
      .nullable()
      .describe(
        'LOEUF (oe_lof_upper) — the headline intolerance metric; gnomAD recommends < 0.45 on v4.1.2 and < 0.35 on v2.1.1 to call a gene LoF-intolerant. Null when unavailable, and always null on exac.',
      ),
    oe_mis: z
      .number()
      .nonnegative()
      .nullable()
      .describe('Observed/expected missense ratio. Null when unavailable.'),
    oe_syn: z
      .number()
      .nonnegative()
      .nullable()
      .describe('Observed/expected synonymous ratio. Null when unavailable.'),
    lof_z: z.number().nullable().describe('LoF constraint Z-score. Null when unavailable.'),
    mis_z: z.number().nullable().describe('Missense constraint Z-score. Null when unavailable.'),
    syn_z: z.number().nullable().describe('Synonymous constraint Z-score. Null when unavailable.'),
    obs_lof: z
      .number()
      .nonnegative()
      .nullable()
      .describe('Non-negative observed LoF variant count. Null when unavailable.'),
    exp_lof: z
      .number()
      .nonnegative()
      .nullable()
      .describe('Non-negative expected LoF variant count. Null when unavailable.'),
    obs_mis: z
      .number()
      .nonnegative()
      .nullable()
      .describe('Non-negative observed missense count. Null when unavailable.'),
    exp_mis: z
      .number()
      .nonnegative()
      .nullable()
      .describe('Non-negative expected missense count. Null when unavailable.'),
    obs_syn: z
      .number()
      .nonnegative()
      .nullable()
      .describe('Non-negative observed synonymous count. Null when unavailable.'),
    exp_syn: z
      .number()
      .nonnegative()
      .nullable()
      .describe('Non-negative expected synonymous count. Null when unavailable.'),
    constraint_flags: z
      .array(z.string())
      .describe(
        'Caveat flags gnomAD attaches to the gene’s constraint (e.g. no_exp_lof, mis_too_many, syn_outlier); empty when none, and always empty on exac, where ExAC publishes no flags.',
      ),
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
      reason: 'incoherent_build',
      code: JsonRpcErrorCode.ValidationError,
      when: 'reference_genome was supplied but does not match the dataset.',
      recovery:
        'Omit reference_genome to let it derive, or pass the build matching the dataset (v4/v3=GRCh38, v2.1/ExAC=GRCh37).',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_constraint_data',
      code: JsonRpcErrorCode.ValidationError,
      when: 'gnomAD returned constraint metrics outside their valid ranges, such as a pLI above 1.',
      recovery:
        'Treat this gene’s constraint as unavailable rather than estimating it: gnomAD returns the same out-of-range metrics on every retry. The GRCh37 tables (dataset gnomad_r2_1 or exac) are a separate source for the same gene.',
      thrownBy: 'service',
    },
    {
      reason: 'graphql_error',
      code: JsonRpcErrorCode.ValidationError,
      when: 'gnomAD rejected the constraint query with a GraphQL error.',
      recovery:
        'Check the gene symbol or Ensembl gene ID and the dataset before retrying: gnomAD rejected this query as sent, so the same request fails again.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'gnomAD stayed unavailable or throttled through every retry.',
      recovery:
        'gnomAD is degraded or throttling; wait a few seconds and retry. gnomAD is a community-funded API — keep request volume low.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'Every attempt to reach gnomAD timed out.',
      recovery: 'gnomAD did not answer in time; wait a few seconds, then retry the same gene.',
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
        'Wait a few seconds and retry; gnomAD returned a response this server could not validate.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const svc = getGnomadService();
    const dsCtx = svc.resolveDatasetContext(input.dataset, input.reference_genome);
    const constraint = await svc.getGeneConstraint(input.gene, dsCtx, ctx);
    if (!constraint) {
      throw ctx.fail(
        'gene_not_found',
        `Gene "${input.gene}" not found in ${dsCtx.reference_genome}.`,
        { gene: input.gene },
      );
    }
    ctx.log.info('gnomad_get_gene_constraint resolved', {
      gene: constraint.symbol,
      dataset: dsCtx.dataset,
      hasConstraint: constraint.pli != null || constraint.oe_lof_upper != null,
    });
    return constraint;
  },

  format: (result) => {
    const num = (v: number | null, digits = 4) => (v != null ? v.toFixed(digits) : 'Not available');
    const note = RELEASE_NOTES[result.dataset];
    const lines = [
      `## ${result.symbol} (${result.gene_id})`,
      `**Dataset:** ${result.dataset} (${result.reference_genome})`,
      `**Constraint release:** ${result.constraint_release}${note ? ` (${note})` : ''}`,
      `**pLI:** ${num(result.pli)} | **LOEUF (oe_lof_upper):** ${num(result.oe_lof_upper)} [${num(result.oe_lof_lower)}–${num(result.oe_lof_upper)}] | **oe_lof (point estimate):** ${num(result.oe_lof)}`,
      `**oe_mis:** ${num(result.oe_mis)} | **oe_syn:** ${num(result.oe_syn)}`,
      `**Z-scores:** LoF ${num(result.lof_z)} | mis ${num(result.mis_z)} | syn ${num(result.syn_z)}`,
      `**LoF obs/exp:** ${num(result.obs_lof, 1)} / ${num(result.exp_lof, 1)}`,
      `**Missense obs/exp:** ${num(result.obs_mis, 1)} / ${num(result.exp_mis, 1)}`,
      `**Synonymous obs/exp:** ${num(result.obs_syn, 1)} / ${num(result.exp_syn, 1)}`,
      `**Constraint flags:** ${result.constraint_flags.length ? result.constraint_flags.join(', ') : 'none'}`,
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
