/**
 * @fileoverview gnomad_variant_triage — guided rare-disease variant-triage
 * workflow: resolve the variant → pull its population record → check gene
 * constraint → confirm the position is well-covered before calling it "absent."
 * Emits the tool chain a clinical analyst runs, in order. The coverage step is
 * the one analysts most often skip, so the template makes it explicit.
 * @module mcp-server/prompts/definitions/variant-triage.prompt
 */

import { prompt, z } from '@cyanheads/mcp-ts-core';

export const variantTriagePrompt = prompt('gnomad_variant_triage', {
  description:
    'Guided rare-disease variant-triage workflow over gnomAD: pull the variant population record, weigh it against gene loss-of-function constraint, and — critically — confirm the position is well-covered before concluding a variant is absent. Emits the exact tool chain in order.',
  title: 'gnomAD variant triage',
  args: z.object({
    variant: z
      .string()
      .describe(
        'Variant to triage — a chrom-pos-ref-alt variantId (e.g. 1-55051215-G-GA) or an rsID (rs11591147).',
      ),
    gene: z
      .string()
      .optional()
      .describe(
        'Gene symbol or Ensembl ID for the constraint step (e.g. PCSK9). Omit if not yet known.',
      ),
    dataset: z
      .string()
      .optional()
      .describe(
        'gnomAD dataset to use (e.g. gnomad_r4, gnomad_r2_1). Defaults to the server default when omitted.',
      ),
  }),
  generate: (args) => {
    const datasetClause = args.dataset ? `, dataset: ${args.dataset}` : '';
    const geneStep = args.gene
      ? `2. **Gene constraint.** Call \`gnomad_get_gene_constraint(gene: "${args.gene}"${datasetClause})\`. Read pLI (>0.9 intolerant) and LOEUF / oe_lof_upper (<0.6 intolerant in v4, <0.35 in v2). High constraint weights a loss-of-function variant as more likely deleterious.`
      : `2. **Gene constraint.** Identify the affected gene (from the variant's consequence in step 1, or via ensembl_lookup_gene), then call \`gnomad_get_gene_constraint(gene: <symbol>${datasetClause})\`. Read pLI and LOEUF (oe_lof_upper) to judge how intolerant the gene is to being broken.`;
    const coverageTarget = args.gene ? `gene: "${args.gene}"` : 'gene: <symbol>';

    return [
      {
        role: 'user',
        content: {
          type: 'text',
          text: [
            `Triage variant **${args.variant}** for rare-disease causality using gnomAD. Run these steps in order and report the population context plainly — never overstate certainty from a missing field.`,
            '',
            `1. **Population frequency.** Call \`gnomad_get_variant(variants: ["${args.variant}"]${datasetClause})\`. Report the overall AC/AN/AF and the full per-ancestry vector — a variant common in one genetic-ancestry group and absent in another is exactly the signal. Note homozygote/hemizygote counts, quality flags, and any joined ClinVar significance.`,
            '',
            geneStep,
            '',
            `3. **Callability check (do not skip).** If step 1 returned the variant as absent or ultra-rare, call \`gnomad_get_coverage(${coverageTarget}${datasetClause})\` to confirm the position is well-covered. An absent variant in a well-covered region is informative; one in a poorly-covered region is uninterpretable — the absence may just be uncallable sequence. This step is the one analysts most often skip.`,
            '',
            `Synthesize: is the variant rare enough to be plausibly pathogenic, in a gene intolerant to its consequence class, at a callable position? State which axes support causality and which do not, and flag any uncertainty (sparse ancestry data, beta v4 constraint, low coverage) honestly.`,
          ].join('\n'),
        },
      },
    ];
  },
});
