/**
 * @fileoverview gnomad_get_gene_constraint — loss-of-function constraint for a
 * gene: pLI, LOEUF (oe_lof_upper) with CI and percentile, observed/expected for
 * LoF/missense/synonymous with their intervals, and the three Z-scores, labeled
 * with the constraint release they come from. The metric that weights a
 * candidate LoF variant. By gene symbol or Ensembl gene ID. A subset dataset
 * reads its parent release's table. A mitochondrial gene carries gnomAD's
 * mitochondrial constraint instead, as a union tagged by `kind`.
 * @module mcp-server/tools/definitions/gnomad-get-gene-constraint.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { getGnomadService, parentOf } from '@/services/gnomad/gnomad-service.js';
import type { ParentDataset } from '@/services/gnomad/types.js';
import { datasetField, geneField, referenceGenomeField } from '../shared-schemas.js';

/** The note format() adds where a parent release's constraint differs from what its name suggests. */
const RELEASE_NOTES: Partial<Record<ParentDataset, string>> = {
  gnomad_r3: 'gnomAD publishes no v3 constraint; gnomad_r3 serves the GRCh38 gnomAD v4.1.2 table',
  exac: 'ExAC publishes pLI, Z-scores, and observed/expected counts only — no ratios, intervals, LOEUF, LOEUF percentile, or flags',
};

/** The notes on a dataset's constraint: that a subset reads its parent's table, then the parent's own note. */
function releaseNotes(dataset: string): string[] {
  const parent = parentOf(dataset);
  if (!parent) return [];
  const notes =
    parent === dataset
      ? []
      : [`gnomAD publishes no subset constraint, so ${dataset} reads the ${parent} table`];
  const note = RELEASE_NOTES[parent];
  return note ? [...notes, note] : notes;
}

/** A mitochondrial constraint value: non-null upstream and never negative. */
const mitochondrialValue = (description: string) => z.number().nonnegative().describe(description);

/** gnomAD's constraint for a protein-coding mitochondrial gene, one set per variant class. */
const ProteinMitochondrialConstraint = z
  .object({
    kind: z
      .literal('protein')
      .describe(
        'A protein-coding mitochondrial gene: stop-gain (lof), missense, and synonymous sets.',
      ),
    obs_lof: mitochondrialValue('Observed sum of maximum heteroplasmy over stop-gain SNVs.'),
    exp_lof: mitochondrialValue('Expected sum of maximum heteroplasmy over stop-gain SNVs.'),
    oe_lof: mitochondrialValue('Observed/expected ratio for stop-gain SNVs.'),
    oe_lof_lower: mitochondrialValue('Lower bound of the 90% interval around oe_lof.'),
    oe_lof_upper: mitochondrialValue(
      'Upper bound of the 90% interval around oe_lof (OEUF); lower is more constrained.',
    ),
    obs_mis: mitochondrialValue('Observed sum of maximum heteroplasmy over missense SNVs.'),
    exp_mis: mitochondrialValue('Expected sum of maximum heteroplasmy over missense SNVs.'),
    oe_mis: mitochondrialValue('Observed/expected ratio for missense SNVs.'),
    oe_mis_lower: mitochondrialValue('Lower bound of the 90% interval around oe_mis.'),
    oe_mis_upper: mitochondrialValue(
      'Upper bound of the 90% interval around oe_mis (OEUF); lower is more constrained.',
    ),
    obs_syn: mitochondrialValue('Observed sum of maximum heteroplasmy over synonymous SNVs.'),
    exp_syn: mitochondrialValue('Expected sum of maximum heteroplasmy over synonymous SNVs.'),
    oe_syn: mitochondrialValue('Observed/expected ratio for synonymous SNVs.'),
    oe_syn_lower: mitochondrialValue('Lower bound of the 90% interval around oe_syn.'),
    oe_syn_upper: mitochondrialValue('Upper bound of the 90% interval around oe_syn.'),
  })
  .describe('Constraint for a protein-coding mitochondrial gene.');

/** gnomAD's constraint for a tRNA or rRNA mitochondrial gene, one set over all its SNVs. */
const RnaMitochondrialConstraint = z
  .object({
    kind: z.literal('rna').describe('A tRNA or rRNA mitochondrial gene: one set over all SNVs.'),
    observed: mitochondrialValue('Observed sum of maximum heteroplasmy over all SNVs.'),
    expected: mitochondrialValue('Expected sum of maximum heteroplasmy over all SNVs.'),
    oe: mitochondrialValue('Observed/expected ratio over all SNVs.'),
    oe_lower: mitochondrialValue('Lower bound of the 90% interval around oe.'),
    oe_upper: mitochondrialValue(
      'Upper bound of the 90% interval around oe (OEUF); lower is more constrained.',
    ),
  })
  .describe('Constraint for a tRNA or rRNA mitochondrial gene.');

export const gnomadGetGeneConstraint = tool('gnomad_get_gene_constraint', {
  title: 'gnomad-genetics-mcp-server: get gene constraint',
  description:
    'Fetch gnomAD loss-of-function constraint for a gene — pLI (probability of LoF intolerance; >0.9 intolerant), LOEUF (oe_lof_upper, the headline metric) plus its lower bound and gnomAD’s LOEUF percentile, observed/expected ratios for LoF, missense, and synonymous variation with 90% intervals for missense and synonymous, and the three Z-scores. This is the orthogonal axis to allele frequency: a loss-of-function variant matters far more in a gene intolerant to being broken. Accepts an HGNC symbol (PCSK9) or an Ensembl gene ID (ENSG00000169174). constraint_release names the release the metrics come from: gnomAD v4.1.2 for gnomad_r4, gnomad_r3, and their subsets (gnomAD publishes no v3 constraint), gnomAD v2.1.1 for gnomad_r2_1 and its subsets, and ExAC r0.3 for exac. gnomAD publishes no subset constraint, so a subset dataset reads its parent release’s table and echoes the subset as dataset. gnomAD recommends LOEUF < 0.45 to call a gene LoF-intolerant on v4.1.2 and LOEUF < 0.35 on v2.1.1; only v4.1.2 publishes the LOEUF percentile. ExAC r0.3 publishes only pLI, the Z-scores, and observed/expected counts, so on exac the ratios, their intervals, LOEUF, and the LOEUF percentile are null, constraint_flags is empty, and pLI is the intolerance measure. A mitochondrial gene (MT-CO1, MT-TL1) has no nuclear constraint: gnomAD’s mitochondrial constraint comes back in mitochondrial_constraint instead — kind protein or rna, the same table on every dataset, exac included — and is null for every nuclear gene; the nuclear LOEUF thresholds do not apply to it. Many genes have null constraint (sparse upstream) — null fields are reported as such, never fabricated. Echoes the effective dataset and reference build.\nData source: gnomAD (Broad Institute) — https://gnomad.broadinstitute.org/',
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
        'Constraint release the metrics come from: gnomAD v4.1.2 for gnomad_r4, gnomad_r3, and their subsets (gnomAD publishes no v3 constraint, so gnomad_r3 serves the GRCh38 table), gnomAD v2.1.1 for gnomad_r2_1 and its subsets, ExAC r0.3 for exac. A subset reads its parent release’s table, since gnomAD publishes no subset constraint. It labels the nuclear tables only, never mitochondrial_constraint.',
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
    oe_lof_percentile: z
      .number()
      .int()
      .min(0)
      .max(100)
      .nullable()
      .describe(
        'gnomAD’s LOEUF percentile — the percentile bin the gene’s LOEUF falls in among gnomAD v4.1.2’s MANE Select transcripts, an integer from 0 to 100; lower is more constrained (KMT2A is 0, FLG is 98). Only gnomAD v4.1.2 publishes it, so it is null on gnomad_r2_1, its subsets, and exac, and wherever LOEUF is null.',
      ),
    oe_mis: z
      .number()
      .nonnegative()
      .nullable()
      .describe('Observed/expected missense ratio. Null when unavailable.'),
    oe_mis_lower: z
      .number()
      .nonnegative()
      .nullable()
      .describe(
        'Lower bound of the 90% confidence interval around oe_mis. Null when unavailable, and always null on exac.',
      ),
    oe_mis_upper: z
      .number()
      .nonnegative()
      .nullable()
      .describe(
        'Upper bound of the 90% confidence interval around oe_mis. Null when unavailable, and always null on exac.',
      ),
    oe_syn: z
      .number()
      .nonnegative()
      .nullable()
      .describe('Observed/expected synonymous ratio. Null when unavailable.'),
    oe_syn_lower: z
      .number()
      .nonnegative()
      .nullable()
      .describe(
        'Lower bound of the 90% confidence interval around oe_syn. Null when unavailable, and always null on exac.',
      ),
    oe_syn_upper: z
      .number()
      .nonnegative()
      .nullable()
      .describe(
        'Upper bound of the 90% confidence interval around oe_syn. Null when unavailable, and always null on exac.',
      ),
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
    mitochondrial_constraint: z
      .union([
        ProteinMitochondrialConstraint,
        RnaMitochondrialConstraint,
        z.null().describe('No mitochondrial constraint: the gene is nuclear.'),
      ])
      .describe(
        'gnomAD’s mitochondrial gene constraint, computed from 56,434 gnomAD v4.1 genomes: present for every mitochondrial gene and null for a nuclear gene, whose nuclear fields carry its constraint instead. kind "protein" carries observed, expected, observed/expected, and its 90% interval for stop-gain (lof; splice variants do not apply in mtDNA), missense (mis), and synonymous (syn) SNVs; kind "rna" (a tRNA or rRNA gene) carries one set over all SNVs. Observed and expected are sums of maximum heteroplasmy over every possible SNV, not variant counts, and the intervals come from a beta distribution, so the nuclear LOEUF thresholds do not apply; gnomAD reads the upper bound (OEUF) as the conservative measure, lower meaning stronger selection. The same table on every dataset, exac included; constraint_release does not label it.',
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
        'Omit reference_genome to let it derive, or pass the build matching the dataset (gnomad_r4, gnomad_r3, and their subsets are GRCh38; gnomad_r2_1, its subsets, and exac are GRCh37).',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_constraint_data',
      code: JsonRpcErrorCode.ValidationError,
      when: 'gnomAD returned constraint metrics outside their valid ranges, such as a pLI above 1, or a mitochondrial constraint of a shape gnomAD’s schema does not define.',
      recovery:
        'Treat this gene’s constraint as unavailable rather than estimating it: gnomAD returns the same metrics on every retry. For a nuclear gene, the GRCh37 tables (dataset gnomad_r2_1 or exac) are a separate source; a mitochondrial gene’s constraint is the same table on every dataset.',
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
      when: 'gnomAD attempts timed out or the shared 45 s call budget expired.',
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
      hasConstraint:
        constraint.pli != null ||
        constraint.oe_lof_upper != null ||
        constraint.mitochondrial_constraint != null,
    });
    return constraint;
  },

  format: (result) => {
    const num = (v: number | null) => (v != null ? String(v) : 'Not available');
    const notes = releaseNotes(result.dataset);
    const lines = [
      `**Gene:** ${escapeMarkdownInline(result.symbol)} (${escapeMarkdownInline(result.gene_id)})`,
      `**Dataset:** ${result.dataset} (${result.reference_genome})`,
      `**Constraint release:** ${result.constraint_release}${notes.length ? ` (${notes.join('; ')})` : ''}`,
      `**pLI:** ${num(result.pli)} | **LOEUF (oe_lof_upper):** ${num(result.oe_lof_upper)} [${num(result.oe_lof_lower)}–${num(result.oe_lof_upper)}] | **LOEUF percentile:** ${num(result.oe_lof_percentile)} | **oe_lof (point estimate):** ${num(result.oe_lof)}`,
      `**oe_mis:** ${num(result.oe_mis)} [${num(result.oe_mis_lower)}–${num(result.oe_mis_upper)}] | **oe_syn:** ${num(result.oe_syn)} [${num(result.oe_syn_lower)}–${num(result.oe_syn_upper)}]`,
      `**Z-scores:** LoF ${num(result.lof_z)} | mis ${num(result.mis_z)} | syn ${num(result.syn_z)}`,
      `**LoF obs/exp:** ${num(result.obs_lof)} / ${num(result.exp_lof)}`,
      `**Missense obs/exp:** ${num(result.obs_mis)} / ${num(result.exp_mis)}`,
      `**Synonymous obs/exp:** ${num(result.obs_syn)} / ${num(result.exp_syn)}`,
      `**Constraint flags:** ${result.constraint_flags.length ? result.constraint_flags.map(escapeMarkdownInline).join(', ') : 'none'}`,
    ];
    // Mitochondrial values print as gnomAD sent them; each arm renders on its own check.
    const mito = result.mitochondrial_constraint;
    if (mito === null) {
      lines.push(
        '**Mitochondrial constraint:** none (gnomAD publishes it for mitochondrial genes only)',
      );
    }
    if (mito?.kind === 'protein') {
      lines.push(
        `**Mitochondrial constraint:** ${mito.kind} (protein-coding gene; observed and expected are sums of maximum heteroplasmy)`,
        `**Mitochondrial LoF (stop-gain):** obs/exp ${mito.obs_lof} / ${mito.exp_lof} | o/e ${mito.oe_lof} [${mito.oe_lof_lower}–${mito.oe_lof_upper}]`,
        `**Mitochondrial missense:** obs/exp ${mito.obs_mis} / ${mito.exp_mis} | o/e ${mito.oe_mis} [${mito.oe_mis_lower}–${mito.oe_mis_upper}]`,
        `**Mitochondrial synonymous:** obs/exp ${mito.obs_syn} / ${mito.exp_syn} | o/e ${mito.oe_syn} [${mito.oe_syn_lower}–${mito.oe_syn_upper}]`,
      );
    }
    if (mito?.kind === 'rna') {
      lines.push(
        `**Mitochondrial constraint:** ${mito.kind} (tRNA or rRNA gene; observed and expected are sums of maximum heteroplasmy)`,
        `**Mitochondrial, all SNVs:** obs/exp ${mito.observed} / ${mito.expected} | o/e ${mito.oe} [${mito.oe_lower}–${mito.oe_upper}]`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
