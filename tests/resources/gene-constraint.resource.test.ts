/**
 * @fileoverview Behavior tests for the gnomad://gene/{dataset}/{gene}/constraint
 * resource — mirrors gnomad_get_gene_constraint, surfacing the gene_not_found
 * contract reason when no gene matches, plus subset segments, the LOEUF
 * percentile and intervals, and mitochondrial constraint. Handler tests stub the service
 * accessor; the wire tests run the real service behind a worker handler with
 * only global fetch faked.
 * @module tests/resources/gene-constraint.resource.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GNOMAD_DATASETS } from '@/config/server-config.js';
import { geneConstraintResource } from '@/mcp-server/resources/definitions/gene-constraint.resource.js';
import { gnomadGetGeneConstraint } from '@/mcp-server/tools/definitions/gnomad-get-gene-constraint.tool.js';
import * as serviceModule from '@/services/gnomad/gnomad-service.js';
import type { GeneConstraint } from '@/services/gnomad/types.js';
import { fakeLiveConstraint } from '../helpers/live-constraint.js';
import { readResourceBody, resourceRecordOf } from '../helpers/worker-resource-read.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function constraint(): GeneConstraint {
  return {
    gene_id: 'ENSG00000169174',
    symbol: 'PCSK9',
    dataset: 'gnomad_r4',
    reference_genome: 'GRCh38',
    constraint_release: 'gnomAD v4.1.2',
    pli: 0.01,
    oe_lof: 0.8,
    oe_lof_lower: 0.6,
    oe_lof_upper: 1.0,
    oe_lof_percentile: 60,
    oe_mis: 0.9,
    oe_mis_lower: 0.85,
    oe_mis_upper: 0.95,
    oe_syn: 1.0,
    oe_syn_lower: 0.9,
    oe_syn_upper: 1.1,
    lof_z: 0.5,
    mis_z: 0.3,
    syn_z: 0.1,
    obs_lof: 20,
    exp_lof: 25,
    obs_mis: 200,
    exp_mis: 220,
    obs_syn: 100,
    exp_syn: 100,
    constraint_flags: [],
    mitochondrial_constraint: null,
  };
}

describe('gnomad://gene constraint resource', () => {
  it('attributes the gnomAD source in its description', () => {
    expect(geneConstraintResource.description).toContain(
      'Data source: gnomAD (Broad Institute) — https://gnomad.broadinstitute.org/',
    );
  });
  it('returns the constraint record for a resolved gene', async () => {
    const fake = {
      resolveDatasetContext: () => ({ dataset: 'gnomad_r4', reference_genome: 'GRCh38' }) as const,
      getGeneConstraint: vi.fn(async () => constraint()),
    };
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(fake as never);

    const ctx = createMockContext({ errors: geneConstraintResource.errors });
    const params = geneConstraintResource.params!.parse({ dataset: 'gnomad_r4', gene: 'PCSK9' });
    const result = await geneConstraintResource.handler(params, ctx as never);
    expect(result).toMatchObject({ symbol: 'PCSK9', gene_id: 'ENSG00000169174' });
  });

  it('throws ctx.fail("gene_not_found") when no gene matches', async () => {
    const fake = {
      resolveDatasetContext: () => ({ dataset: 'gnomad_r4', reference_genome: 'GRCh38' }) as const,
      getGeneConstraint: vi.fn(async () => null),
    };
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(fake as never);

    const ctx = createMockContext({ errors: geneConstraintResource.errors });
    const params = geneConstraintResource.params!.parse({
      dataset: 'gnomad_r4',
      gene: 'NOTAGENE',
    });
    await expect(geneConstraintResource.handler(params, ctx as never)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'gene_not_found' },
    });
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/26
  it('names the constraint release and the exac and gnomad_r3 sources in its description', () => {
    expect(geneConstraintResource.description).toContain('constraint_release');
    expect(geneConstraintResource.description).toMatch(/exac[^.]*ExAC r0\.3/);
    expect(geneConstraintResource.description).toMatch(/gnomad_r3[^.]*v4\.1\.2/);
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/26
  it('states gnomAD’s LoF-intolerance guidance per release in its description', () => {
    expect(geneConstraintResource.description).toMatch(/< 0\.45[^.]*v4\.1\.2/);
    expect(geneConstraintResource.description).toMatch(/< 0\.35[^.]*v2\.1\.1/);
    expect(geneConstraintResource.description).toMatch(/on exac[^.]*pLI/);
    expect(geneConstraintResource.description).not.toMatch(/beta|experimental|0\.6\b/i);
  });
});

describe('gnomad://gene constraint resource — through the real service (wire)', () => {
  const readRecord = async (uri: string) =>
    resourceRecordOf(await readResourceBody(geneConstraintResource, uri));

  /** A GRCh37 PCSK9 payload carries both tables; GRCh38 carries no ExAC constraint. */
  function fakePcsk9(): void {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const { variables } = JSON.parse(String(init?.body)) as {
        variables: { referenceGenome: string };
      };
      const grch37 = variables.referenceGenome === 'GRCh37';
      const gnomad = {
        pli: grch37 ? 2.7e-17 : 2.8e-18,
        oe_lof: 0.9,
        oe_lof_lower: 0.7,
        oe_lof_upper: grch37 ? 1.341 : 1.1441,
        oe_lof_percentile: grch37 ? null : 71,
        oe_mis: 0.9,
        oe_mis_lower: grch37 ? 0.888 : 0.8575,
        oe_mis_upper: grch37 ? 1.044 : 0.9587,
        oe_syn: 0.9,
        oe_syn_lower: grch37 ? 0.799 : 0.87,
        oe_syn_upper: grch37 ? 1.03 : 1.0283,
        lof_z: 0.5,
        mis_z: 1.2,
        syn_z: 0.7,
        obs_lof: grch37 ? 26 : 57,
        exp_lof: 60,
        obs_mis: 870,
        exp_mis: 960,
        obs_syn: 387,
        exp_syn: 409,
        flags: [],
      };
      const exac = {
        pli: 1.025e-10,
        lof_z: 0.22,
        mis_z: 0.56,
        syn_z: 1.37,
        obs_lof: 16,
        exp_lof: 16.919,
        obs_mis: 258,
        exp_mis: 276.9,
        obs_syn: 111,
        exp_syn: 136.9,
      };
      return Response.json({
        data: {
          gene: {
            gene_id: 'ENSG00000169174',
            symbol: 'PCSK9',
            gnomad_constraint: gnomad,
            exac_constraint: grch37 ? exac : null,
            mitochondrial_constraint: null,
          },
        },
      });
    });
    serviceModule.initGnomadService({} as never, {} as never);
  }

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/26
  it.each([
    ['gnomad_r4', 'gnomAD v4.1.2', 57],
    ['gnomad_r3', 'gnomAD v4.1.2', 57],
    ['gnomad_r2_1', 'gnomAD v2.1.1', 26],
    ['exac', 'ExAC r0.3', 16],
  ] as const)(
    'returns the tool’s constraint_release and metrics for the %s segment',
    async (dataset, release, obsLof) => {
      fakePcsk9();

      const record = await readRecord(`gnomad://gene/${dataset}/PCSK9/constraint`);
      const tool = await runToolContract(gnomadGetGeneConstraint, { gene: 'PCSK9', dataset });

      expect(record).toMatchObject({ dataset, constraint_release: release, obs_lof: obsLof });
      expect(record).toEqual(tool.structuredContent);
    },
  );

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/68
  it.each([
    ['gnomad_r3_non_cancer', 'GRCh38', 'gnomAD v4.1.2', 57],
    ['gnomad_r2_1_non_topmed', 'GRCh37', 'gnomAD v2.1.1', 26],
  ] as const)(
    'serves the %s subset segment from its parent’s %s table as %s, as the tool does',
    async (dataset, referenceGenome, release, obsLof) => {
      fakePcsk9();

      const record = await readRecord(`gnomad://gene/${dataset}/PCSK9/constraint`);
      const tool = await runToolContract(gnomadGetGeneConstraint, { gene: 'PCSK9', dataset });

      expect(record).toMatchObject({
        dataset,
        reference_genome: referenceGenome,
        constraint_release: release,
        obs_lof: obsLof,
      });
      expect(record).toEqual(tool.structuredContent);
    },
  );

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/68
  it('lists every dataset segment and the subset routing in its descriptions', () => {
    const segment = geneConstraintResource.params!.shape.dataset.description ?? '';
    for (const dataset of GNOMAD_DATASETS) {
      expect(segment).toMatch(new RegExp(`(?<!\\w)${dataset}(?!\\w)`));
    }
    expect(geneConstraintResource.description).toMatch(/subsets?[^.]*parent/);
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/62
  it('resolves a lowercase Ensembl gene segment by its canonical stable ID', async () => {
    const sent: { query: string; variables: { gene: string } }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        query: string;
        variables: { gene: string };
      };
      sent.push(request);
      if (request.variables.gene !== 'ENSG00000169174') {
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
    serviceModule.initGnomadService({} as never, {} as never);

    const record = await readRecord('gnomad://gene/gnomad_r4/ensg00000169174/constraint');

    expect(record).toMatchObject({ gene_id: 'ENSG00000169174', symbol: 'PCSK9' });
    expect(sent[0]?.variables.gene).toBe('ENSG00000169174');
    expect(sent[0]?.query).toContain('gene_id: $gene');
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/69
  it.each([
    [
      'gnomad_r4',
      { oe_lof_percentile: 51, oe_mis_lower: 0.8797909484474278, oe_syn_upper: 0.9336954606632754 },
    ],
    ['gnomad_r2_1', { oe_lof_percentile: null, oe_mis_lower: 0.895, oe_syn_upper: 1.057 }],
    ['exac', { oe_lof_percentile: null, oe_mis_lower: null, oe_syn_upper: null }],
  ] as const)(
    'returns the LOEUF percentile and intervals for BRCA1 on the %s segment, as the tool does',
    async (dataset, expected) => {
      fakeLiveConstraint();
      serviceModule.initGnomadService({} as never, {} as never);

      const record = await readRecord(`gnomad://gene/${dataset}/BRCA1/constraint`);
      const tool = await runToolContract(gnomadGetGeneConstraint, { gene: 'BRCA1', dataset });

      expect(record).toMatchObject(expected);
      expect(record).toEqual(tool.structuredContent);
    },
  );

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/69
  it('names the LOEUF percentile and the missense/synonymous intervals in its description', () => {
    expect(geneConstraintResource.description).toMatch(/LOEUF percentile/);
    expect(geneConstraintResource.description).toMatch(/intervals?[^.]*missense[^.]*synonymous/);
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/73
  it.each([
    ['gnomad_r4', 'MT-CO1', 'protein', 0.042],
    ['exac', 'MT-CO1', 'protein', 0.042],
    ['gnomad_r2_1', 'MT-TL1', 'rna', 0.213],
  ] as const)(
    'returns the mitochondrial constraint on the %s segment for %s, as the tool does',
    async (dataset, gene, kind, upper) => {
      fakeLiveConstraint();
      serviceModule.initGnomadService({} as never, {} as never);

      const record = await readRecord(`gnomad://gene/${dataset}/${gene}/constraint`);
      const tool = await runToolContract(gnomadGetGeneConstraint, { gene, dataset });

      expect(record).toMatchObject({
        symbol: gene,
        pli: null,
        mitochondrial_constraint: {
          kind,
          [kind === 'protein' ? 'oe_lof_upper' : 'oe_upper']: upper,
        },
      });
      expect(record).toEqual(tool.structuredContent);
    },
  );

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/73
  it('names the mitochondrial constraint in its description', () => {
    expect(geneConstraintResource.description).toMatch(/mitochondrial_constraint/);
  });
});
