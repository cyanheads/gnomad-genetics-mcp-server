/**
 * @fileoverview Behavior tests for the gnomad://variant/{dataset}/{variantId}
 * resource — mirrors gnomad_get_variant for a single variant, and surfaces the
 * variant_not_found contract reason when the variant is absent from the dataset.
 * Stubs the service accessor so no network is touched.
 * @module tests/resources/variant.resource.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { variantResource } from '@/mcp-server/resources/definitions/variant.resource.js';
import * as serviceModule from '@/services/gnomad/gnomad-service.js';
import type { VariantRecord } from '@/services/gnomad/types.js';

function record(variantId: string): VariantRecord {
  return {
    variant_id: variantId,
    rsids: [],
    reference_genome: 'GRCh38',
    dataset: 'gnomad_r4',
    ac: 1,
    an: 1000,
    af: 0.001,
    homozygote_count: 0,
    hemizygote_count: null,
    populations: [],
    source: ['exome'],
    flags: [],
    consequence: null,
    transcript_id: null,
    gene_symbol: null,
    in_silico: [],
    clinvar: null,
  };
}

describe('gnomad://variant resource', () => {
  it('returns the population record for a resolved variant', async () => {
    const fake = {
      resolveDatasetContext: () => ({ dataset: 'gnomad_r4', reference_genome: 'GRCh38' }) as const,
      getVariant: vi.fn(async () => record('1-55051215-G-GA')),
    };
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(fake as never);

    const ctx = createMockContext({ errors: variantResource.errors });
    const params = variantResource.params.parse({
      dataset: 'gnomad_r4',
      variantId: '1-55051215-G-GA',
    });
    const result = await variantResource.handler(params, ctx as never);
    expect(result).toMatchObject({ variant_id: '1-55051215-G-GA', dataset: 'gnomad_r4' });
  });

  it('throws ctx.fail("variant_not_found") when the variant is absent', async () => {
    const fake = {
      resolveDatasetContext: () => ({ dataset: 'gnomad_r4', reference_genome: 'GRCh38' }) as const,
      getVariant: vi.fn(async () => null),
    };
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(fake as never);

    const ctx = createMockContext({ errors: variantResource.errors });
    const params = variantResource.params.parse({
      dataset: 'gnomad_r4',
      variantId: '1-55051215-G-GA',
    });
    await expect(variantResource.handler(params, ctx as never)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'variant_not_found' },
    });
  });
});
