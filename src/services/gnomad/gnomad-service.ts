/**
 * @fileoverview gnomAD GraphQL service — owns the parameterized query documents,
 * dataset→reference_genome derivation and pair validation, a politeness
 * concurrency cap, withRetry backoff over the full fetch+parse pipeline, and
 * typed-response validation. Handlers stay pure and throw; this service wraps the
 * upstream so transient 429/5xx surface as ServiceUnavailable, not parse errors,
 * while a region gnomAD refuses fails once as the caller's error.
 * @module services/gnomad/gnomad-service
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { McpError, validationError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, requestContextService, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig, type ServerConfig } from '@/config/server-config.js';
import {
  invalidUpstreamResponse,
  readUpstreamJson,
  sanitizeUpstreamError,
  upstreamGraphqlMessages,
  upstreamUnavailable,
} from '@/services/upstream-error.js';
import {
  CLINVAR_BY_VARIANT_ID_QUERY,
  GENE_CONSTRAINT_BY_ID_QUERY,
  GENE_CONSTRAINT_BY_SYMBOL_QUERY,
  GENE_COVERAGE_BY_ID_QUERY,
  GENE_COVERAGE_BY_SYMBOL_QUERY,
  GENE_VARIANTS_BY_ID_QUERY,
  GENE_VARIANTS_BY_SYMBOL_QUERY,
  REGION_COVERAGE_QUERY,
  REGION_VARIANTS_QUERY,
  TRANSCRIPT_COVERAGE_QUERY,
  TRANSCRIPT_VARIANTS_QUERY,
  VARIANT_BY_RSID_QUERY,
  VARIANT_QUERY,
  VARIANT_SEARCH_QUERY,
} from './queries.js';
import {
  type ConsequenceClass,
  type ConstraintRelease,
  type CoverageSummary,
  type Dataset,
  type GeneConstraint,
  type GeneVariantRow,
  type GenomeTarget,
  type InSilicoPredictor,
  isCanonicalAncestry,
  type PopulationFreq,
  type ReferenceGenome,
  type VariantRecord,
} from './types.js';

/** Effective dataset+build pair, after derivation and coherence validation. */
export interface DatasetContext {
  dataset: Dataset;
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
/** gnomAD serves mitochondrial data through separate fields this server does not query. */
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

/** v4/v3 are GRCh38; v2.1 and ExAC are GRCh37. */
function refGenomeForDataset(dataset: Dataset): ReferenceGenome {
  return dataset === 'gnomad_r2_1' || dataset === 'exac' ? 'GRCh37' : 'GRCh38';
}

/**
 * The constraint release each dataset serves, matching the gnomAD browser. The
 * GRCh38 table has been v4.1.2 since 2026-09-28 (values unchanged from v4.1.1);
 * gnomAD publishes no v3 constraint, so gnomad_r3 serves that same table; exac
 * reads gene.exac_constraint rather than the GRCh37 gnomAD v2.1.1 table.
 */
const CONSTRAINT_RELEASE = {
  gnomad_r4: 'gnomAD v4.1.2',
  gnomad_r3: 'gnomAD v4.1.2',
  gnomad_r2_1: 'gnomAD v2.1.1',
  exac: 'ExAC r0.3',
} as const satisfies Record<Dataset, ConstraintRelease>;

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

const RawSeqData = z
  .object({
    ac: z.number().nullable(),
    an: z.number().nullable(),
    af: z.number().nullable(),
    homozygote_count: z.number().nullable(),
    hemizygote_count: z.number().nullable(),
    populations: z.array(RawPopulation).nullable(),
  })
  .nullable();

const RawVariant = z
  .object({
    variant_id: z.string(),
    reference_genome: z.string(),
    rsids: z.array(z.string()).nullable(),
    flags: z.array(z.string()).nullable(),
    exome: RawSeqData,
    genome: RawSeqData,
    transcript_consequences: z
      .array(
        z.object({
          gene_symbol: z.string().nullable(),
          transcript_id: z.string().nullable(),
          major_consequence: z.string().nullable(),
        }),
      )
      .nullable(),
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

const VariantByRsidResponse = z.object({ variant: RawVariant });
const ClinVarOnlyResponse = z.object({ clinvar_variant: RawClinVar });
const VariantSearchResponse = z.object({
  variant_search: z.array(z.object({ variant_id: z.string() })),
});

const GraphqlEnvelope = z.object({
  data: z.unknown().optional(),
  errors: z
    .array(
      z.object({
        message: z.string(),
        path: z.array(z.union([z.string(), z.number()])).optional(),
      }),
    )
    .optional(),
});

const ConstraintMetrics = z.object({
  pli: z.number().min(0).max(1).nullable(),
  oe_lof: z.number().nonnegative().nullable(),
  oe_lof_lower: z.number().nonnegative().nullable(),
  oe_lof_upper: z.number().nonnegative().nullable(),
  oe_mis: z.number().nonnegative().nullable(),
  oe_syn: z.number().nonnegative().nullable(),
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

/** ExAC r0.3 constraint: pLI, Z-scores, and counts in the same domains — no ratios or flags. */
const ExacConstraintMetrics = ConstraintMetrics.omit({
  oe_lof: true,
  oe_lof_lower: true,
  oe_lof_upper: true,
  oe_mis: true,
  oe_syn: true,
  flags: true,
});

const ConstraintResponse = z.object({
  gene: z
    .object({
      gene_id: z.string(),
      symbol: z.string(),
      gnomad_constraint: z.unknown().nullable(),
      exac_constraint: z.unknown().nullable(),
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
  })
  .nullable();

const RawListVariant = z.object({
  variant_id: z.string(),
  consequence: z.string().nullable(),
  flags: z.array(z.string()).nullable(),
  exome: RawListSeqData,
  genome: RawListSeqData,
});

const RawFeatureVariants = z
  .object({ chrom: z.string(), variants: z.array(RawListVariant).nullable() })
  .nullable()
  .optional();

const VariantListResponse = z.object({
  gene: RawFeatureVariants,
  transcript: RawFeatureVariants,
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
    exome: z.array(RawCoverageBin).nullable(),
    genome: z.array(RawCoverageBin).nullable(),
  })
  .nullable();

const RawFeatureCoverage = z
  .object({ chrom: z.string(), coverage: RawCoverage })
  .nullable()
  .optional();

const CoverageResponse = z.object({
  gene: RawFeatureCoverage,
  transcript: RawFeatureCoverage,
  region: z.object({ coverage: RawCoverage }).nullable().optional(),
});

type RawListVariantT = z.infer<typeof RawListVariant>;
type RawCoverageBinT = z.infer<typeof RawCoverageBin>;

/** Classify a VEP consequence term into the four-bucket consequence class. */
const LOF_TERMS = new Set([
  'transcript_ablation',
  'splice_acceptor_variant',
  'splice_donor_variant',
  'stop_gained',
  'frameshift_variant',
  'stop_lost',
  'start_lost',
  'transcript_amplification',
]);

function classifyConsequence(term: string | null): ConsequenceClass {
  if (!term) return 'other';
  if (LOF_TERMS.has(term)) return 'lof';
  if (term === 'missense_variant') return 'missense';
  if (term === 'synonymous_variant') return 'synonymous';
  return 'other';
}

/** True when a GraphQL `data` payload holds an explicit null at the named root field. */
function isNullRoot(data: unknown, root: string): boolean {
  return typeof data === 'object' && data !== null && Reflect.get(data, root) === null;
}

/** AF from counts: ac/an, or null when an is 0/absent. */
function computeAf(ac: number | null | undefined, an: number | null | undefined): number | null {
  if (ac == null || an == null || an === 0) return null;
  return ac / an;
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

  /** Derive the effective dataset+build pair from a caller's choices, validating coherence. */
  resolveDatasetContext(
    dataset: Dataset | undefined,
    referenceGenome?: ReferenceGenome,
  ): DatasetContext {
    const ds = dataset ?? this.serverConfig.defaultDataset;
    const derived = refGenomeForDataset(ds);
    if (referenceGenome && referenceGenome !== derived) {
      throw validationError(
        `dataset ${ds} requires reference_genome ${derived}, not ${referenceGenome}. ` +
          `gnomAD v4/v3 are GRCh38; v2.1 and ExAC are GRCh37.`,
        {
          reason: 'incoherent_build',
          dataset: ds,
          expected: derived,
          supplied: referenceGenome,
        },
      );
    }
    return { dataset: ds, reference_genome: derived };
  }

  /** Simple semaphore gate — caps concurrent upstream calls for politeness. */
  private async acquireSlot(): Promise<void> {
    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active += 1;
  }

  private releaseSlot(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }

  /**
   * Execute a GraphQL document with retry + concurrency cap + typed validation.
   * `absentRoot` names a nullable root field whose null, beside only not-found
   * errors that are pathless or at that root, is absence rather than a failure —
   * for an operation whose `allowedErrorPath` turns off the generic not-found
   * fallback. `relayRegionRejections` marks an operation whose target gnomAD
   * can refuse as a bad or oversized region (the variant-list and coverage
   * queries), so those HTTP 500 messages reach the caller as its own error.
   */
  private graphql<T>(
    query: string,
    variables: Record<string, unknown>,
    schema: z.ZodType<T>,
    operation: string,
    ctx: Context,
    options?: {
      allowedErrorPath?: readonly (string | number)[];
      acceptPartialData?: (data: T) => boolean;
      onAllowedPartial?: () => void;
      absentRoot?: string;
      relayRegionRejections?: boolean;
    },
  ): Promise<T> {
    const reqCtx = requestContextService.createRequestContext({
      operation,
      parentContext: ctx,
    });
    return withRetry(
      async () => {
        await this.acquireSlot();
        try {
          // fetchWithTimeout throws a status-mapped McpError on non-2xx whose data
          // carries upstream internals (statusCode/responseBody/requestId/URL).
          // A region rejection relays gnomAD's message alone; everything else is
          // sanitized so none of that reaches the client. The typed
          // validation/not-found paths below raise their own clean errors.
          const response = await fetchWithTimeout(this.baseUrl, this.timeoutMs, reqCtx, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ query, variables }),
            signal: ctx.signal,
          }).catch((err: unknown) => {
            const rejection = options?.relayRegionRejections ? regionRejection(err) : undefined;
            if (rejection) throw rejection;
            return sanitizeUpstreamError(err, 'gnomAD');
          });
          const body = await readUpstreamJson(response, 'gnomAD', GraphqlEnvelope);
          let hasAllowedPartialErrors = false;
          if (body.errors?.length) {
            const message = body.errors.map((e) => e.message).join('; ');
            // On a nullable root (gene, transcript, variant) gnomAD reports load
            // shedding and rate limiting as GraphQL errors on an HTTP 200; retry those.
            if (body.errors.some((e) => TRANSIENT_GRAPHQL_MESSAGE.test(e.message))) {
              upstreamUnavailable(new Error(`gnomAD GraphQL error: ${message}`), 'gnomAD');
            }
            // gnomAD returns "<entity> not found" as a GraphQL error *alongside* a
            // valid `data` payload with the entity nulled (e.g. errors:["Gene not
            // found"] + data:{gene:null}). That is a not-found signal, not a fault —
            // fall through to parse so the entity surfaces as null and the caller's
            // typed not-found contract (gene_not_found / variant_not_found) fires.
            // Any other error (Invalid variant ID, Multiple variants found, …) is a
            // real failure and still throws.
            const allNotFound = body.errors.every((e) => NOT_FOUND_MESSAGE.test(e.message));
            const allAllowed =
              options?.allowedErrorPath != null &&
              body.errors.every((error) => {
                const path = error.path;
                const allowed = options.allowedErrorPath;
                if (!path || !allowed || path.length !== allowed.length) return false;
                return path.every((segment, index) => segment === allowed[index]);
              });
            const allowedPartial = allAllowed && body.data != null;
            const legacyNotFound =
              options?.allowedErrorPath == null && allNotFound && body.data != null;
            // gnomAD strips `path` from every error, so its "Variant not found"
            // arrives pathless beside `variant: null` — and beside whatever
            // `clinvar_variant` holds, since ClinVar may know a variant gnomAD lacks.
            const absentRoot = options?.absentRoot;
            const absent =
              absentRoot != null &&
              allNotFound &&
              body.errors.every(
                (error) =>
                  error.path == null || (error.path.length === 1 && error.path[0] === absentRoot),
              ) &&
              isNullRoot(body.data, absentRoot);
            if (allowedPartial) {
              hasAllowedPartialErrors = true;
            } else if (!legacyNotFound && !absent) {
              throw validationError(`gnomAD GraphQL error: ${message}`, {
                reason: 'graphql_error',
                retryable: false,
              });
            }
          }
          try {
            const data = schema.parse(body.data);
            if (hasAllowedPartialErrors) {
              if (!options?.acceptPartialData?.(data)) {
                throw validationError('gnomAD GraphQL error affected required response data.', {
                  reason: 'graphql_error',
                  retryable: false,
                });
              }
              options.onAllowedPartial?.();
            }
            return data;
          } catch (err) {
            if (err instanceof McpError) throw err;
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
      },
    );
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
   */
  async getVariant(
    idOrRsid: string,
    dsCtx: DatasetContext,
    ctx: Context,
  ): Promise<VariantRecord | null> {
    if (MITOCHONDRIAL_VARIANT_ID.test(idOrRsid)) {
      throw mitochondrialUnsupported(`Variant "${idOrRsid}"`);
    }
    if (RSID.test(idOrRsid)) {
      let resolved: z.infer<typeof VariantByRsidResponse>;
      try {
        resolved = await this.graphql(
          VARIANT_BY_RSID_QUERY,
          { rsid: idOrRsid, dataset: dsCtx.dataset },
          VariantByRsidResponse,
          'gnomad.getVariantByRsid',
          ctx,
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
          );
          candidates = search.variant_search.map((candidate) => candidate.variant_id);
        } catch (resolverError) {
          if (ctx.signal.aborted) throw resolverError;
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
      let clinvarUnavailable = false;
      const clinvar = await this.graphql(
        CLINVAR_BY_VARIANT_ID_QUERY,
        { variantId: resolved.variant.variant_id, referenceGenome: dsCtx.reference_genome },
        ClinVarOnlyResponse,
        'gnomad.getClinvar',
        ctx,
        {
          allowedErrorPath: ['clinvar_variant'],
          acceptPartialData: (data) => data.clinvar_variant === null,
          onAllowedPartial: () => {
            clinvarUnavailable = true;
          },
        },
      );
      return this.normalizeVariant(
        resolved.variant,
        clinvar.clinvar_variant,
        dsCtx,
        clinvarUnavailable,
      );
    }
    let clinvarUnavailable = false;
    const data = await this.graphql(
      VARIANT_QUERY,
      { variantId: idOrRsid, dataset: dsCtx.dataset, referenceGenome: dsCtx.reference_genome },
      VariantResponse,
      'gnomad.getVariant',
      ctx,
      {
        allowedErrorPath: ['clinvar_variant'],
        acceptPartialData: (response) =>
          response.variant !== null && response.clinvar_variant === null,
        onAllowedPartial: () => {
          clinvarUnavailable = true;
        },
        absentRoot: 'variant',
      },
    );
    if (!data.variant) return null;
    this.assertVariantBuild(data.variant, dsCtx);
    return this.normalizeVariant(data.variant, data.clinvar_variant, dsCtx, clinvarUnavailable);
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
    clinvar: z.infer<typeof RawClinVar>,
    dsCtx: DatasetContext,
    clinvarUnavailable = false,
  ): VariantRecord {
    const source: VariantRecord['source'] = [];
    const populations: PopulationFreq[] = [];
    let ac = 0;
    let an = 0;
    let hom = 0;
    let hemi: number | null = null;
    let hasAf = false;
    let afNumerator = 0;
    let afDenominator = 0;

    for (const [src, data] of [
      ['exome', v.exome],
      ['genome', v.genome],
    ] as const) {
      if (!data || data.ac == null) continue;
      source.push(src);
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
        if (!isCanonicalAncestry(p.id)) continue;
        populations.push({
          id: p.id,
          source: src,
          ac: p.ac ?? 0,
          an: p.an ?? 0,
          af: computeAf(p.ac, p.an),
          homozygote_count: p.homozygote_count ?? 0,
          hemizygote_count: p.hemizygote_count,
        });
      }
    }

    const tc = v.transcript_consequences?.[0];
    return {
      variant_id: v.variant_id,
      rsids: v.rsids ?? [],
      reference_genome: dsCtx.reference_genome,
      dataset: dsCtx.dataset,
      ac,
      an,
      af: hasAf ? afNumerator / afDenominator : null,
      homozygote_count: hom,
      hemizygote_count: hemi,
      populations,
      source,
      flags: v.flags ?? [],
      consequence: tc?.major_consequence ?? null,
      transcript_id: tc?.transcript_id ?? null,
      gene_symbol: tc?.gene_symbol ?? null,
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
      clinvar_unavailable: clinvarUnavailable,
    };
  }

  /**
   * Fetch gene loss-of-function constraint by symbol or Ensembl gene ID. gnomAD
   * picks the table by build alone, so exac reads gene.exac_constraint beside
   * the GRCh37 gnomAD table, and every result names its constraint release.
   */
  async getGeneConstraint(
    gene: string,
    dsCtx: DatasetContext,
    ctx: Context,
  ): Promise<GeneConstraint | null> {
    const byId = ENSEMBL_GENE_ID.test(gene);
    const data = await this.graphql(
      byId ? GENE_CONSTRAINT_BY_ID_QUERY : GENE_CONSTRAINT_BY_SYMBOL_QUERY,
      { gene, referenceGenome: dsCtx.reference_genome },
      ConstraintResponse,
      'gnomad.getGeneConstraint',
      ctx,
    );
    if (!data.gene) return null;
    const c: Partial<z.infer<typeof ConstraintMetrics>> | null =
      dsCtx.dataset === 'exac'
        ? parseConstraint(ExacConstraintMetrics, data.gene.exac_constraint)
        : parseConstraint(ConstraintMetrics, data.gene.gnomad_constraint);
    return {
      gene_id: data.gene.gene_id,
      symbol: data.gene.symbol,
      dataset: dsCtx.dataset,
      reference_genome: dsCtx.reference_genome,
      constraint_release: CONSTRAINT_RELEASE[dsCtx.dataset],
      pli: c?.pli ?? null,
      oe_lof: c?.oe_lof ?? null,
      oe_lof_lower: c?.oe_lof_lower ?? null,
      oe_lof_upper: c?.oe_lof_upper ?? null,
      oe_mis: c?.oe_mis ?? null,
      oe_syn: c?.oe_syn ?? null,
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
    };
  }

  /**
   * List variants in a gene / transcript / region, filtered by consequence class
   * and max-AF. Returns the full normalized row set (the handler spills it).
   */
  async listGeneVariants(
    target: GenomeTarget,
    filters: { consequenceClass?: ConsequenceClass | undefined; maxAf?: number | undefined },
    dsCtx: DatasetContext,
    ctx: Context,
  ): Promise<GeneVariantRow[]> {
    const { query, variables } = this.buildTargetQuery(target, dsCtx, 'variants');
    const data = await this.graphql(
      query,
      variables,
      VariantListResponse,
      'gnomad.listGeneVariants',
      ctx,
      { relayRegionRejections: true },
    );
    assertNuclearFeature(target, data.gene ?? data.transcript);
    const raw = (data.gene ?? data.transcript ?? data.region)?.variants ?? [];
    const rows = raw.map((r) => this.normalizeListVariant(r));
    return rows.filter((row) => {
      if (filters.consequenceClass && row.consequence_class !== filters.consequenceClass)
        return false;
      if (filters.maxAf != null && row.af != null && row.af > filters.maxAf) return false;
      return true;
    });
  }

  private normalizeListVariant(r: RawListVariantT): GeneVariantRow {
    const exome = r.exome;
    const genome = r.genome;
    const ac = (exome?.ac ?? 0) + (genome?.ac ?? 0);
    // Joint frequency over the carried callsets: sum ac and an across exome +
    // genome, then af = ac/an — matching normalizeVariant(). The per-callset
    // upstream af describes one callset only, so it must not stand in for the
    // joint frequency: an exome-only af on a dual-callset row understates it and
    // would make max_af filter on the wrong number.
    const an = (exome?.an ?? 0) + (genome?.an ?? 0);
    const af = computeAf(ac, an);
    const source: string[] = [];
    if (exome?.ac != null) source.push('exome');
    if (genome?.ac != null) source.push('genome');
    return {
      variant_id: r.variant_id,
      af,
      ac,
      an,
      consequence: r.consequence,
      consequence_class: classifyConsequence(r.consequence),
      homozygote_count: (exome?.homozygote_count ?? 0) + (genome?.homozygote_count ?? 0),
      source: source.join('|'),
      flags: (r.flags ?? []).join('|'),
    };
  }

  /** Fetch sequencing coverage summary for a target, per callset source. */
  async getCoverage(
    target: GenomeTarget,
    dsCtx: DatasetContext,
    ctx: Context,
  ): Promise<CoverageSummary[]> {
    const { query, variables, regionBounds } = this.buildTargetQuery(target, dsCtx, 'coverage');
    const data = await this.graphql(query, variables, CoverageResponse, 'gnomad.getCoverage', ctx, {
      relayRegionRejections: true,
    });
    assertNuclearFeature(target, data.gene ?? data.transcript);
    const cov = (data.gene ?? data.transcript ?? data.region)?.coverage;
    const summaries: CoverageSummary[] = [];
    for (const [src, rawBins] of [
      ['exome', cov?.exome],
      ['genome', cov?.genome],
    ] as const) {
      if (!rawBins || rawBins.length === 0) continue;
      // gnomAD pads a region(...) query to a fixed ~151 bp window centered on the
      // request, so region coverage bins include ±~75 bp of neighboring bases.
      // Bound them to the requested start..stop so the summary describes exactly
      // the requested span (a single-position region → one bin). Gene and
      // transcript bins are the intended whole-feature set and pass through as-is.
      const bins = regionBounds
        ? rawBins.filter(
            (b) => b.pos != null && b.pos >= regionBounds.start && b.pos <= regionBounds.stop,
          )
        : rawBins;
      if (bins.length === 0) continue;
      summaries.push(this.summarizeCoverage(src, bins));
    }
    return summaries;
  }

  private summarizeCoverage(source: 'exome' | 'genome', bins: RawCoverageBinT[]): CoverageSummary {
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
      positions: bins.length,
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
   * region targets, also returns the parsed `regionBounds` so callers can bound
   * the padded window gnomAD returns (see getCoverage); absent for gene/transcript.
   */
  private buildTargetQuery(
    target: GenomeTarget,
    dsCtx: DatasetContext,
    kind: 'variants' | 'coverage',
  ): {
    query: string;
    variables: Record<string, unknown>;
    regionBounds?: { start: number; stop: number };
  } {
    const base = { dataset: dsCtx.dataset, referenceGenome: dsCtx.reference_genome };
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
