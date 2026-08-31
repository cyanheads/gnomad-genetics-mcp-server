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
import type { ClinVarFilters, ClinVarRow } from './types.js';

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
 * query from matching inside "pathogenicity". Underscores in the query are read
 * as spaces so the documented `likely_pathogenic` form works.
 */
function matchesSignificance(value: string | null, requested: string): boolean {
  if (!value) return false;
  const term = requested.trim().replace(/_/g, ' ');
  if (!term) return true;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(value);
}

/** Cap on records pulled per gene search — politeness + bounded canvas size. */
const MAX_RECORDS = 500;
/** esummary batch size per request. */
const SUMMARY_BATCH = 50;
/** Recovery hint for a sanitized NCBI upstream failure — no internal detail. */
const NCBI_RETRY_HINT =
  'NCBI is degraded or throttling; wait a few seconds and retry, or set NCBI_API_KEY for a higher rate limit.';

const EsearchResponse = z.object({
  esearchresult: z.object({
    idlist: z.array(z.string()).default([]),
    count: z.string().optional(),
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

  /** Search ClinVar for a gene, returning normalized rows (the handler spills them). */
  async searchGene(gene: string, filters: ClinVarFilters, ctx: Context): Promise<ClinVarRow[]> {
    const ids = await this.esearch(gene.trim(), filters.clinicalSignificance, ctx);
    if (ids.length === 0) return [];
    const rows: ClinVarRow[] = [];
    for (let i = 0; i < ids.length; i += SUMMARY_BATCH) {
      if (ctx.signal.aborted) break;
      const batch = ids.slice(i, i + SUMMARY_BATCH);
      rows.push(...(await this.esummary(batch, ctx)));
    }
    // NCBI's [clinical_significance] field tag matches broadly — a pathogenic
    // query leaks "Benign"/"Uncertain significance"/"Conflicting…" rows — so the
    // classification filter is enforced here, post-fetch. Both filters compose:
    // the significance term and the star floor each narrow the set when set.
    let filtered = rows;
    if (filters.clinicalSignificance) {
      const sig = filters.clinicalSignificance;
      filtered = filtered.filter((r) => matchesSignificance(r.clinical_significance, sig));
    }
    if (filters.minReviewStars != null) {
      const floor = filters.minReviewStars;
      filtered = filtered.filter((r) => r.gold_stars >= floor);
    }
    return filtered;
  }

  private esearch(
    gene: string,
    clinicalSignificance: string | undefined,
    ctx: Context,
  ): Promise<string[]> {
    const reqCtx = requestContextService.createRequestContext({
      operation: 'clinvar.esearch',
      parentContext: ctx,
    });
    let term = `${gene}[gene]`;
    if (clinicalSignificance) term += ` AND ${clinicalSignificance}[clinical_significance]`;
    const url = this.withKey(new URL(`${this.baseUrl}/esearch.fcgi`));
    url.searchParams.set('db', 'clinvar');
    url.searchParams.set('term', term);
    url.searchParams.set('retmode', 'json');
    url.searchParams.set('retmax', String(MAX_RECORDS));

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
          return EsearchResponse.parse(JSON.parse(text)).esearchresult.idlist;
        } catch (err) {
          invalidUpstreamResponse(err, 'NCBI ClinVar', NCBI_RETRY_HINT);
        }
      },
      { operation: 'clinvar.esearch', context: reqCtx, baseDelayMs: 1000, signal: ctx.signal },
    );
  }

  private esummary(ids: string[], ctx: Context): Promise<ClinVarRow[]> {
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
        try {
          return result.uids
            .map((uid) => result[uid])
            .filter((r): r is Record<string, unknown> => r != null)
            .map((raw) => this.normalize(EsummaryRecord.parse(raw)));
        } catch (err) {
          invalidUpstreamResponse(err, 'NCBI ClinVar', NCBI_RETRY_HINT);
        }
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
