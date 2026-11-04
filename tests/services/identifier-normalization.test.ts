/**
 * @fileoverview Unit tests for the identifier-normalization seam — the full
 * table of one-reading rewrites per kind and the spellings each leaves alone,
 * the GNOMAD_NORMALIZE_IDS off switch, the log line and lazily created counter
 * an applied rewrite emits (exactly once per call on every surface that
 * normalizes), and linear time in the input length on caller-sized text.
 * @module tests/services/identifier-normalization.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { logger } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { variantTriagePrompt } from '@/mcp-server/prompts/definitions/variant-triage.prompt.js';
import { gnomadGetCoverage } from '@/mcp-server/tools/definitions/gnomad-get-coverage.tool.js';
import { gnomadGetGeneConstraint } from '@/mcp-server/tools/definitions/gnomad-get-gene-constraint.tool.js';
import { gnomadGetVariant } from '@/mcp-server/tools/definitions/gnomad-get-variant.tool.js';
import { gnomadListGeneVariants } from '@/mcp-server/tools/definitions/gnomad-list-gene-variants.tool.js';
import * as canvasAccessor from '@/services/canvas-accessor.js';
import { initGnomadService } from '@/services/gnomad/gnomad-service.js';
import {
  type IdentifierKind,
  normalizeIdentifier,
} from '@/services/gnomad/identifier-normalization.js';
import { minimalVariant } from '../helpers/minimal-variant.js';

const { counter, createCounter } = vi.hoisted(() => {
  const counter = { add: vi.fn() };
  return { counter, createCounter: vi.fn(() => counter) };
});

vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  createCounter,
}));

/** The normalization log lines written since the spy was installed. */
let normalizationLogs: () => unknown[][];

beforeEach(() => {
  const info = vi.spyOn(logger, 'info');
  normalizationLogs = () =>
    info.mock.calls.filter(([message]) => String(message).startsWith('Normalized a '));
  counter.add.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetServerConfig();
  vi.restoreAllMocks();
});

function disableNormalization(): void {
  vi.stubEnv('GNOMAD_NORMALIZE_IDS', 'false');
  resetServerConfig();
}

const REWRITTEN: [IdentifierKind, string, string][] = [
  ['rsid', 'RS505151', 'rs505151'],
  ['rsid', 'Rs11591147', 'rs11591147'],
  ['variant', '1:55039974:G:T', '1-55039974-G-T'],
  ['variant', 'chr1:55039974:g:t', 'chr1-55039974-g-t'],
  ['variant', 'MT:3243:A:G', 'MT-3243-A-G'],
  ['gene', 'ensg00000169174', 'ENSG00000169174'],
  ['gene', 'ENSG00000169174.12', 'ENSG00000169174'],
  ['gene', 'ensg00000169174.12', 'ENSG00000169174'],
  ['transcript', 'enst00000302118', 'ENST00000302118'],
  ['transcript', 'ENST00000302118.5', 'ENST00000302118'],
  ['region', 'chr1:55039447-55064852', '1-55039447-55064852'],
  ['region', '1:55,039,447-55,064,852', '1-55039447-55064852'],
  ['region', 'CHRx:1,000-2,000', 'X-1000-2000'],
  ['region', 'chrM:1-100', 'M-1-100'],
  ['region', '1:100-200', '1-100-200'],
];

const UNCHANGED: [IdentifierKind, string][] = [
  ['rsid', 'rs505151'],
  ['variant', '1-55039974-G-T'],
  ['variant', 'chr1-55039974-g-t'],
  ['variant', '1_100_A_T'],
  ['variant', '1:100-A-T'],
  ['variant', '1:100:A'],
  ['variant', '1:100:A:T:G'],
  ['gene', 'PCSK9'],
  ['gene', 'pcsk9'],
  ['gene', 'ENSG00000169174'],
  ['gene', 'ENSG00000182378.PAR_Y'],
  ['gene', 'ENSG00000182378_PAR_Y'],
  ['gene', 'ENSG00000182378.14_PAR_Y'],
  ['gene', 'ENSG00000169174.'],
  ['gene', 'ENSG00000169174.1.2'],
  ['gene', 'ENST00000302118'],
  ['transcript', 'ENST00000302118'],
  ['transcript', 'NM_174936.4'],
  ['transcript', 'ENST00000302118.5_PAR_Y'],
  ['transcript', 'ENSG00000169174'],
  ['region', '1-55039447-55064852'],
  ['region', 'chr1-100-200'],
  ['region', ''],
  ['region', '1:5,5-6'],
  ['region', '1:1,0000-2'],
  ['region', '1:,100-200'],
  ['region', '1-55,039,447-55,064,852'],
  ['region', '1:100'],
  ['region', '1:100-200-300'],
  ['region', ' 1:100-200'],
];

describe('normalizeIdentifier', () => {
  it.each(REWRITTEN)('rewrites %s %j to %j', (kind, value, canonical) => {
    expect(normalizeIdentifier(kind, value)).toBe(canonical);
  });

  it.each(UNCHANGED)('leaves %s %j as sent, with no log line or count', (kind, value) => {
    expect(normalizeIdentifier(kind, value)).toBe(value);
    expect(normalizationLogs()).toEqual([]);
    expect(counter.add).not.toHaveBeenCalled();
  });

  it('keeps the value when the caller declines the rewrite, and records nothing', () => {
    const accepts = vi.fn(() => false);

    expect(normalizeIdentifier('variant', '1:100:N:T', accepts)).toBe('1:100:N:T');
    expect(accepts).toHaveBeenCalledWith('1-100-N-T');
    expect(normalizationLogs()).toEqual([]);
    expect(counter.add).not.toHaveBeenCalled();
  });

  it('logs one line naming the kind and both spellings, and counts it under its kind', () => {
    normalizeIdentifier('transcript', 'ENST00000302118.5');

    const logs = normalizationLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]?.[0]).toBe('Normalized a transcript identifier before validation.');
    expect(logs[0]?.[1]).toMatchObject({
      extra: { kind: 'transcript', from: 'ENST00000302118.5', to: 'ENST00000302118' },
    });
    expect(counter.add).toHaveBeenCalledOnce();
    expect(counter.add).toHaveBeenCalledWith(1, { kind: 'transcript' });
  });

  it('creates its counter on the first rewrite, not at import or on a canonical input', async () => {
    vi.resetModules();
    createCounter.mockClear();
    const fresh = await import('@/services/gnomad/identifier-normalization.js');

    fresh.normalizeIdentifier('gene', 'ENSG00000169174');
    expect(createCounter).not.toHaveBeenCalled();

    fresh.normalizeIdentifier('gene', 'ensg00000169174');
    fresh.normalizeIdentifier('rsid', 'RS1');
    expect(createCounter).toHaveBeenCalledOnce();
    expect(createCounter).toHaveBeenCalledWith(
      'gnomad.identifiers.normalized',
      expect.any(String),
      '{rewrites}',
    );
    expect(counter.add.mock.calls).toEqual([
      [1, { kind: 'gene' }],
      [1, { kind: 'rsid' }],
    ]);
  });

  it.each(REWRITTEN)(
    'leaves %s %j as sent with GNOMAD_NORMALIZE_IDS=false, with no log line or count',
    (kind, value) => {
      disableNormalization();

      expect(normalizeIdentifier(kind, value)).toBe(value);
      expect(normalizationLogs()).toEqual([]);
      expect(counter.add).not.toHaveBeenCalled();
    },
  );

  it('reads GNOMAD_NORMALIZE_IDS on every call, not once at import', () => {
    expect(normalizeIdentifier('rsid', 'RS1')).toBe('rs1');
    disableNormalization();
    expect(normalizeIdentifier('rsid', 'RS1')).toBe('RS1');
  });
});

/** One gnomAD answer per query document, so each surface runs the real service. */
function serveGnomad(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const { query, variables } = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    const feature = { chrom: '1', exons: [{ start: 100, stop: 110 }], coverage: null };
    if (/Coverage/.test(query)) {
      return Response.json({ data: { gene: feature, transcript: feature, region: null } });
    }
    if (/Constraint/.test(query)) {
      return Response.json({
        data: {
          gene: {
            gene_id: 'ENSG00000169174',
            symbol: 'PCSK9',
            gnomad_constraint: null,
            exac_constraint: null,
            mitochondrial_constraint: null,
          },
        },
      });
    }
    if (/Variants/.test(query)) {
      return Response.json({ data: { transcript: { chrom: '1', variants: [] } } });
    }
    if (/Clinvar/.test(query)) return Response.json({ data: { clinvar_variant: null } });
    const id = String(variables.variantId ?? '1-55039974-G-T');
    return Response.json({ data: { variant: minimalVariant(id), clinvar_variant: null } });
  });
  vi.spyOn(canvasAccessor, 'getCanvas').mockReturnValue(undefined);
  initGnomadService({} as never, {} as never);
}

/** Generate the triage prompt the way prompts/get does: one parse, then generate. */
async function getPrompt(variant: string): Promise<void> {
  await variantTriagePrompt.generate(variantTriagePrompt.args!.parse({ variant }));
}

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/62
describe('a normalized call logs and counts its rewrite exactly once', () => {
  it.each<[string, IdentifierKind, () => Promise<unknown>, () => Promise<unknown>]>([
    [
      'gnomad_get_coverage region (schema preprocess)',
      'region',
      () => runToolContract(gnomadGetCoverage, { region: 'chr1:55039447-55064852' }),
      () => runToolContract(gnomadGetCoverage, { region: '1-55039447-55064852' }),
    ],
    [
      'gnomad_list_gene_variants transcript_id (target resolution)',
      'transcript',
      () => runToolContract(gnomadListGeneVariants, { transcript_id: 'ENST00000302118.5' }),
      () => runToolContract(gnomadListGeneVariants, { transcript_id: 'ENST00000302118' }),
    ],
    [
      'gnomad_get_gene_constraint gene (service)',
      'gene',
      () => runToolContract(gnomadGetGeneConstraint, { gene: 'ensg00000169174' }),
      () => runToolContract(gnomadGetGeneConstraint, { gene: 'ENSG00000169174' }),
    ],
    [
      'gnomad_get_variant rsID (handler)',
      'rsid',
      () => runToolContract(gnomadGetVariant, { variants: ['RS505151'] }),
      () => runToolContract(gnomadGetVariant, { variants: ['rs505151'] }),
    ],
    [
      'gnomad_variant_triage variant (argument preprocess, then generate)',
      'variant',
      () => getPrompt('chr1:55039974:G:T'),
      () => getPrompt('1-55039974-G-T'),
    ],
  ])('%s', async (_surface, kind, rewritten, canonical) => {
    serveGnomad();

    await rewritten();
    expect(normalizationLogs()).toHaveLength(1);
    expect(counter.add.mock.calls).toEqual([[1, { kind }]]);

    counter.add.mockClear();
    await canonical();
    expect(normalizationLogs()).toHaveLength(1);
    expect(counter.add).not.toHaveBeenCalled();
  });

  it.each([' 1:100:A:T', '1:100:N:T', '1:0:A:T'])(
    'gnomad_get_variant %j: a colon ID still invalid once dashed logs and counts nothing',
    async (variant) => {
      serveGnomad();

      const result = await runToolContract(gnomadGetVariant, { variants: [variant] });

      expect(result.structuredContent).toMatchObject({
        failed: [{ variant, reason: 'invalid_variant_id' }],
      });
      expect(normalizationLogs()).toEqual([]);
      expect(counter.add).not.toHaveBeenCalled();
    },
  );
});

/** This thread's CPU time in microseconds — never wall clock, which counts descheduled time. */
function cpuMicros(): number {
  const { user, system } = process.threadCpuUsage();
  return user + system;
}

/**
 * Least per-call CPU time of `run` over five batches. The batch doubles until
 * one spans at least 2 ms, so a scan far below the timer's resolution is still
 * measured, and the least of five discards garbage-collection pauses.
 */
function perCallMicros(run: () => void): number {
  let batch = 1;
  for (;;) {
    const start = cpuMicros();
    for (let i = 0; i < batch; i++) run();
    if (cpuMicros() - start >= 2_000) break;
    batch *= 2;
  }
  let least = Number.POSITIVE_INFINITY;
  for (let round = 0; round < 5; round++) {
    const start = cpuMicros();
    for (let i = 0; i < batch; i++) run();
    least = Math.min(least, (cpuMicros() - start) / batch);
  }
  return least;
}

const repeatTo = (unit: string, length: number) => unit.repeat(Math.ceil(length / unit.length));

/**
 * Worst-case shapes per rewrite, each at `length` characters: long runs the
 * matcher walks and then fails at the end, repeated openers with no closer,
 * overlapping prefixes, and the two line-break shapes.
 */
const SHAPES: [label: string, kind: IdentifierKind, make: (length: number) => string][] = [
  ['region: one long matching coordinate', 'region', (n) => `1:${'1'.repeat(n)}-1`],
  ['region: one long stop, then junk', 'region', (n) => `1:1-${'1'.repeat(n)}x`],
  [
    'region: long coordinates each ending in a comma',
    'region',
    (n) => `1:${'1'.repeat(n / 2)},-${'1'.repeat(n / 2)},`,
  ],
  ['region: repeated chr prefix, no colon', 'region', (n) => repeatTo('chr', n)],
  ['region: thousands groups with no stop', 'region', (n) => `1:${repeatTo('111,', n)}`],
  ['region: thousands groups ending short', 'region', (n) => `1:${repeatTo('111,', n)}11-1`],
  ['region: repeated chrom openers', 'region', (n) => repeatTo('chr1:', n)],
  ['region: one long line ending in a break', 'region', (n) => `${repeatTo('§1 x', n)}\ny`],
  ['region: breaks throughout', 'region', (n) => repeatTo('  \r\n', n)],
  [
    'gene: digit runs around a dot, then junk',
    'gene',
    (n) => `ENSG${'1'.repeat(n / 2)}.${'1'.repeat(n / 2)}x`,
  ],
  ['gene: repeated version separators', 'gene', (n) => `ENSG${repeatTo('1.', n)}`],
  ['gene: one long line ending in a break', 'gene', (n) => `${repeatTo('§1 x', n)}\ny`],
  ['gene: breaks throughout', 'gene', (n) => repeatTo('  \r\n', n)],
  ['transcript: long digit run, then junk', 'transcript', (n) => `ENST${'1'.repeat(n)}x`],
  [
    'transcript: digit runs around a dot, then junk',
    'transcript',
    (n) => `ENST${'1'.repeat(n / 2)}.${'1'.repeat(n / 2)}x`,
  ],
  ['transcript: breaks throughout', 'transcript', (n) => repeatTo('  \r\n', n)],
  ['variant: repeated colons', 'variant', (n) => repeatTo('1:', n)],
  ['variant: three colons around a long run', 'variant', (n) => `1:${'1'.repeat(n)}:A:T`],
  ['variant: one long line ending in a break', 'variant', (n) => `${repeatTo('§1 x', n)}\ny`],
  ['variant: breaks throughout', 'variant', (n) => repeatTo('  \r\n', n)],
];

describe('linear-time identifier normalization', () => {
  // Declining every rewrite keeps the full scan and skips the log line, which would otherwise dominate.
  const decline = () => false;

  it.each(SHAPES)('%s stays linear from 5k to 320k characters', (_label, kind, make) => {
    const small = make(5_000);
    const base = perCallMicros(() => normalizeIdentifier(kind, small, decline));
    let last = base;
    for (let length = 10_000; length <= 320_000; length *= 2) {
      const input = make(length);
      last = perCallMicros(() => normalizeIdentifier(kind, input, decline));
      // Linear growth over the full 64× span is ~64×; quadratic passes 256× by 80k.
      expect(last / base, `${length} characters`).toBeLessThan(256);
    }
    expect(last).toBeLessThan(20_000);
  });
});
