/**
 * @fileoverview gnomad_variant_triage — guided rare-disease variant-triage
 * workflow: resolve the variant → pull its population record → check gene
 * constraint → confirm the position is well-covered before calling it "absent."
 * Emits the tool chain a clinical analyst runs, in order. The coverage step is
 * the one analysts most often skip, so the template makes it explicit.
 * @module mcp-server/prompts/definitions/variant-triage.prompt
 */

import { prompt, z } from '@cyanheads/mcp-ts-core';
import { VARIANT_ID_REGEX } from '../../tools/shared-schemas.js';

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
    const datasetClause = args.dataset ? `, dataset: "${args.dataset}"` : '';
    const geneStep = args.gene
      ? `2. **Gene constraint.** Call \`gnomad_get_gene_constraint(gene: "${args.gene}"${datasetClause})\`. Read pLI (>0.9 intolerant) and LOEUF / oe_lof_upper (<0.6 intolerant in v4, <0.35 in v2). High constraint weights a loss-of-function variant as more likely deleterious.`
      : `2. **Gene constraint.** Identify the affected gene (from the variant's consequence in step 1, or via ensembl_lookup_gene), then call \`gnomad_get_gene_constraint(gene: <symbol>${datasetClause})\`. Read pLI and LOEUF (oe_lof_upper) to judge how intolerant the gene is to being broken.`;

    // Coverage must confirm the EXACT variant position. Gene-level coverage
    // averages across the whole gene and can mask a poorly-covered base, so it
    // does not prove the specific position is callable. For a chrom-pos-ref-alt
    // we derive the single-position region (start = stop = pos) up front; for an
    // rsID the coordinates are unknown until step 1 resolves the variant_id.
    const coverageStep = (() => {
      const intro =
        '3. **Callability check (do not skip).** If step 1 returned the variant as absent or ultra-rare, confirm the *exact position* is well-covered before trusting the absence — gene-level coverage averages across the gene and can hide a poorly-covered base.';
      const tail =
        'An absent variant at a well-covered position is informative; one at a poorly-covered position is uninterpretable — the absence may just be uncallable sequence. This step is the one analysts most often skip.';
      if (VARIANT_ID_REGEX.test(args.variant)) {
        const [chrom, pos] = args.variant.split('-');
        return `${intro} Call \`gnomad_get_coverage(region: "${chrom}-${pos}-${pos}"${datasetClause})\` for the single-position region at ${chrom}-${pos}. ${tail}`;
      }
      const fallback = args.gene
        ? ` If exact coordinates are unavailable, \`gnomad_get_coverage(gene: "${args.gene}"${datasetClause})\` is a weaker fallback — it does not confirm the variant position.`
        : ' If exact coordinates are unavailable, gene- or transcript-level coverage is a weaker fallback that does not confirm the variant position.';
      return `${intro} Take the chrom-pos-ref-alt \`variant_id\` that step 1 resolved and call \`gnomad_get_coverage(region: "<chrom>-<pos>-<pos>"${datasetClause})\` for that single position.${fallback} ${tail}`;
    })();

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
            coverageStep,
            '',
            `Synthesize: is the variant rare enough to be plausibly pathogenic, in a gene intolerant to its consequence class, at a callable position? State which axes support causality and which do not, and flag any uncertainty (sparse ancestry data, beta v4 constraint, low coverage) honestly.`,
          ].join('\n'),
        },
      },
    ];
  },
});
