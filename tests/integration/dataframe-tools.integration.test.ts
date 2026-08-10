/**
 * @fileoverview Offline integration tests for the dataframe tool trio against
 * a real in-memory DuckDB DataCanvas. Verifies the read-only SQL gate, schema
 * discoverability, and idempotent missing/already-dropped table behavior without
 * mocking project-owned canvas accessors or handlers.
 * @module tests/integration/dataframe-tools.integration.test
 */

import {
  CanvasRegistry,
  DataCanvas,
  DEFAULT_CANVAS_REGISTRY_OPTIONS,
  DuckdbProvider,
} from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gnomadDataframeDescribe } from '@/mcp-server/tools/definitions/gnomad-dataframe-describe.tool.js';
import { gnomadDataframeDrop } from '@/mcp-server/tools/definitions/gnomad-dataframe-drop.tool.js';
import { gnomadDataframeQuery } from '@/mcp-server/tools/definitions/gnomad-dataframe-query.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';

const context = () => createMockContext({ tenantId: 'default' });

let canvas: DataCanvas;
let canvasId: string;

beforeEach(async () => {
  const provider = new DuckdbProvider({
    defaultRowLimit: 1_000,
    exportRootPath: '/tmp/gnomad-canvas-tests',
    memoryLimitMb: 128,
    schemaSniffRows: 100,
  });
  const registry = new CanvasRegistry(provider, {
    ...DEFAULT_CANVAS_REGISTRY_OPTIONS,
    sweeperIntervalMs: 0,
  });
  canvas = new DataCanvas(provider, registry);
  setCanvas(canvas);
  const instance = await canvas.acquire(undefined, context());
  canvasId = instance.canvasId;
  await instance.registerTable('gene_variants', [
    { variant_id: '1-100-A-T', af: 0.001, consequence_class: 'missense' },
    { variant_id: '1-101-G-GA', af: null, consequence_class: 'lof' },
  ]);
});

afterEach(async () => {
  setCanvas(undefined);
  await canvas.shutdown(context());
});

describe('gnomad dataframe tools with a real canvas', () => {
  it('describe exposes the same table and columns that query can reach', async () => {
    const describeCtx = createMockContext({
      tenantId: 'default',
      errors: gnomadDataframeDescribe.errors,
    });
    const described = await gnomadDataframeDescribe.handler(
      gnomadDataframeDescribe.input.parse({ canvas_id: canvasId }),
      describeCtx,
    );

    const table = described.tables.find((candidate) => candidate.name === 'gene_variants');
    expect(table?.row_count).toBe(2);
    expect(table?.columns.map((column) => column.name)).toEqual([
      'variant_id',
      'af',
      'consequence_class',
    ]);

    const queryCtx = createMockContext({
      tenantId: 'default',
      errors: gnomadDataframeQuery.errors,
    });
    const queried = await gnomadDataframeQuery.handler(
      gnomadDataframeQuery.input.parse({
        canvas_id: canvasId,
        sql: 'SELECT variant_id, af FROM gene_variants ORDER BY variant_id',
      }),
      queryCtx,
    );

    expect(queried.columns).toEqual(['variant_id', 'af']);
    expect(queried.rows).toEqual([
      { variant_id: '1-100-A-T', af: 0.001 },
      { variant_id: '1-101-G-GA', af: null },
    ]);
    expect(
      queried.columns.every((column) => table?.columns.some((item) => item.name === column)),
    ).toBe(true);
  });

  it.each([
    "INSERT INTO gene_variants VALUES ('1-102-A-G', 0.1, 'other')",
    "UPDATE gene_variants SET consequence_class = 'other'",
    'DELETE FROM gene_variants',
    'DROP TABLE gene_variants',
    'CREATE TABLE copied AS SELECT * FROM gene_variants',
  ])('rejects mutating SQL: %s', async (sql) => {
    const ctx = createMockContext({
      tenantId: 'default',
      errors: gnomadDataframeQuery.errors,
    });

    await expect(
      gnomadDataframeQuery.handler(
        gnomadDataframeQuery.input.parse({ canvas_id: canvasId, sql }),
        ctx,
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'non_select_statement' },
    });

    const instance = await canvas.acquire(canvasId, context());
    expect(
      (await instance.describe()).find((table) => table.name === 'gene_variants')?.rowCount,
    ).toBe(2);
  });

  it('rejects file-reading table functions even inside a SELECT', async () => {
    const ctx = createMockContext({
      tenantId: 'default',
      errors: gnomadDataframeQuery.errors,
    });

    await expect(
      gnomadDataframeQuery.handler(
        gnomadDataframeQuery.input.parse({
          canvas_id: canvasId,
          sql: "SELECT * FROM read_csv_auto('/tmp/private.csv')",
        }),
        ctx,
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'denied_function' },
    });
  });

  it('reports missing and already-dropped tables without claiming a mutation occurred', async () => {
    const ctx = createMockContext({
      tenantId: 'default',
      errors: gnomadDataframeDrop.errors,
    });
    const input = gnomadDataframeDrop.input.parse({
      canvas_id: canvasId,
      table_name: 'gene_variants',
    });

    expect(await gnomadDataframeDrop.handler(input, ctx)).toEqual({ dropped: true });
    expect(await gnomadDataframeDrop.handler(input, ctx)).toEqual({ dropped: false });
    expect(
      await gnomadDataframeDrop.handler(
        gnomadDataframeDrop.input.parse({
          canvas_id: canvasId,
          table_name: 'never_staged',
        }),
        ctx,
      ),
    ).toEqual({ dropped: false });

    const described = await gnomadDataframeDescribe.handler(
      gnomadDataframeDescribe.input.parse({ canvas_id: canvasId }),
      createMockContext({ tenantId: 'default', errors: gnomadDataframeDescribe.errors }),
    );
    expect(described.tables).toEqual([]);
  });
});
