/**
 * @fileoverview Domain types for the gnomAD service — the normalized shapes the
 * tools surface, plus the canonical genetic-ancestry group set. Field names and
 * nullability are grounded against the live gnomAD GraphQL schema.
 * @module services/gnomad/types
 */

import type { GNOMAD_DATASETS } from '@/config/server-config.js';

/** Reference build — a gnomAD ReferenceGenomeId enum value. */
export type ReferenceGenome = 'GRCh38' | 'GRCh37';

/** Dataset — a gnomAD DatasetId enum value. */
export type Dataset = (typeof GNOMAD_DATASETS)[number];

/**
 * Canonical genetic-ancestry group codes. The live schema returns these PLUS
 * sex-split (`_XX`/`_XY`), aggregate (`XX`/`XY`), and v4-genome 1000G/HGDP
 * subpopulation (`1kg:*`, `hgdp:*`) rows — the service filters to this set.
 * Exomes carry all except `ami`; genomes add `ami` (Amish).
 */
export const ANCESTRY_GROUPS = [
  'afr',
  'amr',
  'asj',
  'eas',
  'fin',
  'mid',
  'nfe',
  'sas',
  'remaining',
  'ami',
] as const;

export type AncestryGroup = (typeof ANCESTRY_GROUPS)[number];

const ANCESTRY_SET: ReadonlySet<string> = new Set(ANCESTRY_GROUPS);

/** True when a population `id` is a clean ancestry group (not a sex-split / subpop row). */
export const isCanonicalAncestry = (id: string): id is AncestryGroup => ANCESTRY_SET.has(id);

/** Callset source carrying a variant or coverage track. */
export type CallsetSource = 'exome' | 'genome';

/** One genetic-ancestry group's counts. AF = ac / an (null when an == 0). */
export interface PopulationFreq {
  ac: number;
  af: number | null;
  an: number;
  hemizygote_count: number | null;
  homozygote_count: number;
  id: AncestryGroup;
  source: CallsetSource;
}

/** In-silico predictor score (e.g. REVEL, CADD, SpliceAI). Values arrive as strings upstream. */
export interface InSilicoPredictor {
  id: string;
  value: number | null;
}

/** Joined ClinVar clinical significance for a variant (via gnomAD's clinvar_variant field). */
export interface ClinVarAnnotation {
  clinical_significance: string | null;
  clinvar_variation_id: string | null;
  gold_stars: number | null;
  review_status: string | null;
}

/** The full population record gnomad_get_variant returns per variant. */
export interface VariantRecord {
  /** Overall (joint of carried callsets) counts. */
  ac: number;
  af: number | null;
  an: number;
  clinvar: ClinVarAnnotation | null;
  consequence: string | null;
  dataset: Dataset;
  flags: string[];
  gene_symbol: string | null;
  hemizygote_count: number | null;
  homozygote_count: number;
  in_silico: InSilicoPredictor[];
  /** Per-ancestry vector across whichever callset(s) carry the variant — never collapsed. */
  populations: PopulationFreq[];
  reference_genome: ReferenceGenome;
  rsids: string[];
  source: CallsetSource[];
  transcript_id: string | null;
  variant_id: string;
}

/** gnomAD gene loss-of-function constraint — the gene.gnomad_constraint subobject. */
export interface GeneConstraint {
  constraint_flags: string[];
  dataset: Dataset;
  exp_lof: number | null;
  exp_mis: number | null;
  exp_syn: number | null;
  gene_id: string;
  lof_z: number | null;
  mis_z: number | null;
  obs_lof: number | null;
  obs_mis: number | null;
  obs_syn: number | null;
  oe_lof: number | null;
  oe_lof_lower: number | null;
  oe_lof_upper: number | null;
  oe_mis: number | null;
  oe_syn: number | null;
  pli: number | null;
  reference_genome: ReferenceGenome;
  symbol: string;
  syn_z: number | null;
}

/** VEP consequence class buckets used to filter gnomad_list_gene_variants. */
export type ConsequenceClass = 'lof' | 'missense' | 'synonymous' | 'other';

/**
 * One row of the gnomad_list_gene_variants canvas table. Index signature lets it
 * satisfy the spillover/canvas `Record<string, unknown>` row constraint.
 */
export interface GeneVariantRow {
  ac: number;
  af: number | null;
  an: number;
  consequence: string | null;
  consequence_class: ConsequenceClass;
  flags: string;
  homozygote_count: number;
  source: string;
  variant_id: string;
  [key: string]: string | number | null;
}

/** Aggregate coverage summary across a gene / transcript / region for one callset. */
export interface CoverageSummary {
  fraction_over_1: number | null;
  fraction_over_5: number | null;
  fraction_over_10: number | null;
  fraction_over_15: number | null;
  fraction_over_20: number | null;
  fraction_over_25: number | null;
  fraction_over_30: number | null;
  fraction_over_50: number | null;
  fraction_over_100: number | null;
  mean_depth: number | null;
  median_depth: number | null;
  positions: number;
  source: CallsetSource;
}

/** A target stretch of the genome — exactly one of these is supplied to list/coverage tools. */
export type GenomeTarget =
  | { kind: 'gene'; value: string }
  | { kind: 'transcript'; value: string }
  | { kind: 'region'; value: string };
