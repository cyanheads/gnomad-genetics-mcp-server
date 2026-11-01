/**
 * @fileoverview gnomad_dataframe_describe — list the tables staged on a canvas
 * and their columns before writing SQL. Part of the fleet-standard canvas
 * accessor trio; registered only while DataCanvas is on.
 * @module mcp-server/tools/definitions/gnomad-dataframe-describe.tool
 */

import { disabledTool, tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { isCanvasEnabled } from '@/config/server-config.js';
import { getCanvas } from '@/services/canvas-accessor.js';

const gnomadDataframeDescribeDef = tool('gnomad_dataframe_describe', {
  title: 'gnomad-genetics-mcp-server: dataframe describe',
  description:
    'List the tables staged on a canvas and their columns (name and type) so you can write correct SQL for gnomad_dataframe_query. Use the canvas_id returned by gnomad_list_gene_variants or gnomad_search_clinvar. Returns one entry per table with its row count and column schema.',
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  input: z.object({
    canvas_id: CanvasIdSchema.describe(
      'Canvas ID returned by a prior staging call (gnomad_list_gene_variants or gnomad_search_clinvar).',
    ),
  }),
  output: z.object({
    tables: z
      .array(
        z
          .object({
            name: z.string().describe('Table name to reference in SQL.'),
            row_count: z.number().describe('Number of rows in the table.'),
            columns: z
              .array(
                z
                  .object({
                    name: z.string().describe('Column name.'),
                    type: z.string().describe('Column SQL type (DuckDB type).'),
                  })
                  .describe('One column: name and SQL type.'),
              )
              .describe('Column schema, in order.'),
          })
          .describe('One staged table: name, row count, and column schema.'),
      )
      .describe('Tables staged on the canvas.'),
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
      );
    }
    const instance = await canvas.acquire(input.canvas_id, ctx);
    // Tables only: each gnomad_dataframe_query call holds a view of its SQL for the call's length.
    const tables = await instance.describe({ kind: 'table' });
    return {
      tables: tables.map((t) => ({
        name: t.name,
        row_count: t.rowCount,
        columns: t.columns.map((c) => ({ name: c.name, type: c.type })),
      })),
    };
  },

  format: (result) => {
    if (result.tables.length === 0)
      return [{ type: 'text', text: 'No tables staged on this canvas.' }];
    const lines: string[] = [];
    for (const t of result.tables) {
      lines.push(`## ${t.name} (${t.row_count} rows)`);
      lines.push(
        t.columns
          .map((c) => `${escapeMarkdownInline(c.name)}:${escapeMarkdownInline(c.type)}`)
          .join(', '),
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/** Listed only while DataCanvas is on: with it off, no tool stages a table to describe. */
export const gnomadDataframeDescribe = isCanvasEnabled()
  ? gnomadDataframeDescribeDef
  : disabledTool(gnomadDataframeDescribeDef, {
      reason: 'DataCanvas is turned off in this deployment, so no table is staged to describe.',
      hint: 'CANVAS_PROVIDER_TYPE=duckdb',
    });
