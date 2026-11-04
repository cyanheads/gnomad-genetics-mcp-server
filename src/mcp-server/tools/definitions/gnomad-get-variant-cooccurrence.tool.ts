/**
 * @fileoverview gnomad_get_variant_cooccurrence — whether two variants in one
 * gene sit on different haplotypes (in trans) or the same one (in cis), from
 * gnomAD v2.1 exome genotypes: the probability of compound heterozygosity and
 * the genotype and haplotype counts behind it, overall and per
 * genetic-ancestry group. gnomAD serves co-occurrence on gnomad_r2_1 alone, so
 * the tool takes no dataset or build and echoes gnomad_r2_1 and GRCh37. Every
 * result carries gnomAD's calibration caveat and its browser's reading of the
 * probability in one notice.
 * @module mcp-server/tools/definitions/gnomad-get-variant-cooccurrence.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { getGnomadService } from '@/services/gnomad/gnomad-service.js';
import type {
  CooccurrenceCounts,
  CooccurrenceGenotypeCounts,
  CooccurrenceHaplotypeCounts,
} from '@/services/gnomad/types.js';
import { normalizeVariantIdentifier } from '../shared-schemas.js';

/** gnomAD's browser reads p_compound_heterozygous above this as likely in trans. */
const TRANS_THRESHOLD = 0.55;
/** gnomAD's browser reads p_compound_heterozygous below this as likely in cis. */
const CIS_THRESHOLD = 0.02;

/** gnomAD's caveat on its co-occurrence probabilities, verbatim from its browser. */
const CALIBRATION_CAVEAT =
  'Probability values are not well calibrated, particularly where both variants are extremely rare. Interpret with caution.';

const READING_RULE = `gnomAD's browser reads p_compound_heterozygous above ${TRANS_THRESHOLD} as likely in trans (on different haplotypes) and below ${CIS_THRESHOLD} as likely in cis (on the same haplotype), and makes no prediction between those, when the probability is null, or when both variants are singletons seen in the same individual; each population reads the same way from its own counts.`;

const GenotypeCountsSchema = z
  .object({
    ref_ref: z
      .number()
      .describe('Samples homozygous reference for variant_ids[0] and for variant_ids[1].'),
    ref_het: z
      .number()
      .describe(
        'Samples homozygous reference for variant_ids[0] and heterozygous for variant_ids[1].',
      ),
    ref_hom: z
      .number()
      .describe(
        'Samples homozygous reference for variant_ids[0] and homozygous alternate for variant_ids[1].',
      ),
    het_ref: z
      .number()
      .describe(
        'Samples heterozygous for variant_ids[0] and homozygous reference for variant_ids[1].',
      ),
    het_het: z
      .number()
      .describe(
        'Samples heterozygous for both variants — the carriers whose phase the probability estimates.',
      ),
    het_hom: z
      .number()
      .describe(
        'Samples heterozygous for variant_ids[0] and homozygous alternate for variant_ids[1].',
      ),
    hom_ref: z
      .number()
      .describe(
        'Samples homozygous alternate for variant_ids[0] and homozygous reference for variant_ids[1].',
      ),
    hom_het: z
      .number()
      .describe(
        'Samples homozygous alternate for variant_ids[0] and heterozygous for variant_ids[1].',
      ),
    hom_hom: z
      .number()
      .describe('Samples homozygous alternate for variant_ids[0] and for variant_ids[1].'),
  })
  .describe(
    "Samples per genotype pair. Each key names variant_ids[0]'s genotype first and variant_ids[1]'s second: ref (homozygous reference), het (heterozygous), hom (homozygous alternate).",
  ) satisfies z.ZodType<CooccurrenceGenotypeCounts>;

const HaplotypeCountsSchema = z
  .object({
    ref_ref: z
      .number()
      .describe('Estimated haplotypes carrying the reference allele of both variants.'),
    ref_alt: z
      .number()
      .describe(
        'Estimated haplotypes carrying the reference allele of variant_ids[0] and the alternate allele of variant_ids[1].',
      ),
    alt_ref: z
      .number()
      .describe(
        'Estimated haplotypes carrying the alternate allele of variant_ids[0] and the reference allele of variant_ids[1].',
      ),
    alt_alt: z
      .number()
      .describe('Estimated haplotypes carrying the alternate allele of both variants (in cis).'),
  })
  .describe(
    "gnomAD's estimated haplotype counts, fractional where samples heterozygous for both variants leave the phase to its EM estimate. Each key names variant_ids[0]'s allele first and variant_ids[1]'s second.",
  ) satisfies z.ZodType<CooccurrenceHaplotypeCounts>;

const ProbabilitySchema = z
  .number()
  .nullable()
  .describe(
    'Estimated probability that the two variants lie on different haplotypes (in trans, compound heterozygous). Null when gnomAD computes none, as when either variant has no carrier among these samples — never read null as 0.',
  );

const PopulationSchema = z
  .object({
    id: z
      .string()
      .describe(
        'Genetic-ancestry group of gnomAD v2.1 exomes: afr, amr, asj, eas, fin, nfe, oth, sas.',
      ),
    p_compound_heterozygous: ProbabilitySchema,
    genotype_counts: GenotypeCountsSchema,
    haplotype_counts: HaplotypeCountsSchema,
  })
  .describe("One genetic-ancestry group's co-occurrence counts, keyed like the overall counts.");

/**
 * gnomAD's browser reading of one set of co-occurrence counts: no prediction
 * when both variants are singletons in the same individual or the probability
 * is null, else in trans above TRANS_THRESHOLD and in cis below CIS_THRESHOLD.
 */
function readingOf({ genotype_counts: g, p_compound_heterozygous: p }: CooccurrenceCounts): string {
  const carriers = Object.values(g).reduce((sum, count) => sum + count, 0) - g.ref_ref;
  if (g.het_het === 1 && carriers === 1) {
    return 'gets no prediction, because both variants are singletons seen in the same individual';
  }
  if (p === null) return 'gets no prediction, because gnomAD gives no probability';
  if (p > TRANS_THRESHOLD) return 'is likely in trans (on different haplotypes)';
  if (p < CIS_THRESHOLD) return 'is likely in cis (on the same haplotype)';
  return 'gets no prediction, because the probability falls between the two thresholds';
}

/** Render one count object as `key value` pairs in its key order, values unrounded. */
const countsLine = (counts: Record<string, number>) =>
  Object.entries(counts)
    .map(([key, value]) => `${key} ${value}`)
    .join(', ');

const probability = (p: number | null) => (p === null ? 'null (no probability)' : String(p));

export const gnomadGetVariantCooccurrence = tool('gnomad_get_variant_cooccurrence', {
  title: 'gnomad-genetics-mcp-server: get variant cooccurrence',
  description: `Estimate whether two variants in the same gene sit on different haplotypes (in trans — compound heterozygous) or on the same one (in cis), from gnomAD v2.1 exome genotypes: the probability of compound heterozygosity and the genotype and haplotype counts behind it, overall and per genetic-ancestry group. For a proband with two rare heterozygous variants in a recessive gene and no parental samples. Takes exactly two GRCh37 chrom-pos-ref-alt IDs and always reads gnomad_r2_1, the only dataset gnomAD serves co-occurrence for, echoing it with GRCh37. A GRCh38 ID can name a different GRCh37 variant or none, so convert GRCh38 IDs first: gnomad_get_variant on dataset gnomad_r2_1 lists their GRCh37 IDs as candidates only when the ID fails there as variant_not_found_other_build; an ID gnomad_r2_1 finds returns a different variant. gnomAD answers only for two different coding or UTR variants of one gene, both in its exome samples with exome allele frequency of 5% or less; any other pair fails as cooccurrence_unavailable with gnomAD's reason. Each count key names variant_ids[0]'s genotype or allele first and variant_ids[1]'s second, and variant_ids can list the pair in another order than sent. The notice carries gnomAD's calibration caveat and its browser's reading of the probability. gnomAD's browser also notes when the pair is found in phase as a multi-nucleotide variant; this tool does not check for one.\nData source: gnomAD (Broad Institute) — https://gnomad.broadinstitute.org/`,
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    variants: z
      .array(
        z
          .string()
          .describe(
            'GRCh37 variant ID — chrom-pos-ref-alt (1-based, e.g. 1-55505647-G-T) on chromosome 1–22, X, or Y, with an optional chr prefix.',
          ),
      )
      .length(2)
      .describe(
        'The two variants to phase, as GRCh37 chrom-pos-ref-alt IDs. Order does not matter: variant_ids in the output gives the order the counts use.',
      ),
  }),
  output: z.object({
    variant_ids: z
      .array(z.string())
      .describe(
        "The pair in gnomAD's order, which labels every count: variant_ids[0] is the first token of each key, variant_ids[1] the second. Can differ from the order sent.",
      ),
    dataset: z
      .literal('gnomad_r2_1')
      .describe(
        'Dataset the counts come from — always gnomad_r2_1, the only one gnomAD serves co-occurrence for.',
      ),
    reference_genome: z
      .literal('GRCh37')
      .describe('Reference build of variant_ids — always GRCh37.'),
    p_compound_heterozygous: ProbabilitySchema,
    genotype_counts: GenotypeCountsSchema,
    haplotype_counts: HaplotypeCountsSchema,
    populations: z
      .array(PopulationSchema)
      .describe("The same counts per genetic-ancestry group, in gnomAD's order."),
  }),
  enrichment: {
    notice: z
      .string()
      .describe(
        "gnomAD's calibration caveat and its browser's reading of the probability for this pair. When no sample carries both variants, it adds that the counts come from each variant's separate data and do not account for samples not covered at both sites; that coverage sentence appears only then.",
      ),
  },
  enrichmentTrailer: { notice: { render: escapeMarkdownInline } },
  errors: [
    {
      reason: 'invalid_variant_id',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A variant is not a chrom-pos-ref-alt ID on chromosome 1–22, X, or Y — an rsID included, since co-occurrence takes coordinate IDs.',
      recovery:
        'Pass two GRCh37 chrom-pos-ref-alt IDs such as 1-55505647-G-T; gnomad_get_variant on dataset gnomad_r2_1 resolves an rsID to its GRCh37 ID.',
    },
    {
      reason: 'mitochondrial_unsupported',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A variant ID names the mitochondrial chromosome (M, MT, or chrM).',
      recovery:
        'Co-occurrence covers nuclear exome variants only; pass two IDs on chromosomes 1–22, X, or Y.',
      thrownBy: 'service',
    },
    {
      reason: 'cooccurrence_unavailable',
      code: JsonRpcErrorCode.ValidationError,
      when: "gnomAD refused the pair: the same variant twice, a variant absent from gnomAD v2.1 (as a GRCh38 ID usually is), variants in different genes or outside coding and UTR sequence, a variant with no exome call, or one with exome allele frequency above 5%. The message is gnomAD's reason.",
      recovery:
        'Do not resend this pair: gnomAD phases only two different coding or UTR variants of one gene, both in its v2.1 exomes at allele frequency 5% or less. For GRCh38 IDs, run gnomad_get_variant on dataset gnomad_r2_1 and retry with the GRCh37 IDs in its candidates when an ID fails as variant_not_found_other_build.',
      thrownBy: 'service',
    },
    {
      reason: 'graphql_error',
      code: JsonRpcErrorCode.ValidationError,
      when: 'gnomAD rejected the co-occurrence query with a GraphQL error other than a refusal of the pair.',
      recovery:
        'Check both IDs are GRCh37 chrom-pos-ref-alt IDs before retrying: gnomAD rejected this query as sent, so the same request fails again.',
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
      recovery: 'gnomAD did not answer in time; wait a few seconds, then retry the same pair.',
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
      when: 'gnomAD kept answering with a response that failed validation — counts of the wrong shape, or variant_ids naming a pair other than the one sent.',
      recovery:
        'Wait a few seconds and retry; gnomAD returned a response this server could not validate.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const variantIds = input.variants.map((variant) => {
      const id = normalizeVariantIdentifier(variant);
      if (id?.kind === 'variant') return id.canonical;
      throw ctx.fail(
        'invalid_variant_id',
        id
          ? `"${variant}" is an rsID; co-occurrence takes GRCh37 chrom-pos-ref-alt IDs.`
          : `Malformed ID "${variant}". Expected a GRCh37 chrom-pos-ref-alt ID (e.g. 1-55505647-G-T) on chromosome 1–22, X, or Y.`,
        { variant },
      );
    });
    const result = await getGnomadService().getVariantCooccurrence(variantIds, ctx);

    // ctx.enrich.notice is last-wins, so the whole notice is built here and sent once.
    const g = result.genotype_counts;
    const coCarriers = g.het_het + g.het_hom + g.hom_het + g.hom_hom;
    ctx.enrich.notice(
      [
        `Across all samples, this pair ${readingOf(result)}.`,
        READING_RULE,
        CALIBRATION_CAVEAT,
        ...(coCarriers > 0
          ? []
          : [
              "No individual in gnomAD carries both variants, so these counts were computed from each variant's separate data and do not account for samples that may not be covered at both variant sites.",
            ]),
      ].join(' '),
    );
    ctx.log.info('gnomad_get_variant_cooccurrence resolved', {
      variantIds: result.variant_ids,
      pCompoundHeterozygous: result.p_compound_heterozygous,
    });
    return result;
  },

  format: (result) => {
    const lines = [
      `**Variants:** ${result.variant_ids.map((id, index) => `variant_ids[${index}] ${escapeMarkdownInline(id)}`).join(', ')} — each count key names variant_ids[0] first`,
      `**Dataset:** ${result.dataset} (${result.reference_genome})`,
      `**p_compound_heterozygous:** ${probability(result.p_compound_heterozygous)}`,
      `**Genotype counts:** ${countsLine(result.genotype_counts)}`,
      `**Haplotype counts (estimated):** ${countsLine(result.haplotype_counts)}`,
    ];
    if (result.populations.length) {
      lines.push('**Per-ancestry:**');
      for (const p of result.populations) {
        lines.push(
          `- ${escapeMarkdownInline(p.id)}: p_compound_heterozygous ${probability(p.p_compound_heterozygous)} | genotypes ${countsLine(p.genotype_counts)} | haplotypes ${countsLine(p.haplotype_counts)}`,
        );
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
