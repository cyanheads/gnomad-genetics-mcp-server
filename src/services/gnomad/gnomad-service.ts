/**
 * @fileoverview gnomAD GraphQL service — owns the parameterized query documents,
 * the dataset→parent release and reference_genome derivation and pair validation, a politeness
 * concurrency cap, withRetry backoff over the full fetch+parse pipeline, and
 * typed-response validation. Handlers stay pure and throw; this service wraps the
 * upstream so transient 429/5xx surface as ServiceUnavailable, not parse errors,
 * while a region or variant pair gnomAD refuses fails once as the caller's error.
 * @module services/gnomad/gnomad-service
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { McpError, notFound, validationError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, requestContextService, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig, type ServerConfig } from '@/config/server-config.js';
import { remainingBudget, UPSTREAM_CALL_BUDGET_MS } from '@/services/upstream-deadline.js';
import {
  invalidUpstreamResponse,
  readUpstreamJson,
  sanitizeUpstreamError,
  upstreamGraphqlMessages,
  upstreamUnavailable,
} from '@/services/upstream-error.js';
import { normalizeIdentifier } from './identifier-normalization.js';
import {
  CLINVAR_BY_VARIANT_ID_QUERY,
  GENE_CLINVAR_VARIANT_IDS_QUERY,
  GENE_CONSTRAINT_BY_ID_QUERY,
  GENE_CONSTRAINT_BY_SYMBOL_QUERY,
  GENE_COVERAGE_BY_ID_QUERY,
  GENE_COVERAGE_BY_SYMBOL_QUERY,
  GENE_VARIANTS_BY_ID_QUERY,
  GENE_VARIANTS_BY_SYMBOL_QUERY,
  liftoverQuery,
  REGION_COVERAGE_QUERY,
  REGION_VARIANTS_QUERY,
  TRANSCRIPT_COVERAGE_QUERY,
  TRANSCRIPT_VARIANTS_QUERY,
  VARIANT_BY_RSID_QUERY,
  VARIANT_COOCCURRENCE_QUERY,
  VARIANT_ONLY_QUERY,
  VARIANT_QUERY,
  VARIANT_SEARCH_QUERY,
} from './queries.js';
import {
  type AnnotatedGeneVariantRow,
  type CallsetRecord,
  type ConsequenceClass,
  type ConsequenceTranscript,
  type ConstraintRelease,
  type CooccurrenceCounts,
  type CoverageSummary,
  type Dataset,
  type Faf95,
  type GeneConstraint,
  type GeneVariantRow,
  type GenomeTarget,
  type InSilicoPredictor,
  isCanonicalAncestry,
  type JointPopulationFreq,
  type LofConfidence,
  type ParentDataset,
  type PopulationFreq,
  type PrimaryTranscriptConsequence,
  type QcStatus,
  type ReferenceGenome,
  type VariantCooccurrence,
  type VariantRecord,
} from './types.js';

/** Effective dataset, its parent release, and its build, after derivation and coherence validation. */
export interface DatasetContext {
  dataset: Dataset;
  /** The release `dataset` belongs to — itself for a release — read for coverage and constraint. */
  parent: ParentDataset;
  reference_genome: ReferenceGenome;
}

const ENSEMBL_GENE_ID = /^ENSG\d{6,}$/i;
const RSID = /^rs\d+$/i;

/** Chromosome tokens gnomAD's nuclear variant and coverage fields serve. */
const NUCLEAR_CHROMOSOMES: ReadonlySet<string> = new Set([
  ...Array.from({ length: 22 }, (_, index) => String(index + 1)),
  'X',
  'Y',
]);
/** gnomAD serves mitochondrial variants and coverage through separate fields this server does not query. */
const MITOCHONDRIAL_CHROMOSOMES: ReadonlySet<string> = new Set(['M', 'MT']);
const MITOCHONDRIAL_VARIANT_ID = /^(?:chr)?mt?-/i;
const REGION_SHAPE = /^(?:chr)?([0-9A-Z]+)-(\d+)-(\d+)$/i;
/** gnomAD rejects a region coordinate at or above this bound. */
const MAX_REGION_COORDINATE = 1_000_000_000;
/** gnomAD's region variant and coverage queries reject a span (stop − start) at or above this. */
const MAX_REGION_SPAN = 2_500_000;

/** gnomAD's GraphQL messages for transient load: a queue timeout, a shed job, rate limiting. */
const TRANSIENT_GRAPHQL_MESSAGE =
  /request timed out|service overloaded|rate.?limit|too many requests/i;
/** gnomAD's GraphQL message for an entity it does not hold ("Gene not found", "Variant not found"). */
const NOT_FOUND_MESSAGE = /\bnot found\b/i;
/** gnomAD's HTTP 500 messages for a region naming an unserved chromosome or out-of-range bound. */
const INVALID_REGION_MESSAGE = /^(?:Invalid chromosome: |Region st(?:art|op) must be )/;
/** gnomAD's HTTP 500 messages for a region too wide, or holding too many variants, to serve. */
const REGION_TOO_LARGE_MESSAGE =
  /^(?:This region has too many variants to display|Select a smaller region to view variants|Coverage is not available for a region this large)/;
/**
 * gnomAD's one-sentence refusal of a variant pair it will not phase: the same ID
 * twice, a variant it lacks, different genes, a non-coding pair, no exome call,
 * or exome AF above 5%. Anchored at both ends with no nested quantifier, so a
 * test is linear in the message length; a joined message (`; `) never matches.
 */
const COOCCURRENCE_REFUSAL_MESSAGE =
  /^(?:Variants must be different|Variant co-occurrence is only available for [^;]*)$/;

/**
 * Variant lookups share the call budget with their best-effort ClinVar join.
 */
export const CLINVAR_LOOKUP_BUDGET_MS = UPSTREAM_CALL_BUDGET_MS;

/**
 * gnomAD's liftover table pairs GRCh37 sources with GRCh38 targets. An ID a
 * dataset lacks is read as written for the other build: on a GRCh38 dataset as
 * a GRCh37 source, whose target is the candidate; on a GRCh37 dataset as a
 * GRCh38 target, whose source is the candidate. `idBuild` is the build the
 * query names, the one the ID is read as; `queried` is the entry side that
 * echoes the ID asked for.
 */
const LIFTOVER_DIRECTION = {
  GRCh38: {
    argument: 'source_variant_id',
    idBuild: 'GRCh37',
    queried: 'source',
    candidate: 'liftover',
  },
  GRCh37: {
    argument: 'liftover_variant_id',
    idBuild: 'GRCh38',
    queried: 'liftover',
    candidate: 'source',
  },
} as const satisfies Record<
  ReferenceGenome,
  {
    argument: 'source_variant_id' | 'liftover_variant_id';
    idBuild: ReferenceGenome;
    queried: 'source' | 'liftover';
    candidate: 'source' | 'liftover';
  }
>;

/**
 * IDs per liftover request. gnomAD can answer a large liftover document with
 * the reply to a different one, so a batch above this size goes out as several
 * requests, each well under the size where that was seen.
 */
const LIFTOVER_REQUEST_IDS = 25;

/**
 * Each dataset's parent release and build, as gnomAD's browser assigns them
 * (dataset-metadata/metadata.ts: coverageDatasetId, referenceGenome) — the one
 * place the mapping lives. v4 and v3 are GRCh38; v2.1 and ExAC are GRCh37. A
 * subset keeps some of its parent's samples; gnomAD publishes no coverage or
 * constraint for it, so those read the parent.
 */
const DATASET_LINEAGE = {
  gnomad_r4: { parent: 'gnomad_r4', build: 'GRCh38' },
  gnomad_r4_non_ukb: { parent: 'gnomad_r4', build: 'GRCh38' },
  gnomad_r3: { parent: 'gnomad_r3', build: 'GRCh38' },
  gnomad_r3_controls_and_biobanks: { parent: 'gnomad_r3', build: 'GRCh38' },
  gnomad_r3_non_cancer: { parent: 'gnomad_r3', build: 'GRCh38' },
  gnomad_r3_non_neuro: { parent: 'gnomad_r3', build: 'GRCh38' },
  gnomad_r3_non_topmed: { parent: 'gnomad_r3', build: 'GRCh38' },
  gnomad_r3_non_v2: { parent: 'gnomad_r3', build: 'GRCh38' },
  gnomad_r2_1: { parent: 'gnomad_r2_1', build: 'GRCh37' },
  gnomad_r2_1_controls: { parent: 'gnomad_r2_1', build: 'GRCh37' },
  gnomad_r2_1_non_neuro: { parent: 'gnomad_r2_1', build: 'GRCh37' },
  gnomad_r2_1_non_cancer: { parent: 'gnomad_r2_1', build: 'GRCh37' },
  gnomad_r2_1_non_topmed: { parent: 'gnomad_r2_1', build: 'GRCh37' },
  exac: { parent: 'exac', build: 'GRCh37' },
} as const satisfies Record<Dataset, { parent: ParentDataset; build: ReferenceGenome }>;

const PARENT_OF: ReadonlyMap<string, ParentDataset> = new Map(
  Object.entries(DATASET_LINEAGE).map(([dataset, { parent }]) => [dataset, parent]),
);

/**
 * The release a dataset belongs to — itself for a release, its parent for a
 * subset — for a dataset carried as a plain string, such as an output echo;
 * undefined for a string that names no dataset.
 */
export function parentOf(dataset: string): ParentDataset | undefined {
  return PARENT_OF.get(dataset);
}

/**
 * The parent release whose filtering allele frequency gnomAD's variant record
 * carries in place of the dataset's own: gnomad_r4 or gnomad_r3 for one of
 * their subsets, whose detail document reads the parent's FAF (it is not keyed
 * by subset), so the record relays none. Null for a release and for a
 * gnomad_r2_1 subset, which carries its own.
 */
export function recordFafParent({
  dataset,
  parent,
}: DatasetContext): Extract<ParentDataset, 'gnomad_r4' | 'gnomad_r3'> | null {
  return dataset !== parent && (parent === 'gnomad_r4' || parent === 'gnomad_r3') ? parent : null;
}

/**
 * The FAF field that sets a list row's faf95_max on a dataset — the only one
 * the list documents select there: gnomAD's joint `fafmax` on gnomad_r4, whose
 * every row carries joint data; each callset's own `fafmax` on
 * gnomad_r4_non_ukb (list rows key it by subset, unlike the variant record);
 * callset `faf95` on gnomad_r2_1 and its subsets, whose `fafmax` is null; none
 * on gnomad_r3, its subsets, and exac, whose list rows carry no FAF.
 */
export function listRowFafField({
  dataset,
  parent,
}: DatasetContext): 'joint_fafmax' | 'callset_fafmax' | 'callset_faf95' | null {
  if (parent === 'gnomad_r4') return dataset === parent ? 'joint_fafmax' : 'callset_fafmax';
  return parent === 'gnomad_r2_1' ? 'callset_faf95' : null;
}

/**
 * The variables every list document takes beside its target, dataset, and
 * build: the `@include` flag of each FAF selection, set from listRowFafField,
 * and the `annotations` flag of the opt-in HGVS, LOFTEE, and rsID columns.
 */
function listDocumentVariables(
  dsCtx: DatasetContext,
  annotations: boolean,
): Record<string, boolean> {
  const faf = listRowFafField(dsCtx);
  return {
    jointFafmax: faf === 'joint_fafmax',
    callsetFafmax: faf === 'callset_fafmax',
    callsetFaf95: faf === 'callset_faf95',
    annotations,
  };
}

/**
 * The constraint release each parent serves. The GRCh38 table has been v4.1.2
 * since 2026-09-28 (values unchanged from v4.1.1); gnomAD publishes no v3
 * constraint (its browser shows none on gnomad_r3), so gnomad_r3 serves that
 * same GRCh38 table; exac reads gene.exac_constraint rather than the GRCh37
 * gnomAD v2.1.1 table.
 */
const CONSTRAINT_RELEASE = {
  gnomad_r4: 'gnomAD v4.1.2',
  gnomad_r3: 'gnomAD v4.1.2',
  gnomad_r2_1: 'gnomAD v2.1.1',
  exac: 'ExAC r0.3',
} as const satisfies Record<ParentDataset, ConstraintRelease>;

function mitochondrialUnsupported(subject: string): McpError {
  return validationError(
    `${subject} is on the mitochondrial chromosome. gnomAD models mitochondrial variants and coverage separately (heteroplasmy rather than genotype counts), and this server serves nuclear chromosomes 1–22, X, and Y only.`,
    { reason: 'mitochondrial_unsupported', retryable: false },
  );
}

/**
 * gnomAD resolves a mitochondrial gene or transcript but answers its nuclear
 * `variants` and `coverage` fields with nothing, so the chromosome is only
 * knowable from the response: refuse the target rather than report absence.
 */
function assertNuclearFeature(
  target: GenomeTarget,
  feature: { chrom: string } | null | undefined,
): void {
  if (feature && MITOCHONDRIAL_CHROMOSOMES.has(feature.chrom)) {
    throw mitochondrialUnsupported(
      `${target.kind === 'transcript' ? 'Transcript' : 'Gene'} "${target.value}"`,
    );
  }
}

/**
 * gnomAD answers a gene or transcript it does not hold with a null root beside
 * "Gene not found" / "Transcript not found". Its lookup is keyed by build, so
 * the null cannot tell an unknown ID from one absent on this build: the
 * message names the build. A real feature with no rows keeps a non-null root.
 */
function assertFeatureFound(
  target: GenomeTarget,
  data: { gene?: unknown; transcript?: unknown },
  dsCtx: DatasetContext,
): void {
  if (target.kind === 'region' || data[target.kind] !== null) return;
  throw notFound(
    `${target.kind === 'gene' ? 'Gene' : 'Transcript'} "${target.value}" not found in ${dsCtx.reference_genome}.`,
    { reason: `${target.kind}_not_found`, retryable: false },
  );
}

function invalidRegion(message: string): McpError {
  return validationError(message, { reason: 'invalid_region', retryable: false });
}

/**
 * Parse a caller's chrom-start-stop region, rejecting before any fetch whatever
 * gnomAD would reject. gnomAD answers each of these with an HTTP 500 that the
 * retry layer reads as a transient fault, so an unguarded region burns the
 * retry budget and surfaces as a misleading "unavailable" error. Accepts an
 * optional case-insensitive chr prefix and any-case X/Y, and returns the
 * canonical token gnomAD expects.
 */
function parseRegion(value: string): { chrom: string; start: number; stop: number } {
  const match = REGION_SHAPE.exec(value);
  if (!match) {
    throw invalidRegion(
      `Invalid region "${value}". Expected chrom-start-stop, e.g. 1-55039447-55064852.`,
    );
  }
  const [, token = '', startText = '', stopText = ''] = match;
  const chrom = token.toUpperCase();
  if (MITOCHONDRIAL_CHROMOSOMES.has(chrom)) throw mitochondrialUnsupported(`Region "${value}"`);
  if (!NUCLEAR_CHROMOSOMES.has(chrom)) {
    throw invalidRegion(
      `Invalid chromosome "${token}" in region "${value}". gnomAD serves chromosomes 1–22, X, and Y.`,
    );
  }
  const start = Number(startText);
  const stop = Number(stopText);
  if (start < 1) throw invalidRegion(`Region start must be at least 1: got ${start}.`);
  if (stop >= MAX_REGION_COORDINATE) {
    throw invalidRegion(`Region stop must be less than 1,000,000,000: got ${stop}.`);
  }
  // A single position is valid (start == stop), so only start > stop is rejected.
  if (start > stop) {
    throw invalidRegion(
      `Region start must not exceed stop: ${start} > ${stop}. Provide chrom-start-stop with start ≤ stop (a single position uses start = stop).`,
    );
  }
  const span = stop - start;
  if (span >= MAX_REGION_SPAN) {
    throw validationError(
      `Region "${value}" spans ${span.toLocaleString('en-US')} bp (stop − start); gnomAD serves region queries spanning less than 2,500,000 bp.`,
      { reason: 'region_too_large', retryable: false },
    );
  }
  return { chrom, start, stop };
}

/**
 * gnomAD answers a region it cannot serve with an HTTP 500 carrying a
 * caller-facing GraphQL message. parseRegion() catches most of these before any
 * fetch, but not a region under the span limit that holds more variants than
 * gnomAD lists — only gnomAD knows the count. When every message is one of those
 * region rejections, retrying cannot help, so this returns the caller's error
 * carrying gnomAD's text alone; any other failure returns undefined and stays on
 * the transient path.
 */
function regionRejection(err: unknown): McpError | undefined {
  const messages = upstreamGraphqlMessages(err);
  if (!messages) return;
  const invalid = messages.filter((message) => INVALID_REGION_MESSAGE.test(message));
  const tooLarge = messages.filter((message) => REGION_TOO_LARGE_MESSAGE.test(message));
  if (invalid.length + tooLarge.length !== messages.length) return;
  return validationError(
    messages.join('; '),
    { reason: invalid.length > 0 ? 'invalid_region' : 'region_too_large', retryable: false },
    { cause: err },
  );
}

// --- Raw upstream response Zod schemas (sparse: most fields nullable) ---

const RawPopulation = z.object({
  id: z.string(),
  ac: z.number().nullable(),
  an: z.number().nullable(),
  homozygote_count: z.number().nullable(),
  hemizygote_count: z.number().nullable(),
});

/**
 * A callset's QC filters — empty when it passed. gnomAD's schema types the list
 * nullable and every observed record carries one; absent reads as null, which
 * proves no pass (a reply to a document that predates the selection).
 */
const RawFilters = z.array(z.string()).nullish();

/**
 * gnomAD's GroupMax FAF95 on a variant record: `popmax` the value,
 * `popmax_population` its genetic-ancestry group. gnomAD answers an absent FAF
 * with a null object or a null `popmax`; absent reads as null, as on a reply to
 * a document that predates its selection.
 */
const RawFaf95 = z
  .object({ popmax: z.number().nullable(), popmax_population: z.string().nullable() })
  .nullish();

/** gnomAD's list-row FAF summary: `faf95_max` the value, `faf95_max_gen_anc` its group; read as RawFaf95. */
const RawFafmax = z
  .object({ faf95_max: z.number().nullable(), faf95_max_gen_anc: z.string().nullable() })
  .nullish();

const RawSeqData = z
  .object({
    ac: z.number().nullable(),
    an: z.number().nullable(),
    af: z.number().nullable(),
    homozygote_count: z.number().nullable(),
    hemizygote_count: z.number().nullable(),
    filters: RawFilters,
    faf95: RawFaf95,
    populations: z.array(RawPopulation).nullable(),
  })
  .nullable();

/**
 * gnomAD's joint exome + genome record: null outside gnomad_r4, and no `af`
 * field; its `filters` are never selected. Its AN spans every callable sample
 * in both callsets, including a callset that does not carry the variant. Read
 * as absent when a payload omits it, which takes the same callset-sum path as
 * null.
 */
const RawJointData = RawSeqData.unwrap().omit({ af: true, filters: true }).nullish();

const RawVariant = z
  .object({
    variant_id: z.string(),
    reference_genome: z.string(),
    rsids: z.array(z.string()).nullable(),
    flags: z.array(z.string()).nullable(),
    exome: RawSeqData,
    genome: RawSeqData,
    joint: RawJointData,
    /**
     * gnomAD types gene_id and transcript_id non-null. gene_id and the fields
     * after major_consequence read as absent on a reply to a document that
     * predates their selection.
     */
    transcript_consequences: z
      .array(
        z.object({
          gene_id: z.string().optional(),
          gene_symbol: z.string().nullable(),
          transcript_id: z.string(),
          major_consequence: z.string().nullable(),
          is_mane_select: z.boolean().nullish(),
          is_canonical: z.boolean().nullish(),
          hgvsc: z.string().nullish(),
          hgvsp: z.string().nullish(),
          lof: z.string().nullish(),
          lof_filter: z.string().nullish(),
          lof_flags: z.string().nullish(),
        }),
      )
      .nullable(),
    /**
     * gnomAD's manual LoF curations: null when it has none, and absent on a
     * reply to a document that predates their selection; both read as none.
     */
    lof_curations: z
      .array(
        z.object({
          gene_id: z.string(),
          gene_symbol: z.string().nullable(),
          verdict: z.string(),
          flags: z.array(z.string()).nullable(),
          project: z.string(),
        }),
      )
      .nullish(),
    in_silico_predictors: z
      .array(z.object({ id: z.string(), value: z.string().nullable() }))
      .nullable(),
  })
  .nullable();

const RawClinVar = z
  .object({
    clinical_significance: z.string().nullable(),
    review_status: z.string().nullable(),
    gold_stars: z.number().nullable(),
    clinvar_variation_id: z.string().nullable(),
  })
  .nullable();

const VariantResponse = z.object({
  variant: RawVariant,
  clinvar_variant: RawClinVar,
});

/** A reply to a document whose only root is `variant` (by variantId or by rsid). */
const VariantRootResponse = z.object({ variant: RawVariant });
const ClinVarOnlyResponse = z.object({ clinvar_variant: RawClinVar });
const VariantSearchResponse = z.object({
  variant_search: z.array(z.object({ variant_id: z.string() })),
});

/** One alias of the liftover document: every table entry for its ID, empty when none. */
const LiftoverEntries = z.array(
  z.object({
    source: z.object({ variant_id: z.string() }),
    liftover: z.object({ variant_id: z.string() }),
  }),
);

/** gnomAD's errors carry `message` alone — never a `path` — so nothing here keys on one. */
const GraphqlEnvelope = z.object({
  data: z.unknown().optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

const ConstraintMetrics = z.object({
  pli: z.number().min(0).max(1).nullable(),
  oe_lof: z.number().nonnegative().nullable(),
  oe_lof_lower: z.number().nonnegative().nullable(),
  oe_lof_upper: z.number().nonnegative().nullable(),
  /** gnomAD's LOEUF percentile bin (an `Int` upstream); v4.1.2 only, null on GRCh37. */
  oe_lof_percentile: z.number().int().min(0).max(100).nullable(),
  oe_mis: z.number().nonnegative().nullable(),
  oe_mis_lower: z.number().nonnegative().nullable(),
  oe_mis_upper: z.number().nonnegative().nullable(),
  oe_syn: z.number().nonnegative().nullable(),
  oe_syn_lower: z.number().nonnegative().nullable(),
  oe_syn_upper: z.number().nonnegative().nullable(),
  lof_z: z.number().nullable(),
  mis_z: z.number().nullable(),
  syn_z: z.number().nullable(),
  obs_lof: z.number().nonnegative().nullable(),
  exp_lof: z.number().nonnegative().nullable(),
  obs_mis: z.number().nonnegative().nullable(),
  exp_mis: z.number().nonnegative().nullable(),
  obs_syn: z.number().nonnegative().nullable(),
  exp_syn: z.number().nonnegative().nullable(),
  flags: z.array(z.string()).nullable(),
});

/** ExAC r0.3 constraint: pLI, Z-scores, and counts in the same domains — no ratios, intervals, percentile, or flags. */
const ExacConstraintMetrics = ConstraintMetrics.omit({
  oe_lof: true,
  oe_lof_lower: true,
  oe_lof_upper: true,
  oe_lof_percentile: true,
  oe_mis: true,
  oe_mis_lower: true,
  oe_mis_upper: true,
  oe_syn: true,
  oe_syn_lower: true,
  oe_syn_upper: true,
  flags: true,
});

/** Every mitochondrial constraint value: a non-null `Float!` upstream, never negative. */
const mitochondrialValue = z.number().nonnegative();

/**
 * gene.mitochondrial_constraint, gnomAD's union discriminated by `__typename`,
 * re-tagged by `kind`: a protein-coding gene's lof (stop-gain), mis, and syn
 * sets, or a tRNA/rRNA gene's one set. An unknown member fails the parse.
 */
const MitochondrialConstraintMetrics = z.discriminatedUnion('__typename', [
  z
    .object({
      __typename: z.literal('ProteinMitochondrialGeneConstraint'),
      obs_lof: mitochondrialValue,
      exp_lof: mitochondrialValue,
      oe_lof: mitochondrialValue,
      oe_lof_lower: mitochondrialValue,
      oe_lof_upper: mitochondrialValue,
      obs_mis: mitochondrialValue,
      exp_mis: mitochondrialValue,
      oe_mis: mitochondrialValue,
      oe_mis_lower: mitochondrialValue,
      oe_mis_upper: mitochondrialValue,
      obs_syn: mitochondrialValue,
      exp_syn: mitochondrialValue,
      oe_syn: mitochondrialValue,
      oe_syn_lower: mitochondrialValue,
      oe_syn_upper: mitochondrialValue,
    })
    .transform(({ __typename, ...metrics }) => ({ kind: 'protein' as const, ...metrics })),
  z
    .object({
      __typename: z.literal('RNAMitochondrialGeneConstraint'),
      observed: mitochondrialValue,
      expected: mitochondrialValue,
      oe: mitochondrialValue,
      oe_lower: mitochondrialValue,
      oe_upper: mitochondrialValue,
    })
    .transform(({ __typename, ...metrics }) => ({ kind: 'rna' as const, ...metrics })),
]);

const ConstraintResponse = z.object({
  gene: z
    .object({
      gene_id: z.string(),
      symbol: z.string(),
      gnomad_constraint: z.unknown().nullable(),
      exac_constraint: z.unknown().nullable(),
      /**
       * Optional here so a missing key reaches parseConstraint and fails once as
       * invalid_constraint_data, as a malformed value does, rather than the
       * envelope retrying it as an invalid response.
       */
      mitochondrial_constraint: z.unknown().optional(),
    })
    .nullable(),
});

/** Validate one constraint object against its metric domains; null stays null (no constraint). */
function parseConstraint<T>(schema: z.ZodType<T>, raw: unknown): T | null {
  if (raw === null) return null;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw validationError('gnomAD returned constraint metrics outside their valid domains.', {
      reason: 'invalid_constraint_data',
      retryable: false,
    });
  }
  return parsed.data;
}

const RawListSeqData = z
  .object({
    ac: z.number().nullable(),
    an: z.number().nullable(),
    af: z.number().nullable(),
    homozygote_count: z.number().nullable(),
    /** Absent reads as null, as on a reply to a document that predates its selection. */
    hemizygote_count: z.number().nullish(),
    filters: RawFilters,
    /** Each FAF field is absent on a dataset whose list document does not include it (listRowFafField). */
    faf95: RawFaf95,
    fafmax: RawFafmax,
  })
  .nullable();

const RawListVariant = z.object({
  variant_id: z.string(),
  consequence: z.string().nullable(),
  /** Null for a variant with no transcript consequence (intergenic); absent reads as null. */
  transcript_id: z.string().nullish(),
  /**
   * LOFTEE on transcript_id. lof absent reads as null, as on a reply to a
   * document that predates its selection; the rest are absent from every reply
   * to a request without `annotations`.
   */
  lof: z.string().nullish(),
  hgvsc: z.string().nullish(),
  hgvsp: z.string().nullish(),
  lof_filter: z.string().nullish(),
  lof_flags: z.string().nullish(),
  rsids: z.array(z.string()).nullish(),
  flags: z.array(z.string()).nullable(),
  exome: RawListSeqData,
  genome: RawListSeqData,
  /**
   * The joint totals and `fafmax` only (see RawJointData): gnomAD's list joint
   * type has no `faf95`. Absent reads as null.
   */
  joint: RawListSeqData.unwrap().omit({ af: true, filters: true, faf95: true }).nullish(),
});

const RawFeatureVariants = z.object({
  chrom: z.string(),
  variants: z.array(RawListVariant).nullable(),
});

/**
 * A gene's list also carries its primary transcripts. Both are nullable in
 * gnomAD's schema (no MANE Select on GRCh37); absent reads as null.
 */
const RawGeneVariants = RawFeatureVariants.extend({
  canonical_transcript_id: z.string().nullish(),
  mane_select_transcript: z.object({ ensembl_id: z.string() }).nullish(),
});

const VariantListResponse = z.object({
  gene: RawGeneVariants.nullable().optional(),
  transcript: RawFeatureVariants.nullable().optional(),
  region: z
    .object({ variants: z.array(RawListVariant).nullable() })
    .nullable()
    .optional(),
});

const RawCoverageBin = z.object({
  pos: z.number().nullable(),
  mean: z.number().nullable(),
  median: z.number().nullable(),
  over_1: z.number().nullable(),
  over_5: z.number().nullable(),
  over_10: z.number().nullable(),
  over_15: z.number().nullable(),
  over_20: z.number().nullable(),
  over_25: z.number().nullable(),
  over_30: z.number().nullable(),
  over_50: z.number().nullable(),
  over_100: z.number().nullable(),
});

const RawCoverage = z
  .object({
    exome: z.array(RawCoverageBin).nullable().optional(),
    genome: z.array(RawCoverageBin).nullable().optional(),
  })
  .nullable();

const RawExon = z.object({ start: z.number(), stop: z.number() });

const RawFeatureCoverage = z
  .object({ chrom: z.string(), exons: z.array(RawExon), coverage: RawCoverage })
  .nullable()
  .optional();

const CoverageResponse = z.object({
  gene: RawFeatureCoverage,
  transcript: RawFeatureCoverage,
  region: z.object({ coverage: RawCoverage }).nullable().optional(),
});

const Count = z.number();

/**
 * One co-occurrence breakdown: gnomAD's nine genotype-pair counts and four
 * estimated haplotype counts, positional (see labelCooccurrence), and the
 * probability, null when gnomAD computes none.
 */
const RawCooccurrenceCounts = z.object({
  genotype_counts: z.tuple([Count, Count, Count, Count, Count, Count, Count, Count, Count]),
  haplotype_counts: z.tuple([Count, Count, Count, Count]),
  p_compound_heterozygous: z.number().nullable(),
});

const RawCooccurrence = RawCooccurrenceCounts.extend({
  variant_ids: z.array(z.string()),
  populations: z.array(RawCooccurrenceCounts.extend({ id: z.string() })),
});

/**
 * The reply to a co-occurrence request for `variantIds`. Its counts are labelled
 * by its own `variant_ids`, so a reply naming any other pair fails validation.
 */
function cooccurrenceResponse(variantIds: readonly string[]) {
  const sent = [...variantIds].sort().join(' ');
  return z.object({
    variant_cooccurrence: RawCooccurrence.refine(
      (reply) => [...reply.variant_ids].sort().join(' ') === sent,
      'variant_ids name a pair other than the one requested',
    ),
  });
}

/**
 * Name gnomAD's positional co-occurrence counts. Its API documents the genotype
 * counts as [AABB, AABb, AAbb, AaBB, AaBb, Aabb, aaBB, aaBb, aabb], where A/a
 * are the reference/alternate alleles of variant_ids[0] and B/b those of
 * variant_ids[1], and reorders Hail's haplotype counts into [AB, Ab, aB, ab].
 */
function labelCooccurrence(raw: z.infer<typeof RawCooccurrenceCounts>): CooccurrenceCounts {
  const [ref_ref, ref_het, ref_hom, het_ref, het_het, het_hom, hom_ref, hom_het, hom_hom] =
    raw.genotype_counts;
  const [refRef, ref_alt, alt_ref, alt_alt] = raw.haplotype_counts;
  return {
    genotype_counts: {
      ref_ref,
      ref_het,
      ref_hom,
      het_ref,
      het_het,
      het_hom,
      hom_ref,
      hom_het,
      hom_hom,
    },
    haplotype_counts: { ref_ref: refRef, ref_alt, alt_ref, alt_alt },
    p_compound_heterozygous: raw.p_compound_heterozygous,
  };
}

/** What exchange() writes before gnomAD's joined messages in a graphql_error. */
const GRAPHQL_ERROR_PREFIX = 'gnomAD GraphQL error: ';

/**
 * gnomAD answers a variant pair it will not phase with a GraphQL error on an
 * HTTP 200, which exchange() raises as a non-retryable graphql_error after one
 * request. When that error is one refusal sentence, this returns the caller's
 * error carrying gnomAD's sentence alone; any other failure returns undefined
 * and keeps its classification.
 */
function cooccurrenceRefusal(err: unknown): McpError | undefined {
  if (!(err instanceof McpError) || err.data?.reason !== 'graphql_error') return;
  if (!err.message.startsWith(GRAPHQL_ERROR_PREFIX)) return;
  const message = err.message.slice(GRAPHQL_ERROR_PREFIX.length);
  if (!COOCCURRENCE_REFUSAL_MESSAGE.test(message)) return;
  return validationError(
    message,
    { reason: 'cooccurrence_unavailable', retryable: false },
    { cause: err },
  );
}

/**
 * gnomAD's ClinVar mapping for one gene. `gene` is null for a gene gnomAD does
 * not hold ("Gene not found" beside it); `clinvar_variants` is a nullable list
 * in gnomAD's schema.
 */
const GeneClinvarVariantIdsResponse = z.object({
  gene: z
    .object({
      clinvar_variants: z
        .array(z.object({ clinvar_variation_id: z.string(), variant_id: z.string() }))
        .nullable(),
    })
    .nullable(),
});

/**
 * The outcome of {@link GnomadService.clinvarVariantIds}: the mapping, a gene
 * gnomAD does not hold, or a lookup that failed or ran out of time.
 */
export type ClinvarVariantIds =
  | { status: 'resolved'; variantIds: Map<string, string> }
  | { status: 'gene_not_found' }
  | { status: 'unavailable' };

type RawListVariantT = z.infer<typeof RawListVariant>;
type RawCoverageBinT = z.infer<typeof RawCoverageBin>;

/** A closed 1-based genomic interval. */
interface Interval {
  start: number;
  stop: number;
}

/**
 * The target intervals a coverage summary covers and the width of gnomAD's
 * histogram buckets for that target, mirroring `coverage-queries.ts` in
 * gnomad-browser's graphql-api. Bucket keys are multiples of `bucketSize`, so
 * bucket `pos` spans `pos..pos + bucketSize − 1`.
 */
interface CoverageWindow {
  bucketSize: number;
  intervals: Interval[];
}

/** gnomAD's bucket width for a queried size: max(floor(size / 500), 1) bp. */
const coverageBucketSize = (size: number): number => Math.max(Math.floor(size / 500), 1);

/**
 * A region's window. gnomAD sizes its buckets from the span plus its ±75 bp
 * query pad (stop − start + 150), so spans under 850 bp keep 1 bp buckets; the
 * summary covers the requested start..stop, not the pad.
 */
function regionCoverageWindow({ start, stop }: Interval): CoverageWindow {
  return { intervals: [{ start, stop }], bucketSize: coverageBucketSize(stop - start + 150) };
}

/**
 * A gene's or transcript's window: every exon padded by 75 bp, sorted, and
 * merged where intervals overlap or abut, sized by the sum of stop − start —
 * the intervals gnomAD queries. Coverage between them (introns) is never
 * queried; gnomAD's histogram zero-fills it.
 */
function featureCoverageWindow(exons: readonly Interval[]): CoverageWindow {
  const padded = exons
    .map((exon) => ({ start: exon.start - 75, stop: exon.stop + 75 }))
    .sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const interval of padded) {
    const last = merged.at(-1);
    if (last && interval.start <= last.stop + 1) last.stop = Math.max(last.stop, interval.stop);
    else merged.push(interval);
  }
  const size = merged.reduce((sum, { start, stop }) => sum + stop - start, 0);
  return { intervals: merged, bucketSize: coverageBucketSize(size) };
}

/** Bases of `pos..pos + bucketSize − 1` that fall inside the window's intervals. */
function basesInWindow(pos: number, { bucketSize, intervals }: CoverageWindow): number {
  const end = pos + bucketSize - 1;
  return intervals.reduce(
    (sum, { start, stop }) => sum + Math.max(0, Math.min(end, stop) - Math.max(pos, start) + 1),
    0,
  );
}

/**
 * gnomAD's consequence categories for the terms outside `other`, from
 * gnomad-browser's `vepConsequences.ts`: pLoF, then Missense / Inframe indel.
 */
const CONSEQUENCE_CLASS_BY_TERM: ReadonlyMap<string, ConsequenceClass> = new Map([
  ['transcript_ablation', 'lof'],
  ['splice_acceptor_variant', 'lof'],
  ['splice_donor_variant', 'lof'],
  ['stop_gained', 'lof'],
  ['frameshift_variant', 'lof'],
  ['missense_variant', 'missense'],
  ['stop_lost', 'missense'],
  ['start_lost', 'missense'],
  ['inframe_insertion', 'missense'],
  ['inframe_deletion', 'missense'],
  ['synonymous_variant', 'synonymous'],
]);

/**
 * A VEP consequence term's gnomAD category. Every other term is `other` — the
 * rest of gnomAD's table, terms it lists in no category, and a null
 * consequence — as gnomAD's browser filter reads them (`filterVariants.ts`).
 */
export function classifyConsequence(term: string | null): ConsequenceClass {
  return CONSEQUENCE_CLASS_BY_TERM.get(term ?? '') ?? 'other';
}

/** True when a GraphQL `data` payload holds an explicit null at the named root field. */
function isNullRoot(data: unknown, root: string): boolean {
  return typeof data === 'object' && data !== null && Reflect.get(data, root) === null;
}

/** True when a GraphQL `data` payload holds a value at the named root field. */
function isPopulatedRoot(data: unknown, root: string): boolean {
  return typeof data === 'object' && data !== null && Reflect.get(data, root) != null;
}

interface GraphqlOptions {
  /**
   * A nullable root field whose null, beside only not-found errors, is absence
   * rather than a failure. Without it, not-found errors beside any `data` are.
   */
  absentRoot?: string;
  /** Absolute epoch deadline shared across chained requests. */
  deadline: number;
  /**
   * Marks an operation whose target gnomAD can refuse as a bad or oversized
   * region (the variant-list and coverage queries), so those HTTP 500 messages
   * reach the caller as its own error.
   */
  relayRegionRejections?: boolean;
}

interface ExchangeOptions extends GraphqlOptions {
  /**
   * A root field whose value, when errors arrive beside it, returns the reply
   * as `partial`, unjudged and unread: the errors cannot be attributed to a
   * root without a request of its own, and a field nulled inside the reply
   * could fail validation, so the caller re-sends each root alone.
   */
  partialRoot?: string;
}

/** A judged GraphQL reply, or `partial` when errors arrived beside a populated `partialRoot`. */
type Exchange<T> = { partial: false; data: T } | { partial: true };

/** A ClinVar join's outcome: the entry (null when none), or `unavailable` when the lookup failed. */
interface ClinvarLookup {
  clinvar: z.infer<typeof RawClinVar>;
  unavailable: boolean;
}

/** AF from counts: ac/an, or null when an is 0/absent. */
function computeAf(ac: number | null | undefined, an: number | null | undefined): number | null {
  if (ac == null || an == null || an === 0) return null;
  return ac / an;
}

/** One record's counts, shared by the callset and joint group vectors, the per-callset view, and the joint overall. */
function groupCounts(
  p: Omit<z.infer<typeof RawPopulation>, 'id'>,
): Omit<JointPopulationFreq, 'id'> {
  return {
    ac: p.ac ?? 0,
    an: p.an ?? 0,
    af: computeAf(p.ac, p.an),
    homozygote_count: p.homozygote_count ?? 0,
    hemizygote_count: p.hemizygote_count,
  };
}

/**
 * The QC filters of a callset that carries the variant (has an AC, as `source`
 * counts it); null for one that does not. An absent list stays null.
 */
function carriedFilters(
  callset: { ac: number | null; filters?: string[] | null | undefined } | null,
): string[] | null {
  return callset?.ac != null ? (callset.filters ?? null) : null;
}

/**
 * gnomAD browser's QC rule (VariantList/filterVariants.ts): a variant passes
 * when any callset carrying it has an empty filter list. The filter names are
 * never read, so each dataset's vocabulary (AC0, AS_VQSR, RF, VQSRTranche…)
 * counts alike; a carried callset with no list proves no pass.
 */
function qcStatus(carried: readonly (readonly string[] | null)[]): QcStatus {
  return carried.some((filters) => filters?.length === 0) ? 'pass' : 'filtered';
}

/** A FAF95 gnomAD reports a value for; null when it reports none. */
function faf95Of(value: number | null | undefined, group: string | null | undefined): Faf95 | null {
  return value == null ? null : { value, group: group ?? null };
}

/**
 * The highest of the FAF95 values given, the first on a tie — the maximum
 * credible reading gnomAD's FAF takes across ancestry groups, applied across
 * callsets; null when none has a value.
 */
function highestFaf<T extends Faf95>(fafs: readonly (T | null)[]): T | null {
  return fafs.reduce<T | null>(
    (best, faf) => (faf && (!best || faf.value > best.value) ? faf : best),
    null,
  );
}

/**
 * The consequence on the primary transcript of the reported consequence's gene
 * (the gene of transcript_consequences[0]): its MANE Select entry, else its
 * canonical entry. Another gene's entries never stand in.
 */
function primaryTranscriptConsequence(
  entries: NonNullable<NonNullable<z.infer<typeof RawVariant>>['transcript_consequences']>,
): PrimaryTranscriptConsequence | null {
  const geneId = entries[0]?.gene_id;
  const inGene = entries.filter((entry) => entry.gene_id === geneId);
  const primary =
    inGene.find((entry) => entry.is_mane_select) ?? inGene.find((entry) => entry.is_canonical);
  if (!primary) return null;
  return {
    transcript_id: primary.transcript_id,
    is_mane_select: primary.is_mane_select ?? null,
    consequence: primary.major_consequence,
    hgvsc: primary.hgvsc ?? null,
    hgvsp: primary.hgvsp ?? null,
    lof: primary.lof ?? null,
    lof_filter: primary.lof_filter ?? null,
    lof_flags: primary.lof_flags ?? null,
  };
}

/**
 * The transcript gnomAD's gene table marks each row's consequence against
 * (VariantList/variantTableColumns.tsx): the gene's MANE Select transcript,
 * else its canonical one. Null for a gene with neither.
 */
function genePrimaryTranscript(
  gene: z.infer<typeof RawGeneVariants>,
): { id: string; kind: Exclude<ConsequenceTranscript, 'other'> } | null {
  if (gene.mane_select_transcript) {
    return { id: gene.mane_select_transcript.ensembl_id, kind: 'mane_select' };
  }
  if (gene.canonical_transcript_id) return { id: gene.canonical_transcript_id, kind: 'canonical' };
  return null;
}

/**
 * The catch of a best-effort lookup: rethrows a cancelled caller and anything
 * that is not an upstream McpError, and otherwise logs the failure so the
 * caller can report the lookup unavailable.
 */
function absorbUpstreamFailure(
  err: unknown,
  ctx: Context,
  message: string,
  fields: Record<string, unknown>,
): void {
  if (ctx.signal.aborted || !(err instanceof McpError)) throw err;
  ctx.log.warning(message, { ...fields, reason: err.data?.reason, error: err.message });
}

/** A decimal score as gnomAD writes one: optional sign, fraction, and exponent. */
const PREDICTOR_NUMBER = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?`;
const PLAIN_PREDICTOR_VALUE = new RegExp(`^${PREDICTOR_NUMBER}$`, 'i');
/** A score followed by text in parentheses, as gnomad_r3 writes SpliceAI: "0.00 (no_consequence)". */
const ANNOTATED_PREDICTOR_VALUE = new RegExp(`^(${PREDICTOR_NUMBER})\\s*\\((.*)\\)$`, 'i');

/**
 * Split a predictor value into its score and the text gnomAD attaches to it.
 * Never yields a non-finite number: a value with no finite score keeps its
 * text in `annotation` beside a null `value`.
 */
function parsePredictorValue(raw: string | null): Omit<InSilicoPredictor, 'id'> {
  const text = raw?.trim() ?? '';
  if (text === '') return { value: null, annotation: null };
  const annotated = ANNOTATED_PREDICTOR_VALUE.exec(text);
  const score = annotated ? annotated[1] : PLAIN_PREDICTOR_VALUE.test(text) ? text : undefined;
  const value = score === undefined ? Number.NaN : Number(score);
  if (!Number.isFinite(value)) return { value: null, annotation: text };
  return { value, annotation: annotated?.[2]?.trim() || null };
}

export class GnomadService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxConcurrency: number;
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly serverConfig: ServerConfig) {
    this.baseUrl = serverConfig.gnomadApiBaseUrl;
    this.timeoutMs = serverConfig.requestTimeoutMs;
    this.maxConcurrency = serverConfig.maxConcurrency;
  }

  /**
   * Derive the effective dataset, its parent release, and its build from a
   * caller's choices, validating coherence.
   */
  resolveDatasetContext(
    dataset: Dataset | undefined,
    referenceGenome?: ReferenceGenome,
  ): DatasetContext {
    const ds = dataset ?? this.serverConfig.defaultDataset;
    const { parent, build } = DATASET_LINEAGE[ds];
    if (referenceGenome && referenceGenome !== build) {
      throw validationError(
        `dataset ${ds} requires reference_genome ${build}, not ${referenceGenome}. gnomAD v4, v3, and their subsets are GRCh38; v2.1, its subsets, and ExAC are GRCh37.`,
        {
          reason: 'incoherent_build',
          dataset: ds,
          expected: build,
          supplied: referenceGenome,
        },
      );
    }
    return { dataset: ds, parent, reference_genome: build };
  }

  /** Simple semaphore gate — caps concurrent upstream calls for politeness. */
  private async acquireSlot(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        this.queue.splice(this.queue.indexOf(grant), 1);
        reject(signal.reason);
      };
      this.queue.push(grant);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private releaseSlot(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.active -= 1;
  }

  /** Execute a GraphQL document and return its judged `data` — see {@link exchange}. */
  private async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
    schema: z.ZodType<T>,
    operation: string,
    ctx: Context,
    options: GraphqlOptions,
  ): Promise<T> {
    const reply = await this.exchange(query, variables, schema, operation, ctx, options);
    // GraphqlOptions carries no `partialRoot`, so every reply here is judged.
    if (reply.partial) throw new Error(`${operation}: partial reply without a partialRoot`);
    return reply.data;
  }

  /**
   * Execute a GraphQL document with retry + concurrency cap + typed validation.
   * Every attempt's fetch and queue wait share the call's absolute deadline.
   */
  private exchange<T>(
    query: string,
    variables: Record<string, unknown>,
    schema: z.ZodType<T>,
    operation: string,
    ctx: Context,
    options: ExchangeOptions,
  ): Promise<Exchange<T>> {
    const reqCtx = requestContextService.createRequestContext({
      operation,
      parentContext: ctx,
    });
    const deadline = options.deadline;
    const deadlineMs = remainingBudget(deadline, ctx.signal, 'gnomAD');
    return withRetry<Exchange<T>>(
      async ({ signal }) => {
        await this.acquireSlot(signal);
        try {
          // fetchWithTimeout throws a status-mapped McpError on non-2xx whose data
          // carries upstream internals (statusCode/responseBody/requestId/URL).
          // A region rejection relays gnomAD's message alone; everything else is
          // sanitized so none of that reaches the client. The typed
          // validation/not-found paths below raise their own clean errors.
          const timeoutMs = Math.min(this.timeoutMs, remainingBudget(deadline, signal, 'gnomAD'));
          const response = await fetchWithTimeout(this.baseUrl, timeoutMs, reqCtx, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ query, variables }),
            signal,
          }).catch((err: unknown) => {
            const rejection = options?.relayRegionRejections ? regionRejection(err) : undefined;
            if (rejection) throw rejection;
            return sanitizeUpstreamError(err, 'gnomAD');
          });
          const body = await readUpstreamJson(response, 'gnomAD', GraphqlEnvelope);
          if (body.errors?.length) {
            if (options?.partialRoot != null && isPopulatedRoot(body.data, options.partialRoot)) {
              return { partial: true };
            }
            const message = body.errors.map((e) => e.message).join('; ');
            // gnomAD reports load shedding (Request timed out, Service overloaded)
            // as GraphQL errors on an HTTP 200; retry those. Its rate limit arrives
            // as an HTTP 400, which the fetch path already retries; the pattern
            // also covers rate-limit wording on a 200.
            if (body.errors.some((e) => TRANSIENT_GRAPHQL_MESSAGE.test(e.message))) {
              upstreamUnavailable(new Error(`${GRAPHQL_ERROR_PREFIX}${message}`), 'gnomAD');
            }
            // gnomAD returns "<entity> not found" as a GraphQL error *alongside* a
            // valid `data` payload with the entity nulled (e.g. errors:["Gene not
            // found"] + data:{gene:null}). That is a not-found signal, not a fault —
            // fall through to parse so the entity surfaces as null and the caller's
            // typed not-found contract (gene_not_found / variant_not_found) fires.
            // With `absentRoot`, only that root's null counts: the combined variant
            // document answers "Variant not found" beside `variant: null` and
            // whatever `clinvar_variant` holds, since ClinVar may know a variant
            // gnomAD lacks. Any other error (Invalid variant ID, Multiple variants
            // found, …) is a real failure and still throws.
            const allNotFound = body.errors.every((e) => NOT_FOUND_MESSAGE.test(e.message));
            const absentRoot = options?.absentRoot;
            const absent =
              absentRoot != null ? isNullRoot(body.data, absentRoot) : body.data != null;
            if (!allNotFound || !absent) {
              throw validationError(`${GRAPHQL_ERROR_PREFIX}${message}`, {
                reason: 'graphql_error',
                retryable: false,
              });
            }
          }
          try {
            return { partial: false, data: schema.parse(body.data) };
          } catch (err) {
            invalidUpstreamResponse(err, 'gnomAD');
          }
        } finally {
          this.releaseSlot();
        }
      },
      {
        operation,
        context: reqCtx,
        baseDelayMs: 1500,
        maxRetries: 3,
        signal: ctx.signal,
        deadlineMs,
      },
    ).catch((err: unknown) => {
      ctx.signal.throwIfAborted();
      if (err instanceof McpError && err.data?.reason === 'retry_deadline_exceeded') {
        sanitizeUpstreamError(err, 'gnomAD');
      }
      throw err;
    });
  }

  /**
   * Fetch one variant's population record + ClinVar join. Accepts a
   * chrom-pos-ref-alt variantId or an rsID. Returns null when absent in the
   * dataset. gnomAD's `variant(variantId:)` rejects rsIDs, so rsIDs route
   * through the `rsid` argument and the ClinVar join is fetched on the resolved
   * variant_id; an rsID that maps to multiple variants surfaces as the upstream
   * GraphQL error (a per-item failure for the batch handler). A mitochondrial
   * coordinate ID is refused before any fetch: gnomAD's nuclear `variant` field
   * answers it with "Variant not found" even when gnomAD holds the variant.
   *
   * A coordinate ID costs one combined request. gnomAD's errors carry no `path`,
   * so errors beside a populated `variant` cannot say which root failed: that
   * reply is discarded and the lookup re-sent as a variant-only request, then a
   * ClinVar-only request, each judged alone. The ClinVar join is best-effort —
   * see {@link lookupClinvar}; `startedAt` (epoch ms, default now) anchors its
   * call budget, so a batch passes one value to give every item the same deadline.
   */
  async getVariant(
    idOrRsid: string,
    dsCtx: DatasetContext,
    ctx: Context,
    { startedAt = Date.now() }: { startedAt?: number } = {},
  ): Promise<VariantRecord | null> {
    if (MITOCHONDRIAL_VARIANT_ID.test(idOrRsid)) {
      throw mitochondrialUnsupported(`Variant "${idOrRsid}"`);
    }
    const clinvarDeadline = startedAt + UPSTREAM_CALL_BUDGET_MS;
    if (RSID.test(idOrRsid)) {
      let resolved: z.infer<typeof VariantRootResponse>;
      try {
        resolved = await this.graphql(
          VARIANT_BY_RSID_QUERY,
          { rsid: idOrRsid, dataset: dsCtx.dataset },
          VariantRootResponse,
          'gnomad.getVariantByRsid',
          ctx,
          { deadline: clinvarDeadline },
        );
      } catch (err) {
        if (!(err instanceof McpError) || !/multiple variants found/i.test(err.message)) throw err;
        let candidates: string[] = [];
        try {
          const search = await this.graphql(
            VARIANT_SEARCH_QUERY,
            { query: idOrRsid, dataset: dsCtx.dataset },
            VariantSearchResponse,
            'gnomad.searchVariant',
            ctx,
            { deadline: clinvarDeadline },
          );
          candidates = search.variant_search.map((candidate) => candidate.variant_id);
        } catch (resolverError) {
          ctx.signal.throwIfAborted();
          if (
            resolverError instanceof McpError &&
            resolverError.data?.reason === 'upstream_timeout'
          )
            throw resolverError;
          // Preserve the original actionable failure if candidate resolution is unavailable.
        }
        throw validationError(
          candidates.length
            ? `${idOrRsid} maps to multiple variants; retry with a candidate variant ID.`
            : `${idOrRsid} maps to multiple variants; resolve it to a concrete chrom-pos-ref-alt variant ID with dbSNP or Ensembl and retry.`,
          {
            reason: 'ambiguous_rsid',
            retryable: false,
            ...(candidates.length ? { candidates } : {}),
          },
        );
      }
      if (!resolved.variant) return null;
      this.assertVariantBuild(resolved.variant, dsCtx);
      const clinvar = await this.lookupClinvar(
        resolved.variant.variant_id,
        dsCtx,
        ctx,
        clinvarDeadline,
      );
      return this.normalizeVariant(resolved.variant, clinvar, dsCtx);
    }
    const combined = await this.exchange(
      VARIANT_QUERY,
      { variantId: idOrRsid, dataset: dsCtx.dataset, referenceGenome: dsCtx.reference_genome },
      VariantResponse,
      'gnomad.getVariant',
      ctx,
      { absentRoot: 'variant', partialRoot: 'variant', deadline: clinvarDeadline },
    );
    if (!combined.partial) {
      const { variant, clinvar_variant } = combined.data;
      if (!variant) return null;
      this.assertVariantBuild(variant, dsCtx);
      return this.normalizeVariant(
        variant,
        { clinvar: clinvar_variant, unavailable: false },
        dsCtx,
      );
    }
    const { variant } = await this.graphql(
      VARIANT_ONLY_QUERY,
      { variantId: idOrRsid, dataset: dsCtx.dataset },
      VariantRootResponse,
      'gnomad.getVariantOnly',
      ctx,
      { absentRoot: 'variant', deadline: clinvarDeadline },
    );
    if (!variant) return null;
    this.assertVariantBuild(variant, dsCtx);
    const clinvar = await this.lookupClinvar(idOrRsid, dsCtx, ctx, clinvarDeadline);
    return this.normalizeVariant(variant, clinvar, dsCtx);
  }

  /**
   * The ClinVar join as a request of its own, so any failure it reports is
   * ClinVar's. Best-effort: a GraphQL error, an HTTP failure, a transient error
   * outlasting the retries, or `deadline` (epoch ms) passing — across every
   * attempt and backoff — returns `unavailable` beside the population record
   * instead of failing it. A cancelled caller still rejects.
   */
  private async lookupClinvar(
    variantId: string,
    dsCtx: DatasetContext,
    ctx: Context,
    deadline: number,
  ): Promise<ClinvarLookup> {
    ctx.signal.throwIfAborted();
    const deadlineMs = deadline - Date.now();
    if (deadlineMs <= 0) {
      ctx.log.warning('Skipped the ClinVar lookup: its time budget was already spent.', {
        variantId,
      });
      return { clinvar: null, unavailable: true };
    }
    try {
      const data = await this.graphql(
        CLINVAR_BY_VARIANT_ID_QUERY,
        { variantId, referenceGenome: dsCtx.reference_genome },
        ClinVarOnlyResponse,
        'gnomad.getClinvar',
        ctx,
        { deadline },
      );
      return { clinvar: data.clinvar_variant, unavailable: false };
    } catch (err) {
      absorbUpstreamFailure(
        err,
        ctx,
        'ClinVar lookup failed; returning the population record without it.',
        { variantId },
      );
      return { clinvar: null, unavailable: true };
    }
  }

  /**
   * Where each variant ID the dataset lacks would sit on the dataset's build if
   * it were written for the other one, from gnomAD's liftover table: aliased
   * requests of up to {@link LIFTOVER_REQUEST_IDS} distinct coordinate IDs each,
   * sent in turn, keyed in the result by the ID as passed, with only IDs that
   * lift present. rsIDs are dropped, since gnomAD fails the whole document on
   * one, and a call with none left sends nothing. Best-effort like
   * {@link lookupClinvar}: a GraphQL error, an HTTP failure, a transient error
   * outlasting the retries, a reply whose entries name IDs other than the ones
   * asked for, or the call budget anchored at `startedAt` (epoch ms, default
   * now) running out returns no candidates for that request's IDs. A cancelled
   * caller still rejects. A resolved lift says only that the string names a
   * variant on the other build, never that the caller meant that build.
   */
  async liftoverCandidates(
    variantIds: readonly string[],
    dsCtx: DatasetContext,
    ctx: Context,
    { startedAt = Date.now() }: { startedAt?: number } = {},
  ): Promise<Map<string, string[]>> {
    ctx.signal.throwIfAborted();
    const ids = [...new Set(variantIds.filter((id) => !RSID.test(id)))];
    if (ids.length === 0) return new Map();
    const deadline = startedAt + UPSTREAM_CALL_BUDGET_MS;
    if (deadline - Date.now() <= 0) {
      ctx.log.warning('Skipped the liftover lookup: its time budget was already spent.', {
        variantIds: ids,
      });
      return new Map();
    }
    const direction = LIFTOVER_DIRECTION[dsCtx.reference_genome];
    const lifted = new Map<string, string[]>();
    for (let start = 0; start < ids.length; start += LIFTOVER_REQUEST_IDS) {
      const chunk = ids.slice(start, start + LIFTOVER_REQUEST_IDS);
      for (const [id, candidates] of await this.liftoverRequest(chunk, direction, ctx, deadline)) {
        lifted.set(id, candidates);
      }
    }
    return lifted;
  }

  /** One aliased liftover request for `ids`; see {@link liftoverCandidates}. */
  private async liftoverRequest(
    ids: readonly string[],
    direction: (typeof LIFTOVER_DIRECTION)[ReferenceGenome],
    ctx: Context,
    deadline: number,
  ): Promise<Map<string, string[]>> {
    try {
      const data = await this.graphql(
        liftoverQuery(ids.length, direction.argument),
        {
          ...Object.fromEntries(ids.map((id, index) => [`v${index}`, id])),
          referenceGenome: direction.idBuild,
        },
        z.object(Object.fromEntries(ids.map((_, index) => [`l${index}`, LiftoverEntries]))),
        'gnomad.liftover',
        ctx,
        { deadline },
      );
      const lifted = new Map<string, string[]>();
      for (const [index, id] of ids.entries()) {
        const entries = data[`l${index}`] ?? [];
        // An entry for another ID means the reply answers a different document.
        if (entries.some((entry) => entry[direction.queried].variant_id !== id)) {
          ctx.log.warning(
            'Liftover reply names variant IDs it was not asked for; the absent IDs stay plain not-found.',
            { variantIds: ids },
          );
          return new Map();
        }
        const candidates = new Set(entries.map((entry) => entry[direction.candidate].variant_id));
        if (candidates.size) lifted.set(id, [...candidates]);
      }
      return lifted;
    } catch (err) {
      absorbUpstreamFailure(
        err,
        ctx,
        'Liftover lookup failed; the absent IDs stay plain not-found.',
        {
          variantIds: ids,
        },
      );
      return new Map();
    }
  }

  private assertVariantBuild(
    variant: NonNullable<z.infer<typeof RawVariant>>,
    dsCtx: DatasetContext,
  ): void {
    if (variant.reference_genome !== dsCtx.reference_genome) {
      throw validationError('gnomAD returned a variant on a different reference build.', {
        reason: 'upstream_build_mismatch',
        retryable: false,
      });
    }
  }

  private normalizeVariant(
    v: NonNullable<z.infer<typeof RawVariant>>,
    { clinvar, unavailable }: ClinvarLookup,
    dsCtx: DatasetContext,
  ): VariantRecord {
    const source: VariantRecord['source'] = [];
    const populations: PopulationFreq[] = [];
    const callsets: Record<'exome' | 'genome', CallsetRecord | null> = {
      exome: null,
      genome: null,
    };
    // The carried-callset sum — the overall counts wherever gnomAD publishes no joint record.
    let ac = 0;
    let an = 0;
    let hom = 0;
    let hemi: number | null = null;
    let hasAf = false;
    let afNumerator = 0;
    let afDenominator = 0;
    // A gnomad_r4 or gnomad_r3 subset's record carries its parent's FAF, so it relays none.
    const fafWithheld = recordFafParent(dsCtx) != null;

    for (const [src, data] of [
      ['exome', v.exome],
      ['genome', v.genome],
    ] as const) {
      if (!data || data.ac == null) continue;
      source.push(src);
      callsets[src] = {
        ...groupCounts(data),
        filters: data.filters ?? null,
        faf95: fafWithheld ? null : faf95Of(data.faf95?.popmax, data.faf95?.popmax_population),
      };
      ac += data.ac;
      an += data.an ?? 0;
      hom += data.homozygote_count ?? 0;
      if (data.hemizygote_count != null) hemi = (hemi ?? 0) + data.hemizygote_count;
      if (data.an != null && data.an > 0) {
        afNumerator += data.ac;
        afDenominator += data.an;
        hasAf = true;
      }
      for (const p of data.populations ?? []) {
        if (isCanonicalAncestry(p.id))
          populations.push({ id: p.id, source: src, ...groupCounts(p) });
      }
    }

    let overall: Pick<VariantRecord, 'ac' | 'an' | 'af' | 'homozygote_count' | 'hemizygote_count'> =
      {
        ac,
        an,
        af: hasAf ? afNumerator / afDenominator : null,
        homozygote_count: hom,
        hemizygote_count: hemi,
      };
    const jointPopulations: JointPopulationFreq[] = [];
    // Without joint data, the higher carried callset FAF95, which `source` names.
    let faf95: VariantRecord['faf95'] = highestFaf(
      source.map((src) => {
        const faf = callsets[src]?.faf95;
        return faf ? { ...faf, source: src } : null;
      }),
    );
    /**
     * gnomad_r4's joint record is the overall source when it carries an AC, as
     * a callset does: its AN spans both callsets' callable samples, so a
     * single-callset variant is not divided by that callset's AN alone — the
     * Total gnomAD's own browser shows. `source` still names only the callsets
     * carrying the variant. The FAF95 follows it, joint's own even when null,
     * so a record never pairs joint counts with a callset FAF.
     */
    const { joint } = v;
    if (joint?.ac != null) {
      overall = groupCounts(joint);
      const jointFaf = faf95Of(joint.faf95?.popmax, joint.faf95?.popmax_population);
      faf95 = jointFaf && !fafWithheld ? { ...jointFaf, source: 'joint' } : null;
      for (const p of joint.populations ?? []) {
        if (isCanonicalAncestry(p.id)) jointPopulations.push({ id: p.id, ...groupCounts(p) });
      }
    }

    const consequences = v.transcript_consequences ?? [];
    const tc = consequences[0];
    return {
      variant_id: v.variant_id,
      rsids: v.rsids ?? [],
      reference_genome: dsCtx.reference_genome,
      dataset: dsCtx.dataset,
      ...overall,
      faf95,
      populations,
      joint_populations: jointPopulations,
      callsets,
      source,
      flags: v.flags ?? [],
      qc_status: qcStatus([callsets.exome?.filters ?? null, callsets.genome?.filters ?? null]),
      consequence: tc?.major_consequence ?? null,
      transcript_id: tc?.transcript_id ?? null,
      hgvsc: tc?.hgvsc ?? null,
      hgvsp: tc?.hgvsp ?? null,
      lof: tc?.lof ?? null,
      lof_filter: tc?.lof_filter ?? null,
      lof_flags: tc?.lof_flags ?? null,
      primary_transcript: primaryTranscriptConsequence(consequences),
      gene_symbol: tc?.gene_symbol ?? null,
      lof_curations: (v.lof_curations ?? []).map((curation) => ({
        gene_id: curation.gene_id,
        gene_symbol: curation.gene_symbol,
        verdict: curation.verdict,
        flags: curation.flags ?? [],
        project: curation.project,
      })),
      in_silico: (v.in_silico_predictors ?? []).map((p) => ({
        id: p.id,
        ...parsePredictorValue(p.value),
      })),
      clinvar:
        clinvar && (clinvar.clinical_significance != null || clinvar.clinvar_variation_id != null)
          ? {
              clinical_significance: clinvar.clinical_significance,
              review_status: clinvar.review_status,
              gold_stars: clinvar.gold_stars,
              clinvar_variation_id: clinvar.clinvar_variation_id,
            }
          : null,
      clinvar_unavailable: unavailable,
    };
  }

  /**
   * Fetch gene loss-of-function constraint by symbol or Ensembl gene ID. gnomAD
   * picks the table by build alone, so exac reads gene.exac_constraint beside
   * the GRCh37 gnomAD table, a subset reads its parent release's table, and
   * every result names its constraint release while echoing the dataset asked
   * for. gene.mitochondrial_constraint is one table on both builds, so every
   * dataset returns it, exac included. gnomAD matches an Ensembl ID
   * case-sensitively and unversioned, so one is normalized first under
   * GNOMAD_NORMALIZE_IDS; a symbol is sent as given.
   */
  async getGeneConstraint(
    geneRef: string,
    dsCtx: DatasetContext,
    ctx: Context,
  ): Promise<GeneConstraint | null> {
    const deadline = Date.now() + UPSTREAM_CALL_BUDGET_MS;
    const gene = normalizeIdentifier('gene', geneRef);
    const byId = ENSEMBL_GENE_ID.test(gene);
    const data = await this.graphql(
      byId ? GENE_CONSTRAINT_BY_ID_QUERY : GENE_CONSTRAINT_BY_SYMBOL_QUERY,
      { gene, referenceGenome: dsCtx.reference_genome },
      ConstraintResponse,
      'gnomad.getGeneConstraint',
      ctx,
      { deadline },
    );
    if (!data.gene) return null;
    const c: Partial<z.infer<typeof ConstraintMetrics>> | null =
      dsCtx.parent === 'exac'
        ? parseConstraint(ExacConstraintMetrics, data.gene.exac_constraint)
        : parseConstraint(ConstraintMetrics, data.gene.gnomad_constraint);
    const mitochondrial = parseConstraint(
      MitochondrialConstraintMetrics,
      data.gene.mitochondrial_constraint,
    );
    return {
      gene_id: data.gene.gene_id,
      symbol: data.gene.symbol,
      dataset: dsCtx.dataset,
      reference_genome: dsCtx.reference_genome,
      constraint_release: CONSTRAINT_RELEASE[dsCtx.parent],
      pli: c?.pli ?? null,
      oe_lof: c?.oe_lof ?? null,
      oe_lof_lower: c?.oe_lof_lower ?? null,
      oe_lof_upper: c?.oe_lof_upper ?? null,
      oe_lof_percentile: c?.oe_lof_percentile ?? null,
      oe_mis: c?.oe_mis ?? null,
      oe_mis_lower: c?.oe_mis_lower ?? null,
      oe_mis_upper: c?.oe_mis_upper ?? null,
      oe_syn: c?.oe_syn ?? null,
      oe_syn_lower: c?.oe_syn_lower ?? null,
      oe_syn_upper: c?.oe_syn_upper ?? null,
      lof_z: c?.lof_z ?? null,
      mis_z: c?.mis_z ?? null,
      syn_z: c?.syn_z ?? null,
      obs_lof: c?.obs_lof ?? null,
      exp_lof: c?.exp_lof ?? null,
      obs_mis: c?.obs_mis ?? null,
      exp_mis: c?.exp_mis ?? null,
      obs_syn: c?.obs_syn ?? null,
      exp_syn: c?.exp_syn ?? null,
      constraint_flags: c?.flags ?? [],
      mitochondrial_constraint: mitochondrial,
    };
  }

  /**
   * List variants in a gene / transcript / region, filtered by consequence class,
   * LOFTEE confidence, max-AF, and max-FAF; a row with a null af or faf95_max
   * is kept by the filter on it, and lofConfidence keeps only the rows whose
   * lof equals it. Returns the full normalized row set (the handler spills it):
   * with annotations, each row an AnnotatedGeneVariantRow. passOnly selects the
   * counts a row reads (see normalizeListVariant) but drops no row: the caller
   * counts the QC-failed rows first, then drops them.
   */
  async listGeneVariants(
    target: GenomeTarget,
    filters: {
      annotations?: boolean | undefined;
      consequenceClass?: ConsequenceClass | undefined;
      lofConfidence?: LofConfidence | undefined;
      maxAf?: number | undefined;
      maxFaf?: number | undefined;
      passOnly?: boolean | undefined;
    },
    dsCtx: DatasetContext,
    ctx: Context,
  ): Promise<GeneVariantRow[]> {
    const deadline = Date.now() + UPSTREAM_CALL_BUDGET_MS;
    const annotations = filters.annotations ?? false;
    const { query, variables } = this.buildTargetQuery(target, dsCtx, {
      kind: 'variants',
      annotations,
    });
    const data = await this.graphql(
      query,
      variables,
      VariantListResponse,
      'gnomad.listGeneVariants',
      ctx,
      { relayRegionRejections: true, deadline },
    );
    assertFeatureFound(target, data, dsCtx);
    assertNuclearFeature(target, data.gene ?? data.transcript);
    const raw = (data.gene ?? data.transcript ?? data.region)?.variants ?? [];
    // gnomAD's gene table marks consequences off the primary transcript on gene targets only.
    const primary = data.gene ? genePrimaryTranscript(data.gene) : null;
    const rows = raw.map((r) =>
      this.normalizeListVariant(r, primary, filters.passOnly ?? false, annotations),
    );
    return rows.filter((row) => {
      if (filters.consequenceClass && row.consequence_class !== filters.consequenceClass)
        return false;
      if (filters.lofConfidence && row.lof !== filters.lofConfidence) return false;
      if (filters.maxAf != null && row.af != null && row.af > filters.maxAf) return false;
      if (filters.maxFaf != null && row.faf95_max != null && row.faf95_max > filters.maxFaf)
        return false;
      return true;
    });
  }

  private normalizeListVariant(
    r: RawListVariantT,
    primary: ReturnType<typeof genePrimaryTranscript>,
    passOnly: boolean,
    annotations: boolean,
  ): GeneVariantRow | AnnotatedGeneVariantRow {
    const { exome, genome, joint } = r;
    const exomeFilters = carriedFilters(exome);
    const genomeFilters = carriedFilters(genome);
    const qc = qcStatus([exomeFilters, genomeFilters]);
    /**
     * Overall counts match normalizeVariant(): gnomAD's joint record where it
     * carries an AC (gnomad_r4), else the sum across exome + genome. ac, an, and
     * the zygosity counts share that one source and af = ac/an, so max_af
     * filters on the frequency the row shows. The per-callset upstream af
     * describes one callset only and never stands in for it. hemizygote_count
     * stays null when no record summed reports one; gnomAD reports 0 off X/Y.
     * faf95_max reads the same records: joint's fafmax, else the highest FAF95
     * a summed callset reports — its fafmax or faf95, whichever the document
     * selected for the dataset (listRowFafField).
     *
     * Under passOnly the sum leaves out a callset that failed QC, as gnomAD's
     * browser table drops it before merging (VariantList/filterVariants.ts); the
     * joint record is read whole there too. A row no callset passed keeps the
     * full sum, so qc_filtered, counted before the caller drops that row,
     * matches the same rows with and without passOnly.
     */
    const dropFailed = passOnly && qc === 'pass';
    const ex = !dropFailed || exomeFilters?.length === 0 ? exome : null;
    const ge = !dropFailed || genomeFilters?.length === 0 ? genome : null;
    const counts =
      joint?.ac != null
        ? {
            ac: joint.ac,
            an: joint.an ?? 0,
            homozygote_count: joint.homozygote_count ?? 0,
            hemizygote_count: joint.hemizygote_count ?? null,
            faf: faf95Of(joint.fafmax?.faf95_max, joint.fafmax?.faf95_max_gen_anc),
          }
        : {
            ac: (ex?.ac ?? 0) + (ge?.ac ?? 0),
            an: (ex?.an ?? 0) + (ge?.an ?? 0),
            homozygote_count: (ex?.homozygote_count ?? 0) + (ge?.homozygote_count ?? 0),
            hemizygote_count:
              ex?.hemizygote_count == null && ge?.hemizygote_count == null
                ? null
                : (ex?.hemizygote_count ?? 0) + (ge?.hemizygote_count ?? 0),
            faf: highestFaf(
              [ex, ge].flatMap((callset) => [
                faf95Of(callset?.fafmax?.faf95_max, callset?.fafmax?.faf95_max_gen_anc),
                faf95Of(callset?.faf95?.popmax, callset?.faf95?.popmax_population),
              ]),
            ),
          };
    const source: string[] = [];
    if (exome?.ac != null) source.push('exome');
    if (genome?.ac != null) source.push('genome');
    const transcriptId = r.transcript_id ?? null;
    const row: GeneVariantRow = {
      variant_id: r.variant_id,
      af: computeAf(counts.ac, counts.an),
      ac: counts.ac,
      an: counts.an,
      consequence: r.consequence,
      consequence_class: classifyConsequence(r.consequence),
      homozygote_count: counts.homozygote_count,
      hemizygote_count: counts.hemizygote_count,
      faf95_max: counts.faf?.value ?? null,
      faf95_max_group: counts.faf?.group ?? null,
      source: source.join('|'),
      flags: (r.flags ?? []).join('|'),
      exome_filters: exomeFilters?.join('|') ?? null,
      genome_filters: genomeFilters?.join('|') ?? null,
      qc_status: qc,
      transcript_id: transcriptId,
      consequence_transcript: primary && (transcriptId === primary.id ? primary.kind : 'other'),
      lof: r.lof ?? null,
    };
    // The opt-in columns follow every default one, and a row without annotations carries none of them.
    if (!annotations) return row;
    return {
      ...row,
      hgvsc: r.hgvsc ?? null,
      hgvsp: r.hgvsp ?? null,
      lof_filter: r.lof_filter ?? null,
      lof_flags: r.lof_flags ?? null,
      rsids: (r.rsids ?? []).join('|'),
    };
  }

  /**
   * Fetch sequencing coverage summary for a target, per callset source, from
   * the dataset's parent release (itself for a release; see buildTargetQuery).
   */
  async getCoverage(
    target: GenomeTarget,
    dsCtx: DatasetContext,
    ctx: Context,
  ): Promise<CoverageSummary[]> {
    const deadline = Date.now() + UPSTREAM_CALL_BUDGET_MS;
    const { query, variables, regionBounds } = this.buildTargetQuery(target, dsCtx, {
      kind: 'coverage',
    });
    const data = await this.graphql(query, variables, CoverageResponse, 'gnomad.getCoverage', ctx, {
      relayRegionRejections: true,
      deadline,
    });
    assertFeatureFound(target, data, dsCtx);
    const feature = data.gene ?? data.transcript;
    assertNuclearFeature(target, feature);
    // gnomAD answers with histogram buckets, not bases, and zero-fills every
    // bucket between its first and last record. A region is queried ±75 bp
    // around start..stop; a gene or transcript over its merged exons ±75 bp, so
    // its histogram spans the introns between them. Summarize exactly the
    // buckets overlapping the target intervals — a zero-filled bucket inside
    // them is genuinely uncovered, one outside them was never queried.
    const window = feature
      ? featureCoverageWindow(feature.exons)
      : regionBounds && regionCoverageWindow(regionBounds);
    const cov = (feature ?? data.region)?.coverage;
    if (!cov || !window) return [];
    const targetPositions = window.intervals.reduce(
      (sum, interval) => sum + interval.stop - interval.start + 1,
      0,
    );
    const summaries: CoverageSummary[] = [];
    for (const [src, rawBins] of [
      ['exome', cov.exome],
      ['genome', cov.genome],
    ] as const) {
      const bins: RawCoverageBinT[] = [];
      let positions = 0;
      for (const bin of rawBins ?? []) {
        const bases = bin.pos == null ? 0 : basesInWindow(bin.pos, window);
        if (bases === 0) continue;
        bins.push(bin);
        positions += bases;
      }
      if (bins.length === 0) continue;
      summaries.push(
        this.summarizeCoverage(src, bins, positions, window.bucketSize, targetPositions),
      );
    }
    return summaries;
  }

  /**
   * How two variants co-occur in gnomAD's v2.1 exomes, overall and per
   * genetic-ancestry group, with the probability they lie on different
   * haplotypes. gnomAD serves co-occurrence on gnomad_r2_1 alone, so the request
   * names that dataset whatever the server default. `variantIds` are two
   * canonical coordinate IDs; a mitochondrial one is refused before any fetch.
   * gnomAD answers a pair it holds pre-computed in its stored order and any
   * other pair in the order sent, so every count is labelled from the reply's
   * own variant_ids. A pair gnomAD will not phase fails as
   * cooccurrence_unavailable with gnomAD's sentence, after one request.
   */
  async getVariantCooccurrence(
    variantIds: readonly string[],
    ctx: Context,
  ): Promise<VariantCooccurrence> {
    for (const id of variantIds) {
      if (MITOCHONDRIAL_VARIANT_ID.test(id)) throw mitochondrialUnsupported(`Variant "${id}"`);
    }
    const deadline = Date.now() + UPSTREAM_CALL_BUDGET_MS;
    const { variant_cooccurrence: reply } = await this.graphql(
      VARIANT_COOCCURRENCE_QUERY,
      { variants: variantIds, dataset: 'gnomad_r2_1' },
      cooccurrenceResponse(variantIds),
      'gnomad.getVariantCooccurrence',
      ctx,
      { deadline },
    ).catch((err: unknown) => {
      throw cooccurrenceRefusal(err) ?? err;
    });
    return {
      variant_ids: reply.variant_ids,
      dataset: 'gnomad_r2_1',
      reference_genome: 'GRCh37',
      ...labelCooccurrence(reply),
      populations: reply.populations.map((population) => ({
        id: population.id,
        ...labelCooccurrence(population),
      })),
    };
  }

  /**
   * gnomAD's ClinVar mapping for a gene on GRCh38, keyed by ClinVar
   * VariationID: the gnomAD variant ID gnomAD derived from ClinVar's VCF, which
   * keeps the anchor base, so each ID is exact where the mapping answers. The
   * mapping lags NCBI (gnomAD's ClinVar release), covers only records inside
   * the gene's interval that ClinVar's VCF can express, and leaves out
   * mitochondrial IDs, which gnomad_get_variant refuses. One request, no cache.
   * Best-effort like {@link lookupClinvar}: a GraphQL error, an HTTP failure, a
   * transient error outlasting the retries, or the call budget anchored at
   * `startedAt` (epoch ms) running out — no request starts once it has —
   * answers `unavailable`, and a gene gnomAD does not hold `gene_not_found`. A
   * cancelled caller still rejects.
   */
  async clinvarVariantIds(
    gene: string,
    ctx: Context,
    { startedAt }: { startedAt: number },
  ): Promise<ClinvarVariantIds> {
    ctx.signal.throwIfAborted();
    const deadline = startedAt + UPSTREAM_CALL_BUDGET_MS;
    if (deadline - Date.now() <= 0) {
      ctx.log.warning('Skipped the ClinVar ID mapping: its time budget was already spent.', {
        gene,
      });
      return { status: 'unavailable' };
    }
    try {
      const data = await this.graphql(
        GENE_CLINVAR_VARIANT_IDS_QUERY,
        { gene },
        GeneClinvarVariantIdsResponse,
        'gnomad.clinvarVariantIds',
        ctx,
        { deadline },
      );
      if (!data.gene) return { status: 'gene_not_found' };
      const variantIds = new Map<string, string>();
      for (const entry of data.gene.clinvar_variants ?? []) {
        if (!MITOCHONDRIAL_VARIANT_ID.test(entry.variant_id)) {
          variantIds.set(entry.clinvar_variation_id, entry.variant_id);
        }
      }
      return { status: 'resolved', variantIds };
    } catch (err) {
      absorbUpstreamFailure(err, ctx, 'ClinVar ID mapping failed; the underivable IDs stay null.', {
        gene,
      });
      return { status: 'unavailable' };
    }
  }

  private summarizeCoverage(
    source: 'exome' | 'genome',
    bins: RawCoverageBinT[],
    positions: number,
    bucketSize: number,
    targetPositions: number,
  ): CoverageSummary {
    const mean = (key: keyof RawCoverageBinT): number | null => {
      const vals = bins.map((b) => b[key]).filter((v): v is number => v != null);
      if (vals.length === 0) return null;
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    };
    const median = (() => {
      const vals = bins
        .map((b) => b.median)
        .filter((v): v is number => v != null)
        .sort((a, b) => a - b);
      if (vals.length === 0) return null;
      return vals[Math.floor(vals.length / 2)] ?? null;
    })();
    return {
      source,
      positions,
      target_positions: targetPositions,
      missing_positions: targetPositions - positions,
      bucket_count: bins.length,
      bucket_size: bucketSize,
      mean_depth: mean('mean'),
      median_depth: median,
      fraction_over_1: mean('over_1'),
      fraction_over_5: mean('over_5'),
      fraction_over_10: mean('over_10'),
      fraction_over_15: mean('over_15'),
      fraction_over_20: mean('over_20'),
      fraction_over_25: mean('over_25'),
      fraction_over_30: mean('over_30'),
      fraction_over_50: mean('over_50'),
      fraction_over_100: mean('over_100'),
    };
  }

  /**
   * Build the right query + variables for a gene/transcript/region target. For
   * region targets, also returns the parsed `regionBounds`, the interval
   * getCoverage summarizes; gene and transcript intervals come from their exons.
   * A coverage document names the parent release: gnomAD fails every subset's
   * coverage, a region's with an HTTP 500 the retry layer would read as transient.
   * A list document also takes listDocumentVariables.
   */
  private buildTargetQuery(
    target: GenomeTarget,
    dsCtx: DatasetContext,
    document: { kind: 'variants'; annotations: boolean } | { kind: 'coverage' },
  ): {
    query: string;
    variables: Record<string, unknown>;
    regionBounds?: { start: number; stop: number };
  } {
    const { kind } = document;
    const base =
      document.kind === 'variants'
        ? {
            dataset: dsCtx.dataset,
            referenceGenome: dsCtx.reference_genome,
            ...listDocumentVariables(dsCtx, document.annotations),
          }
        : { dataset: dsCtx.parent, referenceGenome: dsCtx.reference_genome };
    if (target.kind === 'transcript') {
      return {
        query: kind === 'variants' ? TRANSCRIPT_VARIANTS_QUERY : TRANSCRIPT_COVERAGE_QUERY,
        variables: { transcriptId: target.value, ...base },
      };
    }
    if (target.kind === 'region') {
      const { chrom, start, stop } = parseRegion(target.value);
      return {
        query: kind === 'variants' ? REGION_VARIANTS_QUERY : REGION_COVERAGE_QUERY,
        variables: { chrom, start, stop, ...base },
        regionBounds: { start, stop },
      };
    }
    const byId = ENSEMBL_GENE_ID.test(target.value);
    const variantsQ = byId ? GENE_VARIANTS_BY_ID_QUERY : GENE_VARIANTS_BY_SYMBOL_QUERY;
    const coverageQ = byId ? GENE_COVERAGE_BY_ID_QUERY : GENE_COVERAGE_BY_SYMBOL_QUERY;
    return {
      query: kind === 'variants' ? variantsQ : coverageQ,
      variables: { gene: target.value, ...base },
    };
  }
}

// --- Init/accessor pattern ---

let _service: GnomadService | undefined;

export function initGnomadService(_config: AppConfig, _storage: StorageService): void {
  _service = new GnomadService(getServerConfig());
}

export function getGnomadService(): GnomadService {
  if (!_service) {
    throw new Error('GnomadService not initialized — call initGnomadService() in setup()');
  }
  return _service;
}
