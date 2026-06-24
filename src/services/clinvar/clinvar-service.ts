/**
 * @fileoverview Optional ClinVar service over NCBI E-utilities (esearch →
 * esummary). Honors NCBI_API_KEY, paces to the keyless/keyed rate limit, and
 * backs off on transient failures. Powers gnomad_search_clinvar — gene-level
 * curation depth beyond the per-variant join gnomAD provides.
 * @module services/clinvar/clinvar-service
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, requestContextService, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig, type ServerConfig } from '@/config/server-config.js';
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

/** Cap on records pulled per gene search — politeness + bounded canvas size. */
const MAX_RECORDS = 500;
/** esummary batch size per request. */
const SUMMARY_BATCH = 50;

const EsearchResponse = z.object({
  esearchresult: z.object({
    idlist: z.array(z.string()).default([]),
    count: z.string().optional(),
  }),
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

  constructor(serverConfig: ServerConfig) {
    this.baseUrl = serverConfig.clinvarBaseUrl;
    if (serverConfig.ncbiApiKey) this.apiKey = serverConfig.ncbiApiKey;
    this.timeoutMs = serverConfig.requestTimeoutMs;
  }

  private withKey(url: URL): URL {
    if (this.apiKey) url.searchParams.set('api_key', this.apiKey);
    return url;
  }

  /** Search ClinVar for a gene, returning normalized rows (the handler spills them). */
  async searchGene(gene: string, filters: ClinVarFilters, ctx: Context): Promise<ClinVarRow[]> {
    const ids = await this.esearch(gene, filters.clinicalSignificance, ctx);
    if (ids.length === 0) return [];
    const rows: ClinVarRow[] = [];
    for (let i = 0; i < ids.length; i += SUMMARY_BATCH) {
      if (ctx.signal.aborted) break;
      const batch = ids.slice(i, i + SUMMARY_BATCH);
      rows.push(...(await this.esummary(batch, ctx)));
    }
    if (filters.minReviewStars != null) {
      const floor = filters.minReviewStars;
      return rows.filter((r) => r.gold_stars >= floor);
    }
    return rows;
  }

  private esearch(
    gene: string,
    clinicalSignificance: string | undefined,
    ctx: Context,
  ): Promise<string[]> {
    const reqCtx = requestContextService.createRequestContext({
      operation: 'clinvar.esearch',
      parentContext: { requestId: ctx.requestId, traceId: ctx.traceId },
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
        const response = await fetchWithTimeout(url, this.timeoutMs, reqCtx, {
          signal: ctx.signal,
        });
        const text = await response.text();
        if (/^\s*<(!doctype\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable('NCBI returned HTML instead of JSON — likely rate-limited.');
        }
        return EsearchResponse.parse(JSON.parse(text)).esearchresult.idlist;
      },
      { operation: 'clinvar.esearch', context: reqCtx, baseDelayMs: 1000, signal: ctx.signal },
    );
  }

  private esummary(ids: string[], ctx: Context): Promise<ClinVarRow[]> {
    const reqCtx = requestContextService.createRequestContext({
      operation: 'clinvar.esummary',
      parentContext: { requestId: ctx.requestId, traceId: ctx.traceId },
    });
    const url = this.withKey(new URL(`${this.baseUrl}/esummary.fcgi`));
    url.searchParams.set('db', 'clinvar');
    url.searchParams.set('id', ids.join(','));
    url.searchParams.set('retmode', 'json');

    return withRetry(
      async () => {
        const response = await fetchWithTimeout(url, this.timeoutMs, reqCtx, {
          signal: ctx.signal,
        });
        const text = await response.text();
        if (/^\s*<(!doctype\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable('NCBI returned HTML instead of JSON — likely rate-limited.');
        }
        const parsed = JSON.parse(text) as { result?: Record<string, unknown> };
        const result = parsed.result;
        if (!result) return [];
        const uids = (result.uids as string[] | undefined) ?? [];
        return uids
          .map((uid) => result[uid])
          .filter((r): r is Record<string, unknown> => r != null)
          .map((raw) => this.normalize(EsummaryRecord.parse(raw)));
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
