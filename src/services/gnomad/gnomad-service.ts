/**
 * @fileoverview gnomAD GraphQL service — owns the parameterized query documents,
 * dataset→reference_genome derivation and pair validation, a politeness
 * concurrency cap, withRetry backoff over the full fetch+parse pipeline, and
 * typed-response validation. Handlers stay pure and throw; this service wraps the
 * upstream so transient 429/5xx surface as ServiceUnavailable, not parse errors.
 * @module services/gnomad/gnomad-service
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { serviceUnavailable, validationError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, requestContextService, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig, type ServerConfig } from '@/config/server-config.js';
import { sanitizeUpstreamError } from '@/services/upstream-error.js';
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
} from './queries.js';
import {
  type ConsequenceClass,
  type CoverageSummary,
  type Dataset,
  type GeneConstraint,
  type GeneVariantRow,
  type GenomeTarget,
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

/** v4/v3 are GRCh38; v2.1 and ExAC are GRCh37. */
function refGenomeForDataset(dataset: Dataset): ReferenceGenome {
  return dataset === 'gnomad_r2_1' || dataset === 'exac' ? 'GRCh37' : 'GRCh38';
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

const RawConstraint = z
  .object({
    pli: z.number().nullable(),
    oe_lof: z.number().nullable(),
    oe_lof_lower: z.number().nullable(),
    oe_lof_upper: z.number().nullable(),
    oe_mis: z.number().nullable(),
    oe_syn: z.number().nullable(),
    lof_z: z.number().nullable(),
    mis_z: z.number().nullable(),
    syn_z: z.number().nullable(),
    obs_lof: z.number().nullable(),
    exp_lof: z.number().nullable(),
    obs_mis: z.number().nullable(),
    exp_mis: z.number().nullable(),
    obs_syn: z.number().nullable(),
    exp_syn: z.number().nullable(),
    flags: z.array(z.string()).nullable(),
  })
  .nullable();

const ConstraintResponse = z.object({
  gene: z
    .object({
      gene_id: z.string(),
      symbol: z.string(),
      gnomad_constraint: RawConstraint,
    })
    .nullable(),
});

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

const VariantListResponse = z.object({
  gene: z
    .object({ variants: z.array(RawListVariant).nullable() })
    .nullable()
    .optional(),
  transcript: z
    .object({ variants: z.array(RawListVariant).nullable() })
    .nullable()
    .optional(),
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

const CoverageResponse = z.object({
  gene: z.object({ coverage: RawCoverage }).nullable().optional(),
  transcript: z.object({ coverage: RawCoverage }).nullable().optional(),
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

/** AF from counts: ac/an, or null when an is 0/absent. */
function computeAf(ac: number | null | undefined, an: number | null | undefined): number | null {
  if (ac == null || an == null || an === 0) return null;
  return ac / an;
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
        { reason: 'incoherent_build', dataset: ds, expected: derived, supplied: referenceGenome },
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

  /** Execute a GraphQL document with retry + concurrency cap + typed validation. */
  private graphql<T>(
    query: string,
    variables: Record<string, unknown>,
    schema: z.ZodType<T>,
    operation: string,
    ctx: Context,
  ): Promise<T> {
    const reqCtx = requestContextService.createRequestContext({
      operation,
      parentContext: { requestId: ctx.requestId, traceId: ctx.traceId },
    });
    return withRetry(
      async () => {
        await this.acquireSlot();
        try {
          // fetchWithTimeout throws a status-mapped McpError on non-2xx whose data
          // carries upstream internals (statusCode/responseBody/requestId/URL).
          // Sanitize it here so none of that reaches the client; the typed
          // validation/not-found paths below raise their own clean errors.
          const response = await fetchWithTimeout(this.baseUrl, this.timeoutMs, reqCtx, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ query, variables }),
            signal: ctx.signal,
          }).catch((err: unknown) =>
            sanitizeUpstreamError(
              err,
              'gnomAD',
              'gnomAD is degraded or throttling; wait a few seconds and retry. gnomAD is a community-funded API — keep request volume low.',
            ),
          );
          const text = await response.text();
          if (/^\s*<(!doctype\s+html|html[\s>])/i.test(text)) {
            throw serviceUnavailable('gnomAD returned HTML instead of JSON — likely rate-limited.');
          }
          const body = JSON.parse(text) as { data?: unknown; errors?: Array<{ message: string }> };
          if (body.errors?.length) {
            const message = body.errors.map((e) => e.message).join('; ');
            // gnomAD reports rate limiting as a GraphQL error; treat that one as transient.
            if (/rate.?limit|too many requests/i.test(message)) {
              throw serviceUnavailable(`gnomAD rate limit: ${message}`);
            }
            // gnomAD returns "<entity> not found" as a GraphQL error *alongside* a
            // valid `data` payload with the entity nulled (e.g. errors:["Gene not
            // found"] + data:{gene:null}). That is a not-found signal, not a fault —
            // fall through to parse so the entity surfaces as null and the caller's
            // typed not-found contract (gene_not_found / variant_not_found) fires.
            // Any other error (Invalid variant ID, Multiple variants found, …) is a
            // real failure and still throws.
            const allNotFound = body.errors.every((e) => /\bnot found\b/i.test(e.message));
            if (!(allNotFound && body.data != null)) {
              throw validationError(`gnomAD GraphQL error: ${message}`, {
                reason: 'graphql_error',
                retryable: false,
              });
            }
          }
          return schema.parse(body.data);
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
   * GraphQL error (a per-item failure for the batch handler).
   */
  async getVariant(
    idOrRsid: string,
    dsCtx: DatasetContext,
    ctx: Context,
  ): Promise<VariantRecord | null> {
    if (RSID.test(idOrRsid)) {
      const resolved = await this.graphql(
        VARIANT_BY_RSID_QUERY,
        { rsid: idOrRsid, dataset: dsCtx.dataset },
        VariantByRsidResponse,
        'gnomad.getVariantByRsid',
        ctx,
      );
      if (!resolved.variant) return null;
      const clinvar = await this.graphql(
        CLINVAR_BY_VARIANT_ID_QUERY,
        { variantId: resolved.variant.variant_id, referenceGenome: dsCtx.reference_genome },
        ClinVarOnlyResponse,
        'gnomad.getClinvar',
        ctx,
      );
      return this.normalizeVariant(resolved.variant, clinvar.clinvar_variant, dsCtx);
    }
    const data = await this.graphql(
      VARIANT_QUERY,
      { variantId: idOrRsid, dataset: dsCtx.dataset, referenceGenome: dsCtx.reference_genome },
      VariantResponse,
      'gnomad.getVariant',
      ctx,
    );
    if (!data.variant) return null;
    return this.normalizeVariant(data.variant, data.clinvar_variant, dsCtx);
  }

  private normalizeVariant(
    v: NonNullable<z.infer<typeof RawVariant>>,
    clinvar: z.infer<typeof RawClinVar>,
    dsCtx: DatasetContext,
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
        value: p.value != null && p.value !== '' ? Number(p.value) : null,
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
    };
  }

  /** Fetch gene loss-of-function constraint by symbol or Ensembl gene ID. */
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
    const c = data.gene.gnomad_constraint;
    return {
      gene_id: data.gene.gene_id,
      symbol: data.gene.symbol,
      dataset: dsCtx.dataset,
      reference_genome: dsCtx.reference_genome,
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
    );
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
    const an = Math.max(exome?.an ?? 0, genome?.an ?? 0);
    // Prefer upstream af; fall back to the joint ac/an when both carry counts.
    const af = exome?.af ?? genome?.af ?? computeAf(ac, an);
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
    const { query, variables } = this.buildTargetQuery(target, dsCtx, 'coverage');
    const data = await this.graphql(query, variables, CoverageResponse, 'gnomad.getCoverage', ctx);
    const cov = (data.gene ?? data.transcript ?? data.region)?.coverage;
    const summaries: CoverageSummary[] = [];
    for (const [src, bins] of [
      ['exome', cov?.exome],
      ['genome', cov?.genome],
    ] as const) {
      if (!bins || bins.length === 0) continue;
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

  /** Build the right query + variables for a gene/transcript/region target. */
  private buildTargetQuery(
    target: GenomeTarget,
    dsCtx: DatasetContext,
    kind: 'variants' | 'coverage',
  ): { query: string; variables: Record<string, unknown> } {
    const base = { dataset: dsCtx.dataset, referenceGenome: dsCtx.reference_genome };
    if (target.kind === 'transcript') {
      return {
        query: kind === 'variants' ? TRANSCRIPT_VARIANTS_QUERY : TRANSCRIPT_COVERAGE_QUERY,
        variables: { transcriptId: target.value, ...base },
      };
    }
    if (target.kind === 'region') {
      const m = /^([0-9XYM]+)-(\d+)-(\d+)$/.exec(target.value);
      if (!m) {
        throw validationError(
          `Invalid region "${target.value}". Expected chrom-start-stop, e.g. 1-55039447-55064852.`,
          {
            reason: 'invalid_region',
          },
        );
      }
      return {
        query: kind === 'variants' ? REGION_VARIANTS_QUERY : REGION_COVERAGE_QUERY,
        variables: { chrom: m[1], start: Number(m[2]), stop: Number(m[3]), ...base },
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
