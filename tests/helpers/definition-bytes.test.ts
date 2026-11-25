/**
 * @fileoverview Tests for serverAuthoredStrings and serverAuthoredBytes, the
 * server-authored text of a tool definition (description, schema descriptions,
 * errors[].when).
 * @module tests/helpers/definition-bytes.test
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import { serverAuthoredBytes, serverAuthoredStrings } from './definition-bytes.js';

const Range = z.object({
  lo: z.number().describe('Low end.'),
  hi: z.number().describe('High end.'),
});

/** A definition exercising every counted surface: nested and reused objects, nullable, enrichment, errors. */
function probeItems() {
  return tool('probe_items', {
    description: 'Fetch items.',
    input: z.object({ ids: z.array(z.string()).describe('Item IDs.') }),
    output: z.object({
      a: Range.describe('First range.'),
      b: Range.describe('Second range.'),
      description: z.string().describe('Its café note.'),
      note: z.string().nullable().describe('Nullable note.'),
    }),
    enrichment: { notice: z.string().optional().describe('Notice.') },
    errors: [
      {
        reason: 'no_match',
        code: JsonRpcErrorCode.NotFound,
        when: 'No item matched.',
        recovery: 'Broaden the query and try again.',
      },
    ],
    handler: async () => ({
      a: { lo: 0, hi: 1 },
      b: { lo: 0, hi: 1 },
      description: '',
      note: null,
    }),
  });
}

describe('serverAuthoredStrings', () => {
  it('lists the description first, then every schema description per emitted copy and each when', () => {
    const strings = serverAuthoredStrings(probeItems());

    expect(strings[0]).toBe('Fetch items.');
    expect(strings.at(-1)).toBe('No item matched.');
    expect(strings.toSorted()).toEqual(
      [
        'Fetch items.',
        'Item IDs.',
        'First range.',
        'Low end.',
        'High end.',
        'Second range.',
        'Low end.',
        'High end.',
        'Its café note.',
        'Nullable note.',
        'Notice.',
        'No item matched.',
      ].toSorted(),
    );
  });
});

describe('serverAuthoredBytes', () => {
  it('sums the description, every schema description at each emitted path, and errors[].when', () => {
    /**
     * 12 description + 9 input + output (12 + 13 + 2 × (8 + 9) for the reused Range +
     * 15 for "café" in UTF-8 + 14) + 7 enrichment + 16 when. Recovery text is not counted.
     */
    expect(serverAuthoredBytes(probeItems())).toBe(132);
  });

  it('counts nothing for absent enrichment and errors', () => {
    const definition = tool('probe_flag', {
      description: 'Two.',
      input: z.object({}),
      output: z.object({ ok: z.boolean().describe('Done.') }),
      handler: async () => ({ ok: true }),
    });
    expect(serverAuthoredBytes(definition)).toBe(9);
  });
});
