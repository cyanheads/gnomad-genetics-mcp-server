/**
 * @fileoverview Service-level tests for ClinVarService.searchGene — the
 * post-fetch classification filter (#2). NCBI indexes the significance phrase
 * across all fields, so a filtered query leaks non-matching significances and
 * searchGene filters the normalized rows itself. Fakes the NCBI boundary
 * (esearch → idlist + count, esummary → records) and asserts which
 * classifications survive a `pathogenic` query and that the significance filter
 * composes with the star floor.
 * @module tests/services/clinvar-service.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { ClinVarService } from '@/services/clinvar/clinvar-service.js';

/** Review-status text for each gold-star rating the fixtures use. */
const STATUS_FOR_STARS: Record<number, string> = {
  1: 'criteria provided, single submitter',
  2: 'criteria provided, multiple submitters, no conflicts',
  3: 'reviewed by expert panel',
};

/** One raw ESummary record with a given classification + star rating. */
function record(uid: string, significance: string, stars: number) {
  return {
    uid,
    accession: `VCV00${uid}`,
    title: `NM_000371.4(TTR):c.${uid}A>G`,
    obj_type: 'single nucleotide variant',
    germline_classification: {
      description: significance,
      review_status: STATUS_FOR_STARS[stars],
      last_evaluated: '2024-01-01',
      trait_set: [{ trait_name: 'Hereditary amyloidosis' }],
    },
  };
}

/**
 * The mixed-significance set the live NCBI search returns for a TTR
 * pathogenic query: real pathogenic classifications alongside the leaks
 * (Uncertain / Benign / Conflicting) the post-filter must drop.
 */
const RECORDS = [
  record('1', 'Pathogenic', 3),
  record('2', 'Likely pathogenic', 1),
  record('3', 'Pathogenic/Likely pathogenic', 2),
  record('4', 'Uncertain significance', 1),
  record('5', 'Benign', 3),
  record('6', 'Conflicting classifications of pathogenicity', 1),
];

function requestUrl(input: string | URL | Request): URL {
  if (input instanceof URL) return input;
  if (input instanceof Request) return new URL(input.url);
  return new URL(input);
}

/** Fake NCBI: esearch returns every fixture UID, esummary returns the records. */
function stubNcbi() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = requestUrl(input);
    if (url.pathname.endsWith('/esearch.fcgi')) {
      return new Response(
        JSON.stringify({
          esearchresult: { count: String(RECORDS.length), idlist: RECORDS.map((r) => r.uid) },
        }),
      );
    }
    if (url.pathname.endsWith('/esummary.fcgi')) {
      const ids = (url.searchParams.get('id') ?? '').split(',');
      const result: Record<string, unknown> = { uids: ids };
      for (const r of RECORDS) if (ids.includes(r.uid)) result[r.uid] = r;
      return new Response(JSON.stringify({ result }));
    }
    throw new Error('unmocked fetch');
  });
}

/** Keyed config: 100 ms pacing keeps the two-request round trip short. */
const service = () => new ClinVarService({ ...getServerConfig(), ncbiApiKey: 'test-key' });

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
  stubNcbi();
});
afterEach(() => vi.restoreAllMocks());

describe('ClinVarService.searchGene — clinical_significance post-filter', () => {
  it('keeps only pathogenic classifications for a pathogenic query', async () => {
    const { rows } = await service().searchGene(
      'TTR',
      { clinicalSignificance: 'pathogenic' },
      createMockContext(),
    );

    // The compound and likely- forms survive; the leaks do not.
    expect(rows.map((r) => r.clinical_significance)).toEqual([
      'Pathogenic',
      'Likely pathogenic',
      'Pathogenic/Likely pathogenic',
    ]);
    const survivors = rows.map((r) => r.clinical_significance);
    expect(survivors).not.toContain('Uncertain significance');
    expect(survivors).not.toContain('Benign');
    // "pathogenicity" must not match "pathogenic" — the word boundary excludes it.
    expect(survivors).not.toContain('Conflicting classifications of pathogenicity');
  });

  it('treats the documented likely_pathogenic underscore form as a space', async () => {
    const { rows } = await service().searchGene(
      'TTR',
      { clinicalSignificance: 'likely_pathogenic' },
      createMockContext(),
    );

    // "Likely pathogenic" plus the compound that contains it; not the bare "Pathogenic".
    expect(rows.map((r) => r.clinvar_variation_id)).toEqual(['2', '3']);
  });

  it('returns every classification when no significance filter is set', async () => {
    const { rows } = await service().searchGene('TTR', {}, createMockContext());
    expect(rows.map((r) => r.clinvar_variation_id)).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  it('composes the significance filter with the star floor', async () => {
    const { rows } = await service().searchGene(
      'TTR',
      { clinicalSignificance: 'pathogenic', minReviewStars: 2 },
      createMockContext(),
    );

    // uid 1 (3★) and uid 3 (2★) are pathogenic AND clear the floor; uid 2
    // (Likely pathogenic, 1★) is pathogenic but below it. Both filters apply.
    expect(rows.map((r) => r.clinvar_variation_id)).toEqual(['1', '3']);
  });

  it('keeps total_found at the candidate count the filters narrowed', async () => {
    const result = await service().searchGene(
      'TTR',
      { clinicalSignificance: 'pathogenic', minReviewStars: 3 },
      createMockContext(),
    );

    expect(result.rows.map((r) => r.clinvar_variation_id)).toEqual(['1']);
    expect(result).toMatchObject({ totalFound: 6, truncated: false, nextOffset: null });
  });
});
