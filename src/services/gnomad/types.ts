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
 * sex-split (`_XX`/`_XY`), aggregate (`XX`/`XY`), gnomad_r2_1 subgroup
 * (`eas_jpn`, `nfe_bgr`, …), and 1000G/HGDP subpopulation (`1kg:*`, `hgdp:*`)
 * rows — the service keeps exact matches to this set only. gnomad_r4 calls the
 * catch-all group `remaining`; gnomad_r3, gnomad_r2_1, and exac call it `oth`,
 * kept under that ID because the releases compose it differently. v4 exomes
 * carry all but `ami` and `oth`; v4 and v3 genomes carry `ami` (Amish).
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
  'oth',
  'ami',
] as const;

export type AncestryGroup = (typeof ANCESTRY_GROUPS)[number];

const ANCESTRY_SET: ReadonlySet<string> = new Set(ANCESTRY_GROUPS);

/** True when a population `id` is a clean ancestry group (not a sex-split / subpop row). */
export const isCanonicalAncestry = (id: string): id is AncestryGroup => ANCESTRY_SET.has(id);

/** Callset source carrying a variant or coverage track. */
export type CallsetSource = 'exome' | 'genome';

/** One genetic-ancestry group's counts in one callset. AF = ac / an (null when an == 0). */
export interface PopulationFreq {
  ac: number;
  af: number | null;
  an: number;
  hemizygote_count: number | null;
  homozygote_count: number;
  id: AncestryGroup;
  source: CallsetSource;
}

/** One genetic-ancestry group's counts in gnomAD's joint exome + genome record. */
export type JointPopulationFreq = Omit<PopulationFreq, 'source'>;

/**
 * gnomAD browser's QC verdict for a variant: `pass` when any callset carrying
 * it has an empty filter list, else `filtered`.
 */
export type QcStatus = 'pass' | 'filtered';

/** One callset's own counts and QC filters for a variant. AF = ac / an (null when an is 0). */
export interface CallsetRecord {
  ac: number;
  af: number | null;
  an: number;
  /**
   * gnomAD's QC filters for this callset (vocabulary varies by dataset); empty
   * when it passed. Null when gnomAD returned no filter list, which proves no pass.
   */
  filters: string[] | null;
  hemizygote_count: number | null;
  homozygote_count: number;
}

/**
 * In-silico predictor score (e.g. REVEL, CADD, SpliceAI). Values arrive as strings
 * upstream, and gnomad_r3 writes SpliceAI as a score followed by its event in
 * parentheses ("0.00 (no_consequence)").
 */
export interface InSilicoPredictor {
  /** Text gnomAD attaches to the score, or the raw value when it holds no number. */
  annotation: string | null;
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

/**
 * A variant's consequence on its gene's primary transcript: the MANE Select
 * entry of the reported consequence's gene, else that gene's canonical entry.
 */
export interface PrimaryTranscriptConsequence {
  consequence: string | null;
  hgvsc: string | null;
  hgvsp: string | null;
  /** True for a MANE Select entry; null where gnomAD reports no MANE status (a gene without a MANE Select; every gene on GRCh37). */
  is_mane_select: boolean | null;
  /** LOFTEE's loss-of-function call on this transcript (e.g. HC, LC); null when it made none. */
  lof: string | null;
  transcript_id: string;
}

/** The full population record gnomad_get_variant returns per variant. */
export interface VariantRecord {
  /**
   * Overall counts: gnomAD's joint record where it publishes one (gnomad_r4),
   * otherwise the sum across the carried callsets. ac, an, af, and the zygosity
   * counts always share one source.
   */
  ac: number;
  af: number | null;
  an: number;
  /** Each callset's own counts and QC filters; null for a callset that does not carry the variant. */
  callsets: Record<CallsetSource, CallsetRecord | null>;
  clinvar: ClinVarAnnotation | null;
  /** True when the ClinVar lookup failed; false when it succeeded, with or without an entry. */
  clinvar_unavailable: boolean;
  consequence: string | null;
  dataset: Dataset;
  flags: string[];
  gene_symbol: string | null;
  hemizygote_count: number | null;
  homozygote_count: number;
  in_silico: InSilicoPredictor[];
  /** Per-ancestry groups of gnomAD's joint record; empty where the dataset publishes none. */
  joint_populations: JointPopulationFreq[];
  /** Per-ancestry vector across whichever callset(s) carry the variant — never collapsed. */
  populations: PopulationFreq[];
  /** The consequence on the gene's MANE Select (else canonical) transcript; null when gnomAD lists neither entry (the variant lies outside both). */
  primary_transcript: PrimaryTranscriptConsequence | null;
  qc_status: QcStatus;
  reference_genome: ReferenceGenome;
  rsids: string[];
  source: CallsetSource[];
  transcript_id: string | null;
  variant_id: string;
}

/**
 * The constraint release a dataset serves. gnomAD's API carries no release
 * identifier, so the service labels each dataset from a fixed map.
 */
export type ConstraintRelease = 'gnomAD v4.1.2' | 'gnomAD v2.1.1' | 'ExAC r0.3';

/**
 * Gene loss-of-function constraint — gene.gnomad_constraint for the gnomAD
 * datasets, gene.exac_constraint for exac (which carries no ratios or flags).
 */
export interface GeneConstraint {
  constraint_flags: string[];
  constraint_release: ConstraintRelease;
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

/** gnomAD's consequence categories (pLoF, missense / inframe indel, synonymous, other), used to filter gnomad_list_gene_variants. */
export type ConsequenceClass = 'lof' | 'missense' | 'synonymous' | 'other';

/**
 * Where a gene-variant row's consequence sits relative to the gene's primary
 * transcript, as gnomAD's gene table marks it: on the MANE Select transcript, on
 * the canonical transcript of a gene without one, or on another transcript.
 */
export type ConsequenceTranscript = 'mane_select' | 'canonical' | 'other';

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
  /** Null off a gene target, and for a gene with neither a MANE Select nor a canonical transcript. */
  consequence_transcript: ConsequenceTranscript | null;
  /** The exome callset's QC filters, pipe-joined: '' when it passed, null when it does not carry the variant. */
  exome_filters: string | null;
  flags: string;
  /** The genome callset's QC filters, pipe-joined, as exome_filters. */
  genome_filters: string | null;
  homozygote_count: number;
  qc_status: QcStatus;
  source: string;
  /** The transcript consequence is on; null when gnomAD names none (an intergenic variant). */
  transcript_id: string | null;
  variant_id: string;
  [key: string]: string | number | null;
}

/**
 * Aggregate coverage summary across a gene / transcript / region for one
 * callset, over the gnomAD coverage buckets that overlap the target intervals.
 */
export interface CoverageSummary {
  /** Number of gnomAD coverage buckets summarized. */
  bucket_count: number;
  /** Width of each gnomAD coverage bucket, in bp. */
  bucket_size: number;
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
  /** Target bases without a returned coverage bucket; callability is unknown. */
  missing_positions: number;
  /** Target bases inside the summarized buckets. */
  positions: number;
  source: CallsetSource;
  /** Total bases in the target's merged intervals, including unobserved bases. */
  target_positions: number;
}

/** A target stretch of the genome — exactly one of these is supplied to list/coverage tools. */
export type GenomeTarget =
  | { kind: 'gene'; value: string }
  | { kind: 'transcript'; value: string }
  | { kind: 'region'; value: string };
