/**
 * @fileoverview Behavior tests for the gnomad_list_gene_variants handler:
 * canvas-disabled (a preview of the rows within the 14,000-character budget,
 * empty canvas_id, no-match + cap notices), canvas-enabled staging (no canvas for a fit without canvas_id, a
 * spill past the 14,000-character preview budget, a supplied canvas_id that
 * replaces or drops the table), the notice/staged-line matrix on both surfaces,
 * the ~24 KB response budget on real PCSK9 rows, format(), and the input
 * contracts (invalid_target, incoherent_build, blank transcript_id). Stubs the
 * service network method and the canvas accessor; drives the real spillover()
 * helper against a fake canvas.
 * @module tests/tools/gnomad-list-gene-variants.test
 */

import { readFileSync } from 'node:fs';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { gnomadListGeneVariants } from '@/mcp-server/tools/definitions/gnomad-list-gene-variants.tool.js';
import * as canvasAccessor from '@/services/canvas-accessor.js';
import * as serviceModule from '@/services/gnomad/gnomad-service.js';
import { GnomadService } from '@/services/gnomad/gnomad-service.js';
import type { GeneVariantRow } from '@/services/gnomad/types.js';
import { PCSK9_R4_GENE } from '../helpers/live-consequences.js';

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
    source: 'exome|genome',
    flags: '',
    exome_filters: '',
    genome_filters: '',
    qc_status: 'pass',
    transcript_id: 'ENST00000302118',
    consequence_transcript: 'mane_select',
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

  it('previews every row of a result that fits the 14,000-character budget, however many (#37)', async () => {
    // 45 compact rows (~295 characters each, no consequence) sum to under 14,000.
    const rows = Array.from({ length: 45 }, (_, i) => ({
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
    const input = gnomadListGeneVariants.input.parse({ gene: 'BRCA2' });
    const result = await gnomadListGeneVariants.handler(input, ctx as never);

    expect(result.total).toBe(45);
    expect(result.preview).toHaveLength(45);
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('previews the longest prefix within the budget and notices the truncation (#37)', async () => {
    const rows = [...Array.from({ length: 39 }, (_, i) => sized(i + 1, 350)), sized(40, 351)];
    stubService(rows);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const ctx = createMockContext({ errors: gnomadListGeneVariants.errors });
    const input = gnomadListGeneVariants.input.parse({ gene: 'BRCA2' });
    const result = await gnomadListGeneVariants.handler(input, ctx as never);

    expect(result.total).toBe(40);
    expect(result.preview).toEqual(rows.slice(0, 39));
    expect(getEnrichment(ctx).notice).toMatch(/showing 39 of 40 variants/);
  });

  it('previews fewer long-ID rows than short ones under the same budget (#37)', async () => {
    stubService(Array.from({ length: 75 }, (_, i) => sized(i + 1, 400)));
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const ctx = createMockContext({ errors: gnomadListGeneVariants.errors });
    const input = gnomadListGeneVariants.input.parse({ gene: 'KCNQ1' });
    const result = await gnomadListGeneVariants.handler(input, ctx as never);

    expect(result.preview).toHaveLength(35);
    expect(getEnrichment(ctx).notice).toMatch(/showing 35 of 75 variants/);
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
    stubService(Array.from({ length: 40 }, (_, i) => sized(i + 1, 350)));
    const { canvas } = fakeCanvas();
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(canvas as never);

    const ctx = createMockContext({ errors: gnomadListGeneVariants.errors });
    const input = gnomadListGeneVariants.input.parse({ gene: 'PCSK9' });
    const result = await gnomadListGeneVariants.handler(input, ctx as never);

    expect(result).toMatchObject({ spilled: false, canvas_id: '', total: 40 });
    expect(result.preview).toHaveLength(40);
    expect(canvas.acquire).not.toHaveBeenCalled();
  });

  it('spills one character past 14,000 and previews the rows under the budget (#37 boundary)', async () => {
    const rows = [...Array.from({ length: 39 }, (_, i) => sized(i + 1, 350)), sized(40, 351)];
    stubService(rows);
    const { canvas, tables } = fakeCanvas();
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(canvas as never);

    const ctx = createMockContext({ errors: gnomadListGeneVariants.errors });
    const input = gnomadListGeneVariants.input.parse({ gene: 'PCSK9' });
    const result = await gnomadListGeneVariants.handler(input, ctx as never);

    expect(result).toMatchObject({ spilled: true, table_name: 'gene_variants', total: 40 });
    expect(result.preview).toHaveLength(39);
    expect(tables.gene_variants).toHaveLength(40);
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
const noMatch =
  'No variants in gene "PCSK9". Broaden the filters, or verify the gene exists in this dataset.';
/** 100 rows of 350 characters against the 14,000-character budget: a 40-row prefix. */
const capped =
  'Canvas is disabled (set CANVAS_PROVIDER_TYPE=duckdb) — showing 40 of 100 variants. Enable the canvas to query the full set with gnomad_dataframe_query.';
const NEUTRAL = '**Staged:** no canvas table for this call.';
const stagedLine = (id: string) =>
  `**Staged:** canvas_id \`${id}\`, table \`gene_variants\` — inspect with gnomad_dataframe_describe, then query with gnomad_dataframe_query.`;

type Size = 'spill' | 'fit' | 'zero';
const rowsFor: Record<Size, () => GeneVariantRow[]> = {
  spill: () => Array.from({ length: 100 }, (_, i) => sized(i + 1, 350)),
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
    notice: capped,
    line: NEUTRAL,
  },
  {
    canvas: 'disabled',
    size: 'spill',
    canvasId: REUSED,
    sc: { canvas_id: '', table_name: '', spilled: false, total: 100 },
    notice: capped,
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
        { consequenceClass: 'missense', maxAf: 0.01 },
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
      { consequenceClass: 'lof', maxAf: 0.001 },
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

describe('gnomad_list_gene_variants response budget (#37)', () => {
  // The first 120 rows of the server's live gnomad_r4 PCSK9 list, captured 2026-11-01 06:23 (UTC).
  const LIVE_ROWS = JSON.parse(
    readFileSync(new URL('../fixtures/pcsk9-gene-variants.live.json', import.meta.url), 'utf8'),
  ) as GeneVariantRow[];

  it.each(['enabled', 'disabled'] as const)(
    'keeps a real-row response under 24 KB with the canvas %s',
    async (mode) => {
      stubService(LIVE_ROWS);
      const { canvas } = fakeCanvas();
      vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(
        mode === 'enabled' ? (canvas as never) : undefined,
      );

      const result = await runToolContract(gnomadListGeneVariants, { gene: 'PCSK9' });

      const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
      expect(bytes).toBeLessThan(24_000);
      expect(bytes).toBeGreaterThan(18_000);
      const sc = result.structuredContent as { preview: GeneVariantRow[]; total: number };
      expect(sc.total).toBe(LIVE_ROWS.length);
      expect(sc.preview.length).toBeLessThan(LIVE_ROWS.length);
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
    expect(() => gnomadListGeneVariants.input.parse({ region: 'chr1:100-200' })).toThrow();
    expect(() => gnomadListGeneVariants.input.parse({ region: '1-100' })).toThrow();
    expect(() => gnomadListGeneVariants.input.parse({ region: '1-100-200-300' })).toThrow();
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

describe('gnomad_list_gene_variants format()', () => {
  const base = {
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
      '- **1-55000002-A-T** | missense (missense_variant) | AF 0.000002 (2.000e-6) | AC 2/1000000 | hom 0 | exome\\|genome | QC pass (exome passed, genome passed) | transcript ENST00000302118 (mane_select)',
    );
    expect(lines).toContain(
      '- **1-55000003-A-T** | missense (missense_variant) | AF 0.000003 (3.000e-6) | AC 3/1000000 | hom 0 | exome\\|genome | flags lcr | QC pass (exome passed, genome passed) | transcript ENST00000302118 (mane_select)',
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

    expect(lines.map((line) => line.split(' | ').slice(6).join(' | '))).toEqual([
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
