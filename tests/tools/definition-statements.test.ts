/**
 * @fileoverview Statement discipline in the tools/list text of the gnomAD and
 * ClinVar tools and gnomad_dataframe_query: a rule that spans fields is stated in
 * exactly one server-authored string of its tool (description, schema
 * descriptions, errors[].when), and each caveat that changes how a value reads
 * still reaches the caller. https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/83
 * @module tests/tools/definition-statements.test
 */

import { type AnyToolDefinition, z } from '@cyanheads/mcp-ts-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GNOMAD_DATASETS } from '@/config/server-config.js';
import { gnomadDataframeQuery } from '@/mcp-server/tools/definitions/gnomad-dataframe-query.tool.js';
import { gnomadGetCoverage } from '@/mcp-server/tools/definitions/gnomad-get-coverage.tool.js';
import { gnomadGetGeneConstraint } from '@/mcp-server/tools/definitions/gnomad-get-gene-constraint.tool.js';
import { gnomadGetVariant } from '@/mcp-server/tools/definitions/gnomad-get-variant.tool.js';
import { gnomadGetVariantCooccurrence } from '@/mcp-server/tools/definitions/gnomad-get-variant-cooccurrence.tool.js';
import { gnomadListGeneVariants } from '@/mcp-server/tools/definitions/gnomad-list-gene-variants.tool.js';
import { gnomadSearchClinvar } from '@/mcp-server/tools/definitions/gnomad-search-clinvar.tool.js';
import { serverAuthoredStrings } from '../helpers/definition-bytes.js';

const strings = (definition: AnyToolDefinition, pattern: RegExp) =>
  serverAuthoredStrings(definition).filter((text) => pattern.test(text));
const listing = (definition: AnyToolDefinition) => serverAuthoredStrings(definition).join('\n');

/** The dataset → build mapping: a string naming exac beside GRCh37. */
const BUILD_RULE = /exac[^.]*GRCh37|GRCh37[^.]*exac/;

/** The ACMG/AMP threshold pointer: a string naming BA1, BS1, or ACMG, so a BS1-only restatement counts too. */
const ACMG_POINTER = /\bB[AS]1\b|ACMG/;

const ONCE: { definition: AnyToolDefinition; rule: string; pattern: RegExp }[] = [
  {
    definition: gnomadGetVariant,
    rule: 'the FAF95 definition',
    pattern: /lower bound of the 95% confidence interval/,
  },
  { definition: gnomadGetVariant, rule: 'the BA1/BS1 pointer', pattern: ACMG_POINTER },
  { definition: gnomadGetVariant, rule: "the browser's QC rule", pattern: /browser hides/ },
  { definition: gnomadGetVariant, rule: 'the build rule', pattern: BUILD_RULE },
  {
    definition: gnomadGetVariant,
    rule: 'the joint-data rule',
    pattern: /no joint data|publishes joint data/,
  },
  { definition: gnomadGetVariant, rule: 'the subset FAF null', pattern: /parent release's FAF/ },
  { definition: gnomadGetVariant, rule: 'the AC 0 and singleton FAF null', pattern: /singleton/ },
  {
    definition: gnomadGetVariant,
    rule: 'that a failure arrives per item in failed[]',
    pattern: /per[- ]item in failed/,
  },
  {
    definition: gnomadGetVariant,
    rule: "that transcript_id's consequence can sit on a minor isoform",
    pattern: /can be a minor isoform/,
  },
  { definition: gnomadGetGeneConstraint, rule: 'the build rule', pattern: BUILD_RULE },
  {
    definition: gnomadGetGeneConstraint,
    rule: 'the subset constraint routing',
    pattern: /no subset constraint/,
  },
  { definition: gnomadGetGeneConstraint, rule: 'the LOEUF thresholds', pattern: /< 0\.45/ },
  {
    definition: gnomadGetGeneConstraint,
    rule: 'what exac leaves null',
    pattern: /null on exac|on exac[^.]*null|empty on exac/,
  },
  {
    definition: gnomadGetGeneConstraint,
    rule: 'that the mitochondrial table is the same on every dataset',
    pattern: /same table on every dataset/,
  },
  {
    definition: gnomadGetGeneConstraint,
    rule: 'that the nuclear thresholds do not apply to mitochondrial constraint',
    pattern: /thresholds do not apply/,
  },
  {
    definition: gnomadGetGeneConstraint,
    rule: 'the heteroplasmy units',
    pattern: /maximum heteroplasmy/,
  },
  {
    definition: gnomadGetVariantCooccurrence,
    rule: 'the count key order',
    pattern: /variant_ids\[0\]'s/,
  },
  {
    definition: gnomadGetVariantCooccurrence,
    rule: 'that a null probability is not 0',
    pattern: /never read null as 0/,
  },
  { definition: gnomadGetVariantCooccurrence, rule: 'the 5% eligibility rule', pattern: /5%/ },
  {
    definition: gnomadGetVariantCooccurrence,
    rule: 'that gnomad_r2_1 is the only co-occurrence dataset',
    pattern: /only (dataset|one) gnomAD serves co-occurrence/,
  },
  {
    definition: gnomadSearchClinvar,
    rule: 'that post-fetch filters shorten a window',
    pattern: /fewer rows/,
  },
  {
    definition: gnomadSearchClinvar,
    rule: 'that total_found counts candidates',
    pattern: /candidate count/,
  },
  {
    definition: gnomadSearchClinvar,
    rule: 'the dataframe workflow',
    pattern: /gnomad_dataframe_describe/,
  },
  { definition: gnomadGetCoverage, rule: 'the build rule', pattern: BUILD_RULE },
  {
    definition: gnomadGetCoverage,
    rule: 'the subset coverage routing',
    pattern: /no (subset coverage|coverage for subsets)/,
  },
  { definition: gnomadGetCoverage, rule: 'the bucket width rule', pattern: /850 bp/ },
  { definition: gnomadGetCoverage, rule: 'the exon window', pattern: /±75/ },
  {
    definition: gnomadGetCoverage,
    rule: 'that bases without coverage are unknown, not zero depth',
    pattern: /not (counted as|measured) zero depth|callability (is )?unknown|unknown, not zero/i,
  },
  { definition: gnomadGetCoverage, rule: "gnomAD's bucket rounding", pattern: /0\.01/ },
  {
    definition: gnomadGetCoverage,
    rule: 'that exactly one target is supplied',
    pattern: /Mutually exclusive|Supply exactly one/,
  },
  {
    definition: gnomadDataframeQuery,
    rule: 'the page character ceiling',
    pattern: /4,000,000/,
  },
  {
    definition: gnomadListGeneVariants,
    rule: 'the FAF95 definition',
    pattern: /lower bound of the 95% confidence interval/,
  },
  { definition: gnomadListGeneVariants, rule: 'the BA1/BS1 pointer', pattern: ACMG_POINTER },
  {
    definition: gnomadListGeneVariants,
    rule: "the browser's QC rule",
    pattern: /at least one callset|every callset carrying|browser hides/,
  },
  { definition: gnomadListGeneVariants, rule: 'the build rule', pattern: BUILD_RULE },
  {
    definition: gnomadListGeneVariants,
    rule: 'which datasets carry no FAF on their rows',
    pattern: /gnomad_r3, its subsets, and exac/,
  },
  {
    definition: gnomadListGeneVariants,
    rule: 'that the consequence can sit on a minor isoform',
    pattern: /minor isoform|non-primary isoform|milder or absent/,
  },
  {
    definition: gnomadListGeneVariants,
    rule: 'that exactly one target is supplied',
    pattern: /Mutually exclusive|Supply exactly one/,
  },
  {
    definition: gnomadListGeneVariants,
    rule: 'the dataframe workflow',
    pattern: /gnomad_dataframe_describe/,
  },
];

/** pass_only's count source: the callsets a row without joint data reads under it. */
const PASS_ONLY_COUNTS = /under pass_only|passing callsets|callsets that passed/;

describe('each cross-field rule is stated in one string of its tool (#83)', () => {
  it.each(ONCE.map((entry) => [entry.definition.name, entry.rule, entry] as const))(
    '%s states %s once',
    (_name, _rule, { definition, pattern }) => {
      expect(strings(definition, pattern)).toHaveLength(1);
    },
  );

  it("gnomad_list_gene_variants states pass_only's count source on pass_only alone", () => {
    expect(strings(gnomadListGeneVariants, PASS_ONLY_COUNTS)).toEqual([
      gnomadListGeneVariants.input.shape.pass_only.description,
    ]);
  });
});

describe('each caveat that changes how a value reads still reaches tools/list (#83)', () => {
  it.each([
    [
      gnomadGetVariant,
      "a subset's null FAF",
      /gnomad_r4 or gnomad_r3 subset[^.]*parent release's FAF/,
    ],
    [gnomadGetVariant, 'QC-failed counts as low-confidence', /filtered[^.]*low-confidence/],
    [gnomadGetVariant, 'the joint AN', /joint AN[^.]*every callable sample/],
    [gnomadGetVariant, 'FAF rather than raw AF for BA1/BS1', /BA1 or BS1[^.]*raw AF/],
    [gnomadGetVariant, 'absence paired with coverage', /gnomad_get_coverage/],
    [gnomadGetGeneConstraint, 'the subset constraint routing', /subsets?[^.]*parent/],
    [gnomadGetGeneConstraint, 'pLI as the exac measure', /on exac[^.]*pLI is the intolerance/],
    [
      gnomadGetGeneConstraint,
      'the nuclear thresholds not applying to mitochondrial genes',
      /LOEUF thresholds do not apply/,
    ],
    [gnomadGetGeneConstraint, 'sparse constraint reported as null', /never fabricated/],
    [gnomadGetVariantCooccurrence, 'GRCh37-only IDs', /two GRCh37 chrom-pos-ref-alt IDs/],
    [gnomadGetVariantCooccurrence, "gnomAD's calibration caveat", /calibration caveat/],
    [gnomadSearchClinvar, 'indel IDs absent from gnomAD', /absent from gnomAD's callsets/],
    [gnomadSearchClinvar, 'an ambiguous rsID', /one rsID can match several/i],
    [gnomadGetCoverage, 'the subset coverage routing', /subset[^.]*parent/],
    [gnomadGetCoverage, 'missing bases as unknown callability', /callability is unknown/i],
    [
      gnomadListGeneVariants,
      'no FAF on gnomad_r3, its subsets, and exac rows',
      /gnomad_r3, its subsets, and exac[^.]*no FAF/,
    ],
    [
      gnomadListGeneVariants,
      "a subset's own FAF on gnomad_r4_non_ukb and gnomad_r2_1 subsets",
      /gnomad_r4_non_ukb's and each gnomad_r2_1 subset's own/,
    ],
    [gnomadListGeneVariants, 'QC-failed counts as low-confidence', /filtered[^.]*low-confidence/],
    [gnomadListGeneVariants, 'the joint AN', /joint AN[^.]*every callable sample/],
    [gnomadListGeneVariants, 'FAF rather than raw AF for BA1/BS1', /BA1 or BS1[^.]*raw AF/],
  ] as const)('%#: %s carries %s', (definition, _caveat, pattern) => {
    expect(listing(definition)).toMatch(pattern);
  });

  it("gnomad_list_gene_variants' ac counts a QC-failed callset only without pass_only", () => {
    // pass_only reads a row without joint data from its passing callsets, so ac's claim must yield to it.
    expect(gnomadListGeneVariants.output.shape.preview.element.shape.ac.description).toMatch(
      /QC-failed one included unless pass_only/,
    );
  });

  it.each([gnomadGetVariant, gnomadListGeneVariants, gnomadGetGeneConstraint, gnomadGetCoverage])(
    '$name lists every dataset with its build, and that a subset can leave a callset unchanged',
    (definition) => {
      const { properties } = z.toJSONSchema(definition.input, { io: 'input' }) as unknown as {
        properties: { dataset: { description: string } };
      };
      const dataset = properties.dataset.description;
      for (const value of GNOMAD_DATASETS) {
        expect(dataset).toMatch(new RegExp(`(?<!\\w)${value}(?!\\w)`));
      }
      expect(dataset).toMatch(/\(GRCh38\).*\(GRCh37\)/s);
      expect(dataset).toMatch(/genome counts equal gnomad_r4's/);
    },
  );
});

describe('listings with CANVAS_PROVIDER_TYPE=none name no dataframe tool (#83)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('names no gnomad_dataframe_ tool in any listing of these tools', async () => {
    vi.stubEnv('CANVAS_PROVIDER_TYPE', 'none');
    vi.resetModules();
    const definitions = [
      (await import('@/mcp-server/tools/definitions/gnomad-get-variant.tool.js')).gnomadGetVariant,
      (await import('@/mcp-server/tools/definitions/gnomad-list-gene-variants.tool.js'))
        .gnomadListGeneVariants,
      (await import('@/mcp-server/tools/definitions/gnomad-get-gene-constraint.tool.js'))
        .gnomadGetGeneConstraint,
      (await import('@/mcp-server/tools/definitions/gnomad-get-variant-cooccurrence.tool.js'))
        .gnomadGetVariantCooccurrence,
      (await import('@/mcp-server/tools/definitions/gnomad-get-coverage.tool.js'))
        .gnomadGetCoverage,
      (await import('@/mcp-server/tools/definitions/gnomad-search-clinvar.tool.js'))
        .gnomadSearchClinvar,
    ];
    for (const definition of definitions) {
      expect(listing(definition), definition.name).not.toContain('gnomad_dataframe_');
    }
  });
});
