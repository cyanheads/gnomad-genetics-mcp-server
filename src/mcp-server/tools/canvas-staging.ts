/**
 * @fileoverview Canvas staging shared by the two row-returning tools
 * (gnomad_list_gene_variants, gnomad_search_clinvar): decide fit-vs-spill on
 * the materialized rows before touching the canvas, so a result that fits
 * inline without a canvas_id never mints a canvas, and a supplied canvas_id
 * always leaves the named table holding exactly this call's rows. Tables are
 * registered with a column schema declared from the row type, never sniffed
 * from a preview sample.
 * @module mcp-server/tools/canvas-staging
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { type ColumnSchema, spillover } from '@cyanheads/mcp-ts-core/canvas';
import { getCanvas } from '@/services/canvas-accessor.js';

/** A row type's declared field names, without its `[key: string]` index signature. */
type DeclaredKeys<Row> = keyof {
  [K in keyof Row as string extends K ? never : number extends K ? never : K]: Row[K];
};

/**
 * The column for one row field. String fields are VARCHAR; numeric fields name
 * DOUBLE (fractional) or BIGINT (integral) explicitly; `nullable` is exactly
 * whether the field's type admits `null`.
 */
interface Column<Value> {
  nullable: null extends Value ? true : false;
  type: [NonNullable<Value>] extends [string]
    ? 'VARCHAR'
    : [NonNullable<Value>] extends [number]
      ? 'DOUBLE' | 'BIGINT'
      : never;
}

/**
 * One column per declared row field — a missing or extra field, a string/number
 * mismatch, or wrong nullability is a compile error. DOUBLE vs BIGINT is not:
 * the type system can't tell fractional from integral numbers, so that choice
 * is the declaration's.
 */
export type RowColumns<Row> = { [K in DeclaredKeys<Row>]: Column<Row[K]> };

/**
 * The canvas schema for a row type, in declaration order (declare the columns
 * in the order the service builds its rows, so describe() matches the row).
 */
export function rowSchema<Row>(columns: RowColumns<Row>): ColumnSchema[] {
  return Object.entries<{ nullable: boolean; type: ColumnSchema['type'] }>(columns).map(
    ([name, { type, nullable }]) => ({ name, type, nullable }),
  );
}

/** The staging fields both tools return verbatim in their output. */
export interface StagedRows<Row> {
  /** Canvas holding table_name, or the supplied canvas_id; '' when no canvas was used. */
  canvas_id: string;
  preview: Row[];
  /** True when the rows exceeded the preview budget and the preview is a prefix. */
  spilled: boolean;
  /** Table this call wrote; '' when it wrote none. */
  table_name: string;
  total: number;
}

export interface StagingOutcome<Row> {
  /** Canvas disabled and rows exceeded the preview budget — the preview is a prefix with no table behind it. */
  capped: boolean;
  staged: StagedRows<Row>;
}

/**
 * Stage `rows` for one call. The preview is always the longest prefix of rows
 * whose summed JSON length fits `previewChars` (spillover's own measure).
 *
 * - Canvas disabled: that prefix inline; `canvas_id` ignored.
 * - Rows fit and no `canvasId`: inline only, no canvas acquired.
 * - Rows exceed the budget: spill to `tableName`, replacing any table of that
 *   name on the supplied canvas.
 * - `canvasId` supplied and rows fit: write them to `tableName` anyway so the
 *   table never holds a previous call's rows; zero rows drop it instead.
 *
 * Both writes use `schema`, so a column's type never depends on which rows
 * happened to land in the preview.
 */
export async function stageRows<Row extends Record<string, unknown>>(opts: {
  canvasId: string | undefined;
  ctx: Context;
  previewChars: number;
  rows: Row[];
  schema: ColumnSchema[];
  tableName: string;
}): Promise<StagingOutcome<Row>> {
  const { rows, canvasId, tableName, previewChars, schema, ctx } = opts;
  const fitting = previewLength(rows, previewChars);
  const fits = fitting === rows.length;
  const canvas = getCanvas();
  if (!canvas) {
    return {
      capped: !fits,
      staged: {
        preview: rows.slice(0, fitting),
        canvas_id: '',
        table_name: '',
        spilled: false,
        total: rows.length,
      },
    };
  }

  const inline = { preview: rows, table_name: '', spilled: false, total: rows.length };
  if (fits && !canvasId) return { capped: false, staged: { ...inline, canvas_id: '' } };

  const instance = await canvas.acquire(canvasId, ctx);
  if (!fits) {
    const result = await spillover<Row>({
      canvas: instance,
      source: rows,
      previewChars,
      schema,
      tableName,
      signal: ctx.signal,
    });
    return {
      capped: false,
      staged: {
        preview: result.previewRows,
        canvas_id: instance.canvasId,
        table_name: result.spilled ? result.handle.tableName : '',
        spilled: result.spilled,
        total: result.spilled ? result.handle.rowCount : rows.length,
      },
    };
  }
  if (rows.length === 0) {
    await instance.drop(tableName);
    return { capped: false, staged: { ...inline, canvas_id: instance.canvasId } };
  }
  const handle = await instance.registerTable(tableName, rows, { schema, signal: ctx.signal });
  return {
    capped: false,
    staged: {
      ...inline,
      canvas_id: instance.canvasId,
      table_name: handle.tableName,
      total: handle.rowCount,
    },
  };
}

/** Rows in the longest prefix whose summed JSON length stays within `previewChars`. */
function previewLength(rows: Record<string, unknown>[], previewChars: number): number {
  let chars = 0;
  for (const [i, row] of rows.entries()) {
    chars += JSON.stringify(row).length;
    if (chars > previewChars) return i;
  }
  return rows.length;
}

/** The `**Staged:**` line both tools render, keyed on what this call actually wrote. */
export function stagedLine(result: { canvas_id: string; table_name: string }): string {
  if (result.table_name) {
    return `**Staged:** canvas_id \`${result.canvas_id}\`, table \`${result.table_name}\` — inspect with gnomad_dataframe_describe, then query with gnomad_dataframe_query.`;
  }
  return result.canvas_id
    ? `**Staged:** no canvas table for this call (canvas_id \`${result.canvas_id}\`).`
    : '**Staged:** no canvas table for this call.';
}
