/**
 * @fileoverview Service-level tests for ClinVarService.searchGene — the
 * post-fetch classification filter (#2). NCBI's [clinical_significance] field
 * tag matches broadly and leaks non-matching significances into a filtered
 * query, so searchGene filters the normalized rows itself. Spies the two NCBI
 * calls (esearch → idlist, esummary → rows) and asserts which classifications
 * survive a `pathogenic` query and that the significance filter composes with
 * the star floor.
 * @module tests/services/clinvar-service.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { ClinVarService } from '@/services/clinvar/clinvar-service.js';
import type { ClinVarRow } from '@/services/clinvar/types.js';

/** One normalized ClinVar row with a given classification + star rating. */
function row(uid: string, significance: string, stars: number): ClinVarRow {
  return {
    clinvar_variation_id: uid,
    accession: `VCV00${uid}`,
    title: `NM_000371.4(TTR):c.${uid}A>G`,
    obj_type: 'single nucleotide variant',
    clinical_significance: significance,
    review_status: 'criteria provided, single submitter',
    gold_stars: stars,
    last_evaluated: '2024-01-01',
    molecular_consequences: 'missense_variant',
    protein_change: `p.X${uid}`,
    conditions: 'Hereditary amyloidosis',
    submission_count: 2,
  };
}

/**
 * The mixed-significance set the live NCBI field tag returns for a TTR
 * pathogenic query: real pathogenic classifications alongside the leaks
 * (Uncertain / Benign / Conflicting) the post-filter must drop.
 */
const ROWS: ClinVarRow[] = [
  row('1', 'Pathogenic', 3),
  row('2', 'Likely pathogenic', 1),
  row('3', 'Pathogenic/Likely pathogenic', 2),
  row('4', 'Uncertain significance', 1),
  row('5', 'Benign', 3),
  row('6', 'Conflicting classifications of pathogenicity', 1),
];

/** Spy the two NCBI calls: esearch yields the ids, esummary yields the rows. */
function stubNcbi(svc: ClinVarService) {
  vi.spyOn(svc as any, 'esearch').mockResolvedValue(ROWS.map((r) => r.clinvar_variation_id));
  vi.spyOn(svc as any, 'esummary').mockImplementation((async (batch: string[]) =>
    ROWS.filter((r) => batch.includes(r.clinvar_variation_id))) as any);
}

afterEach(() => vi.restoreAllMocks());

describe('ClinVarService.searchGene — clinical_significance post-filter', () => {
  it('keeps only pathogenic classifications for a pathogenic query', async () => {
    const svc = new ClinVarService(getServerConfig());
    stubNcbi(svc);
    const ctx = createMockContext();
    const rows = await svc.searchGene('TTR', { clinicalSignificance: 'pathogenic' }, ctx);

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
    const svc = new ClinVarService(getServerConfig());
    stubNcbi(svc);
    const ctx = createMockContext();
    const rows = await svc.searchGene('TTR', { clinicalSignificance: 'likely_pathogenic' }, ctx);

    // "Likely pathogenic" plus the compound that contains it; not the bare "Pathogenic".
    expect(rows.map((r) => r.clinvar_variation_id)).toEqual(['2', '3']);
  });

  it('returns every classification when no significance filter is set', async () => {
    const svc = new ClinVarService(getServerConfig());
    stubNcbi(svc);
    const ctx = createMockContext();
    const rows = await svc.searchGene('TTR', {}, ctx);
    expect(rows.map((r) => r.clinvar_variation_id)).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  it('composes the significance filter with the star floor', async () => {
    const svc = new ClinVarService(getServerConfig());
    stubNcbi(svc);
    const ctx = createMockContext();
    const rows = await svc.searchGene(
      'TTR',
      { clinicalSignificance: 'pathogenic', minReviewStars: 2 },
      ctx,
    );

    // uid 1 (3★) and uid 3 (2★) are pathogenic AND clear the floor; uid 2
    // (Likely pathogenic, 1★) is pathogenic but below it. Both filters apply.
    expect(rows.map((r) => r.clinvar_variation_id)).toEqual(['1', '3']);
  });
});
