/**
 * @fileoverview Behavior tests for the gnomad_get_gene_constraint handler — the
 * happy path, the gene_not_found contract reason, the incoherent_build pair
 * rejection (exercised through the real resolveDatasetContext), a sparse
 * all-null constraint record, and format() rendering of unknown fields. Stubs
 * the network methods of the service; uses the real dataset/build derivation.
 * @module tests/tools/gnomad-get-gene-constraint.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { gnomadGetGeneConstraint } from '@/mcp-server/tools/definitions/gnomad-get-gene-constraint.tool.js';
import * as serviceModule from '@/services/gnomad/gnomad-service.js';
import { GnomadService, initGnomadService } from '@/services/gnomad/gnomad-service.js';
import type { GeneConstraint } from '@/services/gnomad/types.js';

/** Real service for genuine dataset/build derivation; network method overridden. */
const realService = new GnomadService(getServerConfig());

afterEach(() => {
  vi.restoreAllMocks();
});

function textOf(blocks: readonly unknown[]): string {
  return (blocks as { text?: string }[]).map((block) => block.text ?? '').join('\n');
}

function fullConstraint(): GeneConstraint {
  return {
    gene_id: 'ENSG00000169174',
    symbol: 'PCSK9',
    dataset: 'gnomad_r4',
    reference_genome: 'GRCh38',
    constraint_release: 'gnomAD v4.1.2',
    pli: 0.0123,
    oe_lof: 0.812,
    oe_lof_lower: 0.6,
    oe_lof_upper: 1.05,
    oe_mis: 0.95,
    oe_syn: 1.0,
    lof_z: 0.4,
    mis_z: 0.2,
    syn_z: 0.05,
    obs_lof: 20,
    exp_lof: 24.6,
    obs_mis: 200,
    exp_mis: 210,
    obs_syn: 100,
    exp_syn: 100,
    constraint_flags: ['no_exp_lof'],
  };
}

/** A gene that exists upstream but has no computed constraint — all metrics null. */
function nullConstraint(): GeneConstraint {
  return {
    gene_id: 'ENSG00000999999',
    symbol: 'SPARSEGENE',
    dataset: 'gnomad_r4',
    reference_genome: 'GRCh38',
    constraint_release: 'gnomAD v4.1.2',
    pli: null,
    oe_lof: null,
    oe_lof_lower: null,
    oe_lof_upper: null,
    oe_mis: null,
    oe_syn: null,
    lof_z: null,
    mis_z: null,
    syn_z: null,
    obs_lof: null,
    exp_lof: null,
    obs_mis: null,
    exp_mis: null,
    obs_syn: null,
    exp_syn: null,
    constraint_flags: [],
  };
}

describe('gnomad_get_gene_constraint handler', () => {
  it('returns the constraint record for a resolved gene', async () => {
    const fake = {
      resolveDatasetContext: realService.resolveDatasetContext.bind(realService),
      getGeneConstraint: vi.fn(async () => fullConstraint()),
    };
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(fake as never);

    const ctx = createMockContext({ errors: gnomadGetGeneConstraint.errors });
    const input = gnomadGetGeneConstraint.input.parse({ gene: 'PCSK9' });
    const result = await gnomadGetGeneConstraint.handler(input, ctx as never);

    expect(result.symbol).toBe('PCSK9');
    expect(result.dataset).toBe('gnomad_r4');
    expect(result.reference_genome).toBe('GRCh38');
    expect(result.pli).toBeCloseTo(0.0123);
    expect(result).toEqual(expect.schemaMatching(gnomadGetGeneConstraint.output));
  });

  it('throws ctx.fail("gene_not_found") when no gene matches', async () => {
    const fake = {
      resolveDatasetContext: realService.resolveDatasetContext.bind(realService),
      getGeneConstraint: vi.fn(async () => null),
    };
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(fake as never);

    const ctx = createMockContext({ errors: gnomadGetGeneConstraint.errors });
    const input = gnomadGetGeneConstraint.input.parse({ gene: 'NOTAREALGENE' });
    await expect(gnomadGetGeneConstraint.handler(input, ctx as never)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'gene_not_found' },
    });
  });

  it('rejects an incoherent dataset/reference_genome pair before any upstream call', async () => {
    const getGeneConstraint = vi.fn(async () => fullConstraint());
    const fake = {
      resolveDatasetContext: realService.resolveDatasetContext.bind(realService),
      getGeneConstraint,
    };
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(fake as never);

    const ctx = createMockContext({ errors: gnomadGetGeneConstraint.errors });
    // gnomad_r4 is GRCh38 — GRCh37 is incoherent.
    const input = gnomadGetGeneConstraint.input.parse({
      gene: 'PCSK9',
      dataset: 'gnomad_r4',
      reference_genome: 'GRCh37',
    });
    await expect(gnomadGetGeneConstraint.handler(input, ctx as never)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'incoherent_build' },
    });
    expect(getGeneConstraint).not.toHaveBeenCalled();
  });

  it('preserves an all-null constraint without fabricating values', async () => {
    const fake = {
      resolveDatasetContext: realService.resolveDatasetContext.bind(realService),
      getGeneConstraint: vi.fn(async () => nullConstraint()),
    };
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(fake as never);

    const ctx = createMockContext({ errors: gnomadGetGeneConstraint.errors });
    const input = gnomadGetGeneConstraint.input.parse({ gene: 'SPARSEGENE' });
    const result = await gnomadGetGeneConstraint.handler(input, ctx as never);

    expect(result.pli).toBeNull();
    expect(result.oe_lof_upper).toBeNull();
    expect(result).toEqual(expect.schemaMatching(gnomadGetGeneConstraint.output));
  });

  it('renders unknown constraint fields as "Not available" in format()', () => {
    const text = (gnomadGetGeneConstraint.format?.(nullConstraint()) ?? [])
      .map((b) => ('text' in b ? b.text : ''))
      .join('');
    expect(text).toContain('SPARSEGENE');
    expect(text).toContain('Not available');
    // A genuine zero must not be masquerading as the null fallback.
    expect(text).not.toContain('0.0000');
  });

  it('renders populated metrics and constraint flags in format()', () => {
    const text = (gnomadGetGeneConstraint.format?.(fullConstraint()) ?? [])
      .map((b) => ('text' in b ? b.text : ''))
      .join('');
    expect(text).toContain('PCSK9');
    expect(text).toContain('0.0123');
    expect(text).toContain('no_exp_lof');
    // The LOEUF interval upper bound is oe_lof_upper (1.0500), not the oe_lof
    // point estimate (0.8120) — the #5 regression.
    expect(text).toContain('[0.6000–1.0500]');
    expect(text).not.toContain('[0.6000–0.8120]');
    // oe_lof is still rendered explicitly (point estimate + format-parity).
    expect(text).toContain('point estimate');
    expect(text).toContain('0.8120');
  });

  it('rejects a too-short gene symbol at parse time', () => {
    expect(() => gnomadGetGeneConstraint.input.parse({ gene: 'X' })).toThrow();
  });
});

/** PCSK9 constraint objects per build, live-shaped, for the real service behind a fake fetch. */
const PCSK9_BY_BUILD = {
  GRCh38: {
    gnomad_constraint: {
      pli: 2.765187110917756e-18,
      oe_lof: 0.9176,
      oe_lof_lower: 0.7416,
      oe_lof_upper: 1.1441,
      oe_mis: 0.9065,
      oe_syn: 0.9453,
      lof_z: 0.5507,
      mis_z: 1.236,
      syn_z: 0.6603,
      obs_lof: 57,
      exp_lof: 62.116,
      obs_mis: 870,
      exp_mis: 959.787,
      obs_syn: 387,
      exp_syn: 409.392,
      flags: [],
    },
    exac_constraint: null,
  },
  GRCh37: {
    gnomad_constraint: {
      pli: 2.7059204562649786e-17,
      oe_lof: 0.9662,
      oe_lof_lower: 0.71,
      oe_lof_upper: 1.341,
      oe_mis: 0.9632,
      oe_syn: 0.9066,
      lof_z: 0.1623,
      mis_z: 0.2724,
      syn_z: 1.0054,
      obs_lof: 26,
      exp_lof: 26.909,
      obs_mis: 419,
      exp_mis: 434.988,
      obs_syn: 170,
      exp_syn: 187.514,
      flags: [],
    },
    exac_constraint: {
      pli: 1.02507611210468e-10,
      lof_z: 0.2213,
      mis_z: 0.5558,
      syn_z: 1.37,
      obs_lof: 16,
      exp_lof: 16.9187162512,
      obs_mis: 258,
      exp_mis: 276.9098,
      obs_syn: 111,
      exp_syn: 136.8532,
    },
  },
};

function fakePcsk9(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const { variables } = JSON.parse(String(init?.body)) as {
      variables: { gene: string; referenceGenome: 'GRCh38' | 'GRCh37' };
    };
    if (variables.gene !== 'PCSK9') {
      return Response.json({ errors: [{ message: 'Gene not found' }], data: { gene: null } });
    }
    return Response.json({
      data: {
        gene: {
          gene_id: 'ENSG00000169174',
          symbol: 'PCSK9',
          ...PCSK9_BY_BUILD[variables.referenceGenome],
        },
      },
    });
  });
  initGnomadService({} as never, {} as never);
}

describe('gnomad_get_gene_constraint release provenance', () => {
  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/26
  it.each([
    ['gnomad_r4', 'gnomAD v4.1.2', 57],
    ['gnomad_r3', 'gnomAD v4.1.2', 57],
    ['gnomad_r2_1', 'gnomAD v2.1.1', 26],
    ['exac', 'ExAC r0.3', 16],
  ] as const)('names the %s release (%s) on both surfaces', async (dataset, release, obsLof) => {
    fakePcsk9();

    const result = await runToolContract(gnomadGetGeneConstraint, { gene: 'PCSK9', dataset });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      dataset,
      constraint_release: release,
      obs_lof: obsLof,
    });
    expect(textOf(result.content)).toContain(`**Constraint release:** ${release}`);
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/26
  it('returns ExAC r0.3 values with no ratios, LOEUF, or flags for exac', async () => {
    fakePcsk9();

    const result = await runToolContract(gnomadGetGeneConstraint, {
      gene: 'PCSK9',
      dataset: 'exac',
    });

    expect(result.structuredContent).toMatchObject({
      reference_genome: 'GRCh37',
      pli: 1.02507611210468e-10,
      obs_lof: 16,
      exp_lof: 16.9187162512,
      oe_lof: null,
      oe_lof_lower: null,
      oe_lof_upper: null,
      oe_mis: null,
      oe_syn: null,
      constraint_flags: [],
      constraint_release: 'ExAC r0.3',
    });
    expect(textOf(result.content)).toMatch(/ExAC r0\.3 \(ExAC publishes pLI, Z-scores/);
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/26
  it('states in content that gnomAD publishes no v3 constraint for gnomad_r3', async () => {
    fakePcsk9();

    const r3 = await runToolContract(gnomadGetGeneConstraint, {
      gene: 'PCSK9',
      dataset: 'gnomad_r3',
    });
    const r4 = await runToolContract(gnomadGetGeneConstraint, {
      gene: 'PCSK9',
      dataset: 'gnomad_r4',
    });

    expect(textOf(r3.content)).toContain('gnomAD publishes no v3 constraint');
    expect(textOf(r4.content)).not.toContain('no v3 constraint');
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/26
  it.each(['gnomad_r4', 'gnomad_r3', 'gnomad_r2_1', 'exac'] as const)(
    'fails an unknown gene with gene_not_found on %s',
    async (dataset) => {
      fakePcsk9();

      const result = await runToolContract(gnomadGetGeneConstraint, {
        gene: 'NOTAGENE',
        dataset,
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'gene_not_found' } },
      });
    },
  );

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/26
  it('states per-release LOEUF guidance and drops the beta and <0.6 claims from its descriptions', () => {
    const shape = gnomadGetGeneConstraint.output.shape;
    const texts = [
      gnomadGetGeneConstraint.description,
      shape.oe_lof_upper.description ?? '',
      shape.constraint_flags.description ?? '',
      shape.constraint_release.description ?? '',
    ].join('\n');

    expect(texts).not.toMatch(/beta|experimental|0\.6\b/i);
    expect(gnomadGetGeneConstraint.description).toMatch(/< 0\.45[^.]*v4\.1\.2/);
    expect(gnomadGetGeneConstraint.description).toMatch(/< 0\.35[^.]*v2\.1\.1/);
    expect(gnomadGetGeneConstraint.description).toMatch(/on exac[^.]*pLI is the intolerance/);
    expect(shape.constraint_flags.description).toMatch(/exac/);
    expect(shape.constraint_release.description).toMatch(/no v3 constraint/);
  });
});
