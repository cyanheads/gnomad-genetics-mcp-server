/**
 * @fileoverview Behavior tests for the gnomad_list_gene_variants handler:
 * canvas-disabled (every row of the offset/limit page, empty canvas_id,
 * no-match + continuation notices), canvas-enabled staging (no canvas for a fit
 * without canvas_id, a spill past the 14,000-character staging budget, a
 * supplied canvas_id that replaces or drops the table, no staging past offset
 * 0), paging and the limit clamp, the target and filter echo, the
 * notice/staged-line matrix on both surfaces, the ~24 KB default-page response
 * on real PCSK9 rows, format(), and the input contracts (invalid_target,
 * incoherent_build, blank transcript_id). Stubs the service network method and
 * the canvas accessor; drives the real spillover() helper against a fake canvas.
 * @module tests/tools/gnomad-list-gene-variants.test
 */

import { readFileSync } from 'node:fs';
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig, resetServerConfig } from '@/config/server-config.js';
import { gnomadGetCoverage } from '@/mcp-server/tools/definitions/gnomad-get-coverage.tool.js';
import { gnomadListGeneVariants } from '@/mcp-server/tools/definitions/gnomad-list-gene-variants.tool.js';
import * as canvasAccessor from '@/services/canvas-accessor.js';
import * as serviceModule from '@/services/gnomad/gnomad-service.js';
import { GnomadService } from '@/services/gnomad/gnomad-service.js';
import type { AnnotatedGeneVariantRow, GeneVariantRow } from '@/services/gnomad/types.js';
import {
  PCSK9_R2_1_REGION_ANNOTATED_ROW,
  PCSK9_R2_1_REGION_ROW,
  PCSK9_R4_GENE,
} from '../helpers/live-consequences.js';
import { fakeFafLists } from '../helpers/live-faf.js';
import { SUBSET_REPLIES } from '../helpers/live-subsets.js';

type CallToolResult = Awaited<ReturnType<typeof runToolContract>>;

const realService = new GnomadService(getServerConfig());

function row(i: number): GeneVariantRow {
  return {
    variant_id: `1-${55000000 + i}-A-T`,
    af: i === 0 ? null : i / 1_000_000,
    ac: i,
    an: 1_000_000,
    consequence: 'missense_variant',
    consequence_class: 'missense',
    homozygote_count: 0,
    hemizygote_count: 0,
    faf95_max: null,
    faf95_max_group: null,
    source: 'exome|genome',
    flags: '',
    exome_filters: '',
    genome_filters: '',
    qc_status: 'pass',
    transcript_id: 'ENST00000302118',
    consequence_transcript: 'mane_select',
    lof: null,
  };
}

/** row(i) failing QC: carried by the exome callset alone, filtered AC0 there. */
function filteredRow(i: number): GeneVariantRow {
  return {
    ...row(i),
    source: 'exome',
    exome_filters: 'AC0',
    genome_filters: null,
    qc_status: 'filtered',
  };
}

/** Stub the service so listGeneVariants yields a fixed row set; real build derivation. */
function stubService(rows: GeneVariantRow[]) {
  const fake = {
    resolveDatasetContext: realService.resolveDatasetContext.bind(realService),
    listGeneVariants: vi.fn(async () => rows),
  };
  vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(fake as never);
  return fake;
}

/** A row padded (via flags) to exactly `chars` characters of JSON — the unit the preview budget counts. */
function sized(i: number, chars: number): GeneVariantRow {
  const base = { ...row(i), flags: '' };
  const pad = chars - JSON.stringify(base).length;
  if (pad < 0) throw new Error(`row ${i} is already longer than ${chars} chars`);
  return { ...base, flags: 'x'.repeat(pad) };
}

const MINTED = 'cnvMinted1';
const REUSED = 'cnvReused1';

/**
 * A fake DataCanvas whose instances keep registered tables in memory, so the
 * real spillover() helper drains, sentinels, and stages against it, and a
 * supplied canvas_id resolves to the same table map. acquire(undefined) mints
 * MINTED; acquire(id) resolves id.
 */
function fakeCanvas() {
  const tables: Record<string, Record<string, unknown>[]> = {};
  const dropped: string[] = [];
  const instance = (canvasId: string) => ({
    canvasId,
    tenantId: 'default',
    isNew: canvasId === MINTED,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    async registerTable(
      name: string,
      rows: AsyncIterable<Record<string, unknown>> | Iterable<Record<string, unknown>>,
    ) {
      const collected: Record<string, unknown>[] = [];
      for await (const r of rows as AsyncIterable<Record<string, unknown>>) collected.push(r);
      tables[name] = collected;
      return {
        tableName: name,
        rowCount: collected.length,
        columns: Object.keys(collected[0] ?? {}),
      };
    },
    async drop(name: string) {
      dropped.push(name);
      const existed = name in tables;
      delete tables[name];
      return existed;
    },
  });
  const canvas = { acquire: vi.fn(async (id?: string) => instance(id ?? MINTED)) };
  return { canvas, tables, dropped };
}

function textOf(result: CallToolResult): string {
  return result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
}

describe('gnomad_list_gene_variants handler — canvas disabled', () => {
  it('returns spilled=false with an empty canvas_id when canvas is off', async () => {
    stubService([row(1), row(2)]);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const ctx = createMockContext({ errors: gnomadListGeneVariants.errors });
    const input = gnomadListGeneVariants.input.parse({ gene: 'PCSK9' });
    const result = await gnomadListGeneVariants.handler(input, ctx as never);

    expect(result.spilled).toBe(false);
    expect(result.canvas_id).toBe('');
    expect(result.table_name).toBe('');
    expect(result.total).toBe(2);
    expect(result.preview).toHaveLength(2);
  });

  it('returns every row of a page that fits the 14,000-character budget, however many (#37, #59)', async () => {
    // 38 compact rows (~367 characters each, no consequence) sum to under 14,000.
    const rows = Array.from({ length: 38 }, (_, i) => ({
      ...row(i + 1),
      consequence: null,
      consequence_class: 'other' as const,
      source: 'exome',
      genome_filters: null,
    }));
    expect(rows.reduce((n, r) => n + JSON.stringify(r).length, 0)).toBeLessThanOrEqual(14_000);
    stubService(rows);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const ctx = createMockContext({ errors: gnomadListGeneVariants.errors });
    const input = gnomadListGeneVariants.input.parse({ gene: 'BRCA2', limit: 38 });
    const result = await gnomadListGeneVariants.handler(input, ctx as never);

    expect(result.total).toBe(38);
    expect(result.preview).toHaveLength(38);
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('returns the whole page one character past the staging budget with the canvas off (#59)', async () => {
    const rows = [...Array.from({ length: 34 }, (_, i) => sized(i + 1, 400)), sized(35, 401)];
    stubService(rows);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const ctx = createMockContext({ errors: gnomadListGeneVariants.errors });
    const input = gnomadListGeneVariants.input.parse({ gene: 'BRCA2', limit: 35 });
    const result = await gnomadListGeneVariants.handler(input, ctx as never);

    expect(result.total).toBe(35);
    expect(result.preview).toEqual(rows);
    expect(result.next_offset).toBeNull();
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('pages long-ID rows by limit alone, whatever their width (#59)', async () => {
    const rows = Array.from({ length: 75 }, (_, i) => sized(i + 1, 400));
    stubService(rows);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const ctx = createMockContext({ errors: gnomadListGeneVariants.errors });
    const input = gnomadListGeneVariants.input.parse({ gene: 'KCNQ1' });
    const result = await gnomadListGeneVariants.handler(input, ctx as never);

    expect(result.preview).toEqual(rows.slice(0, 25));
    expect(result.next_offset).toBe(25);
    expect(getEnrichment(ctx).notice).toBe(continuation(1, 25, 75));
  });

  it('previews the same rows with the canvas disabled as the canvas-on spill does (#37)', async () => {
    const rows = Array.from({ length: 300 }, (_, i) => row(i + 1));
    stubService(rows);
    const input = gnomadListGeneVariants.input.parse({ gene: 'BRCA2' });

    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);
    const off = await gnomadListGeneVariants.handler(
      input,
      createMockContext({ errors: gnomadListGeneVariants.errors }) as never,
    );
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(fakeCanvas().canvas as never);
    const on = await gnomadListGeneVariants.handler(
      input,
      createMockContext({ errors: gnomadListGeneVariants.errors }) as never,
    );

    expect(on.spilled).toBe(true);
    expect(off.preview).toEqual(on.preview);
  });

  it('emits a no-match notice naming the filters when nothing matched', async () => {
    stubService([]);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const ctx = createMockContext({ errors: gnomadListGeneVariants.errors });
    const input = gnomadListGeneVariants.input.parse({
      gene: 'PCSK9',
      consequence_class: 'lof',
      max_af: 0.001,
    });
    const result = await gnomadListGeneVariants.handler(input, ctx as never);

    expect(result.total).toBe(0);
    const notice = getEnrichment(ctx).notice;
    expect(notice).toContain('No variants in gene "PCSK9"');
    expect(notice).toContain('consequence_class=lof');
    expect(notice).toContain('max_af=0.001');
  });
});

describe('gnomad_list_gene_variants handler — canvas enabled', () => {
  it('acquires no canvas for a result that fits inline without canvas_id (#35)', async () => {
    stubService([row(1), row(2)]);
    const { canvas } = fakeCanvas();
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(canvas as never);

    const ctx = createMockContext({ errors: gnomadListGeneVariants.errors });
    const input = gnomadListGeneVariants.input.parse({ gene: 'PCSK9' });
    const result = await gnomadListGeneVariants.handler(input, ctx as never);

    expect(canvas.acquire).not.toHaveBeenCalled();
    expect(result).toMatchObject({ spilled: false, canvas_id: '', table_name: '', total: 2 });
    expect(result.preview).toHaveLength(2);
  });

  it('spills a large result to the canvas table and returns canvas_id + table_name', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => row(i + 1));
    stubService(rows);
    const { canvas, tables } = fakeCanvas();
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(canvas as never);

    const ctx = createMockContext({ errors: gnomadListGeneVariants.errors });
    const input = gnomadListGeneVariants.input.parse({ gene: 'BRCA2' });
    const result = await gnomadListGeneVariants.handler(input, ctx as never);

    expect(canvas.acquire).toHaveBeenCalledWith(undefined, ctx);
    expect(result.spilled).toBe(true);
    expect(result.canvas_id).toBe(MINTED);
    expect(result.table_name).toBe('gene_variants');
    // The full set lands on the canvas table — not just the preview.
    expect(result.total).toBe(1000);
    expect(tables.gene_variants).toHaveLength(1000);
    // The inline preview is a strict, smaller sample of the full set.
    expect(result.preview.length).toBeGreaterThan(0);
    expect(result.preview.length).toBeLessThan(1000);
    expect(result).toEqual(expect.schemaMatching(gnomadListGeneVariants.output));
  });

  it('fits a result of exactly 14,000 preview characters inline (#37 boundary)', async () => {
    stubService(Array.from({ length: 35 }, (_, i) => sized(i + 1, 400)));
    const { canvas } = fakeCanvas();
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(canvas as never);

    const ctx = createMockContext({ errors: gnomadListGeneVariants.errors });
    const input = gnomadListGeneVariants.input.parse({ gene: 'PCSK9', limit: 35 });
    const result = await gnomadListGeneVariants.handler(input, ctx as never);

    expect(result).toMatchObject({ spilled: false, canvas_id: '', total: 35 });
    expect(result.preview).toHaveLength(35);
    expect(canvas.acquire).not.toHaveBeenCalled();
  });

  it('spills one character past 14,000 and still returns the whole page (#37 boundary, #59)', async () => {
    const rows = [...Array.from({ length: 34 }, (_, i) => sized(i + 1, 400)), sized(35, 401)];
    stubService(rows);
    const { canvas, tables } = fakeCanvas();
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(canvas as never);

    const ctx = createMockContext({ errors: gnomadListGeneVariants.errors });
    const input = gnomadListGeneVariants.input.parse({ gene: 'PCSK9', limit: 35 });
    const result = await gnomadListGeneVariants.handler(input, ctx as never);

    expect(result).toMatchObject({ spilled: true, table_name: 'gene_variants', total: 35 });
    expect(result.preview).toEqual(rows);
    expect(tables.gene_variants).toHaveLength(35);
  });

  it('replaces the named table when a supplied canvas_id gets a result that fits (#35)', async () => {
    const { canvas, tables } = fakeCanvas();
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(canvas as never);
    tables.gene_variants = Array.from({ length: 500 }, (_, i) => row(i + 1));
    stubService([row(7), row(8)]);

    const ctx = createMockContext({ errors: gnomadListGeneVariants.errors });
    const input = gnomadListGeneVariants.input.parse({ region: '1-100-200', canvas_id: REUSED });
    const result = await gnomadListGeneVariants.handler(input, ctx as never);

    expect(canvas.acquire).toHaveBeenCalledWith(REUSED, ctx);
    expect(result).toMatchObject({
      spilled: false,
      canvas_id: REUSED,
      table_name: 'gene_variants',
      total: 2,
    });
    expect(result.preview).toEqual([row(7), row(8)]);
    expect(tables.gene_variants).toEqual([row(7), row(8)]);
  });

  it('leaves no stale table when a supplied canvas_id gets zero rows (#35)', async () => {
    const { canvas, tables, dropped } = fakeCanvas();
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(canvas as never);
    tables.gene_variants = [row(1)];
    stubService([]);

    const ctx = createMockContext({ errors: gnomadListGeneVariants.errors });
    const input = gnomadListGeneVariants.input.parse({ gene: 'PCSK9', canvas_id: REUSED });
    const result = await gnomadListGeneVariants.handler(input, ctx as never);

    expect(dropped).toEqual(['gene_variants']);
    expect(tables.gene_variants).toBeUndefined();
    expect(result).toMatchObject({ canvas_id: REUSED, table_name: '', spilled: false, total: 0 });
  });
});

/** The pointer a staged table carries, naming describe before query (#21). */
const pointer = (n: number, id: string) =>
  `Staged ${n} variant(s) in table "gene_variants" (canvas_id ${id}). Call gnomad_dataframe_describe for its columns, then gnomad_dataframe_query to run SQL over every staged row.`;
const noMatch = 'No variants in gene "PCSK9". Broaden the filters.';
/** 100 rows with the canvas disabled: the default 25-row page and where the next one starts (#59). */
const paged = 'Showing variants 1–25 of 100; continue with offset=25 for the next page.';
const NEUTRAL = '**Staged:** no canvas table for this call.';
const stagedLine = (id: string) =>
  `**Staged:** canvas_id \`${id}\`, table \`gene_variants\` — inspect with gnomad_dataframe_describe, then query with gnomad_dataframe_query.`;

type Size = 'spill' | 'fit' | 'zero';
const rowsFor: Record<Size, () => GeneVariantRow[]> = {
  spill: () => Array.from({ length: 100 }, (_, i) => sized(i + 1, 400)),
  fit: () => [row(1), row(2), row(3)],
  zero: () => [],
};

interface Cell {
  acquired?: string | null;
  canvas: 'disabled' | 'enabled';
  canvasId?: string;
  line: string;
  notice?: string;
  sc: Record<string, unknown>;
  size: Size;
}

/** Every reachable (canvas × size × canvas_id) cell of the notice and staging matrix. */
const matrix: Cell[] = [
  {
    canvas: 'disabled',
    size: 'spill',
    sc: { canvas_id: '', table_name: '', spilled: false, total: 100 },
    notice: paged,
    line: NEUTRAL,
  },
  {
    canvas: 'disabled',
    size: 'spill',
    canvasId: REUSED,
    sc: { canvas_id: '', table_name: '', spilled: false, total: 100 },
    notice: paged,
    line: NEUTRAL,
  },
  {
    canvas: 'disabled',
    size: 'fit',
    sc: { canvas_id: '', table_name: '', total: 3 },
    line: NEUTRAL,
  },
  {
    canvas: 'disabled',
    size: 'fit',
    canvasId: REUSED,
    sc: { canvas_id: '', table_name: '', total: 3 },
    line: NEUTRAL,
  },
  {
    canvas: 'disabled',
    size: 'zero',
    sc: { canvas_id: '', table_name: '', total: 0 },
    notice: noMatch,
    line: NEUTRAL,
  },
  {
    canvas: 'disabled',
    size: 'zero',
    canvasId: REUSED,
    sc: { canvas_id: '', table_name: '', total: 0 },
    notice: noMatch,
    line: NEUTRAL,
  },
  {
    canvas: 'enabled',
    size: 'spill',
    acquired: null,
    sc: { canvas_id: MINTED, table_name: 'gene_variants', spilled: true, total: 100 },
    notice: pointer(100, MINTED),
    line: stagedLine(MINTED),
  },
  {
    canvas: 'enabled',
    size: 'spill',
    canvasId: REUSED,
    acquired: REUSED,
    sc: { canvas_id: REUSED, table_name: 'gene_variants', spilled: true, total: 100 },
    notice: pointer(100, REUSED),
    line: stagedLine(REUSED),
  },
  {
    canvas: 'enabled',
    size: 'fit',
    sc: { canvas_id: '', table_name: '', spilled: false, total: 3 },
    line: NEUTRAL,
  },
  {
    canvas: 'enabled',
    size: 'fit',
    canvasId: REUSED,
    acquired: REUSED,
    sc: { canvas_id: REUSED, table_name: 'gene_variants', spilled: false, total: 3 },
    notice: pointer(3, REUSED),
    line: stagedLine(REUSED),
  },
  {
    canvas: 'enabled',
    size: 'zero',
    sc: { canvas_id: '', table_name: '', total: 0 },
    notice: noMatch,
    line: NEUTRAL,
  },
  {
    canvas: 'enabled',
    size: 'zero',
    canvasId: REUSED,
    acquired: REUSED,
    sc: { canvas_id: REUSED, table_name: '', total: 0 },
    notice: noMatch,
    line: `**Staged:** no canvas table for this call (canvas_id \`${REUSED}\`).`,
  },
];

describe('gnomad_list_gene_variants notice and staging matrix (#21, #33, #35)', () => {
  it.each(
    matrix.map(
      (cell) =>
        [
          `${cell.canvas} × ${cell.size} × ${cell.canvasId ? 'canvas_id' : 'no canvas_id'}`,
          cell,
        ] as const,
    ),
  )('%s', async (_label, cell) => {
    stubService(rowsFor[cell.size]());
    const { canvas } = fakeCanvas();
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(
      cell.canvas === 'enabled' ? (canvas as never) : undefined,
    );

    const result = await runToolContract(gnomadListGeneVariants, {
      gene: 'PCSK9',
      ...(cell.canvasId && { canvas_id: cell.canvasId }),
    });

    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc).toMatchObject(cell.sc);
    expect(sc.notice).toBe(cell.notice);
    const text = textOf(result);
    expect(text).toContain(cell.line);
    expect(text).not.toMatch(/Canvas disabled\*\*/);
    if (cell.notice) expect(text).toContain(cell.notice);
    if (cell.acquired === undefined) expect(canvas.acquire).not.toHaveBeenCalled();
    else expect(canvas.acquire).toHaveBeenCalledWith(cell.acquired ?? undefined, expect.anything());
    // Both surfaces carry the same preview rows.
    const preview = sc.preview as GeneVariantRow[];
    expect(text.match(/^- \*\*/gm)?.length ?? 0).toBe(preview.length);
    for (const r of preview) expect(text).toContain(`- **${r.variant_id}**`);
    expect(sc.qc_filtered).toBe(0);
    expect(text).toContain('**QC filtered:** 0');
  });
});

/** 1,000 rows, every third failing QC: 334 filtered, 666 passing. */
const mixedQc = () =>
  Array.from({ length: 1000 }, (_, i) => (i % 3 === 0 ? filteredRow(i + 1) : row(i + 1)));

describe('gnomad_list_gene_variants QC status (#54)', () => {
  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/54
  it('counts qc_filtered over every matching row, not the preview, and names it in a notice', async () => {
    stubService(mixedQc());
    const { canvas, tables } = fakeCanvas();
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(canvas as never);

    const result = await runToolContract(gnomadListGeneVariants, { gene: 'PCSK9' });

    const sc = result.structuredContent as {
      preview: GeneVariantRow[];
      total: number;
      qc_filtered: number;
      notice: string;
    };
    expect(sc).toMatchObject({ spilled: true, total: 1000, qc_filtered: 334 });
    const previewFiltered = sc.preview.filter((r) => r.qc_status === 'filtered').length;
    expect(previewFiltered).toBeGreaterThan(0);
    expect(previewFiltered).toBeLessThan(334);
    expect(tables.gene_variants).toHaveLength(1000);
    expect(sc.notice).toBe(
      `334 of 1000 matching variant(s) failed gnomAD QC in every callset carrying them (qc_status "filtered"; gnomAD's browser hides these by default); exome_filters and genome_filters name the filters. Pass pass_only: true to drop them. ${pointer(1000, MINTED)}`,
    );
    const text = textOf(result);
    expect(text).toContain('**QC filtered:** 334');
    expect(text).toContain('334 of 1000 matching variant(s) failed gnomAD QC');
    expect(
      text.match(/\| QC filtered \(exome AC0\) \| transcript ENST00000302118 \(mane_select\)$/gm),
    ).toHaveLength(previewFiltered);
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/54
  it('never suggests pass_only when every matching row failed QC', async () => {
    stubService([filteredRow(1), filteredRow(2), filteredRow(3)]);
    const { canvas } = fakeCanvas();
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(canvas as never);

    const result = await runToolContract(gnomadListGeneVariants, { gene: 'PCSK9' });

    const sc = result.structuredContent as { total: number; qc_filtered: number; notice: string };
    expect(sc).toMatchObject({ total: 3, qc_filtered: 3 });
    expect(sc.notice).toContain(
      '3 of 3 matching variant(s) failed gnomAD QC in every callset carrying them',
    );
    expect(sc.notice).toContain('None passed, so pass_only: true would return no rows.');
    expect(sc.notice).not.toContain('Pass pass_only: true to drop them');
    expect(textOf(result)).toContain('None passed, so pass_only: true would return no rows.');
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/54
  it('drops filtered rows under pass_only after counting them, from the preview and the staged table', async () => {
    stubService(mixedQc());
    const { canvas, tables } = fakeCanvas();
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(canvas as never);

    const result = await runToolContract(gnomadListGeneVariants, {
      gene: 'PCSK9',
      pass_only: true,
    });

    const sc = result.structuredContent as {
      preview: GeneVariantRow[];
      notice: string;
    };
    expect(sc).toMatchObject({ spilled: true, total: 666, qc_filtered: 334 });
    expect(sc.preview.length).toBeGreaterThan(0);
    expect(sc.preview.every((r) => r.qc_status === 'pass')).toBe(true);
    expect(tables.gene_variants).toHaveLength(666);
    expect(tables.gene_variants?.every((r) => r.qc_status === 'pass')).toBe(true);
    expect(sc.notice).toBe(
      `pass_only dropped 334 of 1000 matching variant(s) that failed gnomAD QC in every callset carrying them. ${pointer(666, MINTED)}`,
    );
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/54
  it.each([{}, { pass_only: false }])(
    'returns every matching row, filtered ones included, with %j',
    async (passOnly) => {
      const rows = [row(1), filteredRow(2), row(3)];
      const fake = stubService(rows);
      vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

      const result = await runToolContract(gnomadListGeneVariants, {
        gene: 'PCSK9',
        consequence_class: 'missense',
        max_af: 0.01,
        ...passOnly,
      });

      expect(result.structuredContent).toMatchObject({ preview: rows, total: 3, qc_filtered: 1 });
      expect(fake.listGeneVariants).toHaveBeenCalledWith(
        { kind: 'gene', value: 'PCSK9' },
        { annotations: false, consequenceClass: 'missense', maxAf: 0.01, passOnly: false },
        expect.anything(),
        expect.anything(),
      );
    },
  );

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/54
  it('keeps the consequence and max_af filters in the service and applies pass_only after them', async () => {
    const fake = stubService([row(1), filteredRow(2)]);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const result = await runToolContract(gnomadListGeneVariants, {
      gene: 'PCSK9',
      consequence_class: 'lof',
      max_af: 0.001,
      pass_only: true,
    });

    expect(fake.listGeneVariants).toHaveBeenCalledWith(
      { kind: 'gene', value: 'PCSK9' },
      { annotations: false, consequenceClass: 'lof', maxAf: 0.001, passOnly: true },
      expect.anything(),
      expect.anything(),
    );
    expect(result.structuredContent).toMatchObject({ preview: [row(1)], total: 1, qc_filtered: 1 });
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/54
  it('names the QC-dropped rows in place of the no-match notice when pass_only empties a region', async () => {
    stubService([filteredRow(1), filteredRow(2)]);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const result = await runToolContract(gnomadListGeneVariants, {
      region: '1-55039866-55039866',
      pass_only: true,
    });

    const notice =
      'All 2 variant(s) in region "1-55039866-55039866" failed gnomAD QC in every callset carrying them, so pass_only dropped them. Omit pass_only to list them with their exome_filters and genome_filters.';
    expect(result.structuredContent).toMatchObject({
      preview: [],
      total: 0,
      qc_filtered: 2,
      notice,
    });
    expect(textOf(result)).toContain(notice);
    expect(textOf(result)).not.toContain('No variants');
  });

  it('keeps the no-match notice when nothing matched before pass_only', async () => {
    stubService([]);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const result = await runToolContract(gnomadListGeneVariants, {
      gene: 'PCSK9',
      pass_only: true,
    });

    expect(result.structuredContent).toMatchObject({ total: 0, qc_filtered: 0, notice: noMatch });
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/54
  it('reports qc_filtered 0 and adds no QC notice when every row passed', async () => {
    stubService([row(1), row(2)]);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const result = await runToolContract(gnomadListGeneVariants, { gene: 'PCSK9' });

    expect(result.structuredContent).toMatchObject({ total: 2, qc_filtered: 0 });
    expect((result.structuredContent as { notice?: string }).notice).toBeUndefined();
    expect(textOf(result)).not.toMatch(/failed gnomAD QC/);
  });

  it('describes pass_only as optional, qc_filtered as counted before pass_only, and total after it', () => {
    expect(gnomadListGeneVariants.input.parse({ gene: 'PCSK9' }).pass_only).toBeUndefined();
    expect(() => gnomadListGeneVariants.input.parse({ gene: 'PCSK9', pass_only: 'yes' })).toThrow();
    expect(gnomadListGeneVariants.output.shape.qc_filtered.description).toMatch(/pass_only/);
    // total excludes what pass_only dropped, so total - qc_filtered is the pass count only without it.
    expect(gnomadListGeneVariants.output.shape.total.description).toMatch(/after pass_only/);
  });
});

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/78
describe("gnomad_list_gene_variants pass_only counts from a row's passing callsets (#78)", () => {
  // Live gnomad_r2_1 rows, captured 2026-11-01 (UTC): exome AC0 + genome passing, and QC-failed in both.
  const VARIANTS = [
    {
      variant_id: '1-55505483-C-G',
      consequence: '5_prime_UTR_variant',
      transcript_id: 'ENST00000302118',
      flags: [],
      exome: { ac: 0, an: 178930, af: 0, homozygote_count: 0, filters: ['AC0'] },
      genome: { ac: 1, an: 31408, af: 0.00003183902190524707, homozygote_count: 0, filters: [] },
      joint: null,
    },
    {
      variant_id: '1-55528992-G-A',
      consequence: 'intron_variant',
      transcript_id: 'ENST00000302118',
      flags: [],
      exome: { ac: 0, an: 199854, af: 0, homozygote_count: 0, filters: ['AC0'] },
      genome: {
        ac: 1,
        an: 31350,
        af: 0.00003189792663476874,
        homozygote_count: 0,
        filters: ['RF'],
      },
      joint: null,
    },
  ];

  it.each([
    [{ pass_only: true }, 31408, 1],
    [{}, 210338, 2],
  ] as const)(
    'with %j, carries an %i on every surface and counts the failed row in qc_filtered',
    async (passOnly, an, total) => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
        Response.json({ data: { region: { variants: VARIANTS } } }),
      );
      vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(
        new GnomadService(getServerConfig()) as never,
      );
      const { canvas, tables } = fakeCanvas();
      vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(canvas as never);

      const result = await runToolContract(gnomadListGeneVariants, {
        region: '1-55505483-55528992',
        dataset: 'gnomad_r2_1',
        canvas_id: REUSED,
        ...passOnly,
      });

      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as { preview: GeneVariantRow[] };
      expect(sc).toMatchObject({ total, qc_filtered: 1, table_name: 'gene_variants' });
      const [shown] = sc.preview;
      expect(shown).toMatchObject({ variant_id: '1-55505483-C-G', ac: 1, an, af: 1 / an });
      expect(tables.gene_variants).toEqual(sc.preview);
      expect(textOf(result)).toContain(
        `| AF ${1 / an} (${(1 / an).toExponential(3)}) | AC 1/${an} |`,
      );
    },
  );
});

describe('gnomad_list_gene_variants response budget (#37)', () => {
  // The first 120 rows of the server's live gnomad_r4 PCSK9 list with annotations; the fixture's _about names the capture.
  const LIVE_ANNOTATED_ROWS = (
    JSON.parse(
      readFileSync(new URL('../fixtures/pcsk9-gene-variants.live.json', import.meta.url), 'utf8'),
    ) as { rows: AnnotatedGeneVariantRow[] }
  ).rows;
  // The same rows in the default shape, as the capture's call without annotations returned them.
  const LIVE_ROWS: GeneVariantRow[] = LIVE_ANNOTATED_ROWS.map(
    ({ hgvsc, hgvsp, lof_filter, lof_flags, rsids, ...row }) => row,
  );

  it.each([
    ['enabled', false],
    ['disabled', false],
    ['enabled', true],
    ['disabled', true],
  ] as const)(
    'keeps a real-row response under 24 KB with the canvas %s (annotations %s)',
    async (mode, annotations) => {
      stubService(annotations ? LIVE_ANNOTATED_ROWS : LIVE_ROWS);
      const { canvas } = fakeCanvas();
      vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(
        mode === 'enabled' ? (canvas as never) : undefined,
      );

      const result = await runToolContract(gnomadListGeneVariants, {
        gene: 'PCSK9',
        ...(annotations && { annotations }),
      });

      const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
      expect(bytes).toBeLessThan(24_000);
      const sc = result.structuredContent as { preview: GeneVariantRow[]; total: number };
      expect(sc.total).toBe(LIVE_ROWS.length);
      // The default page (#59, #63), so the bound above is measured on a full one.
      expect(sc.preview).toHaveLength(25);
      expect('rsids' in (sc.preview[0] ?? {})).toBe(annotations);
    },
  );
});

describe('gnomad_list_gene_variants consequence fields (#57, #74)', () => {
  /** Serve a live gene reply through the real service's fetch seam, canvas off. */
  function serveGene(gene: unknown) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ data: { gene } }));
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(
      new GnomadService(getServerConfig()) as never,
    );
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);
  }

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/57
  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/74
  it('classes start_lost rows missense and marks each row’s transcript, on both surfaces', async () => {
    serveGene(PCSK9_R4_GENE);

    const result = await runToolContract(gnomadListGeneVariants, { gene: 'PCSK9' });

    expect(result.isError).toBeFalsy();
    const { preview } = result.structuredContent as { preview: GeneVariantRow[] };
    expect(
      preview.map((r) => [
        r.variant_id,
        r.consequence,
        r.consequence_class,
        r.transcript_id,
        r.consequence_transcript,
      ]),
    ).toEqual([
      ['1-55039838-A-G', 'start_lost', 'missense', 'ENST00000302118', 'mane_select'],
      ['1-55044012-T-A', 'start_lost', 'missense', 'ENST00000673903', 'other'],
    ]);
    const af = 6 / 1_566_868;
    expect(textOf(result).split('\n')).toContain(
      `- **1-55039838-A-G** | missense (start_lost) | AF ${af} (${af.toExponential(3)}) | AC 6/1566868 | hom 0 | exome | QC pass (exome passed) | transcript ENST00000302118 (mane_select)`,
    );
    expect(textOf(result)).toMatch(
      /^- \*\*1-55044012-T-A\*\* \| missense \(start_lost\) \|.* \| transcript ENST00000673903 \(other\)$/m,
    );
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/74
  it.each([
    ['missense', 2],
    ['lof', 0],
  ] as const)(
    'filters consequence_class %s to %i start_lost row(s)',
    async (consequenceClass, total) => {
      serveGene(PCSK9_R4_GENE);

      const result = await runToolContract(gnomadListGeneVariants, {
        gene: 'PCSK9',
        consequence_class: consequenceClass,
      });

      expect(result.structuredContent).toMatchObject({ total });
    },
  );

  it('names the five lof and five missense terms on the consequence_class filter', () => {
    const description = gnomadListGeneVariants.input.shape.consequence_class.description ?? '';
    const lof = description.slice(description.indexOf('lof'), description.indexOf('; missense'));
    const missense = description.slice(
      description.indexOf('; missense'),
      description.indexOf('; synonymous'),
    );

    for (const term of [
      'transcript_ablation',
      'splice_acceptor_variant',
      'splice_donor_variant',
      'stop_gained',
      'frameshift_variant',
    ]) {
      expect(lof).toContain(term);
    }
    for (const term of [
      'missense_variant',
      'stop_lost',
      'start_lost',
      'inframe_insertion',
      'inframe_deletion',
    ]) {
      expect(missense).toContain(term);
    }
    // gnomAD files these under missense, never pLoF.
    for (const term of ['stop_lost', 'start_lost', 'inframe_insertion', 'inframe_deletion']) {
      expect(lof).not.toContain(term);
    }
  });

  it('describes the consequence term each target kind returns', () => {
    const description =
      gnomadListGeneVariants.output.shape.preview.element.shape.consequence.description ?? '';

    expect(description).toMatch(/most severe in the gene on a gene target/);
    expect(description).toMatch(/named transcript's term on a transcript target/);
    expect(description).toMatch(/most severe across transcripts on a region target/);
  });
});

describe('gnomad_list_gene_variants handler — input contracts', () => {
  it('throws ctx.fail("invalid_target") when no target is supplied', async () => {
    stubService([row(1)]);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const ctx = createMockContext({ errors: gnomadListGeneVariants.errors });
    const input = gnomadListGeneVariants.input.parse({});
    await expect(gnomadListGeneVariants.handler(input, ctx as never)).rejects.toMatchObject({
      data: { reason: 'invalid_target' },
    });
  });

  it('throws ctx.fail("invalid_target") when gene and region are both supplied', async () => {
    stubService([row(1)]);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const ctx = createMockContext({ errors: gnomadListGeneVariants.errors });
    const input = gnomadListGeneVariants.input.parse({
      gene: 'PCSK9',
      region: '1-55039447-55064852',
    });
    await expect(gnomadListGeneVariants.handler(input, ctx as never)).rejects.toMatchObject({
      data: { reason: 'invalid_target' },
    });
  });

  it('rejects an incoherent dataset/reference_genome pair before the upstream call', async () => {
    const fake = stubService([row(1)]);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const ctx = createMockContext({ errors: gnomadListGeneVariants.errors });
    const input = gnomadListGeneVariants.input.parse({
      gene: 'PCSK9',
      dataset: 'exac',
      reference_genome: 'GRCh38',
    });
    await expect(gnomadListGeneVariants.handler(input, ctx as never)).rejects.toMatchObject({
      data: { reason: 'incoherent_build' },
    });
    expect(fake.listGeneVariants).not.toHaveBeenCalled();
  });

  it('rejects a malformed region string at parse time', () => {
    expect(() => gnomadListGeneVariants.input.parse({ region: '1-100' })).toThrow();
    expect(() => gnomadListGeneVariants.input.parse({ region: '1-100-200-300' })).toThrow();
    // Commas read only as thousands groups, and only in the chrom:start-stop form.
    expect(() => gnomadListGeneVariants.input.parse({ region: '1:5,5-6' })).toThrow();
    expect(() =>
      gnomadListGeneVariants.input.parse({ region: '1-55,039,447-55,064,852' }),
    ).toThrow();
  });

  it('lets every chrom-start-stop shape through to the service parser', () => {
    // The schema checks shape only; the service parser owns the chromosome set,
    // so 23, 01, XY, and MT fail there with a typed reason, not InvalidParams.
    for (const region of ['chr1-100-200', 'x-100-200', '23-1-2', '01-1-2', 'XY-1-2', 'MT-1-100']) {
      expect(gnomadListGeneVariants.input.parse({ region }).region).toBe(region);
    }
  });

  it('accepts a well-formed region and resolves it to a region target', async () => {
    const fake = stubService([row(1)]);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const ctx = createMockContext({ errors: gnomadListGeneVariants.errors });
    const input = gnomadListGeneVariants.input.parse({ region: '13-32315474-32400266' });
    await gnomadListGeneVariants.handler(input, ctx as never);

    expect(fake.listGeneVariants).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'region', value: '13-32315474-32400266' }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('rejects an inverted region (start>stop) before any upstream call', async () => {
    // REGION_REGEX validates shape only, so an inverted region parses; the
    // service rejects start>stop in its region parse, failing fast as a
    // ValidationError instead of reaching gnomAD (which 500s and burns the retry
    // budget). Drive the real service so the guard actually runs.
    const real = new GnomadService(getServerConfig());
    const graphql = vi.spyOn(real as any, 'graphql');
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(real as never);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const ctx = createMockContext({ errors: gnomadListGeneVariants.errors });
    const input = gnomadListGeneVariants.input.parse({ region: '1-200-100' });
    await expect(gnomadListGeneVariants.handler(input, ctx as never)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_region' },
    });
    expect(graphql).not.toHaveBeenCalled();
  });
});

/** The target and filter echo every format() fixture carries (#70). */
const ECHO = {
  target: 'PCSK9',
  target_kind: 'gene' as const,
  filters: {
    consequence_class: null,
    lof_confidence: null,
    max_af: null,
    max_faf: null,
    pass_only: null,
  },
  truncated: false,
  next_offset: null,
};

describe('gnomad_list_gene_variants format()', () => {
  const base = {
    ...ECHO,
    canvas_id: '',
    table_name: '',
    spilled: false,
    total: 1,
    qc_filtered: 0,
    dataset: 'gnomad_r4',
    reference_genome: 'GRCh38',
  };
  const render = (result: Parameters<NonNullable<typeof gnomadListGeneVariants.format>>[0]) =>
    (gnomadListGeneVariants.format?.(result) ?? [])
      .map((b) => ('text' in b ? b.text : ''))
      .join('\n');

  it('renders the header, build, and one line per preview row', () => {
    const text = render({ ...base, preview: [row(2), { ...row(3), flags: 'lcr' }] });
    expect(text).toContain('## Gene variants — 1 total');
    expect(text).toContain('**Dataset:** gnomad_r4 (GRCh38) | **Spilled:** no');
    expect(text).toContain('Showing 2 preview row(s):');
    const lines = text.split('\n');
    expect(lines).toContain(
      '- **1-55000002-A-T** | missense (missense_variant) | AF 0.000002 (2.000e-6) | AC 2/1000000 | hom 0 | hemi 0 | exome\\|genome | QC pass (exome passed, genome passed) | transcript ENST00000302118 (mane_select)',
    );
    expect(lines).toContain(
      '- **1-55000003-A-T** | missense (missense_variant) | AF 0.000003 (3.000e-6) | AC 3/1000000 | hom 0 | hemi 0 | exome\\|genome | flags lcr | QC pass (exome passed, genome passed) | transcript ENST00000302118 (mane_select)',
    );
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/57
  it('renders a row’s transcript and its marker, a marker without a transcript, and neither when both are null', () => {
    const lines = render({
      ...base,
      preview: [
        { ...row(4), transcript_id: 'ENST00000673903', consequence_transcript: 'other' },
        { ...row(5), transcript_id: null, consequence_transcript: 'other' },
        { ...row(6), consequence_transcript: null },
        { ...row(7), transcript_id: null, consequence_transcript: null },
      ],
    })
      .split('\n')
      .filter((line) => line.startsWith('- **'));

    expect(lines.map((line) => line.split(' | ').slice(7).join(' | '))).toEqual([
      'QC pass (exome passed, genome passed) | transcript ENST00000673903 (other)',
      'QC pass (exome passed, genome passed) | transcript none (other)',
      'QC pass (exome passed, genome passed) | transcript ENST00000302118',
      'QC pass (exome passed, genome passed)',
    ]);
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/54
  it('renders qc_filtered and each row’s QC status with only the callsets carrying it', () => {
    const lines = render({
      ...base,
      qc_filtered: 2,
      preview: [
        filteredRow(4),
        { ...row(5), exome_filters: 'AC0', qc_status: 'pass' },
        {
          ...filteredRow(6),
          source: 'exome|genome',
          exome_filters: 'AC0|AS_VQSR',
          genome_filters: 'AS_VQSR',
        },
      ],
    }).split('\n');

    expect(lines).toContain(
      '**Dataset:** gnomad_r4 (GRCh38) | **Spilled:** no | **QC filtered:** 2',
    );
    expect(
      lines
        .filter((line) => line.startsWith('- **'))
        .map((line) => line.split(' | ').find((part) => part.startsWith('QC '))),
    ).toEqual([
      'QC filtered (exome AC0)',
      'QC pass (exome AC0, genome passed)',
      'QC filtered (exome AC0\\|AS_VQSR, genome AS_VQSR)',
    ]);
  });

  it('renders a null AF as n/a', () => {
    expect(render({ ...base, preview: [row(0)] })).toContain('AF n/a');
  });

  it('renders the staged canvas_id and table for a spilled result', () => {
    const text = render({
      ...base,
      preview: [],
      canvas_id: 'cnv1234567',
      table_name: 'gene_variants',
      spilled: true,
      total: 1000,
    });
    expect(text).toContain('**Spilled:** yes');
    expect(text).toContain('canvas_id `cnv1234567`, table `gene_variants`');
  });
});

describe('gnomad_list_gene_variants format() staged line (#21, #33)', () => {
  const render = (result: Parameters<NonNullable<typeof gnomadListGeneVariants.format>>[0]) =>
    (gnomadListGeneVariants.format?.(result) ?? [])
      .map((b) => ('text' in b ? b.text : ''))
      .join('');
  const base = {
    ...ECHO,
    preview: [row(1)],
    spilled: false,
    total: 1,
    qc_filtered: 0,
    dataset: 'gnomad_r4',
    reference_genome: 'GRCh38',
  };

  it('renders an empty canvas_id as the neutral line, never as a disabled canvas', () => {
    const text = render({ ...base, canvas_id: '', table_name: '' });
    expect(text).toContain('**Staged:** no canvas table for this call.');
    expect(text).not.toMatch(/disabled/i);
  });

  it('names describe before query on a staged table, spilled or not', () => {
    for (const spilled of [true, false]) {
      const text = render({ ...base, spilled, canvas_id: REUSED, table_name: 'gene_variants' });
      expect(text).toContain(
        `**Staged:** canvas_id \`${REUSED}\`, table \`gene_variants\` — inspect with gnomad_dataframe_describe, then query with gnomad_dataframe_query.`,
      );
    }
  });
});

describe('gnomad_list_gene_variants blank transcript_id (#31)', () => {
  it.each([
    [{ gene: 'PCSK9' }, { kind: 'gene', value: 'PCSK9' }],
    [{ region: '1-55039974-55039980' }, { kind: 'region', value: '1-55039974-55039980' }],
  ])('treats a whitespace-only transcript_id beside %j as omitted', async (other, target) => {
    const fake = stubService([row(1)]);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const result = await runToolContract(gnomadListGeneVariants, {
      ...other,
      transcript_id: '   ',
    });

    expect(result.isError).toBeFalsy();
    expect(fake.listGeneVariants).toHaveBeenCalledWith(
      target,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('rejects a whitespace-only transcript_id alone as no target', async () => {
    const fake = stubService([row(1)]);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const result = await runToolContract(gnomadListGeneVariants, { transcript_id: '   ' });

    expect(result.isError).toBe(true);
    expect(
      (result.structuredContent as { error: { data: { reason: string } } }).error.data.reason,
    ).toBe('invalid_target');
    expect(fake.listGeneVariants).not.toHaveBeenCalled();
  });

  it('trims a padded transcript_id before the upstream call', async () => {
    const fake = stubService([row(1)]);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    await runToolContract(gnomadListGeneVariants, { transcript_id: ' ENST00000302118 ' });

    expect(fake.listGeneVariants).toHaveBeenCalledWith(
      { kind: 'transcript', value: 'ENST00000302118' },
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });
});

describe('gnomad_list_gene_variants blank gene (#31)', () => {
  it.each(['', '   ', '\t'])('treats gene %j beside a region as omitted', async (gene) => {
    const fake = stubService([row(1)]);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const result = await runToolContract(gnomadListGeneVariants, {
      gene,
      region: '1-55039974-55039980',
    });

    expect(result.isError).toBeFalsy();
    expect(fake.listGeneVariants).toHaveBeenCalledWith(
      { kind: 'region', value: '1-55039974-55039980' },
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it.each(['', '   '])('rejects gene %j alone as no target', async (gene) => {
    const fake = stubService([row(1)]);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const result = await runToolContract(gnomadListGeneVariants, { gene });

    expect(result.isError).toBe(true);
    expect(
      (result.structuredContent as { error: { data: { reason: string } } }).error.data.reason,
    ).toBe('invalid_target');
    expect(fake.listGeneVariants).not.toHaveBeenCalled();
  });

  it('still rejects a non-blank one-character gene at parse time', async () => {
    const fake = stubService([row(1)]);
    const result = await runToolContract(gnomadListGeneVariants, {
      gene: 'A',
      region: '1-55039974-55039980',
    });

    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error: { code: number } }).error.code).toBe(
      JsonRpcErrorCode.InvalidParams,
    );
    expect(fake.listGeneVariants).not.toHaveBeenCalled();
  });

  it('trims a padded gene before the upstream call', async () => {
    const fake = stubService([row(1)]);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    await runToolContract(gnomadListGeneVariants, { gene: ' PCSK9 ' });

    expect(fake.listGeneVariants).toHaveBeenCalledWith(
      { kind: 'gene', value: 'PCSK9' },
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });
});

describe('gnomad_list_gene_variants one-character gene message (#31)', () => {
  it('reports the gene length rule with blank as the alternative', async () => {
    stubService([row(1)]);
    const result = await runToolContract(gnomadListGeneVariants, { gene: 'A' });
    const message = (result.structuredContent as { error: { message: string } }).error.message;
    expect(message).toContain(
      'gene: Too small: expected string to have >=2 characters or blank to omit the gene',
    );
    expect(message).not.toMatch(/<=0/);
  });
});

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/62
describe('gnomad_list_gene_variants identifier normalization (#62)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetServerConfig();
    vi.restoreAllMocks();
  });

  it.each([
    [{ region: '1:55,039,447-55,064,852' }, { kind: 'region', value: '1-55039447-55064852' }],
    [{ gene: 'ensg00000169174' }, { kind: 'gene', value: 'ENSG00000169174' }],
    [{ transcript_id: 'ENST00000302118.5' }, { kind: 'transcript', value: 'ENST00000302118' }],
  ])('resolves %j to the canonical %j target', async (input, target) => {
    const fake = stubService([row(1)]);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const result = await runToolContract(gnomadListGeneVariants, input);

    expect(result.isError).toBeFalsy();
    expect(fake.listGeneVariants).toHaveBeenCalledWith(
      target,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('rejects a colon region at the schema with GNOMAD_NORMALIZE_IDS=false', async () => {
    vi.stubEnv('GNOMAD_NORMALIZE_IDS', 'false');
    resetServerConfig();
    const fake = stubService([row(1)]);

    const result = await runToolContract(gnomadListGeneVariants, { region: 'chr1:100-200' });

    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error: { code: number } }).error.code).toBe(
      JsonRpcErrorCode.InvalidParams,
    );
    expect(fake.listGeneVariants).not.toHaveBeenCalled();
  });
});

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/56
describe('gnomad_list_gene_variants unknown gene or transcript (#56)', () => {
  afterEach(() => vi.restoreAllMocks());

  /** Answer every gnomAD request with `envelope` through the real service; returns the request count. */
  function serveEnvelope(envelope: unknown): { count: number } {
    const sent = { count: 0 };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      sent.count += 1;
      return Response.json(envelope);
    });
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(realService);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);
    return sent;
  }

  it.each([
    [
      { gene: 'NOTAGENE123' },
      'gene_not_found',
      { errors: [{ message: 'Gene not found' }], data: { gene: null } },
      'Gene "NOTAGENE123" not found in GRCh38.',
    ],
    [
      { transcript_id: 'NM_174936.4' },
      'transcript_not_found',
      { errors: [{ message: 'Transcript not found' }], data: { transcript: null } },
      'Transcript "NM_174936.4" not found in GRCh38.',
    ],
  ])(
    'fails %j as %s with the declared recovery on both surfaces',
    async (input, reason, envelope, message) => {
      const sent = serveEnvelope(envelope);

      const result = await runToolContract(gnomadListGeneVariants, input);

      expect(result.isError).toBe(true);
      const recovery = gnomadListGeneVariants.errors?.find(
        (entry) => entry.reason === reason,
      )?.recovery;
      expect(recovery).toBeDefined();
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.NotFound,
          message,
          data: { reason, recovery: { hint: recovery } },
        },
      });
      expect(textOf(result)).toContain(message);
      expect(textOf(result)).toContain(recovery ?? '');
      expect(sent.count).toBe(1);
    },
  );

  it('answers a known gene with no variants as an empty success and the no-match notice', async () => {
    serveEnvelope({ data: { gene: { chrom: '1', variants: [] } } });

    const result = await runToolContract(gnomadListGeneVariants, { gene: 'PCSK9' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ total: 0, preview: [], notice: noMatch });
  });

  it('never raises a not-found reason for a region target', async () => {
    serveEnvelope({ data: { region: null } });

    const result = await runToolContract(gnomadListGeneVariants, { region: '1-55039447-55064852' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ total: 0 });
  });
});

interface Page {
  canvas_id: string;
  next_offset: number | null;
  notice?: string;
  preview: GeneVariantRow[];
  qc_filtered: number;
  spilled: boolean;
  table_name: string;
  total: number;
  truncated: boolean;
}

const pageOf = (result: CallToolResult) => result.structuredContent as unknown as Page;

/** The continuation notice a page without a staged table carries. */
const continuation = (from: number, to: number, total: number) =>
  `Showing variants ${from}–${to} of ${total}; continue with offset=${to} for the next page.`;

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/59
describe('gnomad_list_gene_variants paging (#59)', () => {
  afterEach(() => vi.restoreAllMocks());

  /** 100 rows of 400 JSON characters: 40,000 characters, past the 14,000-character staging budget. */
  const hundred = () => Array.from({ length: 100 }, (_, i) => sized(i + 1, 400));

  it('returns every row a limit covers with the canvas off, past the 14,000-character budget', async () => {
    const rows = hundred();
    stubService(rows);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const result = await runToolContract(gnomadListGeneVariants, { gene: 'PCSK9', limit: 100 });

    const page = pageOf(result);
    expect(page).toMatchObject({ total: 100, next_offset: null, canvas_id: '', table_name: '' });
    expect(page.preview).toEqual(rows);
    expect(page.notice).toBeUndefined();
    expect(textOf(result).match(/^- \*\*/gm)).toHaveLength(100);
  });

  it('walks every row once, in order, from offset 0 to a null next_offset with the canvas off', async () => {
    const rows = hundred();
    stubService(rows);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const walked: GeneVariantRow[] = [];
    const offsets: (number | null)[] = [];
    const truncated: string[] = [];
    let offset: number | null = 0;
    while (offset != null) {
      const result = await runToolContract(gnomadListGeneVariants, {
        gene: 'PCSK9',
        offset,
        limit: 30,
      });
      const page = pageOf(result);
      const text = textOf(result);
      expect(page.total).toBe(100);
      expect(text).toContain(`**Next offset:** ${page.next_offset ?? 'none'}`);
      // Both surfaces carry the page's rows.
      expect(text.match(/^- \*\*/gm)?.length ?? 0).toBe(page.preview.length);
      if (page.next_offset != null) {
        const notice = continuation(offset + 1, page.next_offset, 100);
        expect(page.notice).toBe(notice);
        expect(text).toContain(notice);
      } else {
        expect(page.notice).toBeUndefined();
      }
      expect(text).not.toContain('CANVAS_PROVIDER_TYPE');
      walked.push(...page.preview);
      offsets.push(page.next_offset);
      truncated.push(`${page.truncated} ${text.match(/\*\*Truncated:\*\* (yes|no)/)?.[1]}`);
      offset = page.next_offset;
    }

    expect(offsets).toEqual([30, 60, 90, null]);
    expect(truncated).toEqual(['true yes', 'true yes', 'true yes', 'false no']);
    expect(walked).toEqual(rows);
  });

  it('pages the default 25 rows and stages every matching variant at offset 0 with the canvas on', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => row(i + 1));
    stubService(rows);
    const { canvas, tables } = fakeCanvas();
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(canvas as never);

    const result = await runToolContract(gnomadListGeneVariants, { gene: 'PCSK9' });

    const page = pageOf(result);
    expect(page).toMatchObject({
      canvas_id: MINTED,
      table_name: 'gene_variants',
      spilled: true,
      total: 1000,
      next_offset: 25,
    });
    expect(page.preview).toEqual(rows.slice(0, 25));
    expect(tables.gene_variants).toHaveLength(1000);
    expect(page.notice).toBe(pointer(1000, MINTED));
    expect(textOf(result)).toContain('**Next offset:** 25');
  });

  it('serves a later page from the re-fetched rows without acquiring a canvas or staging', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => row(i + 1));
    const fake = stubService(rows);
    const { canvas, tables } = fakeCanvas();
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(canvas as never);

    const result = await runToolContract(gnomadListGeneVariants, { gene: 'PCSK9', offset: 25 });

    const page = pageOf(result);
    expect(page).toMatchObject({
      canvas_id: '',
      table_name: '',
      spilled: false,
      total: 1000,
      next_offset: 50,
    });
    expect(page.preview).toEqual(rows.slice(25, 50));
    expect(page.notice).toBe(continuation(26, 50, 1000));
    expect(canvas.acquire).not.toHaveBeenCalled();
    expect(tables).toEqual({});
    expect(fake.listGeneVariants).toHaveBeenCalledTimes(1);
  });

  it('leaves the table of a supplied canvas_id unchanged at an offset past 0', async () => {
    const { canvas, tables, dropped } = fakeCanvas();
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(canvas as never);
    const before = Array.from({ length: 500 }, (_, i) => row(i + 1));
    tables.gene_variants = before;
    stubService([row(7), row(8), row(9)]);

    const result = await runToolContract(gnomadListGeneVariants, {
      gene: 'PCSK9',
      offset: 1,
      canvas_id: REUSED,
    });

    expect(pageOf(result)).toMatchObject({
      preview: [row(8), row(9)],
      canvas_id: '',
      table_name: '',
      total: 3,
      next_offset: null,
    });
    expect(canvas.acquire).not.toHaveBeenCalled();
    expect(dropped).toEqual([]);
    expect(tables.gene_variants).toBe(before);
    expect(textOf(result)).toContain(NEUTRAL);
  });

  it('pages the rows the filters keep, with the same total and qc_filtered on every page', async () => {
    const all = mixedQc();
    const passing = all.filter((r) => r.qc_status === 'pass');
    const fake = stubService(all);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const pages = [];
    for (const offset of [0, 25, 650, 666, 700]) {
      pages.push({
        offset,
        page: pageOf(
          await runToolContract(gnomadListGeneVariants, {
            gene: 'PCSK9',
            consequence_class: 'missense',
            max_af: 0.01,
            pass_only: true,
            offset,
          }),
        ),
      });
    }

    for (const { offset, page } of pages) {
      expect(page.total).toBe(666);
      expect(page.qc_filtered).toBe(334);
      expect(page.preview).toEqual(passing.slice(offset, offset + 25));
    }
    expect(pages.map(({ page }) => page.next_offset)).toEqual([25, 50, null, null, null]);
    expect(pages[2]?.page.preview).toHaveLength(16);
    // Every filter reaches the service on every page; pass_only's drop applies to what it returns.
    expect(fake.listGeneVariants).toHaveBeenCalledTimes(5);
    for (const call of fake.listGeneVariants.mock.calls as unknown[][]) {
      expect(call[1]).toEqual({
        annotations: false,
        consequenceClass: 'missense',
        maxAf: 0.01,
        passOnly: true,
      });
    }
  });

  it.each([30, 500])(
    'returns an empty page, the same total, and a null next_offset at offset %i of 30',
    async (offset) => {
      stubService(Array.from({ length: 30 }, (_, i) => row(i + 1)));
      const { canvas } = fakeCanvas();
      vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(canvas as never);

      const result = await runToolContract(gnomadListGeneVariants, { gene: 'PCSK9', offset });

      const notice = `offset ${offset} is past the end of the 30 matching variant(s); use an offset below 30.`;
      expect(pageOf(result)).toMatchObject({
        preview: [],
        total: 30,
        next_offset: null,
        canvas_id: '',
        table_name: '',
        notice,
      });
      expect(textOf(result)).toContain(notice);
      expect(textOf(result)).toContain('**Next offset:** none');
      expect(canvas.acquire).not.toHaveBeenCalled();
    },
  );

  it('keeps the no-match notice alone for an empty result at an offset past 0', async () => {
    stubService([]);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const result = await runToolContract(gnomadListGeneVariants, { gene: 'PCSK9', offset: 50 });

    expect(pageOf(result)).toMatchObject({
      preview: [],
      total: 0,
      next_offset: null,
      notice: noMatch,
    });
  });

  it('describes the re-fetch on every page in the tool description', () => {
    expect(gnomadListGeneVariants.description).toMatch(/each page re-fetches the whole target/i);
    expect(gnomadListGeneVariants.input.parse({ gene: 'PCSK9' })).toMatchObject({
      offset: 0,
      limit: 25,
    });
    expect(() => gnomadListGeneVariants.input.parse({ gene: 'PCSK9', offset: -1 })).toThrow();
  });
});

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/63
describe('gnomad_list_gene_variants limit (#63)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('clamps a limit above 3,000 to 3,000 with a notice on both surfaces, paging from the effective value', async () => {
    const rows = Array.from({ length: 4000 }, (_, i) => row(i + 1));
    stubService(rows);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const result = await runToolContract(gnomadListGeneVariants, { gene: 'PCSK9', limit: 5000 });

    const page = pageOf(result);
    expect(page.preview).toEqual(rows.slice(0, 3000));
    expect(page.next_offset).toBe(3000);
    const clamped = 'Requested limit 5000 was clamped to the cap of 3000.';
    expect(page.notice).toBe(`${clamped} ${continuation(1, 3000, 4000)}`);
    expect(textOf(result)).toContain(clamped);
  });

  it('adds no clamp notice for a limit at the cap', async () => {
    stubService(Array.from({ length: 3000 }, (_, i) => row(i + 1)));
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const result = await runToolContract(gnomadListGeneVariants, { gene: 'PCSK9', limit: 3000 });

    expect(pageOf(result)).toMatchObject({ next_offset: null });
    expect(pageOf(result).preview).toHaveLength(3000);
    expect(pageOf(result).notice).toBeUndefined();
  });

  it('advertises a default of 25 and a minimum of 1 with no maximum while clamping', () => {
    const { limit, offset } = (
      z.toJSONSchema(gnomadListGeneVariants.input) as {
        properties: Record<string, Record<string, unknown>>;
      }
    ).properties as Record<string, Record<string, unknown>>;
    expect(limit).toMatchObject({ default: 25, minimum: 1 });
    expect(limit).not.toHaveProperty('maximum');
    expect(offset).toMatchObject({ default: 0, minimum: 0 });
    expect(gnomadListGeneVariants.input.safeParse({ gene: 'PCSK9', limit: 2.5 }).success).toBe(
      false,
    );
  });
});

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/70
describe('gnomad_list_gene_variants target and filter echo (#70)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('echoes the target and row filters on both surfaces', async () => {
    stubService([row(1)]);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const result = await runToolContract(gnomadListGeneVariants, {
      gene: 'PCSK9',
      consequence_class: 'lof',
      max_af: 0.001,
    });

    expect(result.structuredContent).toMatchObject({
      target: 'PCSK9',
      target_kind: 'gene',
      filters: { consequence_class: 'lof', max_af: 0.001, pass_only: null },
    });
    expect(textOf(result)).toContain(
      '**Target:** gene PCSK9 | **Filters:** consequence_class=lof, max_af=0.001',
    );
  });

  it('echoes a region with every filter null and renders the filters as none', async () => {
    stubService([row(1)]);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const result = await runToolContract(gnomadListGeneVariants, {
      region: '13-32315474-32400266',
    });

    expect(result.structuredContent).toMatchObject({
      target: '13-32315474-32400266',
      target_kind: 'region',
      filters: {
        consequence_class: null,
        lof_confidence: null,
        max_af: null,
        max_faf: null,
        pass_only: null,
      },
    });
    expect(textOf(result)).toContain('**Target:** region 13-32315474-32400266 | **Filters:** none');
  });

  it.each([
    [true, true, ' | **Filters:** pass_only=true'],
    [false, null, ' | **Filters:** none'],
  ] as const)('echoes pass_only %s as %s', async (passOnly, echoed, rendered) => {
    stubService([row(1)]);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const result = await runToolContract(gnomadListGeneVariants, {
      gene: 'PCSK9',
      pass_only: passOnly,
    });

    expect((result.structuredContent as { filters: unknown }).filters).toEqual({
      consequence_class: null,
      lof_confidence: null,
      max_af: null,
      max_faf: null,
      pass_only: echoed,
    });
    expect(textOf(result)).toContain(`**Target:** gene PCSK9${rendered}`);
  });

  it.each([' pcsk9 ', 'ensg00000169174', 'ENST00000302118.5'])(
    'echoes the target gnomad_get_coverage echoes for %j',
    async (value) => {
      const field = value.startsWith('ENST') ? 'transcript_id' : 'gene';
      vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue({
        resolveDatasetContext: realService.resolveDatasetContext.bind(realService),
        listGeneVariants: async () => [row(1)],
        getCoverage: async () => [],
      } as never);
      vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

      const listed = await runToolContract(gnomadListGeneVariants, { [field]: value });
      const covered = await runToolContract(gnomadGetCoverage, { [field]: value });

      const echo = (result: CallToolResult) => {
        const { target, target_kind } = result.structuredContent as Record<string, unknown>;
        return { target, target_kind };
      };
      expect(echo(listed)).toEqual(echo(covered));
      expect(echo(listed).target).not.toBe(value);
    },
  );

  it('keeps offset, limit, canvas_id, and annotations out of filters', async () => {
    stubService([row(1)]);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const result = await runToolContract(gnomadListGeneVariants, {
      gene: 'PCSK9',
      offset: 0,
      limit: 10,
      canvas_id: REUSED,
      max_af: 0.5,
      annotations: true,
    });

    const { filters } = result.structuredContent as { filters: Record<string, unknown> };
    expect(Object.keys(filters)).toEqual([
      'consequence_class',
      'lof_confidence',
      'max_af',
      'max_faf',
      'pass_only',
    ]);
    expect(textOf(result)).toContain('**Filters:** max_af=0.5\n');
    expect(textOf(result)).not.toContain('annotations');
  });
});

describe('gnomad_list_gene_variants definition-time limit mode (#63)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('advertises and enforces a maximum of 3,000 with GNOMAD_CLAMP_LIMITS=false', async () => {
    vi.stubEnv('GNOMAD_CLAMP_LIMITS', 'false');
    vi.resetModules();
    const { gnomadListGeneVariants: strict } = await import(
      '@/mcp-server/tools/definitions/gnomad-list-gene-variants.tool.js'
    );

    const { limit } = (
      z.toJSONSchema(strict.input) as { properties: Record<string, Record<string, unknown>> }
    ).properties as Record<string, Record<string, unknown>>;
    expect(limit).toMatchObject({ default: 25, minimum: 1, maximum: 3000 });
    expect(strict.input.safeParse({ gene: 'PCSK9', limit: 3000 }).success).toBe(true);
    expect(strict.input.safeParse({ gene: 'PCSK9', limit: 3001 }).success).toBe(false);
  });
});

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/68
describe('gnomad_list_gene_variants on a subset dataset (#68)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends gnomad_r2_1_non_neuro as given and sums the callsets of its rows', async () => {
    const live = SUBSET_REPLIES['list-region:gnomad_r2_1_non_neuro:1-55505647-55505647'];
    const requests: { variables: Record<string, unknown> }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { variables: Record<string, unknown> };
      requests.push(request);
      if (!live) throw new Error('Unmocked gnomAD document');
      return Response.json(live.body, { status: live.status });
    });
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(realService);

    const result = await runToolContract(gnomadListGeneVariants, {
      region: '1-55505647-55505647',
      dataset: 'gnomad_r2_1_non_neuro',
    });

    expect(result.isError).toBeFalsy();
    expect(requests.map((request) => request.variables)).toEqual([
      {
        chrom: '1',
        start: 55505647,
        stop: 55505647,
        dataset: 'gnomad_r2_1_non_neuro',
        referenceGenome: 'GRCh37',
        // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/64
        jointFafmax: false,
        callsetFafmax: false,
        callsetFaf95: true,
        // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/65
        annotations: false,
      },
    ]);
    expect(result.structuredContent).toMatchObject({
      dataset: 'gnomad_r2_1_non_neuro',
      reference_genome: 'GRCh37',
      total: 1,
      preview: [{ variant_id: '1-55505647-G-T', ac: 1863 + 279, an: 163544 + 21264 }],
    });
  });

  it('describes joint counts as gnomad_r4 only, gnomad_r4_non_ukb summed', () => {
    const rowShape = (
      gnomadListGeneVariants.output.shape.preview as unknown as {
        element: { shape: Record<string, { description?: string }> };
      }
    ).element.shape;
    expect(rowShape.ac?.description).toMatch(/gnomad_r4_non_ukb/);
    expect(rowShape.an?.description).toMatch(/gnomad_r4_non_ukb/);
    expect(gnomadListGeneVariants.input.shape.pass_only.description).toMatch(/gnomad_r4_non_ukb/);
  });
});

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/75
describe('gnomad_list_gene_variants hemizygote_count (#75)', () => {
  afterEach(() => vi.restoreAllMocks());

  /** Live X-38403555-G-A row on gnomad_r4, captured 2026-11-04 (UTC). */
  const X_R4_ROW = {
    variant_id: 'X-38403555-G-A',
    consequence: 'intron_variant',
    transcript_id: 'ENST00000039007',
    flags: [],
    exome: {
      ac: 395059,
      an: 1028348,
      af: 0.38416858884346544,
      homozygote_count: 54539,
      hemizygote_count: 125444,
      filters: [],
    },
    genome: {
      ac: 51516,
      an: 110767,
      af: 0.46508436628237654,
      homozygote_count: 9642,
      hemizygote_count: 15246,
      filters: [],
    },
    joint: { ac: 446575, an: 1139115, homozygote_count: 64181, hemizygote_count: 140690 },
  };

  it('carries the joint hemizygote count on both surfaces and in the staged table', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({ data: { region: { variants: [X_R4_ROW] } } }),
    );
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(realService);
    const { canvas, tables } = fakeCanvas();
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(canvas as never);

    const result = await runToolContract(gnomadListGeneVariants, {
      region: 'X-38403555-38403555',
      canvas_id: REUSED,
    });

    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as { preview: GeneVariantRow[] };
    expect(sc.preview).toMatchObject([{ homozygote_count: 64181, hemizygote_count: 140690 }]);
    expect(tables.gene_variants).toEqual(sc.preview);
    expect(textOf(result)).toContain('| hom 64181 | hemi 140690 |');
  });

  it('leaves hemi out of a row line whose hemizygote_count is null', async () => {
    stubService([{ ...row(1), hemizygote_count: null }, row(2)]);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const result = await runToolContract(gnomadListGeneVariants, { gene: 'OTC' });

    const [nullHemi, zeroHemi] = textOf(result)
      .split('\n')
      .filter((line) => line.startsWith('- **'));
    expect(nullHemi).toContain('| hom 0 | exome\\|genome |');
    expect(zeroHemi).toContain('| hom 0 | hemi 0 | exome\\|genome |');
    const sc = result.structuredContent as { preview: GeneVariantRow[] };
    expect(sc.preview.map((r) => r.hemizygote_count)).toEqual([null, 0]);
  });

  it('declares hemizygote_count a nullable count beside homozygote_count', () => {
    const rowShape = (
      gnomadListGeneVariants.output.shape.preview as unknown as {
        element: { shape: Record<string, z.ZodType> };
      }
    ).element.shape;
    const keys = Object.keys(rowShape);
    expect(keys.indexOf('hemizygote_count')).toBe(keys.indexOf('homozygote_count') + 1);
    expect(rowShape.hemizygote_count?.safeParse(null).success).toBe(true);
    expect(gnomadListGeneVariants.input.shape.pass_only.description).toMatch(/hemizygote_count/);
  });
});

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/64
describe('gnomad_list_gene_variants faf95_max and max_faf (#64)', () => {
  afterEach(() => vi.restoreAllMocks());

  /** Run the real service over gnomAD's live FAF replies, canvas off. */
  function serveLive() {
    fakeFafLists();
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(realService);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);
  }
  const untested = (count: number, total: number) =>
    `max_faf could not test ${count} of the ${total} variant(s) it kept: gnomAD reports no filtering allele frequency for them (faf95_max null), so judge them by af.`;
  const noFafRows = (dataset: string) =>
    `${dataset} list rows carry no filtering allele frequency (faf95_max is null on every row), so max_faf filtered no variant.`;
  const out = (result: CallToolResult) =>
    gnomadListGeneVariants.output.parse(result.structuredContent);

  it('lists PCSK9 on gnomad_r4 whole without max_faf, with no FAF notice and a null max_faf echo', async () => {
    serveLive();

    const result = await runToolContract(gnomadListGeneVariants, { gene: 'PCSK9' });

    const sc = result.structuredContent as { total: number; notice?: string };
    expect(out(result)).toMatchObject({ total: 4544, filters: { max_faf: null } });
    expect(sc.notice).not.toMatch(/max_faf|filtering allele frequency/);
    expect(textOf(result)).toContain('**Target:** gene PCSK9 | **Filters:** none');
  });

  it.each([
    [1, 4544],
    [0.001, 4409],
    [0, 3004],
  ])(
    'keeps %d → %i PCSK9 rows on gnomad_r4, counting the 3,004 null-FAF rows kept, on both surfaces',
    async (maxFaf, total) => {
      serveLive();

      const result = await runToolContract(gnomadListGeneVariants, {
        gene: 'PCSK9',
        max_faf: maxFaf,
      });

      const parsed = out(result);
      expect(parsed).toMatchObject({ total, filters: { max_faf: maxFaf } });
      expect(parsed.preview.every((r) => r.faf95_max == null || r.faf95_max <= maxFaf)).toBe(true);
      const notice = (result.structuredContent as { notice: string }).notice;
      expect(notice).toContain(untested(3004, total));
      const text = textOf(result);
      expect(text).toContain(untested(3004, total));
      expect(text).toContain(`**Target:** gene PCSK9 | **Filters:** max_faf=${maxFaf}\n`);
    },
  );

  it('keeps 1,316 PCSK9 rows on gnomad_r2_1 under max_faf 0.001, 857 of them untested', async () => {
    serveLive();

    const result = await runToolContract(gnomadListGeneVariants, {
      gene: 'PCSK9',
      dataset: 'gnomad_r2_1',
      max_faf: 0.001,
    });

    expect(out(result)).toMatchObject({ total: 1316, dataset: 'gnomad_r2_1' });
    expect((result.structuredContent as { notice: string }).notice).toContain(untested(857, 1316));
  });

  it.each([
    ['gnomad_r3', { gene: 'INS' }, 156],
    ['exac', { region: '1-55505647-55505647' }, 1],
  ] as const)(
    'filters nothing on %s, whose list rows carry no FAF, and says so',
    async (dataset, target, total) => {
      serveLive();

      const result = await runToolContract(gnomadListGeneVariants, {
        ...target,
        dataset,
        max_faf: 0.001,
      });

      const parsed = out(result);
      expect(parsed.total).toBe(total);
      expect(parsed.preview.every((r) => r.faf95_max === null && r.faf95_max_group === null)).toBe(
        true,
      );
      const notice = (result.structuredContent as { notice: string }).notice;
      expect(notice).toContain(noFafRows(dataset));
      expect(notice).not.toContain('max_faf could not test');
      expect(textOf(result)).toContain(noFafRows(dataset));
    },
  );

  it('adds no untested count when max_faf leaves no row to count', async () => {
    serveLive();

    const result = await runToolContract(gnomadListGeneVariants, {
      region: '1-55039974-55039974',
      max_faf: 0.01,
      consequence_class: 'synonymous',
    });

    const sc = result.structuredContent as { total: number; notice: string };
    expect(sc.total).toBe(0);
    expect(sc.notice).toBe(
      'No variants in region "1-55039974-55039974" matching consequence_class=synonymous, max_faf=0.01. Broaden the filters.',
    );
  });

  it('carries faf95_max and its group on both surfaces, and leaves a null one out of the row line', async () => {
    serveLive();

    const result = await runToolContract(gnomadListGeneVariants, {
      region: '1-55039974-55039974',
    });

    expect(out(result).preview.map((r) => [r.variant_id, r.faf95_max, r.faf95_max_group])).toEqual([
      ['1-55039974-G-T', 0.01649444, 'nfe'],
      ['1-55039974-G-A', null, null],
    ]);
    const [withFaf, withoutFaf] = textOf(result)
      .split('\n')
      .filter((line) => line.startsWith('- **'));
    expect(withFaf).toMatch(
      /^- \*\*1-55039974-G-T\*\* \|.* \| hom 226 \| FAF95 0\.01649444 \(nfe\) \| /,
    );
    expect(withoutFaf).toMatch(/^- \*\*1-55039974-G-A\*\* \|/);
    expect(withoutFaf).not.toContain('FAF95');
  });

  it('renders a FAF95 whose group gnomAD leaves unnamed without one', async () => {
    stubService([{ ...row(1), faf95_max: 0.0021, faf95_max_group: null }]);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const result = await runToolContract(gnomadListGeneVariants, { gene: 'PCSK9' });

    expect(textOf(result)).toContain('| hom 0 | hemi 0 | FAF95 0.0021 | exome\\|genome |');
  });

  it.each([
    [0, true],
    [1, true],
    [-0.001, false],
    [1.001, false],
  ])('takes max_faf %d: %s', (maxFaf, accepted) => {
    expect(gnomadListGeneVariants.input.safeParse({ gene: 'PCSK9', max_faf: maxFaf }).success).toBe(
      accepted,
    );
  });

  it('declares faf95_max and faf95_max_group after hemizygote_count, both nullable', () => {
    const rowShape = (
      gnomadListGeneVariants.output.shape.preview as unknown as {
        element: { shape: Record<string, z.ZodType> };
      }
    ).element.shape;
    const keys = Object.keys(rowShape);
    expect(keys.slice(keys.indexOf('hemizygote_count') + 1, keys.indexOf('source'))).toEqual([
      'faf95_max',
      'faf95_max_group',
    ]);
    expect(rowShape.faf95_max?.safeParse(null).success).toBe(true);
    expect(rowShape.faf95_max_group?.safeParse(null).success).toBe(true);
  });
});

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/65
describe('gnomad_list_gene_variants lof, lof_confidence, and annotations (#65)', () => {
  afterEach(() => vi.restoreAllMocks());

  const ANNOTATIONS = ['hgvsc', 'hgvsp', 'lof_filter', 'lof_flags', 'rsids'] as const;

  /** Run the real service over gnomAD's live list replies, canvas off. */
  function serveLive() {
    const requests = fakeFafLists();
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(realService);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);
    return requests;
  }
  const out = (result: CallToolResult) =>
    gnomadListGeneVariants.output.parse(result.structuredContent);
  const rowLines = (result: CallToolResult) =>
    textOf(result)
      .split('\n')
      .filter((line) => line.startsWith('- **'));

  it.each([
    ['HC', 181],
    ['LC', 23],
  ] as const)(
    'keeps the %s rows of PCSK9 on gnomad_r4 (%i), echoed and rendered on both surfaces',
    async (lofConfidence, total) => {
      serveLive();

      const result = await runToolContract(gnomadListGeneVariants, {
        gene: 'PCSK9',
        lof_confidence: lofConfidence,
        limit: 3000,
      });

      expect(result.isError).toBeFalsy();
      const parsed = out(result);
      expect(parsed).toMatchObject({ total, filters: { lof_confidence: lofConfidence } });
      expect(parsed.preview.every((r) => r.lof === lofConfidence)).toBe(true);
      expect(textOf(result)).toContain(`**Filters:** lof_confidence=${lofConfidence}\n`);
      const lines = rowLines(result);
      expect(lines).toHaveLength(total);
      expect(lines.every((line) => line.endsWith(` | LoF ${lofConfidence}`))).toBe(true);
    },
  );

  it('lists PCSK9 whole without lof_confidence: 4,544 rows, 4,340 with lof null, a null echo', async () => {
    serveLive();

    const result = await runToolContract(gnomadListGeneVariants, { gene: 'PCSK9', limit: 3000 });
    const rest = await runToolContract(gnomadListGeneVariants, {
      gene: 'PCSK9',
      limit: 3000,
      offset: 3000,
    });

    const parsed = out(result);
    expect(parsed).toMatchObject({ total: 4544, filters: { lof_confidence: null } });
    expect(textOf(result)).not.toContain('lof_confidence');
    const rows = [...parsed.preview, ...out(rest).preview];
    expect(rows).toHaveLength(4544);
    expect(rows.filter((r) => r.lof == null)).toHaveLength(4340);
  });

  it.each([
    ['HC', 1],
    ['LC', 9],
  ] as const)(
    'keeps %s INS rows on gnomad_r2_1 (%i), never the OS row',
    async (lofConfidence, total) => {
      serveLive();

      const result = await runToolContract(gnomadListGeneVariants, {
        gene: 'INS',
        dataset: 'gnomad_r2_1',
        lof_confidence: lofConfidence,
      });

      const parsed = out(result);
      expect(parsed.total).toBe(total);
      expect(parsed.preview.map((r) => r.variant_id)).not.toContain(
        '11-2181230-G-GCAGGTCCTCTGCCTC',
      );
      expect(textOf(result)).not.toContain('11-2181230-G-GCAGGTCCTCTGCCTC');
    },
  );

  it('names lof_confidence in the no-match notice of an empty result', async () => {
    serveLive();

    const result = await runToolContract(gnomadListGeneVariants, {
      region: '1-55505647-55505647',
      dataset: 'gnomad_r2_1',
      lof_confidence: 'HC',
    });

    expect(out(result)).toMatchObject({ total: 0, preview: [] });
    expect((result.structuredContent as { notice?: string }).notice).toBe(
      'No variants in region "1-55505647-55505647" matching lof_confidence=HC. Broaden the filters.',
    );
  });

  it('counts the HC rows max_faf could not test, beside lof_confidence', async () => {
    serveLive();

    const result = await runToolContract(gnomadListGeneVariants, {
      gene: 'PCSK9',
      lof_confidence: 'HC',
      max_faf: 0.0001,
    });

    expect(out(result)).toMatchObject({
      total: 175,
      filters: { lof_confidence: 'HC', max_faf: 0.0001 },
    });
    expect((result.structuredContent as { notice?: string }).notice).toContain(
      'max_faf could not test 122 of the 175 variant(s) it kept',
    );
    expect(textOf(result)).toContain('**Filters:** lof_confidence=HC, max_faf=0.0001\n');
  });

  it('takes lof_confidence HC or LC and a boolean annotations', () => {
    const parse = (input: Record<string, unknown>) =>
      gnomadListGeneVariants.input.safeParse({ gene: 'PCSK9', ...input }).success;

    expect(parse({ lof_confidence: 'HC' })).toBe(true);
    expect(parse({ lof_confidence: 'LC', annotations: true })).toBe(true);
    expect(parse({ annotations: false })).toBe(true);
    expect(parse({ annotations: 'true' })).toBe(false);
  });

  it.each(['OS', 'hc', '', 'HC '])('rejects lof_confidence %j at the schema', async (value) => {
    expect(
      gnomadListGeneVariants.input.safeParse({ gene: 'PCSK9', lof_confidence: value }).success,
    ).toBe(false);
    const fake = stubService([row(1)]);

    const result = await runToolContract(gnomadListGeneVariants, {
      gene: 'PCSK9',
      lof_confidence: value,
    } as never);

    expect(result.isError).toBe(true);
    expect(fake.listGeneVariants).not.toHaveBeenCalled();
  });

  it('sends annotations false by default: rows and their lines carry lof and none of the five', async () => {
    const requests = serveLive();

    const result = await runToolContract(gnomadListGeneVariants, { gene: 'PCSK9' });

    expect(requests[0]?.variables).toMatchObject({ annotations: false });
    const preview = (result.structuredContent as { preview: Record<string, unknown>[] }).preview;
    expect(preview).toHaveLength(25);
    for (const r of [...preview, ...out(result).preview]) {
      expect('lof' in r).toBe(true);
      expect(ANNOTATIONS.filter((name) => name in r)).toEqual([]);
    }
    expect(textOf(result)).not.toMatch(/HGVSc|HGVSp|LoF filter|LoF flags|rsIDs/);
  });

  it('returns the region row 1-55505647-G-T with its live annotations on both surfaces', async () => {
    const sent: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const { variables } = JSON.parse(String(init?.body)) as {
        variables: Record<string, unknown>;
      };
      sent.push(variables);
      const row = variables.annotations ? PCSK9_R2_1_REGION_ANNOTATED_ROW : PCSK9_R2_1_REGION_ROW;
      return Response.json({ data: { region: { variants: [row] } } });
    });
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(realService);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const result = await runToolContract(gnomadListGeneVariants, {
      region: '1-55505647-55505647',
      dataset: 'gnomad_r2_1',
      annotations: true,
    });

    expect(sent).toMatchObject([{ annotations: true }]);
    const [annotated] = out(result).preview;
    expect(annotated).toMatchObject({
      variant_id: '1-55505647-G-T',
      lof: null,
      hgvsc: 'c.137G>T',
      hgvsp: 'p.Arg46Leu',
      lof_filter: null,
      lof_flags: null,
      rsids: 'rs11591147',
    });
    expect(Object.keys(annotated ?? {}).slice(-6)).toEqual(['lof', ...ANNOTATIONS]);
    // annotations is a column toggle, not a filter.
    expect(out(result).filters).not.toHaveProperty('annotations');
    // A null lof, lof_filter, and lof_flags render no field.
    expect(rowLines(result)).toEqual([
      expect.stringMatching(
        / \| transcript ENST00000302118 \| HGVSc c\.137G>T \| HGVSp p\.Arg46Leu \| rsIDs rs11591147$/,
      ),
    ]);
  });

  it('renders lof and each annotations value on a row line, and nothing for a null or empty one', () => {
    const lines = (
      gnomadListGeneVariants.format?.({
        ...ECHO,
        canvas_id: '',
        table_name: '',
        spilled: false,
        total: 3,
        qc_filtered: 0,
        dataset: 'gnomad_r4',
        reference_genome: 'GRCh38',
        preview: [
          { ...row(1), lof: 'LC' },
          {
            ...row(2),
            lof: 'LC',
            hgvsc: 'c.1819G>T',
            hgvsp: 'p.Glu607Ter',
            lof_filter: 'END_TRUNC',
            lof_flags: 'PHYLOCSF_WEAK',
            rsids: 'rs1|rs2',
          },
          { ...row(3), hgvsc: null, hgvsp: null, lof_filter: null, lof_flags: null, rsids: '' },
        ],
      }) ?? []
    )
      .map((b) => ('text' in b ? b.text : ''))
      .join('\n')
      .split('\n')
      .filter((line) => line.startsWith('- **'))
      .map((line) => line.slice(line.indexOf('| transcript')));

    expect(lines).toEqual([
      '| transcript ENST00000302118 (mane_select) | LoF LC',
      '| transcript ENST00000302118 (mane_select) | LoF LC | HGVSc c.1819G>T | HGVSp p.Glu607Ter | LoF filter END_TRUNC | LoF flags PHYLOCSF_WEAK | rsIDs rs1\\|rs2',
      '| transcript ENST00000302118 (mane_select)',
    ]);
  });

  it('declares lof after consequence_transcript and the five optional columns last', () => {
    const rowShape = (
      gnomadListGeneVariants.output.shape.preview as unknown as {
        element: { shape: Record<string, z.ZodType> };
      }
    ).element.shape;
    const keys = Object.keys(rowShape);
    expect(keys.slice(-7)).toEqual(['consequence_transcript', 'lof', ...ANNOTATIONS]);
    expect(rowShape.lof?.safeParse(undefined).success).toBe(false);
    for (const name of ANNOTATIONS) {
      expect(rowShape[name]?.safeParse(undefined).success).toBe(true);
      expect(rowShape[name]?.description).toMatch(/Present only when annotations is true/);
    }
    expect(rowShape.rsids?.safeParse(null).success).toBe(false);
    expect(gnomadListGeneVariants.input.shape.annotations.description).toMatch(/not a filter/);
  });
});
