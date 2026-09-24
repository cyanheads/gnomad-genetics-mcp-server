/**
 * @fileoverview Offline integration tests for the NCBI E-utilities boundary.
 * Exercises ESearch term and window construction, sparse/partial esummary
 * normalization, gnomAD-compatible identifier mapping over real ESummary
 * payloads, review stars, batching, rate limiting, and timeout sanitization
 * through the real ClinVarService. Only global fetch is faked.
 * @module tests/integration/clinvar-boundary.integration.test
 */

import { readFileSync } from 'node:fs';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { ClinVarService } from '@/services/clinvar/clinvar-service.js';

/** Real ESummary payloads (captured 2026-09-23), `allele_freq_set` trimmed. */
const LIVE = JSON.parse(
  readFileSync(new URL('../fixtures/clinvar-esummary.live.json', import.meta.url), 'utf8'),
) as { result: Record<string, unknown> & { uids: string[] } };

function requestUrl(input: string | URL | Request): URL {
  if (input instanceof URL) return input;
  if (input instanceof Request) return new URL(input.url);
  return new URL(input);
}

function summaryRecord(uid: string, reviewStatus = 'reviewed by expert panel') {
  return {
    uid,
    accession: `VCV000${uid}`,
    title: `NM_000527.5(LDLR):c.${uid}G>A`,
    obj_type: 'single nucleotide variant',
    protein_change: `G${uid}S`,
    molecular_consequence_list: ['missense_variant'],
    germline_classification: {
      description: 'Pathogenic',
      review_status: reviewStatus,
      last_evaluated: '2025-01-01',
      trait_set: [{ trait_name: 'Familial hypercholesterolemia' }],
    },
    supporting_submissions: { scv: ['SCV1', 'SCV2'], rcv: ['RCV1'] },
  };
}

async function runExhausting(operation: () => Promise<unknown>): Promise<McpError> {
  const settled = operation().then(
    () => {
      throw new Error('operation did not throw');
    },
    (error: unknown) => error as McpError,
  );
  for (let index = 0; index < 12; index += 1) {
    await vi.advanceTimersByTimeAsync(60_000);
  }
  return settled;
}

/** An ESearch envelope: `count` is the full hit count, `idlist` the window. */
function esearchBody(idlist: string[], count = String(idlist.length)): Response {
  return new Response(JSON.stringify({ esearchresult: { count, idlist } }));
}

/**
 * Fake NCBI: ESearch answers with `esearch`, ESummary answers from `records`
 * (UIDs absent from `records` are absent from `result`). Returns the request log.
 */
function fakeNcbi(esearch: Response, records: Record<string, unknown>): URL[] {
  const urls: URL[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = requestUrl(input);
    urls.push(url);
    if (url.pathname.endsWith('/esearch.fcgi')) return esearch.clone();
    if (url.pathname.endsWith('/esummary.fcgi')) {
      const ids = (url.searchParams.get('id') ?? '').split(',');
      const result: Record<string, unknown> = { uids: ids };
      for (const id of ids) if (records[id]) result[id] = records[id];
      return new Response(JSON.stringify({ result }));
    }
    throw new Error('unmocked fetch');
  });
  return urls;
}

/** Run searchGene on a fresh service under fake timers, so NCBI pacing costs no wall-clock time. */
async function search(gene: string, filters: Parameters<ClinVarService['searchGene']>[1]) {
  vi.useFakeTimers();
  let settled = false;
  const pending = new ClinVarService(getServerConfig())
    .searchGene(gene, filters, createMockContext())
    .finally(() => {
      settled = true;
    });
  for (let i = 0; i < 50 && !settled; i += 1) await vi.advanceTimersByTimeAsync(500);
  return pending;
}

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ClinVarService E-utilities boundary', () => {
  it.each([
    { apiKey: false, interval: 334 },
    { apiKey: true, interval: 100 },
  ])(
    'paces concurrent request starts at the configured NCBI rate ($apiKey)',
    async ({ apiKey, interval }) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const starts: number[] = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        starts.push(Date.now());
        return esearchBody([]);
      });
      const base = getServerConfig();
      const svc = new ClinVarService(apiKey ? { ...base, ncbiApiKey: 'test-key' } : base);
      const calls = Promise.all(
        Array.from({ length: 4 }, (_, index) =>
          svc.searchGene(`GENE${index}`, {}, createMockContext()),
        ),
      );

      await vi.advanceTimersByTimeAsync(interval * 4 + 1);
      await calls;

      expect(starts).toHaveLength(4);
      for (let index = 1; index < starts.length; index += 1) {
        expect((starts[index] ?? 0) - (starts[index - 1] ?? 0)).toBeGreaterThanOrEqual(
          interval - 1,
        );
      }
      if (!apiKey) {
        expect((starts[3] ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(1000);
      }
    },
  );

  it('aborts a queued request without consuming a later limiter turn', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const starts: number[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      starts.push(Date.now());
      return esearchBody([]);
    });
    const svc = new ClinVarService(getServerConfig());
    const first = svc.searchGene('FIRST', {}, createMockContext());
    const controller = new AbortController();
    const cancelled = svc.searchGene(
      'CANCELLED',
      {},
      createMockContext({ signal: controller.signal }),
    );
    const third = svc.searchGene('THIRD', {}, createMockContext());
    controller.abort(new Error('cancelled'));

    await expect(cancelled).rejects.toThrow('cancelled');
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([first, third]);

    expect(starts).toHaveLength(2);
    expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(334);
  });

  it('builds a scoped gene query and normalizes review metadata', async () => {
    const urls: URL[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = requestUrl(input);
      urls.push(url);
      if (url.pathname.endsWith('/esearch.fcgi')) {
        return new Response(JSON.stringify({ esearchresult: { idlist: ['1', '2'], count: '2' } }));
      }
      return new Response(
        JSON.stringify({
          result: {
            uids: ['1', '2'],
            '1': summaryRecord('1'),
            '2': summaryRecord('2', 'criteria provided, single submitter'),
          },
        }),
      );
    });
    const svc = new ClinVarService(getServerConfig());

    const { rows, totalFound } = await svc.searchGene(
      'LDLR',
      { clinicalSignificance: 'pathogenic' },
      createMockContext(),
    );

    expect(urls).toHaveLength(2);
    expect(urls[0]?.searchParams.get('db')).toBe('clinvar');
    expect(urls[0]?.searchParams.get('term')).toBe(
      '"LDLR"[gene] AND "pathogenic"[clinical_significance]',
    );
    expect(urls[0]?.searchParams.get('retstart')).toBe('0');
    expect(urls[0]?.searchParams.get('retmax')).toBe('500');
    expect(urls[1]?.searchParams.get('id')).toBe('1,2');
    expect(totalFound).toBe(2);
    expect(rows).toEqual([
      expect.objectContaining({ clinvar_variation_id: '1', gold_stars: 3, submission_count: 2 }),
      expect.objectContaining({ clinvar_variation_id: '2', gold_stars: 1, submission_count: 2 }),
    ]);
  });

  it('preserves sparse fields and lists IDs missing from a partial esummary result', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith('/esearch.fcgi')) {
        return new Response(
          JSON.stringify({ esearchresult: { idlist: ['10', '11', '12'], count: '3' } }),
        );
      }
      return new Response(
        JSON.stringify({
          result: {
            uids: ['10', '11', '12'],
            '10': {
              uid: '10',
              germline_classification: {
                description: null,
                review_status: null,
                trait_set: [{ trait_name: null }, {}],
              },
            },
            '11': summaryRecord('11', 'PRACTICE GUIDELINE'),
          },
        }),
      );
    });
    const svc = new ClinVarService(getServerConfig());

    const { rows, unavailableIds } = await svc.searchGene('LDLR', {}, createMockContext());

    expect(rows).toHaveLength(2);
    // No variation_set / variation_xrefs at all: the identifier columns stay unknown.
    expect(rows[0]).toEqual({
      clinvar_variation_id: '10',
      accession: '',
      title: '',
      obj_type: '',
      clinical_significance: null,
      review_status: null,
      gold_stars: 0,
      last_evaluated: null,
      molecular_consequences: '',
      protein_change: '',
      conditions: '',
      submission_count: 0,
      canonical_spdi: null,
      rsids: '',
      grch38_variant_id: null,
    });
    expect(rows[1]?.gold_stars).toBe(4);
    expect(unavailableIds).toEqual(['12']);
  });

  it('batches more than 50 VariationIDs into separate esummary requests', async () => {
    const ids = Array.from({ length: 51 }, (_, index) => String(index + 1));
    const summaryBatches: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith('/esearch.fcgi')) {
        return new Response(JSON.stringify({ esearchresult: { idlist: ids, count: '51' } }));
      }
      const batch = url.searchParams.get('id') ?? '';
      summaryBatches.push(batch);
      const batchIds = batch.split(',');
      return new Response(
        JSON.stringify({
          result: {
            uids: batchIds,
            ...Object.fromEntries(batchIds.map((id) => [id, summaryRecord(id)])),
          },
        }),
      );
    });
    const svc = new ClinVarService(getServerConfig());

    const { rows } = await svc.searchGene('LDLR', {}, createMockContext());

    expect(summaryBatches).toHaveLength(2);
    expect(summaryBatches[0]?.split(',')).toHaveLength(50);
    expect(summaryBatches[1]).toBe('51');
    expect(rows).toHaveLength(51);
  });

  it('does not call esummary when the search returns no IDs', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(esearchBody([]));
    const svc = new ClinVarService(getServerConfig());

    const result = await svc.searchGene('NORESULTS', {}, createMockContext());

    expect(result).toEqual({
      rows: [],
      totalFound: 0,
      truncated: false,
      nextOffset: null,
      unavailableIds: [],
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe('ClinVarService ESearch window (#28)', () => {
  it.each([
    { offset: 0, limit: 500, count: '1571', truncated: true, nextOffset: 500 },
    { offset: 500, limit: 500, count: '1571', truncated: true, nextOffset: 1000 },
    { offset: 1500, limit: 500, count: '1571', truncated: false, nextOffset: null },
    { offset: 1000, limit: 571, count: '1571', truncated: false, nextOffset: null },
    { offset: 5000, limit: 500, count: '1571', truncated: false, nextOffset: null },
    { offset: 0, limit: 1, count: '2', truncated: true, nextOffset: 1 },
  ])(
    'window offset=$offset limit=$limit of $count → truncated=$truncated next=$nextOffset',
    async ({ offset, limit, count, truncated, nextOffset }) => {
      const urls = fakeNcbi(esearchBody([], count), {});

      const result = await search('PCSK9', { offset, limit });

      expect(urls[0]?.searchParams.get('retstart')).toBe(String(offset));
      expect(urls[0]?.searchParams.get('retmax')).toBe(String(limit));
      expect(result).toMatchObject({ totalFound: Number(count), truncated, nextOffset });
    },
  );

  it('keeps total_found at the ESearch count while the post-filter drops rows', async () => {
    const records = {
      '1': summaryRecord('1'),
      '2': { ...summaryRecord('2'), germline_classification: { description: 'Benign' } },
    };
    fakeNcbi(esearchBody(['1', '2'], '40'), records);

    const result = await search('LDLR', { clinicalSignificance: 'pathogenic', limit: 2 });

    expect(result.rows.map((r) => r.clinvar_variation_id)).toEqual(['1']);
    expect(result).toMatchObject({ totalFound: 40, truncated: true, nextOffset: 2 });
  });

  it('reports error-keyed and missing UIDs across batches, preserving ESearch order', async () => {
    const idlist = Array.from({ length: 60 }, (_, i) => String(i + 1));
    const records: Record<string, unknown> = {};
    for (const id of idlist) records[id] = summaryRecord(id);
    records['5'] = { uid: '5', error: 'cannot get document summary' };
    delete records['55'];
    records['58'] = LIVE.result['999999999'];
    fakeNcbi(esearchBody(idlist, '60'), records);

    const { rows, unavailableIds } = await search('LDLR', {});

    expect(unavailableIds).toEqual(['5', '55', '58']);
    expect(rows).toHaveLength(57);
    expect(rows.every((r) => r.title !== '')).toBe(true);
  });
});

describe('ClinVarService ESearch term (#28, #31)', () => {
  async function termFor(filters: Parameters<ClinVarService['searchGene']>[1]) {
    const urls = fakeNcbi(esearchBody([]), {});
    await search('TTR', filters);
    return urls[0]?.searchParams.get('term');
  }

  it.each([
    ['uncertain significance', '"TTR"[gene] AND "uncertain significance"[clinical_significance]'],
    ['uncertain_significance', '"TTR"[gene] AND "uncertain significance"[clinical_significance]'],
    [' pathogenic ', '"TTR"[gene] AND "pathogenic"[clinical_significance]'],
    ['likely_pathogenic', '"TTR"[gene] AND "likely pathogenic"[clinical_significance]'],
    ['"benign"', '"TTR"[gene] AND "benign"[clinical_significance]'],
    ['   ', '"TTR"[gene]'],
    ['', '"TTR"[gene]'],
    ['"', '"TTR"[gene]'],
  ])('clinical_significance %j → %s', async (clinicalSignificance, term) => {
    expect(await termFor({ clinicalSignificance })).toBe(term);
  });

  it.each([
    [0, '"TTR"[gene]'],
    [
      1,
      '"TTR"[gene] AND ("practice guideline"[Review status] OR "reviewed by expert panel"[Review status] OR "criteria provided, multiple submitters, no conflicts"[Review status] OR "criteria provided, conflicting classifications"[Review status] OR "criteria provided, conflicting interpretations"[Review status] OR "criteria provided, single submitter"[Review status])',
    ],
    [
      2,
      '"TTR"[gene] AND ("practice guideline"[Review status] OR "reviewed by expert panel"[Review status] OR "criteria provided, multiple submitters, no conflicts"[Review status])',
    ],
    [
      3,
      '"TTR"[gene] AND ("practice guideline"[Review status] OR "reviewed by expert panel"[Review status])',
    ],
    [4, '"TTR"[gene] AND ("practice guideline"[Review status])'],
  ])('min_review_stars %d → %s', async (minReviewStars, term) => {
    expect(await termFor({ minReviewStars })).toBe(term);
  });

  it('returns the same rows for the spaced and underscored significance forms', async () => {
    const records = {
      '1': {
        ...summaryRecord('1'),
        germline_classification: { description: 'Uncertain significance' },
      },
      '2': summaryRecord('2'),
    };
    const run = async (clinicalSignificance: string) => {
      fakeNcbi(esearchBody(['1', '2']), records);
      const { rows } = await search('TTR', { clinicalSignificance });
      vi.restoreAllMocks();
      return rows.map((r) => r.clinvar_variation_id);
    };

    expect(await run('uncertain significance')).toEqual(['1']);
    expect(await run('uncertain_significance')).toEqual(['1']);
  });

  it('applies no post-filter for a blank significance (#31)', async () => {
    const records = {
      '1': { ...summaryRecord('1'), germline_classification: { description: 'Benign' } },
      '2': summaryRecord('2'),
    };
    fakeNcbi(esearchBody(['1', '2']), records);

    const { rows } = await search('TTR', { clinicalSignificance: '  ' });

    expect(rows.map((r) => r.clinvar_variation_id)).toEqual(['1', '2']);
  });

  it.each([
    ['"pathogenic"', ['2']],
    ['"likely_pathogenic"', []],
    ['"', ['1', '2']],
    ['""', ['1', '2']],
  ])('filters rows by the same normalized value it sends for %j', async (significance, kept) => {
    const records = {
      '1': { ...summaryRecord('1'), germline_classification: { description: 'Benign' } },
      '2': summaryRecord('2'),
    };
    fakeNcbi(esearchBody(['1', '2']), records);

    const { rows } = await search('TTR', { clinicalSignificance: significance });

    expect(rows.map((r) => r.clinvar_variation_id)).toEqual(kept);
  });
});

describe('ClinVarService gene term (#40)', () => {
  async function termFor(gene: string) {
    const urls = fakeNcbi(esearchBody([]), {});
    await search(gene, {});
    return urls[0]?.searchParams.get('term');
  }

  it.each([
    ['PCSK9', '"PCSK9"[gene]'],
    [' PCSK9 ', '"PCSK9"[gene]'],
    ['HLA-A', '"HLA-A"[gene]'],
    ['C9orf72', '"C9orf72"[gene]'],
    ['PCSK9)', '"PCSK9)"[gene]'],
    ['((', '"(("[gene]'],
    ['PCSK9 OR', '"PCSK9 OR"[gene]'],
    ['PCSK9[All Fields]', '"PCSK9[All Fields]"[gene]'],
    ['PCSK9"[gene] OR "BRCA1', '"PCSK9[gene] OR BRCA1"[gene]'],
  ])('sends gene %j as the quoted phrase %s', async (gene, term) => {
    expect(await termFor(gene)).toBe(term);
  });

  it('quotes the gene ahead of the significance and review-status clauses', async () => {
    const urls = fakeNcbi(esearchBody([]), {});

    await search('BRCA1)', { clinicalSignificance: 'pathogenic', minReviewStars: 4 });

    expect(urls[0]?.searchParams.get('term')).toBe(
      '"BRCA1)"[gene] AND "pathogenic"[clinical_significance] AND ("practice guideline"[Review status])',
    );
  });

  it.each(['""', '" "', '""""'])(
    'answers gene %j with an empty window and no request, since NCBI ignores an empty phrase',
    async (gene) => {
      const urls = fakeNcbi(esearchBody(['1'], '2696146'), { '1': summaryRecord('1') });

      const result = await search(gene, {});

      expect(urls).toHaveLength(0);
      expect(result).toEqual({
        rows: [],
        totalFound: 0,
        truncated: false,
        nextOffset: null,
        unavailableIds: [],
      });
    },
  );
});

describe('ClinVarService gnomAD-compatible identifiers (#29)', () => {
  /** Normalize the live fixture records through the real ESummary path. */
  async function liveRows(ids: string[]) {
    fakeNcbi(esearchBody(ids), LIVE.result);
    return search('ANY', {});
  }

  it.each([
    // SNV with a dbSNP xref.
    ['2878', 'NC_000001.11:55039973:G:T', 'rs11591147', '1-55039974-G-T'],
    // Haplotype (two alleles) — multi-allele records carry no identifiers.
    ['7', null, '', null],
    // Deletion: canonical SPDI is repeat-expanded and shares the first base.
    ['4880644', 'NC_000018.10:31519900:GGG:GG', '', null],
    // Insertion: empty deleted allele.
    ['3775576', 'NC_000018.10:31524569::C', '', null],
    // Delins whose alleles differ at both ends.
    ['4759136', 'NC_000018.10:31518278:GGAAAC:AAGGCAG', '', '18-31518279-GGAAAC-AAGGCAG'],
    [
      '2610176',
      'NC_000018.10:31592942:T:AGTCCTCGGTCAAA',
      'rs2510932360',
      '18-31592943-T-AGTCCTCGGTCAAA',
    ],
    // MNV.
    ['1712259', 'NC_000018.10:31595138:GA:CT', 'rs730881168', '18-31595139-GA-CT'],
    // CNV: ClinVar sends "" for canonical_spdi.
    ['4682935', null, '', null],
    // Mitochondrial: gnomad_get_variant does not resolve M- IDs.
    ['4851466', 'NC_012920.1:9626:G:A', '', null],
    // Microsatellite: shared first base.
    ['4797433', 'NC_000018.10:31524595:TTCTTCT:TTCT', '', null],
  ])('VariationID %s → spdi %s, rsids %j, grch38 %s', async (uid, spdi, rsids, variantId) => {
    const { rows } = await liveRows([uid]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.canonical_spdi).toBe(spdi);
    expect(rows[0]?.rsids).toBe(rsids);
    expect(rows[0]?.grch38_variant_id).toBe(variantId);
  });

  it('keeps the fixture error entry out of the rows', async () => {
    const { rows, unavailableIds } = await liveRows(['2878', '999999999']);
    expect(rows.map((r) => r.clinvar_variation_id)).toEqual(['2878']);
    expect(unavailableIds).toEqual(['999999999']);
  });

  /** A single-allele record carrying `spdi` and the given dbSNP xref IDs. */
  function allele(uid: string, spdi: string | null | undefined, dbsnp: string[] = []) {
    return {
      ...summaryRecord(uid),
      variation_set: [
        {
          canonical_spdi: spdi,
          variation_xrefs: [
            { db_source: 'ClinGen', db_id: 'CA1' },
            ...dbsnp.map((db_id) => ({ db_source: 'dbSNP', db_id })),
          ],
        },
      ],
    };
  }

  it.each([
    ['NC_000018.10:31592942:C:', null],
    ['NC_000018.10:31592942::TA', null],
    ['NC_000018.10:31592942:TTT:TT', null],
    ['NC_000018.10:31592942:TAC:TGC', null],
    ['NC_012920.1:3242:A:G', null],
    ['NC_000001.10:55505646:G:T', null],
    ['NT_187361.1:100:A:G', null],
    ['NC_000018.10:31592942:N:A', null],
    ['NC_000018.10:abc:A:G', null],
    ['', null],
    ['NC_000023.11:100:A:G', 'X-101-A-G'],
    ['NC_000024.10:2786854:C:T', 'Y-2786855-C-T'],
    ['NC_000022.11:0:A:C', '22-1-A-C'],
    ['NC_000018.10:31595138:GA:CT', '18-31595139-GA-CT'],
  ])('SPDI %j → grch38_variant_id %s', async (spdi, variantId) => {
    fakeNcbi(esearchBody(['1']), { '1': allele('1', spdi) });
    const { rows } = await search('ANY', {});
    expect(rows[0]?.grch38_variant_id).toBe(variantId);
    expect(rows[0]?.canonical_spdi).toBe(spdi === '' ? null : spdi);
  });

  it('prefixes, de-duplicates, and joins dbSNP xrefs', async () => {
    fakeNcbi(esearchBody(['1']), {
      '1': allele('1', 'NC_000001.11:55039973:G:T', ['11591147', '28362263', '11591147']),
    });
    const { rows } = await search('ANY', {});
    expect(rows[0]?.rsids).toBe('rs11591147;rs28362263');
  });

  it('parses a variation_set entry that omits canonical_spdi and variation_xrefs', async () => {
    fakeNcbi(esearchBody(['1']), { '1': { ...summaryRecord('1'), variation_set: [{}] } });
    const { rows } = await search('ANY', {});
    expect(rows[0]).toMatchObject({ canonical_spdi: null, rsids: '', grch38_variant_id: null });
  });
});

describe('ClinVarService upstream error contracts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('sanitizes NCBI 429 responses and preserves retry guidance', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('PRIVATE_RATE_LIMIT_DETAIL', {
        status: 429,
        statusText: 'Too Many Requests',
      }),
    );
    const svc = new ClinVarService(getServerConfig());

    const error = await runExhausting(() => svc.searchGene('LDLR', {}, createMockContext()));

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'upstream_unavailable', retryable: true });
    expect((error.data?.recovery as { hint?: string } | undefined)?.hint).toMatch(/NCBI.*retry/i);
    expect(JSON.stringify({ message: error.message, data: error.data })).not.toContain(
      'PRIVATE_RATE_LIMIT_DETAIL',
    );
  });

  it('classifies a malformed esummary record without leaking response fields', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith('/esearch.fcgi')) {
        return new Response(JSON.stringify({ esearchresult: { idlist: ['1'] } }));
      }
      return new Response(
        JSON.stringify({
          result: {
            uids: ['1'],
            '1': { uid: 1, private_upstream_field: 'DO_NOT_LEAK' },
          },
        }),
      );
    });
    const svc = new ClinVarService(getServerConfig());

    const error = await runExhausting(() => svc.searchGene('LDLR', {}, createMockContext()));

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'invalid_upstream_response', retryable: true },
    });
    expect(JSON.stringify({ message: error.message, data: error.data })).not.toContain(
      'DO_NOT_LEAK',
    );
  });

  it('classifies a real fetch timeout path without leaking the E-utilities URL', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) reject(signal.reason);
          else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const svc = new ClinVarService(getServerConfig());

    const error = await runExhausting(() => svc.searchGene('LDLR', {}, createMockContext()));

    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.data).toMatchObject({ reason: 'upstream_timeout', retryable: true });
    expect(JSON.stringify({ message: error.message, data: error.data })).not.toContain(
      'eutils.ncbi.nlm.nih.gov',
    );
  });
});
