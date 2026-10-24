/**
 * @fileoverview Formatter regressions: upstream Markdown syntax stays literal
 * in content while structured output retains the original strings and numbers.
 * @module tests/tools/markdown-output.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { gnomadDataframeQuery } from '@/mcp-server/tools/definitions/gnomad-dataframe-query.tool.js';
import { gnomadGetCoverage } from '@/mcp-server/tools/definitions/gnomad-get-coverage.tool.js';

describe('Markdown output preserves upstream values', () => {
  it('escapes coverage targets while preserving numeric precision and unknowns', async () => {
    const output = {
      target: 'A*p* [x](https://example.com) <b>',
      target_kind: 'gene' as const,
      dataset: 'gnomad_r4',
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
});
