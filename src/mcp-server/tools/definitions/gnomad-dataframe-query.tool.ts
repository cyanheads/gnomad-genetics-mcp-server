/**
 * @fileoverview gnomad_dataframe_query — run a read-only SQL SELECT against a
 * canvas table staged by gnomad_list_gene_variants or gnomad_search_clinvar and
 * return one page of the result. Pages are cut on the server from the rows the
 * canvas query returns (bounded by the canvas row cap): offset/limit select the
 * slice, and a 10,000-character row-JSON budget ends a page early so both
 * surfaces stay small. The caller's SQL and the canvas gate are untouched.
 * Mandatory companion to any tool that emits a canvas_id.
 * @module mcp-server/tools/definitions/gnomad-dataframe-query.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas-accessor.js';
import { previewLength } from '../canvas-staging.js';

/**
 * Characters of row JSON one page may carry. A full page renders twice (the
 * rows in structuredContent and again in the format() text), which keeps a
 * response under ~24 KB.
 */
const PAGE_CHARS = 10_000;

const PAGE_LIMIT_DEFAULT = 100;
const PAGE_LIMIT_MAX = 500;

export const gnomadDataframeQuery = tool('gnomad_dataframe_query', {
  title: 'gnomad-genetics-mcp-server: dataframe query',
  description:
    'Run a read-only SQL SELECT against a canvas table staged by gnomad_list_gene_variants (table gene_variants) or gnomad_search_clinvar (table clinvar_variants) and return one page of the result. Use the canvas_id and table_name those tools returned to rank by allele frequency, group by consequence class, count loss-of-function variants, or filter the full set the inline preview only sampled. A page holds up to limit rows (default 100, max 500) and ends early once its rows reach 10,000 characters of JSON; continue from next_offset until it is null. Each page re-runs the SQL, so stable paging needs an ORDER BY over a unique key (such as variant_id) and an unchanged table. Paging reaches the server row cap: above it total is null and later rows are reachable only by filtering or aggregating in SQL. SELECT statements only — writes, DDL, and file/HTTP table functions are rejected by the canvas gate. Call gnomad_dataframe_describe first to discover staged table and column names.',
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  input: z.object({
    canvas_id: CanvasIdSchema.describe(
      'Canvas ID returned by gnomad_list_gene_variants or gnomad_search_clinvar.',
    ),
    sql: z
      .string()
      .min(1)
      .describe(
        'Read-only SQL SELECT. Reference tables by the names the staging tool returned (e.g. gene_variants). Add an ORDER BY over a unique key when paging.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Row offset of the page to return. Start at 0, then pass next_offset from the previous page.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(PAGE_LIMIT_MAX)
      .default(PAGE_LIMIT_DEFAULT)
      .describe(
        'Maximum rows on the page (1–500). A page also ends before its rows pass 10,000 characters of JSON.',
      ),
  }),
  output: z.object({
    rows: z
      .array(
        z
          .object({})
          .passthrough()
          .describe('One result row — dynamic columns per the SQL projection.'),
      )
      .describe('This page of result rows, in result order.'),
    columns: z.array(z.string()).describe('Column names in the result, in order.'),
    offset: z.number().describe('Row offset this page starts at.'),
    returned: z
      .number()
      .describe(
        'Rows on this page — fewer than limit when the 10,000-character row budget or the end of the result ends it early.',
      ),
    total: z
      .number()
      .nullable()
      .describe(
        'Rows the SQL produced; null when the result exceeds the server row cap, whose later rows paging cannot reach.',
      ),
    truncated: z
      .boolean()
      .describe(
        'True when result rows exist after this page, including rows past the row cap that next_offset cannot reach.',
      ),
    next_offset: z
      .number()
      .nullable()
      .describe(
        'offset for the next page; null when no page follows (end of the result, or the row cap reached).',
      ),
  }),
  errors: [
    {
      reason: 'canvas_disabled',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'DataCanvas is not enabled on this server instance.',
      recovery:
        'Set CANVAS_PROVIDER_TYPE=duckdb and restart; the staging tools then return a queryable canvas_id.',
    },
    {
      reason: 'row_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The first row of the requested page serializes to more than 10,000 characters of JSON, so no page can hold it.',
      recovery:
        'Select a narrower projection — fewer columns, or long text cut with substr(column, 1, 500) — so each row stays under 10,000 characters.',
    },
  ],

  async handler(input, ctx) {
    const canvas = getCanvas();
    if (!canvas) {
      throw ctx.fail(
        'canvas_disabled',
        'DataCanvas is not enabled. Set CANVAS_PROVIDER_TYPE=duckdb.',
      );
    }
    const instance = await canvas.acquire(input.canvas_id, ctx);
    const result = await instance.query(input.sql, { signal: ctx.signal });
    const capped = result.truncated ?? false;

    const candidates = result.rows.slice(input.offset, input.offset + input.limit);
    const returned = previewLength(candidates, PAGE_CHARS);
    const [first] = candidates;
    if (returned === 0 && first) {
      const rowChars = JSON.stringify(first).length;
      throw ctx.fail(
        'row_too_large',
        `Row at offset ${input.offset} is ${rowChars} characters of JSON, over the ${PAGE_CHARS}-character page budget.`,
        { offset: input.offset, row_chars: rowChars },
      );
    }
    const end = input.offset + returned;
    const more = end < result.rows.length;
    const page = {
      rows: candidates.slice(0, returned),
      columns: result.columns,
      offset: input.offset,
      returned,
      total: capped ? null : result.rows.length,
      truncated: more || capped,
      next_offset: more ? end : null,
    };
    ctx.log.info('gnomad_dataframe_query executed', {
      canvas_id: instance.canvasId,
      offset: page.offset,
      returned: page.returned,
      total: page.total,
      truncated: page.truncated,
    });
    return page;
  },

  format: (result) => {
    const lines = [
      `**columns:** ${result.columns.join(', ')}`,
      `**offset:** ${result.offset} · **returned:** ${result.returned} · **total:** ${result.total ?? 'null'} · **truncated:** ${result.truncated} · **next_offset:** ${result.next_offset ?? 'null'}`,
    ];
    if (result.total === null) {
      lines.push(
        'The result exceeds the server row cap: total is unknown and rows past the cap are unreachable by paging — filter or aggregate in SQL to reach them.',
      );
    }
    for (const row of result.rows) lines.push(`- ${JSON.stringify(row)}`);
    if (result.next_offset !== null) lines.push(`Continue with offset ${result.next_offset}.`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
