/**
 * @fileoverview Behavior tests for the gnomad_get_gene_constraint handler — the
 * happy path, the gene_not_found contract reason, the incoherent_build pair
 * rejection (exercised through the real resolveDatasetContext), a sparse
 * all-null constraint record, and format() rendering of unknown fields. Stubs
 * the network methods of the service; uses the real dataset/build derivation.
 * @module tests/tools/gnomad-get-gene-constraint.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { gnomadGetGeneConstraint } from '@/mcp-server/tools/definitions/gnomad-get-gene-constraint.tool.js';
import * as serviceModule from '@/services/gnomad/gnomad-service.js';
import { GnomadService } from '@/services/gnomad/gnomad-service.js';
import type { GeneConstraint } from '@/services/gnomad/types.js';

/** Real service for genuine dataset/build derivation; network method overridden. */
const realService = new GnomadService(getServerConfig());

function fullConstraint(): GeneConstraint {
  return {
    gene_id: 'ENSG00000169174',
    symbol: 'PCSK9',
    dataset: 'gnomad_r4',
    reference_genome: 'GRCh38',
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
  });

  it('rejects a too-short gene symbol at parse time', () => {
    expect(() => gnomadGetGeneConstraint.input.parse({ gene: 'X' })).toThrow();
  });
});
