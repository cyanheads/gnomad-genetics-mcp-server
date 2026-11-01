/**
 * @fileoverview gnomad_dataframe_query — run a read-only SQL SELECT against a
 * canvas table staged by gnomad_list_gene_variants or gnomad_search_clinvar and
 * return one page of the result. The page is cut in DuckDB: the caller's SQL is
 * registered as a view for the length of the call, which puts it through the
 * canvas gate exactly as sent, and the page reads that view under LIMIT/OFFSET,
 * where a running sum of each row's JSON width ends it before the row that
 * would take it past 4,000,000 characters. A page reads at most `limit` rows
 * from the engine, plus one count capped at the canvas row cap, which is where
 * paging stops. Registered only while DataCanvas is on. Mandatory
 * companion to any tool that emits a canvas_id.
 * @module mcp-server/tools/definitions/gnomad-dataframe-query.tool
 */

import { disabledTool, tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema, quoteIdentifier } from '@cyanheads/mcp-ts-core/canvas';
import { config } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { isCanvasEnabled } from '@/config/server-config.js';
import { getCanvas } from '@/services/canvas-accessor.js';
import { previewLength } from '../canvas-staging.js';
import { type CountLimit, clampLimit, limitSchema } from '../count-limit.js';

/** Characters of row JSON one page may carry; a page ends before the row that would pass it. */
const PAGE_CEILING_CHARS = 4_000_000;

const LIMIT: CountLimit = { tool: 'gnomad_dataframe_query', default: 25, cap: 3_000 };

/** Each row's JSON width summed in result order, all of its columns measured as one struct. */
const RUNNING_CHARS =
  'sum(length(to_json(struct_pack(*COLUMNS(*))))) OVER (ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)';

/**
 * Up to `span` rows of `view` from `offset`, ending before the row that would
 * take the page's row JSON past the ceiling. The view's `columns` are the
 * result's `names` as DuckDB made them unique (`a`, `a_1`); each is renamed back
 * by position, so duplicate and case-only names come back as the SQL wrote
 * them. The running total takes a name no column has, so no column can stand
 * in for it.
 */
function pageSql(view: string, columns: string[], names: string[], offset: number, span: number) {
  const taken = new Set(columns.map((column) => column.toLowerCase()));
  let total = 'page_chars';
  while (taken.has(total)) total += '_';
  const running = quoteIdentifier(total);
  const renames = columns.flatMap((column, i) => {
    const name = names[i];
    return name === undefined || name === column
      ? []
      : [`${quoteIdentifier(column)} AS ${quoteIdentifier(name)}`];
  });
  const rename = renames.length > 0 ? ` RENAME (${renames.join(', ')})` : '';
  return `SELECT * EXCLUDE (${running})${rename} FROM (SELECT *, ${RUNNING_CHARS} AS ${running} FROM (SELECT * FROM ${view} LIMIT ${span} OFFSET ${offset})) WHERE ${running} <= ${PAGE_CEILING_CHARS}`;
}

/** Rows `view` produces, counted up to one past `rowCap` so a larger result reads as capped. */
const countSql = (view: string, rowCap: number) =>
  `SELECT count(*) AS n FROM (SELECT 1 FROM ${view} LIMIT ${rowCap + 1})`;

/** The JSON width of the row at `offset`, without reading the row. */
const widthSql = (view: string, offset: number) =>
  `SELECT length(to_json(struct_pack(*COLUMNS(*)))) AS row_chars FROM (SELECT * FROM ${view} LIMIT 1 OFFSET ${offset})`;

const gnomadDataframeQueryDef = tool('gnomad_dataframe_query', {
  title: 'gnomad-genetics-mcp-server: dataframe query',
  description:
    'Run a read-only SQL SELECT against a canvas table staged by gnomad_list_gene_variants (table gene_variants) or gnomad_search_clinvar (table clinvar_variants) and return one page of the result. Use the canvas_id and table_name those tools returned to rank by allele frequency, group by consequence class, count loss-of-function variants, or filter the full set the inline preview only sampled. A page holds up to limit rows (default 25, capped at 3,000) and ends before a row that would take its row JSON past 4,000,000 characters; continue from next_offset until it is null. Each page re-runs the SQL, so stable paging needs an ORDER BY over a unique key (such as variant_id) and an unchanged table. Paging reaches the server row cap: above it total is null and later rows are reachable only by filtering or aggregating in SQL. BIGINT values, such as the staged ac and an counts and COUNT(*), arrive as JSON strings to keep their precision; CAST(col AS INTEGER) returns a number. SELECT statements only — writes, DDL, and file/HTTP table functions are rejected by the canvas gate. Call gnomad_dataframe_describe first to discover staged table and column names.',
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
    limit: limitSchema(
      LIMIT,
      'Maximum rows on the page. A page also ends before a row that would take its row JSON past 4,000,000 characters.',
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
        'Rows on this page — fewer than limit when the end of the result, the row cap, or the 4,000,000-character row-JSON ceiling ends it early.',
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
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Set when limit was above its cap: the requested and applied values.'),
  },
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
      when: 'The first row of the requested page serializes to more than 4,000,000 characters of JSON, so no page can hold it.',
      recovery:
        'Select a narrower projection — fewer columns, or long text cut with substr(column, 1, 500) — so each row stays under 4,000,000 characters.',
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
    const { applied: limit, notice } = clampLimit(ctx, LIMIT, input.limit);
    const instance = await canvas.acquire(input.canvas_id, ctx);

    // The provider is built with this cap; paging reaches only the result's first rowCap rows.
    const rowCap = config.canvas.defaultRowLimit;
    const reachable = Math.max(0, Math.min(limit, rowCap - input.offset));
    // The page statement asks for at least one row, so it always runs the caller's query.
    const span = Math.max(1, reachable);
    const read = (sql: string, rowLimit: number) =>
      instance.query(sql, { rowLimit, signal: ctx.signal });

    // Registering runs the canvas gate over the SQL as sent, so a refusal is the one a direct query gets.
    const view = `page_${crypto.randomUUID().replaceAll('-', '')}`;
    try {
      const { columns } = await instance.registerView(view, input.sql, { signal: ctx.signal });
      // DESCRIBE binds the SQL without running it and reports the result's names as the SQL wrote them.
      const described = await read(`DESCRIBE ${input.sql}`, Math.min(columns.length, rowCap));
      const names = described.rows.map((row) => String(row.column_name));
      const quoted = quoteIdentifier(view);
      const fetched = await read(pageSql(quoted, columns, names, input.offset, span), span);
      const produced = Number((await read(countSql(quoted, rowCap), 1)).rows[0]?.n);
      const capped = produced > rowCap;
      const available = Math.min(produced, rowCap);

      const candidates = fetched.rows.slice(0, reachable);
      const returned = previewLength(candidates, PAGE_CEILING_CHARS);
      if (returned === 0 && input.offset < available) {
        const [first] = candidates;
        const rowChars = first
          ? JSON.stringify(first).length
          : Number((await read(widthSql(quoted, input.offset), 1)).rows[0]?.row_chars);
        throw ctx.fail(
          'row_too_large',
          `Row at offset ${input.offset} is ${rowChars} characters of JSON, over the ${PAGE_CEILING_CHARS}-character page ceiling.`,
          { offset: input.offset, row_chars: rowChars },
        );
      }
      const end = input.offset + returned;
      const more = end < available;
      const page = {
        rows: candidates.slice(0, returned),
        columns: fetched.columns,
        offset: input.offset,
        returned,
        total: capped ? null : produced,
        truncated: more || capped,
        next_offset: more ? end : null,
      };
      if (notice) ctx.enrich.notice(notice);
      ctx.log.info('gnomad_dataframe_query executed', {
        canvas_id: instance.canvasId,
        offset: page.offset,
        returned: page.returned,
        total: page.total,
        truncated: page.truncated,
      });
      return page;
    } finally {
      // Dropped however the call ends; a view the gate refused was never created, so this is a no-op.
      await instance.drop(view);
    }
  },

  format: (result) => {
    const lines = [
      `**columns:** ${result.columns.map(escapeMarkdownInline).join(', ')}`,
      `**offset:** ${result.offset} · **returned:** ${result.returned} · **total:** ${result.total ?? 'null'} · **truncated:** ${result.truncated} · **next_offset:** ${result.next_offset ?? 'null'}`,
    ];
    if (result.total === null) {
      lines.push(
        'The result exceeds the server row cap: total is unknown and rows past the cap are unreachable by paging — filter or aggregate in SQL to reach them.',
      );
    }
    for (const row of result.rows) lines.push(`- ${escapeMarkdownInline(JSON.stringify(row))}`);
    if (result.next_offset !== null) lines.push(`Continue with offset ${result.next_offset}.`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/** Listed only while DataCanvas is on: with it off, no tool stages a table to query. */
export const gnomadDataframeQuery = isCanvasEnabled()
  ? gnomadDataframeQueryDef
  : disabledTool(gnomadDataframeQueryDef, {
      reason: 'DataCanvas is turned off in this deployment, so no table is staged to query.',
      hint: 'CANVAS_PROVIDER_TYPE=duckdb',
    });
