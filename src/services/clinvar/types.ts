/**
 * @fileoverview Domain types for the optional ClinVar service (NCBI E-utilities).
 * @module services/clinvar/types
 */

/**
 * One row of the gnomad_search_clinvar canvas table. Index signature lets it
 * satisfy the spillover/canvas `Record<string, unknown>` row constraint.
 */
export interface ClinVarRow {
  accession: string;
  /** Canonical SPDI of a single-allele record; null otherwise. */
  canonical_spdi: string | null;
  /** Somatic clinical-impact (AMP/ASCO/CAP tier) classification; null when none. */
  clinical_impact_classification: string | null;
  /** Tumor types the clinical-impact classification names, semicolon-joined; empty when none. */
  clinical_impact_conditions: string;
  clinical_impact_last_evaluated: string | null;
  clinical_impact_review_status: string | null;
  /** Germline classification; the filters and `gold_stars` read the germline block alone. */
  clinical_significance: string | null;
  clinvar_variation_id: string;
  /** Germline classification's conditions, semicolon-joined; empty when none. */
  conditions: string;
  gold_stars: number;
  /**
   * gnomAD `chrom-pos-ref-alt` ID (GRCh38): derived from the canonical SPDI
   * where that mapping is exact (SNVs, MNVs, delins), else filled by the tool
   * from gnomAD's ClinVar mapping by VariationID; null when neither has it.
   */
  grch38_variant_id: string | null;
  last_evaluated: string | null;
  molecular_consequences: string;
  obj_type: string;
  /** Somatic oncogenicity classification; null when none. */
  oncogenicity_classification: string | null;
  /** Tumor types the oncogenicity classification names, semicolon-joined; empty when none. */
  oncogenicity_conditions: string;
  oncogenicity_last_evaluated: string | null;
  oncogenicity_review_status: string | null;
  protein_change: string;
  review_status: string | null;
  /** dbSNP rsIDs, semicolon-joined; empty when none. */
  rsids: string;
  submission_count: number;
  title: string;
  [key: string]: string | number | null;
}

/** Filters and window for a gene-level ClinVar search. */
export interface ClinVarFilters {
  clinicalSignificance?: string | undefined;
  /** Candidate-ID page size (ESearch `retmax`). Defaults to CLINVAR_WINDOW_DEFAULT (10). */
  limit?: number | undefined;
  minReviewStars?: number | undefined;
  /** Zero-based index of the first candidate ID (ESearch `retstart`). Defaults to 0. */
  offset?: number | undefined;
}

/** One window of a gene-level ClinVar search. */
export interface ClinVarSearchResult {
  /** Offset of the next window, or null when this window reaches the end. */
  nextOffset: number | null;
  /** Rows in this window that passed the significance and star filters. */
  rows: ClinVarRow[];
  /** ESearch hit count for the term sent — candidate IDs across every window. */
  totalFound: number;
  /** True when candidate IDs remain past this window. */
  truncated: boolean;
  /** Requested VariationIDs ESummary returned an error for or left out. */
  unavailableIds: string[];
}
