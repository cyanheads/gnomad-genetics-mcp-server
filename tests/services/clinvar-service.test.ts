/**
 * @fileoverview Service-level tests for ClinVarService.searchGene — the
 * post-fetch classification filter (#2, #67). The filter stays authoritative
 * over the ESearch clause, so searchGene filters the normalized rows itself.
 * Fakes the NCBI boundary (esearch → idlist + count, esummary → records) and
 * asserts which classifications survive each mapped term and an unmapped one,
 * that the significance filter composes with the star floor, how
 * normalizeSignificance() reads a term, and that each mapped term's pattern
 * scans in linear time, and that the filters and star rating read the germline
 * block beside somatic ones (#76).
 * @module tests/services/clinvar-service.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import {
  ClinVarService,
  normalizeSignificance,
  significanceMatch,
} from '@/services/clinvar/clinvar-service.js';

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
function stubNcbi(records: ReturnType<typeof record>[] = RECORDS) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = requestUrl(input);
    if (url.pathname.endsWith('/esearch.fcgi')) {
      return new Response(
        JSON.stringify({
          esearchresult: { count: String(records.length), idlist: records.map((r) => r.uid) },
        }),
      );
    }
    if (url.pathname.endsWith('/esummary.fcgi')) {
      const ids = (url.searchParams.get('id') ?? '').split(',');
      const result: Record<string, unknown> = { uids: ids };
      for (const r of records) if (ids.includes(r.uid)) result[r.uid] = r;
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

/**
 * One record per germline classification ClinVar writes, as its descriptions
 * read: combined forms, low penetrance, the VUS tiers, a classification beside
 * a risk factor, and a record with no germline classification at all (somatic
 * only), which every significance filter drops.
 */
const CLASSIFICATIONS = [
  'Pathogenic',
  'Likely pathogenic',
  'Pathogenic/Likely pathogenic',
  'Pathogenic, low penetrance',
  'Likely pathogenic, low penetrance',
  'Likely pathogenic/Pathogenic, low penetrance',
  'Pathogenic; risk factor',
  'Uncertain significance',
  'VUS-high',
  'VUS-mid',
  'VUS-low',
  'Likely benign',
  'Benign',
  'Benign/Likely benign',
  'Conflicting classifications of pathogenicity',
  'risk factor',
  '',
];
const BY_CLASSIFICATION = CLASSIFICATIONS.map((description, i) =>
  record(String(i + 1), description, 1),
);

describe('ClinVarService.searchGene — mapped significance terms (#67)', () => {
  it.each([
    [
      'pathogenic',
      [
        'Pathogenic',
        'Likely pathogenic',
        'Pathogenic/Likely pathogenic',
        'Pathogenic, low penetrance',
        'Likely pathogenic, low penetrance',
        'Likely pathogenic/Pathogenic, low penetrance',
        'Pathogenic; risk factor',
      ],
    ],
    [
      'likely pathogenic',
      [
        'Likely pathogenic',
        'Pathogenic/Likely pathogenic',
        'Likely pathogenic, low penetrance',
        'Likely pathogenic/Pathogenic, low penetrance',
      ],
    ],
    ['uncertain significance', ['Uncertain significance']],
    ['vus', ['Uncertain significance', 'VUS-high', 'VUS-mid', 'VUS-low']],
    ['likely benign', ['Likely benign', 'Benign/Likely benign']],
    ['benign', ['Likely benign', 'Benign', 'Benign/Likely benign']],
    ['conflicting', ['Conflicting classifications of pathogenicity']],
    // Unmapped: the whole-word phrase, as before.
    ['risk factor', ['Pathogenic; risk factor', 'risk factor']],
  ])('%s keeps %j', async (clinicalSignificance, kept) => {
    stubNcbi(BY_CLASSIFICATION);

    const { rows } = await service().searchGene(
      'CFH',
      { clinicalSignificance },
      createMockContext(),
    );

    expect(rows.map((r) => r.clinical_significance)).toEqual(kept);
  });

  it.each(['Pathogenic', 'PATHOGENIC', '"Pathogenic"'])(
    'reads %j as the pathogenic term on the rows',
    async (clinicalSignificance) => {
      stubNcbi(BY_CLASSIFICATION);
      const ctx = createMockContext();

      const spelled = await service().searchGene('CFH', { clinicalSignificance }, ctx);
      const canonical = await service().searchGene(
        'CFH',
        { clinicalSignificance: 'pathogenic' },
        ctx,
      );

      expect(spelled.rows).toEqual(canonical.rows);
    },
  );
});

/**
 * Records whose somatic blocks reuse germline words (ESummary sends all three
 * blocks; somatic oncogenicity calls include "Uncertain significance"): the
 * filters and the star floor read the germline block alone.
 */
const SOMATIC_RECORDS = [
  {
    ...record('1', '', 1),
    germline_classification: { description: '', review_status: '', trait_set: [] },
    oncogenicity_classification: {
      description: 'Uncertain significance',
      review_status: 'reviewed by expert panel',
      last_evaluated: '2025/02/01 00:00',
      trait_set: [{ trait_name: 'Colorectal cancer' }],
    },
  },
  {
    ...record('2', 'Uncertain significance', 1),
    clinical_impact_classification: {
      description: 'Tier I - Strong',
      review_status: 'reviewed by expert panel',
      last_evaluated: '2025/03/01 00:00',
      trait_set: [{ trait_name: 'Lung adenocarcinoma' }],
    },
  },
];

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/76
describe('ClinVarService.searchGene — the filters stay germline beside somatic blocks (#76)', () => {
  it.each([
    [{ clinicalSignificance: 'vus' }, ['2']],
    [{ clinicalSignificance: 'uncertain significance' }, ['2']],
    [{ minReviewStars: 2 }, []],
    [{ minReviewStars: 1 }, ['2']],
    [{}, ['1', '2']],
  ])('%j keeps %j', async (filters, kept) => {
    stubNcbi(SOMATIC_RECORDS as ReturnType<typeof record>[]);

    const { rows } = await service().searchGene('KRAS', filters, createMockContext());

    expect(rows.map((r) => r.clinvar_variation_id)).toEqual(kept);
  });

  it('rates stars from the germline review status, never a somatic one', async () => {
    stubNcbi(SOMATIC_RECORDS as ReturnType<typeof record>[]);

    const { rows } = await service().searchGene('KRAS', {}, createMockContext());

    expect(rows.map((r) => [r.review_status, r.gold_stars])).toEqual([
      [null, 0],
      ['criteria provided, single submitter', 1],
    ]);
  });
});

describe('normalizeSignificance', () => {
  it.each([
    ['Pathogenic', 'pathogenic'],
    ['LIKELY_PATHOGENIC', 'likely pathogenic'],
    [' likely pathogenic ', 'likely pathogenic'],
    ['"VUS"', 'vus'],
    ['Risk Factor', 'risk factor'],
    ['  ', undefined],
    ['""', undefined],
    [undefined, undefined],
  ])('%j → %j', (value, normalized) => {
    expect(normalizeSignificance(value)).toBe(normalized);
  });
});

/** This thread's CPU time in microseconds — never wall clock, which counts descheduled time. */
function cpuMicros(): number {
  const { user, system } = process.threadCpuUsage();
  return user + system;
}

/**
 * Least per-call CPU time of `pattern.test()` over five batches, alternating
 * `text` with a one-character-longer copy so no call repeats the one before
 * it — an optimizer can lift a test of an unchanging string out of the batch
 * loop, which reads as near-zero time. The batch doubles until one spans at
 * least 2 ms, so a scan far below the timer's resolution is still measured,
 * and the least of five discards garbage-collection pauses.
 */
function perCallMicros(pattern: RegExp, text: string): number {
  const inputs = [text, `${text}.`];
  let batch = 1;
  for (;;) {
    const start = cpuMicros();
    for (let i = 0; i < batch; i++) pattern.test(inputs[i & 1] as string);
    if (cpuMicros() - start >= 2_000) break;
    batch *= 2;
  }
  let least = Number.POSITIVE_INFINITY;
  for (let round = 0; round < 5; round++) {
    const start = cpuMicros();
    for (let i = 0; i < batch; i++) pattern.test(inputs[i & 1] as string);
    least = Math.min(least, (cpuMicros() - start) / batch);
  }
  return least;
}

const repeatTo = (unit: string, length: number) => unit.repeat(Math.ceil(length / unit.length));

/**
 * Worst-case classification text for each mapped term's post-filter pattern:
 * the term's own words repeated with the last letter missing (overlapping
 * prefixes that never complete), its first word repeated, a long digit run,
 * and the two line-break shapes.
 */
const TIMING_SHAPES = (
  [
    ['pathogenic', 'pathogeni', 'pathogenicity '],
    ['likely pathogenic', 'likely pathogeni', 'likely '],
    ['uncertain significance', 'uncertain significanc', 'uncertain '],
    ['vus', 'uncertain significanc vu', 'uncertain '],
    ['likely benign', 'likely benig', 'likely '],
    ['benign', 'benig', 'benignity '],
    ['conflicting', 'conflictin', 'conflictings '],
  ] as const
).flatMap(([term, prefix, word]) =>
  (
    [
      ['overlapping prefixes', (n: number) => repeatTo(prefix, n)],
      ['repeated first word', (n: number) => repeatTo(word, n)],
      ['long digit run', (n: number) => '1'.repeat(n)],
      ['one long line ending in a break', (n: number) => `${repeatTo('§1 x', n)}\ny`],
      ['breaks throughout', (n: number) => repeatTo('  \r\n', n)],
    ] as const
  ).map(([shape, make]) => [`${term}: ${shape}`, term, make] as const),
);

describe('linear-time significance post-filter (#67)', () => {
  it.each(TIMING_SHAPES)('%s stays linear from 5k to 320k characters', (_label, term, make) => {
    const { pattern } = significanceMatch(term);
    const base = perCallMicros(pattern, make(5_000));
    let last = base;
    for (let length = 10_000; length <= 320_000; length *= 2) {
      last = perCallMicros(pattern, make(length));
      // Linear growth over the full 64× span is ~64×; quadratic passes 256× by 80k.
      expect(last / base, `${length} characters`).toBeLessThan(256);
    }
    expect(last).toBeLessThan(20_000);
  });
});
