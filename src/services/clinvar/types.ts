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
  clinical_significance: string | null;
  clinvar_variation_id: string;
  conditions: string;
  gold_stars: number;
  /** gnomAD `chrom-pos-ref-alt` ID derived from the SPDI (GRCh38); null when not derivable. */
  grch38_variant_id: string | null;
  last_evaluated: string | null;
  molecular_consequences: string;
  obj_type: string;
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
  /** Candidate-ID page size (ESearch `retmax`). Defaults to 500. */
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
