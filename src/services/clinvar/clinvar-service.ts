/**
 * @fileoverview Optional ClinVar service over NCBI E-utilities (esearch →
 * esummary). Honors NCBI_API_KEY, paces to the keyless/keyed rate limit, and
 * backs off on transient failures. Powers gnomad_search_clinvar — gene-level
 * curation depth beyond the per-variant join gnomAD provides.
 * @module services/clinvar/clinvar-service
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, requestContextService, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig, type ServerConfig } from '@/config/server-config.js';
import { invalidUpstreamResponse, sanitizeUpstreamError } from '@/services/upstream-error.js';
import type { ClinVarFilters, ClinVarRow, ClinVarSearchResult } from './types.js';

/** ClinVar review-status text → gold-star rating (the standard convention). */
const REVIEW_STATUS_STARS: Record<string, number> = {
  'practice guideline': 4,
  'reviewed by expert panel': 3,
  'criteria provided, multiple submitters, no conflicts': 2,
  'criteria provided, conflicting classifications': 1,
  'criteria provided, conflicting interpretations': 1,
  'criteria provided, single submitter': 1,
  'no assertion criteria provided': 0,
  'no assertion provided': 0,
  'no classification provided': 0,
  'no classifications from unflagged records': 0,
};

function starsForReviewStatus(status: string | null | undefined): number {
  if (!status) return 0;
  return REVIEW_STATUS_STARS[status.toLowerCase().trim()] ?? 0;
}

/**
 * Whole-word, case-insensitive classification match. A `pathogenic` query keeps
 * "Pathogenic", "Likely pathogenic", and "Pathogenic/Likely pathogenic" but not
 * "Conflicting classifications of pathogenicity" — the word boundary stops the
 * query from matching inside "pathogenicity". `requested` is already
 * normalized by normalizeSignificance().
 */
function matchesSignificance(value: string | null, requested: string): boolean {
  if (!value) return false;
  const escaped = requested.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(value);
}

/**
 * The clinical-significance filter as both the ESearch term and the post-fetch
 * filter use it: `"` dropped (the term quotes the phrase itself), underscores
 * read as spaces so the documented `likely_pathogenic` form works, trimmed.
 * Blank after that means no filter — form clients send `""` or whitespace for
 * an untouched field.
 */
export function normalizeSignificance(value: string | undefined): string | undefined {
  const normalized = value?.replace(/"/g, '').replace(/_/g, ' ').trim();
  return normalized ? normalized : undefined;
}

/**
 * Build the ESearch term. The gene goes out as a quoted phrase, so query
 * syntax in it — parentheses, brackets, a trailing `OR` — stays inside the
 * `[gene]` field instead of detaching the tag and searching all fields. NCBI
 * rewrites the `[clinical_significance]` tag to `[All Fields]`, where an
 * unquoted multi-word phrase matches nothing, so the significance goes out
 * quoted too. The star floor goes out as an OR of the exact review-status
 * values at or above it; a floor of 0 admits every status, including ones the
 * star map does not know, so it adds no clause. Both filter clauses only
 * narrow the candidate set — the post-fetch filters in searchGene() stay
 * authoritative. `symbol` and `significance` arrive with `"` already removed.
 */
function buildEsearchTerm(
  symbol: string,
  significance: string | undefined,
  minReviewStars: number | undefined,
): string {
  const clauses = [`"${symbol}"[gene]`];
  if (significance) clauses.push(`"${significance}"[clinical_significance]`);
  if (minReviewStars != null && minReviewStars > 0) {
    const statuses = Object.entries(REVIEW_STATUS_STARS)
      .filter(([, stars]) => stars >= minReviewStars)
      .map(([status]) => `"${status}"[Review status]`);
    clauses.push(`(${statuses.join(' OR ')})`);
  }
  return clauses.join(' AND ');
}

/** GRCh38 chromosome RefSeq accessions (GRCh38.p14 assembly report) → gnomAD chrom. */
const GRCH38_CHROM_BY_ACCESSION: Record<string, string> = {
  'NC_000001.11': '1',
  'NC_000002.12': '2',
  'NC_000003.12': '3',
  'NC_000004.12': '4',
  'NC_000005.10': '5',
  'NC_000006.12': '6',
  'NC_000007.14': '7',
  'NC_000008.11': '8',
  'NC_000009.12': '9',
  'NC_000010.11': '10',
  'NC_000011.10': '11',
  'NC_000012.12': '12',
  'NC_000013.11': '13',
  'NC_000014.9': '14',
  'NC_000015.10': '15',
  'NC_000016.10': '16',
  'NC_000017.11': '17',
  'NC_000018.10': '18',
  'NC_000019.10': '19',
  'NC_000020.11': '20',
  'NC_000021.9': '21',
  'NC_000022.11': '22',
  'NC_000023.11': 'X',
  'NC_000024.10': 'Y',
};

const SPDI = /^([^:]+):(\d+):([ACGT]*):([ACGT]*)$/;

/**
 * Derive a gnomAD `chrom-pos-ref-alt` ID from a canonical SPDI (0-based
 * position). Only unanchored changes map one-to-one: both alleles non-empty and
 * differing at their first and last base (SNVs, MNVs, delins). Canonical SPDI
 * repeat-expands deletions, insertions, and duplications and drops the VCF
 * anchor base, and mitochondrial and non-GRCh38 accessions have no gnomAD ID
 * here — all of those return null.
 */
function grch38VariantId(spdi: string | null): string | null {
  const match = spdi ? SPDI.exec(spdi) : null;
  if (!match) return null;
  const [, accession = '', position = '', deleted = '', inserted = ''] = match;
  const chrom = GRCH38_CHROM_BY_ACCESSION[accession];
  if (!chrom || !deleted || !inserted) return null;
  if (deleted[0] === inserted[0] || deleted.at(-1) === inserted.at(-1)) return null;
  return `${chrom}-${Number(position) + 1}-${deleted}-${inserted}`;
}

/** Default and maximum ESearch window, in candidate VariationIDs. */
export const CLINVAR_WINDOW_MAX = 500;
/** Largest ESearch `retstart` NCBI accepts (signed 32-bit); past it ESearch answers 200 with an empty body. */
export const CLINVAR_OFFSET_MAX = 2_147_483_647;
/** esummary batch size per request. */
const SUMMARY_BATCH = 50;
/** Recovery hint for a sanitized NCBI upstream failure — no internal detail. */
const NCBI_RETRY_HINT =
  'NCBI is degraded or throttling; wait a few seconds and retry, or set NCBI_API_KEY for a higher rate limit.';

const EsearchResponse = z.object({
  esearchresult: z.object({
    idlist: z.array(z.string()).default([]),
    count: z
      .string()
      .regex(/^\d+$/)
      .transform((c) => Number.parseInt(c, 10)),
  }),
});

const EsummaryResponse = z.object({
  result: z.object({ uids: z.array(z.string()) }).catchall(z.unknown()),
});

const ClassificationSchema = z
  .object({
    description: z.string().nullable().optional(),
    review_status: z.string().nullable().optional(),
    last_evaluated: z.string().nullable().optional(),
    trait_set: z
      .array(z.object({ trait_name: z.string().nullable().optional() }).passthrough())
      .nullable()
      .optional(),
  })
  .passthrough();

const EsummaryRecord = z
  .object({
    uid: z.string(),
    accession: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    obj_type: z.string().nullable().optional(),
    protein_change: z.string().nullable().optional(),
    molecular_consequence_list: z.array(z.string()).nullable().optional(),
    germline_classification: ClassificationSchema.nullable().optional(),
    variation_set: z
      .array(
        z
          .object({
            canonical_spdi: z.string().nullable().optional(),
            variation_xrefs: z
              .array(
                z
                  .object({
                    db_source: z.string().nullable().optional(),
                    db_id: z.string().nullable().optional(),
                  })
                  .passthrough(),
              )
              .nullable()
              .optional(),
          })
          .passthrough(),
      )
      .nullable()
      .optional(),
    supporting_submissions: z
      .object({
        scv: z.array(z.string()).nullable().optional(),
        rcv: z.array(z.string()).nullable().optional(),
      })
      .nullable()
      .optional(),
  })
  .passthrough();

export class ClinVarService {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly requestIntervalMs: number;
  private nextRequestAt = 0;
  private rateTail: Promise<void> = Promise.resolve();

  constructor(serverConfig: ServerConfig) {
    this.baseUrl = serverConfig.clinvarBaseUrl;
    if (serverConfig.ncbiApiKey) this.apiKey = serverConfig.ncbiApiKey;
    this.timeoutMs = serverConfig.requestTimeoutMs;
    this.requestIntervalMs = Math.ceil(1000 / (this.apiKey ? 10 : 3));
  }

  /** Serialize request starts at NCBI's process-shared keyed/keyless rate. */
  private async waitForRateLimit(signal: AbortSignal): Promise<void> {
    const previous = this.rateTail;
    const turn = previous.then(async () => {
      if (signal.aborted) throw signal.reason ?? new Error('Request aborted');
      const delay = Math.max(0, this.nextRequestAt - Date.now());
      if (delay > 0) {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason ?? new Error('Request aborted'));
          };
          const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          }, delay);
          signal.addEventListener('abort', onAbort, { once: true });
        });
      }
      if (signal.aborted) throw signal.reason ?? new Error('Request aborted');
      this.nextRequestAt = Date.now() + this.requestIntervalMs;
    });
    this.rateTail = turn.catch(() => {});

    if (signal.aborted) throw signal.reason ?? new Error('Request aborted');
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(signal.reason ?? new Error('Request aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      void turn.then(
        () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        },
        (err: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    });
  }

  private withKey(url: URL): URL {
    if (this.apiKey) url.searchParams.set('api_key', this.apiKey);
    return url;
  }

  /**
   * Search one window of ClinVar candidates for a gene. `offset`/`limit` page
   * the ESearch ID list; the significance and star filters then narrow the
   * window's rows, so a window can hold fewer rows than `limit`.
   */
  async searchGene(
    gene: string,
    filters: ClinVarFilters,
    ctx: Context,
  ): Promise<ClinVarSearchResult> {
    const offset = filters.offset ?? 0;
    const limit = filters.limit ?? CLINVAR_WINDOW_MAX;
    const significance = normalizeSignificance(filters.clinicalSignificance);
    /**
     * NCBI ignores an empty quoted phrase and falls back to searching every
     * field for "gene" — all of ClinVar — so a gene of nothing but quotes and
     * whitespace matches no record, without a request.
     */
    const symbol = gene.replace(/"/g, '').trim();
    if (!symbol) {
      return { rows: [], totalFound: 0, truncated: false, nextOffset: null, unavailableIds: [] };
    }
    const term = buildEsearchTerm(symbol, significance, filters.minReviewStars);
    const { ids, count } = await this.esearch(term, offset, limit, ctx);

    const rows: ClinVarRow[] = [];
    const unavailableIds: string[] = [];
    for (let i = 0; i < ids.length; i += SUMMARY_BATCH) {
      if (ctx.signal.aborted) break;
      const batch = await this.esummary(ids.slice(i, i + SUMMARY_BATCH), ctx);
      rows.push(...batch.rows);
      unavailableIds.push(...batch.unavailable);
    }
    // The ESearch clauses only narrow the candidate set — the significance
    // phrase matches across all fields, so a pathogenic query still leaks
    // "Benign"/"Uncertain significance"/"Conflicting…" rows. Both filters are
    // enforced here, post-fetch, and compose when both are set.
    let filtered = rows;
    if (significance) {
      filtered = filtered.filter((r) => matchesSignificance(r.clinical_significance, significance));
    }
    if (filters.minReviewStars != null) {
      const floor = filters.minReviewStars;
      filtered = filtered.filter((r) => r.gold_stars >= floor);
    }
    const truncated = offset + limit < count;
    return {
      rows: filtered,
      totalFound: count,
      truncated,
      nextOffset: truncated ? offset + limit : null,
      unavailableIds,
    };
  }

  private esearch(
    term: string,
    offset: number,
    limit: number,
    ctx: Context,
  ): Promise<{ ids: string[]; count: number }> {
    const reqCtx = requestContextService.createRequestContext({
      operation: 'clinvar.esearch',
      parentContext: ctx,
    });
    const url = this.withKey(new URL(`${this.baseUrl}/esearch.fcgi`));
    url.searchParams.set('db', 'clinvar');
    url.searchParams.set('term', term);
    url.searchParams.set('retmode', 'json');
    url.searchParams.set('retstart', String(offset));
    url.searchParams.set('retmax', String(limit));

    return withRetry(
      async () => {
        await this.waitForRateLimit(ctx.signal);
        // Sanitize the framework HTTP error so an NCBI non-2xx/network failure
        // can't leak its URL/status/body/requestId to the client.
        const response = await fetchWithTimeout(url, this.timeoutMs, reqCtx, {
          signal: ctx.signal,
        }).catch((err: unknown) => sanitizeUpstreamError(err, 'NCBI ClinVar', NCBI_RETRY_HINT));
        const text = await response.text();
        if (/^\s*<(!doctype\s+html|html[\s>])/i.test(text)) {
          invalidUpstreamResponse(
            new Error('NCBI returned HTML instead of JSON.'),
            'NCBI ClinVar',
            NCBI_RETRY_HINT,
          );
        }
        try {
          const { idlist, count } = EsearchResponse.parse(JSON.parse(text)).esearchresult;
          return { ids: idlist, count };
        } catch (err) {
          invalidUpstreamResponse(err, 'NCBI ClinVar', NCBI_RETRY_HINT);
        }
      },
      { operation: 'clinvar.esearch', context: reqCtx, baseDelayMs: 1000, signal: ctx.signal },
    );
  }

  /**
   * Summarize one batch of VariationIDs. A requested ID that ESummary answers
   * with an `error` entry, or leaves out of `result`, yields no row and is
   * reported in `unavailable` instead.
   */
  private esummary(
    ids: string[],
    ctx: Context,
  ): Promise<{ rows: ClinVarRow[]; unavailable: string[] }> {
    const reqCtx = requestContextService.createRequestContext({
      operation: 'clinvar.esummary',
      parentContext: ctx,
    });
    const url = this.withKey(new URL(`${this.baseUrl}/esummary.fcgi`));
    url.searchParams.set('db', 'clinvar');
    url.searchParams.set('id', ids.join(','));
    url.searchParams.set('retmode', 'json');

    return withRetry(
      async () => {
        await this.waitForRateLimit(ctx.signal);
        // Sanitize the framework HTTP error so an NCBI non-2xx/network failure
        // can't leak its URL/status/body/requestId to the client.
        const response = await fetchWithTimeout(url, this.timeoutMs, reqCtx, {
          signal: ctx.signal,
        }).catch((err: unknown) => sanitizeUpstreamError(err, 'NCBI ClinVar', NCBI_RETRY_HINT));
        const text = await response.text();
        if (/^\s*<(!doctype\s+html|html[\s>])/i.test(text)) {
          invalidUpstreamResponse(
            new Error('NCBI returned HTML instead of JSON.'),
            'NCBI ClinVar',
            NCBI_RETRY_HINT,
          );
        }
        let result: z.infer<typeof EsummaryResponse>['result'];
        try {
          result = EsummaryResponse.parse(JSON.parse(text)).result;
        } catch (err) {
          invalidUpstreamResponse(err, 'NCBI ClinVar', NCBI_RETRY_HINT);
        }
        const rows: ClinVarRow[] = [];
        const unavailable: string[] = [];
        try {
          for (const id of ids) {
            const raw = result[id] as { error?: unknown } | null | undefined;
            if (raw == null || (typeof raw.error === 'string' && raw.error !== '')) {
              unavailable.push(id);
              continue;
            }
            rows.push(this.normalize(EsummaryRecord.parse(raw)));
          }
        } catch (err) {
          invalidUpstreamResponse(err, 'NCBI ClinVar', NCBI_RETRY_HINT);
        }
        return { rows, unavailable };
      },
      { operation: 'clinvar.esummary', context: reqCtx, baseDelayMs: 1000, signal: ctx.signal },
    );
  }

  private normalize(r: z.infer<typeof EsummaryRecord>): ClinVarRow {
    const cls = r.germline_classification ?? undefined;
    const conditions = (cls?.trait_set ?? [])
      .map((t) => (t as { trait_name?: string | null }).trait_name)
      .filter((n): n is string => n != null && n !== '')
      .join('; ');
    const scv = r.supporting_submissions?.scv ?? [];
    // Identifiers describe one allele: multi-allele records (haplotypes,
    // compound genotypes) carry no single SPDI or rsID set, so they stay empty.
    const allele = r.variation_set?.length === 1 ? r.variation_set[0] : undefined;
    const canonicalSpdi = allele?.canonical_spdi || null;
    const rsids = new Set<string>();
    for (const xref of allele?.variation_xrefs ?? []) {
      if (xref.db_source === 'dbSNP' && xref.db_id && /^\d+$/.test(xref.db_id)) {
        rsids.add(`rs${xref.db_id}`);
      }
    }
    return {
      clinvar_variation_id: r.uid,
      accession: r.accession ?? '',
      title: r.title ?? '',
      obj_type: r.obj_type ?? '',
      clinical_significance: cls?.description ?? null,
      review_status: cls?.review_status ?? null,
      gold_stars: starsForReviewStatus(cls?.review_status),
      last_evaluated: cls?.last_evaluated ?? null,
      molecular_consequences: (r.molecular_consequence_list ?? []).join('; '),
      protein_change: r.protein_change ?? '',
      conditions,
      submission_count: scv.length,
      canonical_spdi: canonicalSpdi,
      rsids: [...rsids].join(';'),
      grch38_variant_id: grch38VariantId(canonicalSpdi),
    };
  }
}

// --- Init/accessor pattern ---

let _service: ClinVarService | undefined;

export function initClinVarService(_config: AppConfig, _storage: StorageService): void {
  _service = new ClinVarService(getServerConfig());
}

export function getClinVarService(): ClinVarService {
  if (!_service) {
    throw new Error('ClinVarService not initialized — call initClinVarService() in setup()');
  }
  return _service;
}
