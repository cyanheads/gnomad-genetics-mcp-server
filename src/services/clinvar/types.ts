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
  clinical_significance: string | null;
  clinvar_variation_id: string;
  conditions: string;
  gold_stars: number;
  last_evaluated: string | null;
  molecular_consequences: string;
  obj_type: string;
  protein_change: string;
  review_status: string | null;
  submission_count: number;
  title: string;
  [key: string]: string | number | null;
}

/** Filters for a gene-level ClinVar search. */
export interface ClinVarFilters {
  clinicalSignificance?: string | undefined;
  minReviewStars?: number | undefined;
}
