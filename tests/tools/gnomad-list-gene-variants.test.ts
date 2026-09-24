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
    // 80 compact rows (~161 characters each, no consequence) sum to under 14,000.
    const rows = Array.from({ length: 80 }, (_, i) => ({
      ...row(i + 1),
      consequence: null,
      consequence_class: 'other' as const,
      source: 'exome',
    }));
    expect(rows.reduce((n, r) => n + JSON.stringify(r).length, 0)).toBeLessThanOrEqual(14_000);
    stubService(rows);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const ctx = createMockContext({ errors: gnomadListGeneVariants.errors });
    const input = gnomadListGeneVariants.input.parse({ gene: 'BRCA2' });
    const result = await gnomadListGeneVariants.handler(input, ctx as never);

    expect(result.total).toBe(80);
    expect(result.preview).toHaveLength(80);
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('previews the longest prefix within the budget and notices the truncation (#37)', async () => {
    const rows = [...Array.from({ length: 69 }, (_, i) => sized(i + 1, 200)), sized(70, 201)];
    stubService(rows);
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const ctx = createMockContext({ errors: gnomadListGeneVariants.errors });
    const input = gnomadListGeneVariants.input.parse({ gene: 'BRCA2' });
    const result = await gnomadListGeneVariants.handler(input, ctx as never);

    expect(result.total).toBe(70);
    expect(result.preview).toEqual(rows.slice(0, 69));
    expect(getEnrichment(ctx).notice).toMatch(/showing 69 of 70 variants/);
  });

  it('previews fewer long-ID rows than short ones under the same budget (#37)', async () => {
    stubService(Array.from({ length: 75 }, (_, i) => sized(i + 1, 280)));
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);

    const ctx = createMockContext({ errors: gnomadListGeneVariants.errors });
    const input = gnomadListGeneVariants.input.parse({ gene: 'KCNQ1' });
    const result = await gnomadListGeneVariants.handler(input, ctx as never);

    expect(result.preview).toHaveLength(50);
    expect(getEnrichment(ctx).notice).toMatch(/showing 50 of 75 variants/);
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
    stubService(Array.from({ length: 70 }, (_, i) => sized(i + 1, 200)));
    const { canvas } = fakeCanvas();
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(canvas as never);

    const ctx = createMockContext({ errors: gnomadListGeneVariants.errors });
    const input = gnomadListGeneVariants.input.parse({ gene: 'PCSK9' });
    const result = await gnomadListGeneVariants.handler(input, ctx as never);

    expect(result).toMatchObject({ spilled: false, canvas_id: '', total: 70 });
    expect(result.preview).toHaveLength(70);
    expect(canvas.acquire).not.toHaveBeenCalled();
  });

  it('spills one character past 14,000 and previews the rows under the budget (#37 boundary)', async () => {
    const rows = [...Array.from({ length: 69 }, (_, i) => sized(i + 1, 200)), sized(70, 201)];
    stubService(rows);
    const { canvas, tables } = fakeCanvas();
    vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(canvas as never);

    const ctx = createMockContext({ errors: gnomadListGeneVariants.errors });
    const input = gnomadListGeneVariants.input.parse({ gene: 'PCSK9' });
    const result = await gnomadListGeneVariants.handler(input, ctx as never);

    expect(result).toMatchObject({ spilled: true, table_name: 'gene_variants', total: 70 });
    expect(result.preview).toHaveLength(69);
    expect(tables.gene_variants).toHaveLength(70);
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
/** 100 rows of 200 characters against the 14,000-character budget: a 70-row prefix. */
const capped =
  'Canvas is disabled (set CANVAS_PROVIDER_TYPE=duckdb) — showing 70 of 100 variants. Enable the canvas to query the full set with gnomad_dataframe_query.';
const NEUTRAL = '**Staged:** no canvas table for this call.';
const stagedLine = (id: string) =>
  `**Staged:** canvas_id \`${id}\`, table \`gene_variants\` — inspect with gnomad_dataframe_describe, then query with gnomad_dataframe_query.`;

type Size = 'spill' | 'fit' | 'zero';
const rowsFor: Record<Size, () => GeneVariantRow[]> = {
  spill: () => Array.from({ length: 100 }, (_, i) => sized(i + 1, 200)),
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
  });
});

describe('gnomad_list_gene_variants response budget (#37)', () => {
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
    dataset: 'gnomad_r4',
    reference_genome: 'GRCh38',
  };
  const render = (result: Parameters<NonNullable<typeof gnomadListGeneVariants.format>>[0]) =>
    (gnomadListGeneVariants.format?.(result) ?? [])
      .map((b) => ('text' in b ? b.text : ''))
      .join('');

  it('renders the header, build, and one line per preview row', () => {
    const text = render({ ...base, preview: [row(2), { ...row(3), flags: 'lcr' }] });
    expect(text).toContain('## Gene variants — 1 total');
    expect(text).toContain('**Dataset:** gnomad_r4 (GRCh38) | **Spilled:** no');
    expect(text).toContain('Showing 2 preview row(s):');
    expect(text).toContain(
      '- **1-55000002-A-T** | missense (missense_variant) | AF 0.000002 (2.000e-6) | AC 2/1000000 | hom 0 | exome|genome',
    );
    expect(text).toContain('| flags lcr');
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
