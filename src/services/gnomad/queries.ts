/**
 * @fileoverview Parameterized gnomAD GraphQL query documents — one per tool.
 * Each requests only the fields its tool returns. Field names are grounded
 * against the live schema (gnomad.broadinstitute.org/api).
 * @module services/gnomad/queries
 */

/**
 * Shared variant field selection — reused by the variantId and rsid documents.
 * Type is `VariantDetails`, which has NO top-level gene_symbol/transcript_id/
 * consequence (those live on the flattened gene-variant `Variant` type only);
 * the consequence is derived from transcript_consequences[0].
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
  populations { id ac an homozygote_count hemizygote_count }
}
genome {
  ac
  an
  af
  homozygote_count
  hemizygote_count
  populations { id ac an homozygote_count hemizygote_count }
}
transcript_consequences {
  gene_symbol
  transcript_id
  major_consequence
}
in_silico_predictors { id value }`;

/**
 * Single-variant population record by chrom-pos-ref-alt variantId + joined
 * ClinVar significance. `clinvar_variant` is a sibling top-level field (NOT
 * nested in `variant`) and takes `reference_genome`, not `dataset`.
 * Per-population AF is absent upstream and computed client-side as ac/an.
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

/** ClinVar join for a resolved variant_id (second hop for rsID lookups). */
export const CLINVAR_BY_VARIANT_ID_QUERY = `
query GnomadClinvar($variantId: String!, $referenceGenome: ReferenceGenomeId!) {
  clinvar_variant(variant_id: $variantId, reference_genome: $referenceGenome) {
    clinical_significance
    review_status
    gold_stars
    clinvar_variation_id
  }
}` as const;

/** Gene loss-of-function constraint, by gene symbol. */
export const GENE_CONSTRAINT_BY_SYMBOL_QUERY = `
query GnomadGeneConstraintBySymbol($gene: String!, $referenceGenome: ReferenceGenomeId!) {
  gene(gene_symbol: $gene, reference_genome: $referenceGenome) {
    gene_id
    symbol
    gnomad_constraint {
      pli oe_lof oe_lof_lower oe_lof_upper oe_mis oe_syn
      lof_z mis_z syn_z
      obs_lof exp_lof obs_mis exp_mis obs_syn exp_syn
      flags
    }
  }
}` as const;

/** Gene loss-of-function constraint, by Ensembl gene ID. */
export const GENE_CONSTRAINT_BY_ID_QUERY = `
query GnomadGeneConstraintById($gene: String!, $referenceGenome: ReferenceGenomeId!) {
  gene(gene_id: $gene, reference_genome: $referenceGenome) {
    gene_id
    symbol
    gnomad_constraint {
      pli oe_lof oe_lof_lower oe_lof_upper oe_mis oe_syn
      lof_z mis_z syn_z
      obs_lof exp_lof obs_mis exp_mis obs_syn exp_syn
      flags
    }
  }
}` as const;

/** Shared selection for a flattened gene/region/transcript variant list element. */
const VARIANT_LIST_SELECTION = `
variants(dataset: $dataset) {
  variant_id
  consequence
  flags
  exome { ac an af homozygote_count }
  genome { ac an af homozygote_count }
}`;

export const GENE_VARIANTS_BY_SYMBOL_QUERY = `
query GnomadGeneVariantsBySymbol($gene: String!, $dataset: DatasetId!, $referenceGenome: ReferenceGenomeId!) {
  gene(gene_symbol: $gene, reference_genome: $referenceGenome) { ${VARIANT_LIST_SELECTION} }
}` as const;

export const GENE_VARIANTS_BY_ID_QUERY = `
query GnomadGeneVariantsById($gene: String!, $dataset: DatasetId!, $referenceGenome: ReferenceGenomeId!) {
  gene(gene_id: $gene, reference_genome: $referenceGenome) { ${VARIANT_LIST_SELECTION} }
}` as const;

export const TRANSCRIPT_VARIANTS_QUERY = `
query GnomadTranscriptVariants($transcriptId: String!, $dataset: DatasetId!, $referenceGenome: ReferenceGenomeId!) {
  transcript(transcript_id: $transcriptId, reference_genome: $referenceGenome) { ${VARIANT_LIST_SELECTION} }
}` as const;

export const REGION_VARIANTS_QUERY = `
query GnomadRegionVariants($chrom: String!, $start: Int!, $stop: Int!, $dataset: DatasetId!, $referenceGenome: ReferenceGenomeId!) {
  region(chrom: $chrom, start: $start, stop: $stop, reference_genome: $referenceGenome) { ${VARIANT_LIST_SELECTION} }
}` as const;

/** Shared coverage selection — exome and genome bins. */
const COVERAGE_SELECTION = `
coverage(dataset: $dataset) {
  exome { pos mean median over_1 over_5 over_10 over_15 over_20 over_25 over_30 over_50 over_100 }
  genome { pos mean median over_1 over_5 over_10 over_15 over_20 over_25 over_30 over_50 over_100 }
}`;

export const GENE_COVERAGE_BY_SYMBOL_QUERY = `
query GnomadGeneCoverageBySymbol($gene: String!, $dataset: DatasetId!, $referenceGenome: ReferenceGenomeId!) {
  gene(gene_symbol: $gene, reference_genome: $referenceGenome) { ${COVERAGE_SELECTION} }
}` as const;

export const GENE_COVERAGE_BY_ID_QUERY = `
query GnomadGeneCoverageById($gene: String!, $dataset: DatasetId!, $referenceGenome: ReferenceGenomeId!) {
  gene(gene_id: $gene, reference_genome: $referenceGenome) { ${COVERAGE_SELECTION} }
}` as const;

export const TRANSCRIPT_COVERAGE_QUERY = `
query GnomadTranscriptCoverage($transcriptId: String!, $dataset: DatasetId!, $referenceGenome: ReferenceGenomeId!) {
  transcript(transcript_id: $transcriptId, reference_genome: $referenceGenome) { ${COVERAGE_SELECTION} }
}` as const;

export const REGION_COVERAGE_QUERY = `
query GnomadRegionCoverage($chrom: String!, $start: Int!, $stop: Int!, $dataset: DatasetId!, $referenceGenome: ReferenceGenomeId!) {
  region(chrom: $chrom, start: $start, stop: $stop, reference_genome: $referenceGenome) { ${COVERAGE_SELECTION} }
}` as const;
