/**
 * @fileoverview gnomad_dataframe_query — run a read-only SQL SELECT against a
 * canvas table staged by gnomad_list_gene_variants or gnomad_search_clinvar.
 * Mandatory companion to any tool that emits a canvas_id.
 * @module mcp-server/tools/definitions/gnomad-dataframe-query.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas-accessor.js';

export const gnomadDataframeQuery = tool('gnomad_dataframe_query', {
  title: 'gnomad-genetics-mcp-server: dataframe query',
  description:
    'Run a read-only SQL SELECT against a canvas table staged by gnomad_list_gene_variants (table gene_variants) or gnomad_search_clinvar (table clinvar_variants). Use the canvas_id and table_name those tools returned to rank by allele frequency, group by consequence class, count loss-of-function variants, or filter the full set the inline preview only sampled. SELECT statements only — writes, DDL, and file/HTTP table functions are rejected by the canvas gate. Call gnomad_dataframe_describe first to discover staged table and column names.',
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  input: z.object({
    canvas_id: z
      .string()
      .min(1)
      .describe('Canvas ID returned by gnomad_list_gene_variants or gnomad_search_clinvar.'),
    sql: z
      .string()
      .min(1)
      .describe(
        'Read-only SQL SELECT. Reference tables by the names the staging tool returned (e.g. gene_variants).',
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
      .describe(
        'Result rows (dynamic columns per the SQL projection), capped at the canvas row limit.',
      ),
    row_count: z.number().describe('Number of rows the query produced (materialized count).'),
    columns: z.array(z.string()).describe('Column names in the result, in order.'),
    truncated: z.boolean().describe('True when the result exceeded the row cap and was clipped.'),
  }),
  errors: [
    {
      reason: 'canvas_disabled',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'DataCanvas is not enabled on this server instance.',
      recovery:
        'Set CANVAS_PROVIDER_TYPE=duckdb and restart; the staging tools then return a queryable canvas_id.',
    },
  ],

  async handler(input, ctx) {
    const canvas = getCanvas();
    if (!canvas) {
      throw ctx.fail(
        'canvas_disabled',
        'DataCanvas is not enabled. Set CANVAS_PROVIDER_TYPE=duckdb.',
        {
          ...ctx.recoveryFor('canvas_disabled'),
        },
      );
    }
    const instance = await canvas.acquire(input.canvas_id, ctx);
    const result = await instance.query(input.sql, { signal: ctx.signal });
    ctx.log.info('gnomad_dataframe_query executed', {
      canvas_id: instance.canvasId,
      row_count: result.rowCount,
      truncated: result.truncated ?? false,
    });
    return {
      rows: result.rows,
      row_count: result.rowCount,
      columns: result.columns,
      truncated: result.truncated ?? false,
    };
  },

  format: (result) => {
    const lines = [
      `**${result.row_count} row(s)** [${result.columns.join(', ')}]${result.truncated ? ' (truncated)' : ''}`,
    ];
    const sample = result.rows.slice(0, 50);
    for (const row of sample) lines.push(`- ${JSON.stringify(row)}`);
    if (result.rows.length > sample.length)
      lines.push(`… and ${result.rows.length - sample.length} more row(s).`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
