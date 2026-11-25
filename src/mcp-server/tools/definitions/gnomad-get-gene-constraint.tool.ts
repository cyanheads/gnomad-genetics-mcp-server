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

/**
 * gnomAD's constraint for a protein-coding mitochondrial gene, one set per variant
 * class. The kinds, the units, the interval model, and the OEUF reading are stated
 * once on mitochondrial_constraint.
 */
const ProteinMitochondrialConstraint = z
  .object({
    kind: z.literal('protein').describe('A protein-coding gene.'),
    obs_lof: mitochondrialValue('Observed, stop-gain SNVs.'),
    exp_lof: mitochondrialValue('Expected, stop-gain SNVs.'),
    oe_lof: mitochondrialValue('Observed/expected, stop-gain SNVs.'),
    oe_lof_lower: mitochondrialValue('Lower bound of the 90% interval around oe_lof.'),
    oe_lof_upper: mitochondrialValue('Upper bound (OEUF) of the 90% interval around oe_lof.'),
    obs_mis: mitochondrialValue('Observed, missense SNVs.'),
    exp_mis: mitochondrialValue('Expected, missense SNVs.'),
    oe_mis: mitochondrialValue('Observed/expected, missense SNVs.'),
    oe_mis_lower: mitochondrialValue('Lower bound of the 90% interval around oe_mis.'),
    oe_mis_upper: mitochondrialValue('Upper bound (OEUF) of the 90% interval around oe_mis.'),
    obs_syn: mitochondrialValue('Observed, synonymous SNVs.'),
    exp_syn: mitochondrialValue('Expected, synonymous SNVs.'),
    oe_syn: mitochondrialValue('Observed/expected, synonymous SNVs.'),
    oe_syn_lower: mitochondrialValue('Lower bound of the 90% interval around oe_syn.'),
    oe_syn_upper: mitochondrialValue('Upper bound of the 90% interval around oe_syn.'),
  })
  .describe('Constraint for a protein-coding mitochondrial gene.');

/** gnomAD's constraint for a tRNA or rRNA mitochondrial gene, one set over all its SNVs. */
const RnaMitochondrialConstraint = z
  .object({
    kind: z.literal('rna').describe('A tRNA or rRNA gene.'),
    observed: mitochondrialValue('Observed, all SNVs.'),
    expected: mitochondrialValue('Expected, all SNVs.'),
    oe: mitochondrialValue('Observed/expected, all SNVs.'),
    oe_lower: mitochondrialValue('Lower bound of the 90% interval around oe.'),
    oe_upper: mitochondrialValue('Upper bound (OEUF) of the 90% interval around oe.'),
  })
  .describe('Constraint for a tRNA or rRNA mitochondrial gene.');

export const gnomadGetGeneConstraint = tool('gnomad_get_gene_constraint', {
  title: 'gnomad-genetics-mcp-server: get gene constraint',
  description:
    'Fetch gnomAD loss-of-function constraint for a gene — pLI, LOEUF (oe_lof_upper, the headline metric) with its lower bound and the LOEUF percentile, observed/expected ratios for LoF, missense, and synonymous variation with the missense and synonymous intervals, the observed and expected counts, and the three Z-scores. This is the orthogonal axis to allele frequency: a loss-of-function variant matters far more in a gene intolerant to being broken. Accepts an HGNC symbol (PCSK9) or an Ensembl gene ID (ENSG00000169174). gnomAD recommends LOEUF < 0.45 to call a gene LoF-intolerant on v4.1.2 and LOEUF < 0.35 on v2.1.1; on exac, pLI is the intolerance measure: ExAC publishes only pLI, the Z-scores, and observed/expected counts, so every other metric is null there and constraint_flags is empty. A mitochondrial gene (MT-CO1, MT-TL1) carries gnomAD’s mitochondrial constraint in mitochondrial_constraint instead of nuclear metrics. Many genes lack some metrics upstream; those fields are null, never fabricated.\nData source: gnomAD (Broad Institute) — https://gnomad.broadinstitute.org/',
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
        'Constraint release the nuclear metrics come from: gnomAD v4.1.2 for gnomad_r4, gnomad_r3 (gnomAD publishes no v3 constraint), and their subsets; gnomAD v2.1.1 for gnomad_r2_1 and its subsets; ExAC r0.3 for exac. A subset reads its parent release’s table, since gnomAD publishes no subset constraint. It labels the nuclear tables only, never mitochondrial_constraint.',
      ),
    pli: z
      .number()
      .min(0)
      .max(1)
      .nullable()
      .describe('Probability of LoF intolerance; above 0.9 is intolerant.'),
    oe_lof: z.number().nonnegative().nullable().describe('Observed/expected LoF ratio.'),
    oe_lof_lower: z
      .number()
      .nonnegative()
      .nullable()
      .describe('Lower bound of the 90% interval around oe_lof.'),
    oe_lof_upper: z
      .number()
      .nonnegative()
      .nullable()
      .describe(
        'LOEUF, the upper bound of the 90% interval around oe_lof and the headline intolerance metric; lower is more constrained.',
      ),
    oe_lof_percentile: z
      .number()
      .int()
      .min(0)
      .max(100)
      .nullable()
      .describe(
        'Percentile bin of the gene’s LOEUF among gnomAD v4.1.2’s MANE Select transcripts; lower is more constrained (KMT2A is 0, FLG is 98). Only v4.1.2 publishes it, so it is null on every GRCh37 dataset and wherever LOEUF is null.',
      ),
    oe_mis: z.number().nonnegative().nullable().describe('Observed/expected missense ratio.'),
    oe_mis_lower: z
      .number()
      .nonnegative()
      .nullable()
      .describe('Lower bound of the 90% interval around oe_mis.'),
    oe_mis_upper: z
      .number()
      .nonnegative()
      .nullable()
      .describe('Upper bound of the 90% interval around oe_mis.'),
    oe_syn: z.number().nonnegative().nullable().describe('Observed/expected synonymous ratio.'),
    oe_syn_lower: z
      .number()
      .nonnegative()
      .nullable()
      .describe('Lower bound of the 90% interval around oe_syn.'),
    oe_syn_upper: z
      .number()
      .nonnegative()
      .nullable()
      .describe('Upper bound of the 90% interval around oe_syn.'),
    lof_z: z.number().nullable().describe('LoF constraint Z-score.'),
    mis_z: z.number().nullable().describe('Missense constraint Z-score.'),
    syn_z: z.number().nullable().describe('Synonymous constraint Z-score.'),
    obs_lof: z.number().nonnegative().nullable().describe('Observed LoF variant count.'),
    exp_lof: z.number().nonnegative().nullable().describe('Expected LoF variant count.'),
    obs_mis: z.number().nonnegative().nullable().describe('Observed missense variant count.'),
    exp_mis: z.number().nonnegative().nullable().describe('Expected missense variant count.'),
    obs_syn: z.number().nonnegative().nullable().describe('Observed synonymous variant count.'),
    exp_syn: z.number().nonnegative().nullable().describe('Expected synonymous variant count.'),
    constraint_flags: z
      .array(z.string())
      .describe(
        'Caveat flags gnomAD attaches to the gene’s constraint (e.g. no_exp_lof, mis_too_many, syn_outlier); empty when none.',
      ),
    mitochondrial_constraint: z
      .union([
        ProteinMitochondrialConstraint,
        RnaMitochondrialConstraint,
        z.null().describe('No mitochondrial constraint: the gene is nuclear.'),
      ])
      .describe(
        'gnomAD’s mitochondrial gene constraint, from 56,434 gnomAD v4.1 genomes; null for a nuclear gene. kind protein carries stop-gain (lof; splice variants do not apply in mtDNA), missense (mis), and synonymous (syn) sets, kind rna one set over all SNVs. Observed and expected are sums of maximum heteroplasmy over every possible SNV, not variant counts, and the intervals come from a beta distribution, so the nuclear LOEUF thresholds do not apply; gnomAD reads the upper bound (OEUF) as the conservative measure, lower meaning stronger selection. The same table on every dataset, exac included.',
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
      when: 'gnomAD returned constraint metrics outside their valid ranges (such as a pLI above 1), or a mitochondrial constraint of a shape its schema does not define.',
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
