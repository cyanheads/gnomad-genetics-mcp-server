/**
 * @fileoverview Formatter regressions: upstream Markdown syntax stays literal
 * in content while structured output retains the original strings and numbers.
 * @module tests/tools/markdown-output.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { gnomadDataframeQuery } from '@/mcp-server/tools/definitions/gnomad-dataframe-query.tool.js';
import { gnomadGetCoverage } from '@/mcp-server/tools/definitions/gnomad-get-coverage.tool.js';
import { gnomadListGeneVariants } from '@/mcp-server/tools/definitions/gnomad-list-gene-variants.tool.js';
import { gnomadSearchClinvar } from '@/mcp-server/tools/definitions/gnomad-search-clinvar.tool.js';

describe('Markdown output preserves upstream values', () => {
  it('escapes coverage targets while preserving numeric precision and unknowns', async () => {
    const output = {
      target: 'A*p* [x](https://example.com) <b>',
      target_kind: 'gene' as const,
      dataset: 'gnomad_r4',
      coverage_dataset: 'gnomad_r4',
      reference_genome: 'GRCh38',
      summaries: [
        {
          source: 'exome' as const,
          positions: 123,
          target_positions: 123,
          missing_positions: 0,
          bucket_count: 3,
          bucket_size: 15,
          mean_depth: 12.3456,
          median_depth: null,
          fraction_over_1: 0.98765,
          fraction_over_5: null,
          fraction_over_10: null,
          fraction_over_15: null,
          fraction_over_20: null,
          fraction_over_25: null,
          fraction_over_30: null,
          fraction_over_50: null,
          fraction_over_100: null,
        },
      ],
    };
    const result = await runToolContract(
      { ...gnomadGetCoverage, handler: async () => output },
      { gene: 'PCSK9' },
    );
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(output);
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain('**Coverage — gene:** A\\*p\\* \\[x\\](https://example.com) \\<b>');
    expect(text).toContain('**Buckets:** 3 × 15 bp');
    expect(text).toContain('**Mean depth:** 12.3 | **Median depth:** Not available');
    expect(text).toContain('1×=98.8% 5×=Not available');
  });

  it('escapes Markdown inside arbitrary SQL columns and rows without changing the data', async () => {
    const output = {
      rows: [{ '*label*': '[x](https://example.com)', source: 'exome|genome' }],
      columns: ['*label*', 'source'],
      offset: 0,
      returned: 1,
      total: 1,
      truncated: false,
      next_offset: null,
    };
    const result = await runToolContract(
      { ...gnomadDataframeQuery, handler: async () => output },
      { canvas_id: 'cnvquery01', sql: 'SELECT 1' },
    );
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(output);
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain('**columns:** \\*label\\*, source');
    expect(text).toContain('"source":"exome\\|genome"');
    expect(text).toContain('"\\*label\\*":"\\[x\\](https://example.com)"');
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/70
  it('escapes the echoed list target while structured output keeps it as given', async () => {
    const output = {
      target: 'PCSK9*[x](https://example.com)',
      target_kind: 'gene' as const,
      filters: {
        consequence_class: 'lof' as const,
        lof_confidence: 'HC' as const,
        max_af: 0.001,
        max_faf: null,
        pass_only: true as const,
      },
      preview: [],
      canvas_id: '',
      table_name: '',
      spilled: false,
      total: 0,
      truncated: false,
      next_offset: null,
      qc_filtered: 0,
      dataset: 'gnomad_r4',
      reference_genome: 'GRCh38',
    };
    const result = await runToolContract(
      { ...gnomadListGeneVariants, handler: async () => output },
      { gene: 'PCSK9' },
    );
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(output);
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain(
      '**Target:** gene PCSK9\\*\\[x\\](https://example.com) | **Filters:** consequence_class=lof, lof_confidence=HC, max_af=0.001, pass_only=true',
    );
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/65
  it("escapes a row's HGVS and rsIDs while structured output keeps them as gnomAD sent them", async () => {
    const row = {
      variant_id: '9-21968220-C-A',
      af: 0.00001,
      ac: 1,
      an: 100_000,
      consequence: '3_prime_UTR_variant',
      consequence_class: 'other' as const,
      homozygote_count: 0,
      hemizygote_count: 0,
      faf95_max: null,
      faf95_max_group: null,
      source: 'exome',
      flags: '',
      exome_filters: '',
      genome_filters: null,
      qc_status: 'pass' as const,
      transcript_id: 'ENST00000304494',
      consequence_transcript: 'mane_select' as const,
      lof: null,
      hgvsc: 'c.*9G>T',
      hgvsp: null,
      lof_filter: null,
      lof_flags: 'PHYLOCSF_WEAK',
      rsids: 'rs863224604|rs1',
    };
    const output = {
      target: 'CDKN2A',
      target_kind: 'gene' as const,
      filters: {
        consequence_class: null,
        lof_confidence: null,
        max_af: null,
        max_faf: null,
        pass_only: null,
      },
      preview: [row],
      canvas_id: '',
      table_name: '',
      spilled: false,
      total: 1,
      truncated: false,
      next_offset: null,
      qc_filtered: 0,
      dataset: 'gnomad_r4',
      reference_genome: 'GRCh38',
    };
    const result = await runToolContract(
      { ...gnomadListGeneVariants, handler: async () => output },
      { gene: 'CDKN2A', annotations: true },
    );
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(output);
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    // A null lof, hgvsp, and lof_filter render no field at all.
    expect(text).toMatch(
      /\| transcript ENST00000304494 \(mane_select\) \| HGVSc c\.\\\*9G>T \| LoF flags PHYLOCSF_WEAK \| rsIDs rs863224604\\\|rs1$/m,
    );
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/70
  it('escapes the echoed ClinVar gene and significance while structured output keeps them as given', async () => {
    const output = {
      gene: 'PCSK9*',
      filters: { clinical_significance: 'risk *factor*', min_review_stars: 2 },
      preview: [],
      canvas_id: '',
      table_name: '',
      spilled: false,
      total: 0,
      total_found: 0,
      truncated: false,
      next_offset: null,
      unavailable_ids: [],
    };
    const result = await runToolContract(
      { ...gnomadSearchClinvar, handler: async () => output },
      { gene: 'PCSK9' },
    );
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(output);
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain(
      '**Gene:** PCSK9\\* | **Filters:** clinical_significance=risk \\*factor\\*, min_review_stars=2',
    );
  });
});
