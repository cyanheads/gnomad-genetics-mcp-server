/**
 * @fileoverview Behavior tests for the gnomad_get_gene_constraint handler — the
 * happy path, the gene_not_found contract reason, the incoherent_build pair
 * rejection (exercised through the real resolveDatasetContext), a sparse
 * all-null constraint record, and format() rendering of unknown fields, plus
 * subset datasets reading their parent's table, the LOEUF percentile and
 * missense/synonymous intervals, and mitochondrial constraint. Stubs
 * the network methods of the service; uses the real dataset/build derivation.
 * @module tests/tools/gnomad-get-gene-constraint.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig, resetServerConfig } from '@/config/server-config.js';
import { gnomadGetGeneConstraint } from '@/mcp-server/tools/definitions/gnomad-get-gene-constraint.tool.js';
import * as serviceModule from '@/services/gnomad/gnomad-service.js';
import { GnomadService, initGnomadService } from '@/services/gnomad/gnomad-service.js';
import type { Dataset, GeneConstraint } from '@/services/gnomad/types.js';
import { fakeLiveConstraint, liveGene } from '../helpers/live-constraint.js';

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
    oe_lof_percentile: 63,
    oe_mis: 0.95,
    oe_mis_lower: 0.88,
    oe_mis_upper: 1.02,
    oe_syn: 1.0,
    oe_syn_lower: 0.9,
    oe_syn_upper: 1.1,
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
    mitochondrial_constraint: null,
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
    oe_lof_percentile: null,
    oe_mis: null,
    oe_mis_lower: null,
    oe_mis_upper: null,
    oe_syn: null,
    oe_syn_lower: null,
    oe_syn_upper: null,
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
    mitochondrial_constraint: null,
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
    // The LOEUF interval upper bound is oe_lof_upper (1.05), not the oe_lof
    // point estimate (0.812) — the #5 regression.
    expect(text).toContain('[0.6–1.05]');
    expect(text).not.toContain('[0.6–0.812]');
    // oe_lof is still rendered explicitly (point estimate + format-parity).
    expect(text).toContain('point estimate');
    expect(text).toContain('0.812');
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
      oe_lof_percentile: 71,
      oe_mis: 0.9065,
      oe_mis_lower: 0.8575,
      oe_mis_upper: 0.9587,
      oe_syn: 0.9453,
      oe_syn_lower: 0.87,
      oe_syn_upper: 1.0283,
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
    mitochondrial_constraint: null,
  },
  GRCh37: {
    gnomad_constraint: {
      pli: 2.7059204562649786e-17,
      oe_lof: 0.9662,
      oe_lof_lower: 0.71,
      oe_lof_upper: 1.341,
      oe_lof_percentile: null,
      oe_mis: 0.9632,
      oe_mis_lower: 0.888,
      oe_mis_upper: 1.044,
      oe_syn: 0.9066,
      oe_syn_lower: 0.799,
      oe_syn_upper: 1.03,
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
    mitochondrial_constraint: null,
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

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/62
describe('gnomad_get_gene_constraint identifier normalization (#62)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetServerConfig();
  });

  /** gnomAD as it matches genes: case-sensitively, by unversioned ID or symbol. Returns the requests. */
  function serveExactGenes(): { query: string; variables: { gene: string } }[] {
    const requests: { query: string; variables: { gene: string } }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        query: string;
        variables: { gene: string };
      };
      requests.push(request);
      if (!['ENSG00000169174', 'PCSK9'].includes(request.variables.gene)) {
        return Response.json({ errors: [{ message: 'Gene not found' }], data: { gene: null } });
      }
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
    });
    initGnomadService({} as never, {} as never);
    return requests;
  }

  it.each(['ensg00000169174', 'ENSG00000169174.12'])(
    'resolves %s as ENSG00000169174 by stable ID',
    async (gene) => {
      const requests = serveExactGenes();

      const result = await runToolContract(gnomadGetGeneConstraint, { gene });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ gene_id: 'ENSG00000169174' });
      expect(requests[0]?.variables.gene).toBe('ENSG00000169174');
      expect(requests[0]?.query).toContain('gene_id: $gene');
    },
  );

  it.each(['pcsk9', 'ENSG00000182378.PAR_Y', 'ENSG00000182378_PAR_Y', 'ENSG00000182378.14_PAR_Y'])(
    'sends %s to gnomAD unchanged',
    async (gene) => {
      const requests = serveExactGenes();

      await runToolContract(gnomadGetGeneConstraint, { gene });

      expect(requests[0]?.variables.gene).toBe(gene);
    },
  );

  it('fails a lowercase Ensembl ID as gene_not_found with GNOMAD_NORMALIZE_IDS=false', async () => {
    vi.stubEnv('GNOMAD_NORMALIZE_IDS', 'false');
    resetServerConfig();
    const requests = serveExactGenes();

    const result = await runToolContract(gnomadGetGeneConstraint, { gene: 'ensg00000169174' });

    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'gene_not_found' } },
    });
    expect(requests[0]?.variables.gene).toBe('ensg00000169174');
  });
});

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/68
describe('gnomad_get_gene_constraint on a subset dataset (#68)', () => {
  it.each([
    [
      'gnomad_r3_non_neuro',
      'GRCh38',
      'gnomAD v4.1.2',
      57,
      'gnomAD publishes no subset constraint, so gnomad_r3_non_neuro reads the gnomad_r3 table; gnomAD publishes no v3 constraint; gnomad_r3 serves the GRCh38 gnomAD v4.1.2 table',
    ],
    [
      'gnomad_r2_1_controls',
      'GRCh37',
      'gnomAD v2.1.1',
      26,
      'gnomAD publishes no subset constraint, so gnomad_r2_1_controls reads the gnomad_r2_1 table',
    ],
    [
      'gnomad_r4_non_ukb',
      'GRCh38',
      'gnomAD v4.1.2',
      57,
      'gnomAD publishes no subset constraint, so gnomad_r4_non_ukb reads the gnomad_r4 table',
    ],
  ] as const)(
    'serves %s from its parent’s %s table as %s, noting it on both surfaces',
    async (dataset, referenceGenome, release, obsLof, note) => {
      fakePcsk9();

      const result = await runToolContract(gnomadGetGeneConstraint, { gene: 'PCSK9', dataset });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        dataset,
        reference_genome: referenceGenome,
        constraint_release: release,
        obs_lof: obsLof,
      });
      expect(textOf(result.content)).toContain(`**Constraint release:** ${release} (${note})`);
    },
  );

  it.each(['gnomad_r4', 'gnomad_r3', 'gnomad_r2_1', 'exac'] as const)(
    'adds no subset note on the parent release %s',
    async (dataset) => {
      fakePcsk9();

      const result = await runToolContract(gnomadGetGeneConstraint, { gene: 'PCSK9', dataset });

      expect(textOf(result.content)).not.toContain('no subset constraint');
    },
  );

  it('names the subset routing in the tool and constraint_release descriptions', () => {
    expect(gnomadGetGeneConstraint.description).toMatch(/subsets?[^.]*parent/);
    expect(gnomadGetGeneConstraint.output.shape.constraint_release.description).toMatch(
      /subsets?[^.]*parent/,
    );
  });
});

/** Run the tool for a gene on a dataset with the real service behind gnomAD's live answers. */
function runLive(gene: string, dataset: Dataset) {
  fakeLiveConstraint();
  initGnomadService({} as never, {} as never);
  return runToolContract(gnomadGetGeneConstraint, { gene, dataset });
}

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/69
describe('gnomad_get_gene_constraint LOEUF percentile and missense/synonymous intervals (#69)', () => {
  /** Live BRCA1 and SCN2A values (2026-11-03), and their renderings in content[]. */
  const GRCH38_VALUES = {
    BRCA1: {
      structured: {
        oe_lof_percentile: 51,
        oe_mis_lower: 0.8797909484474278,
        oe_mis_upper: 0.9472361204624538,
        oe_syn_lower: 0.8216770433571385,
        oe_syn_upper: 0.9336954606632754,
      },
      text: [
        '**LOEUF percentile:** 51',
        '[0.8797909484474278–0.9472361204624538]',
        '[0.8216770433571385–0.9336954606632754]',
      ],
    },
    SCN2A: {
      structured: {
        oe_lof_percentile: 1,
        oe_mis_lower: 0.49928208167348614,
        oe_mis_upper: 0.5473961032927889,
        oe_syn_lower: 0.9109439933018288,
        oe_syn_upper: 1.0229636145701955,
      },
      text: [
        '**LOEUF percentile:** 1',
        '[0.49928208167348614–0.5473961032927889]',
        '[0.9109439933018288–1.0229636145701955]',
      ],
    },
  } as const;

  it.each([
    ['BRCA1', 'gnomad_r4'],
    ['BRCA1', 'gnomad_r3'],
    ['BRCA1', 'gnomad_r4_non_ukb'],
    ['SCN2A', 'gnomad_r4'],
    ['SCN2A', 'gnomad_r3'],
  ] as const)(
    'returns %s’s v4.1.2 percentile and intervals on %s, on both surfaces',
    async (gene, dataset) => {
      const result = await runLive(gene, dataset);

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        dataset,
        constraint_release: 'gnomAD v4.1.2',
        ...GRCH38_VALUES[gene].structured,
      });
      for (const rendered of GRCH38_VALUES[gene].text) {
        expect(textOf(result.content)).toContain(rendered);
      }
    },
  );

  it.each(['gnomad_r2_1', 'gnomad_r2_1_controls'] as const)(
    'returns BRCA1’s v2.1.1 intervals with a null percentile on %s',
    async (dataset) => {
      const result = await runLive('BRCA1', dataset);

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        constraint_release: 'gnomAD v2.1.1',
        oe_lof_percentile: null,
        oe_mis_lower: 0.895,
        oe_mis_upper: 1,
        oe_syn_lower: 0.881,
        oe_syn_upper: 1.057,
      });
      const text = textOf(result.content);
      expect(text).toContain('**LOEUF percentile:** Not available');
      expect(text).toContain('[0.895–1]');
      expect(text).toContain('[0.881–1.057]');
    },
  );

  it('returns all five as null for BRCA1 on exac, whose table carries none of them', async () => {
    const result = await runLive('BRCA1', 'exac');

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      constraint_release: 'ExAC r0.3',
      pli: 3.28742187416399e-20,
      oe_lof_percentile: null,
      oe_mis_lower: null,
      oe_mis_upper: null,
      oe_syn_lower: null,
      oe_syn_upper: null,
    });
    expect(textOf(result.content)).toContain('**LOEUF percentile:** Not available');
    expect(textOf(result.content)).toMatch(/ExAC publishes [^)]*no [^)]*intervals[^)]*percentile/);
  });

  it.each(['gnomad_r4', 'gnomad_r2_1'] as const)(
    'returns the five as null without error for MALAT1, which has no constraint, on %s',
    async (dataset) => {
      const result = await runLive('MALAT1', dataset);

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        symbol: 'MALAT1',
        oe_lof_percentile: null,
        oe_mis_lower: null,
        oe_mis_upper: null,
        oe_syn_lower: null,
        oe_syn_upper: null,
      });
    },
  );

  it('renders the percentile as an integer and both intervals in format()', () => {
    const text = textOf(gnomadGetGeneConstraint.format?.(fullConstraint()) ?? []);

    expect(text).toContain('**LOEUF percentile:** 63');
    expect(text).not.toContain('63.0');
    expect(text).toContain('**oe_mis:** 0.95 [0.88–1.02]');
    expect(text).toContain('**oe_syn:** 1 [0.9–1.1]');
  });

  it('describes the percentile’s direction and release and the intervals’ exac nulls', () => {
    const shape = gnomadGetGeneConstraint.output.shape;

    expect(shape.oe_lof_percentile.description).toMatch(/lower is more constrained/i);
    expect(shape.oe_lof_percentile.description).toMatch(/KMT2A is 0/);
    expect(shape.oe_lof_percentile.description).toMatch(/v4\.1\.2/);
    for (const field of ['oe_mis_lower', 'oe_mis_upper', 'oe_syn_lower', 'oe_syn_upper'] as const) {
      expect(shape[field].description).toMatch(/90%/);
      expect(shape[field].description).toMatch(/exac/);
    }
    expect(gnomadGetGeneConstraint.description).toMatch(/percentile/);
  });
});

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/73
describe('gnomad_get_gene_constraint mitochondrial constraint (#73)', () => {
  /** gnomAD's live mitochondrial constraint (2026-11-03), identical on both builds. */
  const MT_CO1 = {
    kind: 'protein',
    obs_lof: 0.876,
    exp_lof: 66.802,
    oe_lof: 0.013,
    oe_lof_lower: 0.001,
    oe_lof_upper: 0.042,
    obs_mis: 196.443,
    exp_mis: 1238.397,
    oe_mis: 0.159,
    oe_mis_lower: 0.14,
    oe_mis_upper: 0.177,
    obs_syn: 616.941,
    exp_syn: 596.473,
    oe_syn: 1.034,
    oe_syn_lower: 0.988,
    oe_syn_upper: 1.08,
  };
  const MT_TL1 = {
    kind: 'rna',
    observed: 13.634,
    expected: 92.721,
    oe: 0.147,
    oe_lower: 0.085,
    oe_upper: 0.213,
  };
  const MT_RNR1 = {
    kind: 'rna',
    observed: 315.935,
    expected: 1229.075,
    oe: 0.257,
    oe_lower: 0.234,
    oe_upper: 0.28,
  };

  const mitochondrialOf = (structured: unknown) =>
    (structured as { mitochondrial_constraint: unknown }).mitochondrial_constraint;

  it.each([
    'gnomad_r4',
    'gnomad_r3',
    'gnomad_r2_1',
    'exac',
    'gnomad_r3_non_neuro',
    'gnomad_r2_1_controls',
  ] as const)('returns MT-CO1’s protein arm on %s, its nuclear fields null', async (dataset) => {
    const result = await runLive('MT-CO1', dataset);

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      symbol: 'MT-CO1',
      dataset,
      pli: null,
      oe_lof_upper: null,
      obs_lof: null,
      oe_lof_percentile: null,
      oe_mis_lower: null,
      constraint_flags: [],
    });
    expect(mitochondrialOf(result.structuredContent)).toEqual(MT_CO1);
  });

  it.each([
    ['MT-TL1', 'gnomad_r4', MT_TL1],
    ['MT-TL1', 'exac', MT_TL1],
    ['MT-RNR1', 'gnomad_r4', MT_RNR1],
    ['MT-RNR1', 'gnomad_r2_1', MT_RNR1],
  ] as const)('returns %s’s rna arm on %s', async (gene, dataset, expected) => {
    const result = await runLive(gene, dataset);

    expect(result.isError).toBeFalsy();
    expect(mitochondrialOf(result.structuredContent)).toEqual(expected);
  });

  it.each(['gnomad_r4', 'gnomad_r2_1', 'exac'] as const)(
    'returns null for BRCA1, a nuclear gene, with its nuclear fields unchanged on %s',
    async (dataset) => {
      const result = await runLive('BRCA1', dataset);
      const live = liveGene(dataset === 'gnomad_r4' ? 'GRCh38' : 'GRCh37', 'BRCA1');
      const table = dataset === 'exac' ? live.exac_constraint : live.gnomad_constraint;

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        mitochondrial_constraint: null,
        pli: table?.pli,
        obs_lof: table?.obs_lof,
      });
      expect(textOf(result.content)).toContain('**Mitochondrial constraint:** none');
    },
  );

  it('renders every field of the protein arm in content', async () => {
    const text = textOf((await runLive('MT-CO1', 'gnomad_r4')).content);

    expect(text).toContain('**Mitochondrial constraint:** protein (');
    expect(text).toContain(
      '**Mitochondrial LoF (stop-gain):** obs/exp 0.876 / 66.802 | o/e 0.013 [0.001–0.042]',
    );
    expect(text).toContain(
      '**Mitochondrial missense:** obs/exp 196.443 / 1238.397 | o/e 0.159 [0.14–0.177]',
    );
    expect(text).toContain(
      '**Mitochondrial synonymous:** obs/exp 616.941 / 596.473 | o/e 1.034 [0.988–1.08]',
    );
    expect(text).not.toContain('**Mitochondrial constraint:** none');
  });

  it('renders every field of the rna arm in content', async () => {
    const text = textOf((await runLive('MT-TL1', 'gnomad_r4')).content);

    expect(text).toContain('**Mitochondrial constraint:** rna (');
    expect(text).toContain(
      '**Mitochondrial, all SNVs:** obs/exp 13.634 / 92.721 | o/e 0.147 [0.085–0.213]',
    );
    expect(text).not.toContain('**Mitochondrial LoF');
  });

  it('describes the mitochondrial model and labels constraint_release as nuclear-only', () => {
    const shape = gnomadGetGeneConstraint.output.shape;
    const field = shape.mitochondrial_constraint.description ?? '';

    expect(field).toMatch(/maximum heteroplasmy/);
    expect(field).toMatch(/not variant counts/);
    expect(field).toMatch(/stop-gain/);
    expect(field).toMatch(/beta/);
    expect(field).toMatch(/LOEUF[^.]*do(?:es)? not apply/);
    expect(shape.constraint_release.description).toMatch(/nuclear tables only/);
    expect(gnomadGetGeneConstraint.description).toMatch(/mitochondrial_constraint/);
  });

  it('logs a mitochondrial gene as having constraint', async () => {
    fakeLiveConstraint();
    initGnomadService({} as never, {} as never);
    const ctx = createMockContext({ errors: gnomadGetGeneConstraint.errors });
    const info = vi.spyOn(ctx.log, 'info');

    await gnomadGetGeneConstraint.handler(
      gnomadGetGeneConstraint.input.parse({ gene: 'MT-TL1' }),
      ctx as never,
    );

    expect(info).toHaveBeenCalledWith(
      'gnomad_get_gene_constraint resolved',
      expect.objectContaining({ gene: 'MT-TL1', hasConstraint: true }),
    );
  });
});
