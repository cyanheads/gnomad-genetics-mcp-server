/**
 * @fileoverview Behavior tests for the gnomad://gene/{dataset}/{gene}/constraint
 * resource — mirrors gnomad_get_gene_constraint, surfacing the gene_not_found
 * contract reason when no gene matches. Stubs the service accessor.
 * @module tests/resources/gene-constraint.resource.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { geneConstraintResource } from '@/mcp-server/resources/definitions/gene-constraint.resource.js';
import * as serviceModule from '@/services/gnomad/gnomad-service.js';
import type { GeneConstraint } from '@/services/gnomad/types.js';

function constraint(): GeneConstraint {
  return {
    gene_id: 'ENSG00000169174',
    symbol: 'PCSK9',
    dataset: 'gnomad_r4',
    reference_genome: 'GRCh38',
    pli: 0.01,
    oe_lof: 0.8,
    oe_lof_lower: 0.6,
    oe_lof_upper: 1.0,
    oe_mis: 0.9,
    oe_syn: 1.0,
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
  };
}

describe('gnomad://gene constraint resource', () => {
  it('returns the constraint record for a resolved gene', async () => {
    const fake = {
      resolveDatasetContext: () => ({ dataset: 'gnomad_r4', reference_genome: 'GRCh38' }) as const,
      getGeneConstraint: vi.fn(async () => constraint()),
    };
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(fake as never);

    const ctx = createMockContext({ errors: geneConstraintResource.errors });
    const params = geneConstraintResource.params.parse({ dataset: 'gnomad_r4', gene: 'PCSK9' });
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
    const params = geneConstraintResource.params.parse({ dataset: 'gnomad_r4', gene: 'NOTAGENE' });
    await expect(geneConstraintResource.handler(params, ctx as never)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'gene_not_found' },
    });
  });
});
