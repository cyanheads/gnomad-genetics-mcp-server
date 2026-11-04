/**
 * @fileoverview Behavior tests for gnomad_get_variant_cooccurrence, run through
 * runToolContract against live gnomAD replies at the fetch seam: every
 * acceptance pair on both surfaces, the one combined notice (calibration
 * caveat, the browser's reading, and the coverage note), the declared refusal
 * and GraphQL-error reasons, ID validation and normalization before any fetch,
 * and the definition's advertised contract.
 * @module tests/tools/gnomad-get-variant-cooccurrence.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { gnomadGetVariantCooccurrence } from '@/mcp-server/tools/definitions/gnomad-get-variant-cooccurrence.tool.js';
import { initGnomadService } from '@/services/gnomad/gnomad-service.js';
import type { VariantCooccurrence } from '@/services/gnomad/types.js';
import { fakeCooccurrenceFetch, liveCooccurrence } from '../helpers/live-cooccurrence.js';

const CAVEAT =
  'Probability values are not well calibrated, particularly where both variants are extremely rare. Interpret with caution.';
const RULE =
  "gnomAD's browser reads p_compound_heterozygous above 0.55 as likely in trans (on different haplotypes) and below 0.02 as likely in cis (on the same haplotype), and makes no prediction between those, when the probability is null, or when both variants are singletons seen in the same individual";
const NO_CO_CARRIER =
  "No individual in gnomAD carries both variants, so these counts were computed from each variant's separate data and do not account for samples that may not be covered at both variant sites.";
/** A coverage claim for co-carrier pairs, which no notice makes. */
const CO_CARRIER_COVERAGE = 'Only samples covered at both variant sites are counted.';

/** A live pair gnomAD holds pre-computed, with 17 samples heterozygous for both. */
const PAIR = ['1-55505647-G-T', '1-55505651-C-T'];
/** A live pair no sample carries together, computed by gnomAD in the order sent. */
const SINGLETONS = ['1-55505515-G-A', '1-55505537-C-G'];
/** A live pair whose first variant has no exome carrier, so gnomAD gives no probability. */
const NULL_P = ['11-2181053-G-T', '11-2181054-C-T'];

type Success = VariantCooccurrence & { notice: string };

function textOf(result: { content: unknown[] }): string {
  return (result.content as { text?: string }[]).map((block) => block.text ?? '').join('\n');
}

async function call(variants: unknown) {
  return runToolContract(gnomadGetVariantCooccurrence, { variants } as never);
}

/** A successful call's structured result and its content text. */
async function succeed(variants: string[]) {
  const result = await call(variants);
  expect(result.isError, textOf(result)).toBeFalsy();
  return { data: result.structuredContent as Success, text: textOf(result) };
}

/** The error envelope of a failed call and its content text. */
async function fail(variants: unknown) {
  const result = await call(variants);
  expect(result.isError).toBe(true);
  const { error } = result.structuredContent as {
    error: {
      code: number;
      message: string;
      data?: { reason?: string; recovery?: { hint?: string } };
    };
  };
  return { error, text: textOf(result) };
}

/** A live reply with its overall block replaced, for readings no live pair shows. */
function withOverall(overall: {
  genotype_counts: number[];
  haplotype_counts: number[];
  p_compound_heterozygous: number | null;
}) {
  const body = structuredClone(liveCooccurrence(...PAIR)) as {
    data: { variant_cooccurrence: Record<string, unknown> };
  };
  Object.assign(body.data.variant_cooccurrence, overall);
  return body;
}

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
  initGnomadService({} as never, {} as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetServerConfig();
  vi.restoreAllMocks();
});

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/71
describe('gnomad_get_variant_cooccurrence — live pairs on both surfaces', () => {
  it('labels a pair no sample carries together, with null for the groups that miss a variant', async () => {
    fakeCooccurrenceFetch();

    const { data, text } = await succeed(['1-55516888-G-GA', '1-55505647-G-T']);

    expect(data).toMatchObject({
      variant_ids: ['1-55516888-G-GA', '1-55505647-G-T'],
      dataset: 'gnomad_r2_1',
      reference_genome: 'GRCh37',
      p_compound_heterozygous: 1,
      genotype_counts: { ref_het: 2283, ref_hom: 29, het_ref: 117, hom_ref: 2 },
    });
    const byGroup = Object.fromEntries(
      data.populations.map((population) => [population.id, population.p_compound_heterozygous]),
    );
    expect(byGroup).toEqual({
      afr: 1,
      amr: 1,
      asj: null,
      eas: null,
      fin: null,
      nfe: 1,
      oth: 1,
      sas: null,
    });
    expect(text).toContain('**p_compound_heterozygous:** 1');
    expect(text).toContain('ref_het 2283, ref_hom 29, het_ref 117');
    expect(text).toContain('hom_ref 2,');
    expect(text).toContain('- asj: p_compound_heterozygous null (no probability)');
    expect(text).toContain('- sas: p_compound_heterozygous null (no probability)');
  });

  it('carries a pair with het_het carriers, haplotype counts unrounded on both surfaces', async () => {
    fakeCooccurrenceFetch();

    const { data, text } = await succeed(PAIR);

    expect(data.genotype_counts).toMatchObject({ het_het: 17, ref_het: 1887, het_ref: 2194 });
    expect(data.haplotype_counts.ref_alt).toBeCloseTo(1931.95, 2);
    expect(data.haplotype_counts.alt_ref).toBeCloseTo(2266.95, 2);
    expect(data.p_compound_heterozygous).toBeCloseTo(0.9979, 4);
    expect(text).toContain(
      '**Haplotype counts (estimated):** ref_ref 189249.04847395173, ref_alt 1931.9515260482826, alt_ref 2266.9515260482826, alt_alt 0.04847395171724291',
    );
    expect(text).toContain('**p_compound_heterozygous:** 0.9979097658252426');
  });

  it('returns that pair sent reversed in gnomAD’s order with identical counts', async () => {
    fakeCooccurrenceFetch();
    const forward = await succeed(PAIR);

    const reversed = await succeed([...PAIR].reverse());

    expect(reversed.data.variant_ids).toEqual(PAIR);
    expect(reversed.data).toEqual(forward.data);
    expect(reversed.text).toBe(forward.text);
  });

  it('follows the order sent for a computed pair, the two carriers trading keys', async () => {
    fakeCooccurrenceFetch();

    const forward = await succeed(SINGLETONS);
    const reversed = await succeed([...SINGLETONS].reverse());

    const counts = (data: Success, id: string) =>
      data.populations.find((population) => population.id === id)?.genotype_counts;
    expect(forward.data).toMatchObject({
      variant_ids: SINGLETONS,
      p_compound_heterozygous: 1,
      genotype_counts: { het_het: 0 },
    });
    expect(counts(forward.data, 'nfe')).toMatchObject({ ref_het: 1, het_ref: 0 });
    expect(counts(forward.data, 'sas')).toMatchObject({ ref_het: 0, het_ref: 1 });
    expect(reversed.data.variant_ids).toEqual([...SINGLETONS].reverse());
    expect(counts(reversed.data, 'nfe')).toMatchObject({ ref_het: 0, het_ref: 1 });
    expect(counts(reversed.data, 'sas')).toMatchObject({ ref_het: 1, het_ref: 0 });
    expect(forward.text).toContain('variant_ids[0] 1-55505515-G-A, variant_ids[1] 1-55505537-C-G');
    expect(reversed.text).toContain('variant_ids[0] 1-55505537-C-G, variant_ids[1] 1-55505515-G-A');
  });

  it('keeps a null probability null on both surfaces, never 0', async () => {
    fakeCooccurrenceFetch();

    const { data, text } = await succeed(NULL_P);

    expect(data.p_compound_heterozygous).toBeNull();
    expect(text).toContain('**p_compound_heterozygous:** null (no probability)');
    expect(text).not.toMatch(/\*\*p_compound_heterozygous:\*\* 0/);
  });

  it('renders every key, count, and group of the output in content[]', async () => {
    fakeCooccurrenceFetch();

    const { data, text } = await succeed(PAIR);

    expect(text).toContain('**Dataset:** gnomad_r2_1 (GRCh37)');
    for (const counts of [data, ...data.populations]) {
      for (const [key, value] of [
        ...Object.entries(counts.genotype_counts),
        ...Object.entries(counts.haplotype_counts),
      ]) {
        expect(text).toContain(`${key} ${value}`);
      }
    }
    for (const population of data.populations) {
      expect(text).toContain(
        `- ${population.id}: p_compound_heterozygous ${population.p_compound_heterozygous ?? 'null (no probability)'} | genotypes ${Object.entries(
          population.genotype_counts,
        )
          .map(([key, value]) => `${key} ${value}`)
          .join(', ')} | haplotypes ${Object.entries(population.haplotype_counts)
          .map(([key, value]) => `${key} ${value}`)
          .join(', ')}`,
      );
    }
  });

  it('validates its output against the declared schema', async () => {
    fakeCooccurrenceFetch();

    const { data } = await succeed(SINGLETONS);
    const { notice: _notice, ...output } = data;

    expect(gnomadGetVariantCooccurrence.output.parse(output)).toEqual(output);
  });
});

describe('gnomad_get_variant_cooccurrence — the notice', () => {
  it('carries the calibration caveat verbatim and the reading rule on every success', async () => {
    fakeCooccurrenceFetch();

    for (const variants of [PAIR, SINGLETONS, NULL_P]) {
      const { data, text } = await succeed(variants);
      expect(data.notice).toContain(CAVEAT);
      expect(data.notice).toContain(RULE);
      expect(text).toContain(CAVEAT);
    }
  });

  it('reads a probability above 0.55 as likely in trans with no coverage sentence', async () => {
    fakeCooccurrenceFetch();

    const { data, text } = await succeed(PAIR);

    expect(data.notice).toMatch(
      /^Across all samples, this pair is likely in trans \(on different haplotypes\)\. /,
    );
    expect(data.notice).not.toContain(CO_CARRIER_COVERAGE);
    expect(data.notice).not.toContain(NO_CO_CARRIER);
    expect(text).toContain('this pair is likely in trans');
  });

  it('adds the separate-data note when no sample carries both variants', async () => {
    fakeCooccurrenceFetch();

    const { data, text } = await succeed(SINGLETONS);

    expect(data.notice).toContain('this pair is likely in trans');
    expect(data.notice).toContain(NO_CO_CARRIER);
    expect(data.notice).not.toContain(CO_CARRIER_COVERAGE);
    expect(text).toContain('No individual in gnomAD carries both variants');
  });

  it('joins the null reading and the separate-data note into one notice', async () => {
    fakeCooccurrenceFetch();

    const { data } = await succeed(NULL_P);

    expect(data.notice).toContain(
      'this pair gets no prediction, because gnomAD gives no probability.',
    );
    expect(data.notice).toContain(NO_CO_CARRIER);
    expect(data.notice).toContain(CAVEAT);
  });

  it.each([
    [
      'below 0.02 as likely in cis',
      {
        genotype_counts: [9000, 10, 0, 10, 5, 0, 0, 0, 0],
        haplotype_counts: [18000, 10, 10, 5],
        p: 0.01,
      },
      'is likely in cis (on the same haplotype)',
    ],
    [
      'between the thresholds as no prediction',
      {
        genotype_counts: [9000, 10, 0, 10, 5, 0, 0, 0, 0],
        haplotype_counts: [18000, 12, 12, 3],
        p: 0.3,
      },
      'gets no prediction, because the probability falls between the two thresholds',
    ],
    [
      'two singletons in the same individual as no prediction, whatever the probability',
      { genotype_counts: [9000, 0, 0, 0, 1, 0, 0, 0, 0], haplotype_counts: [18000, 0, 0, 1], p: 0 },
      'gets no prediction, because both variants are singletons seen in the same individual',
    ],
  ])('reads a probability %s', async (_label, overall, reading) => {
    fakeCooccurrenceFetch(() =>
      Response.json(
        withOverall({
          genotype_counts: overall.genotype_counts,
          haplotype_counts: overall.haplotype_counts,
          p_compound_heterozygous: overall.p,
        }),
      ),
    );

    const { data } = await succeed(PAIR);

    expect(data.notice).toContain(`Across all samples, this pair ${reading}.`);
    expect(data.notice).not.toContain(CO_CARRIER_COVERAGE);
    expect(data.notice).not.toContain(NO_CO_CARRIER);
  });
});

describe('gnomad_get_variant_cooccurrence — declared failures', () => {
  it.each([
    ['the same ID twice', ['1-55505647-G-T', '1-55505647-G-T'], 'Variants must be different'],
    [
      'two GRCh38 IDs',
      ['1-55051215-G-GA', '1-55039974-G-T'],
      'Variant co-occurrence is only available for variants found in gnomAD',
    ],
    [
      'variants in different genes',
      ['1-55505647-G-T', '11-2181054-C-T'],
      'Variant co-occurrence is only available for variants that occur in the same gene',
    ],
    [
      'two intronic variants',
      ['1-55505742-G-A', '1-55505753-G-A'],
      'Variant co-occurrence is only available for coding or UTR variants that occur in the same gene',
    ],
    [
      'a genome-only variant',
      ['1-55505647-G-T', '1-55505452-T-G'],
      'Variant co-occurrence is only available for variants that appear in gnomAD exome samples',
    ],
    [
      'a variant above 5% exome AF',
      ['1-55505647-G-T', '1-55505668-C-T'],
      'Variant co-occurrence is only available for variants with a global allele frequency ≤ 5%',
    ],
  ])(
    'fails %s as cooccurrence_unavailable with gnomAD’s sentence and the recovery, after one request',
    async (_label, variants, sentence) => {
      const { fetch } = fakeCooccurrenceFetch();
      const declared = gnomadGetVariantCooccurrence.errors?.find(
        (entry) => entry.reason === 'cooccurrence_unavailable',
      )?.recovery;

      const { error, text } = await fail(variants);

      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: sentence,
        data: { reason: 'cooccurrence_unavailable', recovery: { hint: declared } },
      });
      expect(text).toContain(sentence);
      expect(text).toContain('gnomad_get_variant on dataset gnomad_r2_1');
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it('keeps a GraphQL error outside the refusals a graphql_error', async () => {
    fakeCooccurrenceFetch(() =>
      Response.json({
        errors: [{ message: 'Invalid variant ID' }],
        data: { variant_cooccurrence: null },
      }),
    );

    const { error } = await fail(PAIR);

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: 'gnomAD GraphQL error: Invalid variant ID',
      data: { reason: 'graphql_error' },
    });
  });

  it.each([
    ['an rsID', 'rs11591147', 'is an rsID'],
    ['a region', '1-55505647-55505651', 'Malformed ID'],
    ['an empty string', '', 'Malformed ID'],
    ['a non-ACGT allele', '1-55505647-G-N', 'Malformed ID'],
    ['chromosome 23', '23-100-A-C', 'Malformed ID'],
  ])('fails %s as invalid_variant_id before any fetch', async (_label, id, message) => {
    const fetch = vi.spyOn(globalThis, 'fetch');

    const { error, text } = await fail(['1-55505647-G-T', id]);

    expect(error.data?.reason).toBe('invalid_variant_id');
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.message).toContain(message);
    expect(text).toContain('gnomad_get_variant on dataset gnomad_r2_1 resolves an rsID');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([['M-3243-A-G'], ['chrMT-3243-A-G'], ['MT:3243:A:G']])(
    'fails mitochondrial %s as mitochondrial_unsupported before any fetch',
    async (id) => {
      const fetch = vi.spyOn(globalThis, 'fetch');

      const { error } = await fail([id, '1-55505647-G-T']);

      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'mitochondrial_unsupported' },
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['one ID', ['1-55505647-G-T']],
    ['three IDs', ['1-55505647-G-T', '1-55505651-C-T', '1-55516888-G-GA']],
    ['a lone string', '1-55505647-G-T'],
  ])('rejects %s at input validation', async (_label, variants) => {
    const fetch = vi.spyOn(globalThis, 'fetch');

    const { error } = await fail(variants);

    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('gnomad_get_variant_cooccurrence — identifier normalization', () => {
  it.each([[['1:55505647:G:T', 'chr1-55505651-c-t']], [['chr1:55505647:G:T', '1-55505651-C-T']]])(
    'sends %j to gnomAD as canonical IDs',
    async (variants) => {
      const { requests } = fakeCooccurrenceFetch();

      const { data } = await succeed(variants);

      expect(requests[0]?.variables).toEqual({ variants: PAIR, dataset: 'gnomad_r2_1' });
      expect(data.variant_ids).toEqual(PAIR);
    },
  );

  it('with GNOMAD_NORMALIZE_IDS=false fails a colon form as invalid_variant_id with no fetch', async () => {
    vi.stubEnv('GNOMAD_NORMALIZE_IDS', 'false');
    resetServerConfig();
    const fetch = vi.spyOn(globalThis, 'fetch');

    const { error } = await fail(['1:55505647:G:T', '1-55505651-C-T']);

    expect(error.data?.reason).toBe('invalid_variant_id');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('gnomad_get_variant_cooccurrence — definition', () => {
  it('advertises exactly two IDs and a fixed dataset and build', () => {
    const input = z.toJSONSchema(gnomadGetVariantCooccurrence.input) as {
      properties?: Record<string, unknown>;
    };

    expect(input).toMatchObject({ properties: { variants: { minItems: 2, maxItems: 2 } } });
    expect(Object.keys(input.properties ?? {})).toEqual(['variants']);
    expect(z.toJSONSchema(gnomadGetVariantCooccurrence.output)).toMatchObject({
      properties: { dataset: { const: 'gnomad_r2_1' }, reference_genome: { const: 'GRCh37' } },
    });
  });

  it('tells the caller the IDs are GRCh37 and a GRCh38 ID can name another variant', () => {
    const { description } = gnomadGetVariantCooccurrence;

    expect(description).toContain('two GRCh37 chrom-pos-ref-alt IDs');
    expect(description).toContain('A GRCh38 ID can name a different GRCh37 variant or none');
    expect(description).toContain('gnomad_get_variant on dataset gnomad_r2_1');
    expect(description).toContain('multi-nucleotide variant');
    expect(description).toContain(
      'Data source: gnomAD (Broad Institute) — https://gnomad.broadinstitute.org/',
    );
  });
});
