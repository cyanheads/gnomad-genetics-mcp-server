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
    clinvar_unavailable: false,
  };
}

describe('gnomad://variant resource', () => {
  it('attributes the gnomAD source in its description', () => {
    expect(variantResource.description).toContain(
      'Data source: gnomAD (Broad Institute) — https://gnomad.broadinstitute.org/',
    );
  });
  it('returns the population record for a resolved variant', async () => {
    const fake = {
      resolveDatasetContext: () => ({ dataset: 'gnomad_r4', reference_genome: 'GRCh38' }) as const,
      getVariant: vi.fn(async () => ({
        ...record('1-55051215-G-GA'),
        clinvar_unavailable: true,
      })),
    };
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(fake as never);

    const ctx = createMockContext({ errors: variantResource.errors });
    const params = variantResource.params!.parse({
      dataset: 'gnomad_r4',
      variantId: '1-55051215-G-GA',
    });
    const result = await variantResource.handler(params, ctx as never);
    expect(result).toMatchObject({
      variant_id: '1-55051215-G-GA',
      dataset: 'gnomad_r4',
      clinvar_unavailable: true,
    });
  });

  it('canonicalizes chr prefixes and allele case before lookup', async () => {
    const getVariant = vi.fn(async () => record('1-55051215-G-GA'));
    const fake = {
      resolveDatasetContext: () => ({ dataset: 'gnomad_r4', reference_genome: 'GRCh38' }) as const,
      getVariant,
    };
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(fake as never);

    const ctx = createMockContext({ errors: variantResource.errors });
    const params = variantResource.params!.parse({
      dataset: 'gnomad_r4',
      variantId: 'chr1-55051215-g-ga',
    });
    await variantResource.handler(params, ctx as never);

    expect(getVariant).toHaveBeenCalledWith(
      '1-55051215-G-GA',
      expect.anything(),
      expect.anything(),
    );
  });

  it('rejects invalid coordinate bounds before lookup', async () => {
    const getVariant = vi.fn();
    const fake = {
      resolveDatasetContext: () => ({ dataset: 'gnomad_r4', reference_genome: 'GRCh38' }) as const,
      getVariant,
    };
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(fake as never);

    const ctx = createMockContext({ errors: variantResource.errors });
    const params = variantResource.params!.parse({ dataset: 'gnomad_r4', variantId: '23-0-A-T' });

    await expect(variantResource.handler(params, ctx as never)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_variant_id' },
    });
    expect(getVariant).not.toHaveBeenCalled();
  });

  it('throws ctx.fail("variant_not_found") when the variant is absent', async () => {
    const fake = {
      resolveDatasetContext: () => ({ dataset: 'gnomad_r4', reference_genome: 'GRCh38' }) as const,
      getVariant: vi.fn(async () => null),
    };
    vi.spyOn(serviceModule, 'getGnomadService').mockReturnValue(fake as never);

    const ctx = createMockContext({ errors: variantResource.errors });
    const params = variantResource.params!.parse({
      dataset: 'gnomad_r4',
      variantId: '1-55051215-G-GA',
    });
    await expect(variantResource.handler(params, ctx as never)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'variant_not_found' },
    });
  });
});
