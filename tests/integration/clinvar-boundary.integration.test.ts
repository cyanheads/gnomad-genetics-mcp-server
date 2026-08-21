/**
 * @fileoverview Offline integration tests for the NCBI E-utilities boundary.
 * Exercises URL construction, sparse/partial esummary normalization, review
 * stars, batching, rate limiting, and timeout sanitization through the real
 * ClinVarService. Only global fetch is faked.
 * @module tests/integration/clinvar-boundary.integration.test
 */

import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { ClinVarService } from '@/services/clinvar/clinvar-service.js';

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

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ClinVarService E-utilities boundary', () => {
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

    const rows = await svc.searchGene(
      'LDLR',
      { clinicalSignificance: 'pathogenic' },
      createMockContext(),
    );

    expect(urls).toHaveLength(2);
    expect(urls[0]?.searchParams.get('db')).toBe('clinvar');
    expect(urls[0]?.searchParams.get('term')).toBe(
      'LDLR[gene] AND pathogenic[clinical_significance]',
    );
    expect(urls[0]?.searchParams.get('retmax')).toBe('500');
    expect(urls[1]?.searchParams.get('id')).toBe('1,2');
    expect(rows).toEqual([
      expect.objectContaining({ clinvar_variation_id: '1', gold_stars: 3, submission_count: 2 }),
      expect.objectContaining({ clinvar_variation_id: '2', gold_stars: 1, submission_count: 2 }),
    ]);
  });

  it('preserves sparse fields and skips IDs missing from a partial esummary result', async () => {
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

    const rows = await svc.searchGene('LDLR', {}, createMockContext());

    expect(rows).toHaveLength(2);
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
    });
    expect(rows[1]?.gold_stars).toBe(4);
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

    const rows = await svc.searchGene('LDLR', {}, createMockContext());

    expect(summaryBatches).toHaveLength(2);
    expect(summaryBatches[0]?.split(',')).toHaveLength(50);
    expect(summaryBatches[1]).toBe('51');
    expect(rows).toHaveLength(51);
  });

  it('does not call esummary when the search returns no IDs', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ esearchresult: { idlist: [] } })));
    const svc = new ClinVarService(getServerConfig());

    const rows = await svc.searchGene('NORESULTS', {}, createMockContext());

    expect(rows).toEqual([]);
    expect(fetch).toHaveBeenCalledOnce();
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
