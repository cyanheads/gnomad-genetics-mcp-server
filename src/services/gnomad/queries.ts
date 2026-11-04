/**
 * @fileoverview Parameterized gnomAD GraphQL query documents — one per tool.
 * Each requests only the fields its tool returns, plus `chrom` on the gene and
 * transcript list/coverage documents: gnomAD resolves mitochondrial features but
 * answers their nuclear `variants`/`coverage` fields with nothing, so the
 * service reads `chrom` to refuse them rather than report absence. The gene and
 * transcript coverage documents also carry `exons`, which bound the summarized
 * coverage buckets, and the gene list documents the gene's MANE Select and
 * canonical transcript IDs. Every list document takes `@include` flags that
 * select only the FAF fields the dataset's rows read, and an `annotations`
 * flag that selects the opt-in HGVS, LOFTEE, and rsID columns. The liftover document
 * is built per request, one alias per absent coordinate ID, at most 25 of
 * them. The gene ClinVar-mapping document fills gnomad_search_clinvar's GRCh38
 * variant IDs. Field names are grounded against the live schema
 * (gnomad.broadinstitute.org/api).
 * @module services/gnomad/queries
 */

/**
 * Shared variant field selection — reused by the variantId and rsid documents.
 * Type is `VariantDetails`, which has NO top-level gene_symbol/transcript_id/
 * consequence (those live on the flattened gene-variant `Variant` type only);
 * the consequence, its HGVS, and its LOFTEE call are derived from
 * transcript_consequences[0], and the primary transcript from the MANE Select
 * or canonical entry of that entry's gene. `lof_curations` holds gnomAD's
 * manual LoF curation verdicts (null when it has none). `joint` is
 * gnomAD's combined exome + genome record, published on gnomad_r4 only (null
 * elsewhere); it has no `af` field. Each callset's `filters` is its QC verdict.
 * `joint.filters` is not selected: it carries joint-level flags
 * (`discrepant_frequencies`, `not_called_in_*`) and disagrees between the detail
 * and list documents for the same variant (1-55039866-G-A: `[]` here, `["AC0"]`
 * in the list), so it never decides QC status. Each record's `faf95` is
 * gnomAD's GroupMax filtering allele frequency (`popmax` the value,
 * `popmax_population` its group); this document carries no `fafmax`. On a
 * gnomad_r4 or gnomad_r3 subset gnomAD answers it with the parent release's
 * FAF, which the service never relays.
 */
const VARIANT_SELECTION = `
variant_id
reference_genome
rsids
flags
exome {
  ac
  an
  af
  homozygote_count
  hemizygote_count
  filters
  faf95 { popmax popmax_population }
  populations { id ac an homozygote_count hemizygote_count }
}
genome {
  ac
  an
  af
  homozygote_count
  hemizygote_count
  filters
  faf95 { popmax popmax_population }
  populations { id ac an homozygote_count hemizygote_count }
}
joint {
  ac
  an
  homozygote_count
  hemizygote_count
  faf95 { popmax popmax_population }
  populations { id ac an homozygote_count hemizygote_count }
}
transcript_consequences {
  gene_id
  gene_symbol
  transcript_id
  major_consequence
  is_mane_select
  is_canonical
  hgvsc
  hgvsp
  lof
  lof_filter
  lof_flags
}
lof_curations { gene_id gene_symbol verdict flags project }
in_silico_predictors { id value }`;

/**
 * Single-variant population record by chrom-pos-ref-alt variantId + joined
 * ClinVar significance. `clinvar_variant` is a sibling top-level field (NOT
 * nested in `variant`) and takes `reference_genome`, not `dataset`.
 * Per-population AF is absent upstream and computed client-side as ac/an.
 * A reply carrying errors beside a populated `variant` is discarded and the
 * lookup re-sent as VARIANT_ONLY_QUERY and CLINVAR_BY_VARIANT_ID_QUERY.
 */
export const VARIANT_QUERY = `
query GnomadVariant($variantId: String!, $dataset: DatasetId!, $referenceGenome: ReferenceGenomeId!) {
  variant(variantId: $variantId, dataset: $dataset) { ${VARIANT_SELECTION} }
  clinvar_variant(variant_id: $variantId, reference_genome: $referenceGenome) {
    clinical_significance
    review_status
    gold_stars
    clinvar_variation_id
  }
}` as const;

/**
 * Resolve a single variant by rsID. gnomAD's `variant(variantId:)` rejects
 * rsIDs — they go through the dedicated `rsid` argument, which errors if the
 * rsID maps to multiple variants. ClinVar is fetched separately (keyed on the
 * resolved variant_id) since the join needs a chrom-pos-ref-alt.
 */
export const VARIANT_BY_RSID_QUERY = `
query GnomadVariantByRsid($rsid: String!, $dataset: DatasetId!) {
  variant(rsid: $rsid, dataset: $dataset) { ${VARIANT_SELECTION} }
}` as const;

/** Resolve concrete variant IDs associated with an ambiguous rsID. */
export const VARIANT_SEARCH_QUERY = `
query GnomadVariantSearch($query: String!, $dataset: DatasetId!) {
  variant_search(query: $query, dataset: $dataset) { variant_id }
}` as const;

/**
 * The variantId document's `variant` root alone — the population half of a
 * split lookup, sent when the combined reply carries errors beside a populated
 * `variant`. gnomAD's errors carry no `path`, so only a request of its own can
 * attribute an error to the variant rather than to the ClinVar join.
 */
export const VARIANT_ONLY_QUERY = `
query GnomadVariantOnly($variantId: String!, $dataset: DatasetId!) {
  variant(variantId: $variantId, dataset: $dataset) { ${VARIANT_SELECTION} }
}` as const;

/**
 * ClinVar join for a variant_id on its own — the rsID path's second hop, and
 * the ClinVar half of a split coordinate lookup.
 */
export const CLINVAR_BY_VARIANT_ID_QUERY = `
query GnomadClinvar($variantId: String!, $referenceGenome: ReferenceGenomeId!) {
  clinvar_variant(variant_id: $variantId, reference_genome: $referenceGenome) {
    clinical_significance
    review_status
    gold_stars
    clinvar_variation_id
  }
}` as const;

/**
 * gnomAD's liftover table for several variant IDs in one request: alias `l<i>`
 * looks up variable `$v<i>`, keyed by `argument` — `source_variant_id` reads an
 * ID as a GRCh37 source, `liftover_variant_id` as a GRCh38 target — with
 * `$referenceGenome` naming that ID's build. Each alias answers a list, empty
 * when the table holds no entry. gnomAD fails the whole document with an HTTP
 * 500 when any variable is an rsID, so only coordinate IDs belong in it.
 */
export function liftoverQuery(
  count: number,
  argument: 'source_variant_id' | 'liftover_variant_id',
): string {
  const indexes = Array.from({ length: count }, (_, index) => index);
  const variables = indexes.map((index) => `$v${index}: String!`).join(', ');
  const fields = indexes
    .map(
      (index) =>
        `  l${index}: liftover(${argument}: $v${index}, reference_genome: $referenceGenome) { source { variant_id } liftover { variant_id } }`,
    )
    .join('\n');
  return `
query GnomadLiftover(${variables}, $referenceGenome: ReferenceGenomeId!) {
${fields}
}`;
}

/**
 * Shared gene constraint selection. `gnomad_constraint` holds the build's gnomAD
 * table (v4.1.2 on GRCh38, v2.1.1 on GRCh37, which answers `oe_lof_percentile`
 * with null); `exac_constraint` holds ExAC r0.3 (GRCh37 only, null on GRCh38),
 * which publishes no ratios, intervals, percentile, or flags. The service reads
 * one of the two by dataset. `mitochondrial_constraint` is gnomAD's union of a
 * protein-coding and an RNA member, one table served on both builds and null
 * for a nuclear gene; `__typename` tells the members apart.
 */
const GENE_CONSTRAINT_SELECTION = `
gene_id
symbol
gnomad_constraint {
  pli oe_lof oe_lof_lower oe_lof_upper oe_lof_percentile
  oe_mis oe_mis_lower oe_mis_upper oe_syn oe_syn_lower oe_syn_upper
  lof_z mis_z syn_z
  obs_lof exp_lof obs_mis exp_mis obs_syn exp_syn
  flags
}
exac_constraint {
  pli lof_z mis_z syn_z
  obs_lof exp_lof obs_mis exp_mis obs_syn exp_syn
}
mitochondrial_constraint {
  __typename
  ... on ProteinMitochondrialGeneConstraint {
    obs_lof exp_lof oe_lof oe_lof_lower oe_lof_upper
    obs_mis exp_mis oe_mis oe_mis_lower oe_mis_upper
    obs_syn exp_syn oe_syn oe_syn_lower oe_syn_upper
  }
  ... on RNAMitochondrialGeneConstraint {
    observed expected oe oe_lower oe_upper
  }
}`;

/** Gene loss-of-function constraint, by gene symbol. */
export const GENE_CONSTRAINT_BY_SYMBOL_QUERY = `
query GnomadGeneConstraintBySymbol($gene: String!, $referenceGenome: ReferenceGenomeId!) {
  gene(gene_symbol: $gene, reference_genome: $referenceGenome) { ${GENE_CONSTRAINT_SELECTION} }
}` as const;

/** Gene loss-of-function constraint, by Ensembl gene ID. */
export const GENE_CONSTRAINT_BY_ID_QUERY = `
query GnomadGeneConstraintById($gene: String!, $referenceGenome: ReferenceGenomeId!) {
  gene(gene_id: $gene, reference_genome: $referenceGenome) { ${GENE_CONSTRAINT_SELECTION} }
}` as const;

/**
 * Shared selection for a flattened gene/region/transcript variant list element.
 * `joint` carries the totals alone: its `populations` feed no list column and
 * would multiply the response about 3.6× (PCSK9 on gnomad_r4, as of November 2026).
 * Every record carries its zygosity counts — `hemizygote_count` beside
 * `homozygote_count`, read from the same record as ac and an. Each callset
 * carries its QC `filters`; joint's are not selected (see VARIANT_SELECTION).
 * `transcript_id` names the transcript `consequence` is on, and `lof` is
 * LOFTEE's call on it. The HGVS, LOFTEE filter and flags, and rsIDs are
 * included only on an `annotations` request: they add about 10.8 MB to TTN's
 * gnomad_r4 reply (as of November 2026), which every page re-fetches.
 *
 * The FAF fields are each included only on the datasets whose rows read them
 * (the service's listRowFafField): joint `fafmax` on gnomad_r4, callset
 * `fafmax` on gnomad_r4_non_ukb, callset `faf95` on the gnomad_r2_1 family,
 * none on the gnomad_r3 family or exac. Every gnomad_r4 row carries joint
 * data, so callset FAF there never sets a row and would add about 3.7 MB to
 * TTN's reply (as of November 2026); the list joint type has no `faf95`.
 */
const LIST_CALLSET_FIELDS = `ac an af homozygote_count hemizygote_count filters faf95 @include(if: $callsetFaf95) { popmax popmax_population } fafmax @include(if: $callsetFafmax) { faf95_max faf95_max_gen_anc }`;

const VARIANT_LIST_SELECTION = `
variants(dataset: $dataset) {
  variant_id
  consequence
  transcript_id
  lof
  hgvsc @include(if: $annotations)
  hgvsp @include(if: $annotations)
  lof_filter @include(if: $annotations)
  lof_flags @include(if: $annotations)
  rsids @include(if: $annotations)
  flags
  exome { ${LIST_CALLSET_FIELDS} }
  genome { ${LIST_CALLSET_FIELDS} }
  joint { ac an homozygote_count hemizygote_count fafmax @include(if: $jointFafmax) { faf95_max faf95_max_gen_anc } }
}`;

/** The variables every list document declares beside its target, dataset, and build. */
const LIST_VARIABLES =
  '$jointFafmax: Boolean!, $callsetFafmax: Boolean!, $callsetFaf95: Boolean!, $annotations: Boolean!';

/**
 * The gene list documents also select the gene's MANE Select and canonical
 * transcript IDs, which mark each row's consequence transcript as gnomAD's gene
 * table does.
 */
const GENE_VARIANTS_SELECTION = `chrom canonical_transcript_id mane_select_transcript { ensembl_id } ${VARIANT_LIST_SELECTION}`;

export const GENE_VARIANTS_BY_SYMBOL_QUERY = `
query GnomadGeneVariantsBySymbol($gene: String!, $dataset: DatasetId!, $referenceGenome: ReferenceGenomeId!, ${LIST_VARIABLES}) {
  gene(gene_symbol: $gene, reference_genome: $referenceGenome) { ${GENE_VARIANTS_SELECTION} }
}` as const;

export const GENE_VARIANTS_BY_ID_QUERY = `
query GnomadGeneVariantsById($gene: String!, $dataset: DatasetId!, $referenceGenome: ReferenceGenomeId!, ${LIST_VARIABLES}) {
  gene(gene_id: $gene, reference_genome: $referenceGenome) { ${GENE_VARIANTS_SELECTION} }
}` as const;

export const TRANSCRIPT_VARIANTS_QUERY = `
query GnomadTranscriptVariants($transcriptId: String!, $dataset: DatasetId!, $referenceGenome: ReferenceGenomeId!, ${LIST_VARIABLES}) {
  transcript(transcript_id: $transcriptId, reference_genome: $referenceGenome) { chrom ${VARIANT_LIST_SELECTION} }
}` as const;

export const REGION_VARIANTS_QUERY = `
query GnomadRegionVariants($chrom: String!, $start: Int!, $stop: Int!, $dataset: DatasetId!, $referenceGenome: ReferenceGenomeId!, ${LIST_VARIABLES}) {
  region(chrom: $chrom, start: $start, stop: $stop, reference_genome: $referenceGenome) { ${VARIANT_LIST_SELECTION} }
}` as const;

/** Shared coverage selection — gnomAD's exome and genome histogram buckets. */
const COVERAGE_SELECTION = `
coverage(dataset: $dataset) {
  exome { pos mean median over_1 over_5 over_10 over_15 over_20 over_25 over_30 over_50 over_100 }
  genome { pos mean median over_1 over_5 over_10 over_15 over_20 over_25 over_30 over_50 over_100 }
}`;

/**
 * Gene and transcript coverage also select `exons`: gnomAD queries coverage over
 * the merged exons ±75 bp, and the service needs those intervals to size the
 * buckets and drop the zero-filled intron buckets between them.
 */
const FEATURE_COVERAGE_SELECTION = `chrom exons { start stop } ${COVERAGE_SELECTION}`;

export const GENE_COVERAGE_BY_SYMBOL_QUERY = `
query GnomadGeneCoverageBySymbol($gene: String!, $dataset: DatasetId!, $referenceGenome: ReferenceGenomeId!) {
  gene(gene_symbol: $gene, reference_genome: $referenceGenome) { ${FEATURE_COVERAGE_SELECTION} }
}` as const;

export const GENE_COVERAGE_BY_ID_QUERY = `
query GnomadGeneCoverageById($gene: String!, $dataset: DatasetId!, $referenceGenome: ReferenceGenomeId!) {
  gene(gene_id: $gene, reference_genome: $referenceGenome) { ${FEATURE_COVERAGE_SELECTION} }
}` as const;

export const TRANSCRIPT_COVERAGE_QUERY = `
query GnomadTranscriptCoverage($transcriptId: String!, $dataset: DatasetId!, $referenceGenome: ReferenceGenomeId!) {
  transcript(transcript_id: $transcriptId, reference_genome: $referenceGenome) { ${FEATURE_COVERAGE_SELECTION} }
}` as const;

export const REGION_COVERAGE_QUERY = `
query GnomadRegionCoverage($chrom: String!, $start: Int!, $stop: Int!, $dataset: DatasetId!, $referenceGenome: ReferenceGenomeId!) {
  region(chrom: $chrom, start: $start, stop: $stop, reference_genome: $referenceGenome) { ${COVERAGE_SELECTION} }
}` as const;

/**
 * Co-occurrence of a variant pair in gnomAD's v2.1 exomes, overall and per
 * genetic-ancestry group. gnomAD refuses every dataset but gnomad_r2_1, and
 * answers a pair it will not phase with a GraphQL error beside a null root.
 */
export const VARIANT_COOCCURRENCE_QUERY = `
query GnomadVariantCooccurrence($variants: [String!]!, $dataset: DatasetId!) {
  variant_cooccurrence(variants: $variants, dataset: $dataset) {
    variant_ids
    genotype_counts
    haplotype_counts
    p_compound_heterozygous
    populations { id genotype_counts haplotype_counts p_compound_heterozygous }
  }
}` as const;

/**
 * gnomAD's ClinVar mapping for one gene on GRCh38: each ClinVar VariationID it
 * holds and the gnomAD variant ID it derived from ClinVar's VCF, anchor base
 * kept. `clinvar_variants` takes no arguments (no paging, no dataset), and one
 * gene per document stays under gnomAD's query-cost limit, which three aliased
 * genes exceed.
 */
export const GENE_CLINVAR_VARIANT_IDS_QUERY = `
query GnomadGeneClinvarVariantIds($gene: String!) {
  gene(gene_symbol: $gene, reference_genome: GRCh38) { clinvar_variants { clinvar_variation_id variant_id } }
}` as const;
