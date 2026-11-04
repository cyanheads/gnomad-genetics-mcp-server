/**
 * @fileoverview Domain types for the gnomAD service — the normalized shapes the
 * tools surface, plus the canonical genetic-ancestry group set. Field names and
 * nullability are grounded against the live gnomAD GraphQL schema.
 * @module services/gnomad/types
 */

import type { GNOMAD_DATASETS } from '@/config/server-config.js';

/** Reference build — a gnomAD ReferenceGenomeId enum value. */
export type ReferenceGenome = 'GRCh38' | 'GRCh37';

/** Dataset — a gnomAD DatasetId enum value: a release or one of its subsets. */
export type Dataset = (typeof GNOMAD_DATASETS)[number];

/**
 * A release a subset is drawn from, and the dataset gnomAD serves coverage and
 * constraint for: gnomAD publishes neither per subset.
 */
export type ParentDataset = Extract<Dataset, 'gnomad_r4' | 'gnomad_r3' | 'gnomad_r2_1' | 'exac'>;

/**
 * Canonical genetic-ancestry group codes. The live schema returns these PLUS
 * sex-split (`_XX`/`_XY`), aggregate (`XX`/`XY`), gnomad_r2_1 subgroup
 * (`eas_jpn`, `nfe_bgr`, …), and 1000G/HGDP subpopulation (`1kg:*`, `hgdp:*`)
 * rows — the service keeps exact matches to this set only. gnomad_r4 calls the
 * catch-all group `remaining` (gnomad_r4_non_ukb too); every other dataset calls it `oth`,
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

/**
 * gnomAD's filtering allele frequency at 95% confidence (GroupMax FAF95): the
 * lower bound of the 95% confidence interval of a genetic-ancestry group's AF,
 * from the group with the highest bound, over non-bottlenecked groups only.
 */
export interface Faf95 {
  /** The genetic-ancestry group the value comes from; null when gnomAD names none. */
  group: string | null;
  value: number;
}

/** One callset's own counts and QC filters for a variant. AF = ac / an (null when an is 0). */
export interface CallsetRecord {
  ac: number;
  af: number | null;
  an: number;
  /** Null when gnomAD reports none, and on a gnomad_r4 or gnomad_r3 subset, whose record carries the parent's. */
  faf95: Faf95 | null;
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
  /** The LOFTEE filter behind an LC call (e.g. END_TRUNC); null when none. */
  lof_filter: string | null;
  /** LOFTEE's flags on the call (e.g. PHYLOCSF_WEAK); null when none. */
  lof_flags: string | null;
  transcript_id: string;
}

/** One of gnomAD's manual loss-of-function curation verdicts on a variant. */
export interface LofCuration {
  /** The curation's reasons, as gnomAD writes them; empty when it lists none. */
  flags: string[];
  gene_id: string;
  gene_symbol: string | null;
  /** The curation project (e.g. metabolic_conditions_genes). */
  project: string;
  /** The verdict (e.g. LoF, Likely LoF, Not LoF). */
  verdict: string;
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
  /**
   * gnomAD's joint FAF95 wherever it publishes a joint record (its value null
   * included), else the higher callset value; `source` names which. Null on a
   * gnomad_r4 or gnomad_r3 subset, whose record carries the parent's.
   */
  faf95: (Faf95 & { source: 'joint' | CallsetSource }) | null;
  flags: string[];
  gene_symbol: string | null;
  hemizygote_count: number | null;
  /** HGVS on transcript_id, as gnomAD gives it; null when none. */
  hgvsc: string | null;
  hgvsp: string | null;
  homozygote_count: number;
  in_silico: InSilicoPredictor[];
  /** Per-ancestry groups of gnomAD's joint record; empty where the dataset publishes none. */
  joint_populations: JointPopulationFreq[];
  /** LOFTEE's call, filter, and flags on transcript_id; null when none. */
  lof: string | null;
  /** gnomAD's manual LoF curations of the variant; empty when it has none. */
  lof_curations: LofCuration[];
  lof_filter: string | null;
  lof_flags: string | null;
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
 * gnomAD's mitochondrial constraint for a protein-coding mitochondrial gene:
 * observed and expected sums of maximum heteroplasmy, their ratio, and its 90%
 * interval, for stop-gain (lof), missense, and synonymous SNVs.
 */
export interface ProteinMitochondrialConstraint {
  exp_lof: number;
  exp_mis: number;
  exp_syn: number;
  kind: 'protein';
  obs_lof: number;
  obs_mis: number;
  obs_syn: number;
  oe_lof: number;
  oe_lof_lower: number;
  oe_lof_upper: number;
  oe_mis: number;
  oe_mis_lower: number;
  oe_mis_upper: number;
  oe_syn: number;
  oe_syn_lower: number;
  oe_syn_upper: number;
}

/** gnomAD's mitochondrial constraint for a tRNA or rRNA gene, over all its SNVs. */
export interface RnaMitochondrialConstraint {
  expected: number;
  kind: 'rna';
  observed: number;
  oe: number;
  oe_lower: number;
  oe_upper: number;
}

/** gene.mitochondrial_constraint, tagged by the member gnomAD returned. */
export type MitochondrialConstraint = ProteinMitochondrialConstraint | RnaMitochondrialConstraint;

/**
 * Gene loss-of-function constraint — gene.gnomad_constraint for the gnomAD
 * datasets, gene.exac_constraint for exac (which carries no ratios, intervals,
 * percentile, or flags) — plus gene.mitochondrial_constraint, the same on every
 * dataset and null for a nuclear gene.
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
  /** Null for a nuclear gene; the nuclear fields are null for a mitochondrial one. */
  mitochondrial_constraint: MitochondrialConstraint | null;
  obs_lof: number | null;
  obs_mis: number | null;
  obs_syn: number | null;
  oe_lof: number | null;
  oe_lof_lower: number | null;
  /** gnomAD's LOEUF percentile bin, 0–100; lower is more constrained. gnomAD v4.1.2 only. */
  oe_lof_percentile: number | null;
  oe_lof_upper: number | null;
  oe_mis: number | null;
  oe_mis_lower: number | null;
  oe_mis_upper: number | null;
  oe_syn: number | null;
  oe_syn_lower: number | null;
  oe_syn_upper: number | null;
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
  /** gnomAD's FAF95 from the same record(s) as ac and an; null where the dataset's rows carry none. */
  faf95_max: number | null;
  faf95_max_group: string | null;
  flags: string;
  /** The genome callset's QC filters, pipe-joined, as exome_filters. */
  genome_filters: string | null;
  /** From the same record(s) as ac and an (0 off X/Y); null when none of them reports one. */
  hemizygote_count: number | null;
  homozygote_count: number;
  /** LOFTEE's loss-of-function call on transcript_id (HC, LC, or OS); null when it made none. */
  lof: string | null;
  qc_status: QcStatus;
  source: string;
  /** The transcript consequence is on; null when gnomAD names none (an intergenic variant). */
  transcript_id: string | null;
  variant_id: string;
  [key: string]: string | number | null;
}

/** The LOFTEE confidence gnomad_list_gene_variants filters rows on: a row's lof must equal it. */
export type LofConfidence = 'HC' | 'LC';

/**
 * A gene-variant row of an `annotations` request: the default row plus the
 * opt-in columns, all describing transcript_id, appended after every default
 * column.
 */
export interface AnnotatedGeneVariantRow extends GeneVariantRow {
  hgvsc: string | null;
  hgvsp: string | null;
  lof_filter: string | null;
  lof_flags: string | null;
  /** dbSNP rsIDs, pipe-joined; '' when gnomAD lists none. */
  rsids: string;
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

/**
 * Samples per genotype pair of a variant pair. Each key's first token is the
 * genotype of `variant_ids[0]`, its second that of `variant_ids[1]`: ref
 * (homozygous reference), het (heterozygous), hom (homozygous alternate).
 */
export interface CooccurrenceGenotypeCounts {
  het_het: number;
  het_hom: number;
  het_ref: number;
  hom_het: number;
  hom_hom: number;
  hom_ref: number;
  ref_het: number;
  ref_hom: number;
  ref_ref: number;
}

/**
 * gnomAD's estimated haplotype counts for a variant pair — fractional, from
 * its EM estimate. Each key's first token is the allele of `variant_ids[0]`
 * on the haplotype, its second that of `variant_ids[1]`.
 */
export interface CooccurrenceHaplotypeCounts {
  alt_alt: number;
  alt_ref: number;
  ref_alt: number;
  ref_ref: number;
}

/** A variant pair's co-occurrence over one set of samples (all, or one ancestry group). */
export interface CooccurrenceCounts {
  genotype_counts: CooccurrenceGenotypeCounts;
  haplotype_counts: CooccurrenceHaplotypeCounts;
  /** Probability the pair is on different haplotypes; null when gnomAD gives none. */
  p_compound_heterozygous: number | null;
}

/** One genetic-ancestry group's co-occurrence counts. */
export interface CooccurrencePopulation extends CooccurrenceCounts {
  id: string;
}

/**
 * gnomad_get_variant_cooccurrence's record. gnomAD serves co-occurrence on
 * gnomad_r2_1 only, so the dataset and build are fixed. `variant_ids` is the
 * pair in gnomAD's order, which labels every count and can differ from the
 * order sent.
 */
export interface VariantCooccurrence extends CooccurrenceCounts {
  dataset: 'gnomad_r2_1';
  populations: CooccurrencePopulation[];
  reference_genome: 'GRCh37';
  variant_ids: string[];
}
