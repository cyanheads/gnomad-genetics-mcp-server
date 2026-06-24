/**
 * @fileoverview gnomad_get_gene_constraint — loss-of-function constraint for a
 * gene: pLI, LOEUF (oe_lof_upper) with CI, observed/expected for LoF/missense/
 * synonymous, and the three Z-scores. The metric that weights a candidate LoF
 * variant. By gene symbol or Ensembl gene ID.
 * @module mcp-server/tools/definitions/gnomad-get-gene-constraint.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getGnomadService } from '@/services/gnomad/gnomad-service.js';
import { datasetField, geneField, referenceGenomeField } from '../shared-schemas.js';

export const gnomadGetGeneConstraint = tool('gnomad_get_gene_constraint', {
  title: 'gnomad-genetics-mcp-server: get gene constraint',
  description:
    'Fetch gnomAD loss-of-function constraint for a gene — pLI (probability of LoF intolerance; >0.9 intolerant), LOEUF (oe_lof_upper, the headline metric; <0.6 intolerant in v4, <0.35 in v2) plus its lower bound, observed/expected ratios for LoF, missense, and synonymous variation, and the three Z-scores. This is the orthogonal axis to allele frequency: a loss-of-function variant matters far more in a gene intolerant to being broken. Accepts an HGNC symbol (PCSK9) or an Ensembl gene ID (ENSG00000169174). Many genes have null constraint (sparse upstream) — null fields are reported as such, never fabricated. v4 constraint is flagged beta by the gnomAD team; constraint_flags surfaces any caveats. Echoes the effective dataset and reference build.',
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
    pli: z
      .number()
      .nullable()
      .describe('pLI — probability of LoF intolerance; >0.9 intolerant. Null when unavailable.'),
    oe_lof: z.number().nullable().describe('Observed/expected LoF ratio. Null when unavailable.'),
    oe_lof_lower: z
      .number()
      .nullable()
      .describe('LOEUF confidence-interval lower bound. Null when unavailable.'),
    oe_lof_upper: z
      .number()
      .nullable()
      .describe('LOEUF (oe_lof_upper) — the headline intolerance metric. Null when unavailable.'),
    oe_mis: z
      .number()
      .nullable()
      .describe('Observed/expected missense ratio. Null when unavailable.'),
    oe_syn: z
      .number()
      .nullable()
      .describe('Observed/expected synonymous ratio. Null when unavailable.'),
    lof_z: z.number().nullable().describe('LoF constraint Z-score. Null when unavailable.'),
    mis_z: z.number().nullable().describe('Missense constraint Z-score. Null when unavailable.'),
    syn_z: z.number().nullable().describe('Synonymous constraint Z-score. Null when unavailable.'),
    obs_lof: z.number().nullable().describe('Observed LoF variant count. Null when unavailable.'),
    exp_lof: z.number().nullable().describe('Expected LoF variant count. Null when unavailable.'),
    obs_mis: z.number().nullable().describe('Observed missense count. Null when unavailable.'),
    exp_mis: z.number().nullable().describe('Expected missense count. Null when unavailable.'),
    obs_syn: z.number().nullable().describe('Observed synonymous count. Null when unavailable.'),
    exp_syn: z.number().nullable().describe('Expected synonymous count. Null when unavailable.'),
    constraint_flags: z
      .array(z.string())
      .describe('Constraint caveat flags (e.g. beta/experimental notes for v4).'),
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
        {
          gene: input.gene,
          ...ctx.recoveryFor('gene_not_found'),
        },
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
    const lines = [
      `## ${result.symbol} (${result.gene_id})`,
      `**Dataset:** ${result.dataset} (${result.reference_genome})`,
      `**pLI:** ${num(result.pli)} | **LOEUF (oe_lof_upper):** ${num(result.oe_lof_upper)} [${num(result.oe_lof_lower)}–${num(result.oe_lof)}]`,
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
