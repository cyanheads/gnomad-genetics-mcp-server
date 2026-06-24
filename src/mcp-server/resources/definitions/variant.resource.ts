/**
 * @fileoverview gnomad://variant/{dataset}/{variantId} — the same population
 * record gnomad_get_variant returns for a single variant. The dataset segment
 * keeps the URI self-describing: a frequency without its dataset silently
 * misleads. The tool is the reliable path; this is convenience for clients that
 * support injectable context.
 * @module mcp-server/resources/definitions/variant.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { GNOMAD_DATASETS } from '@/config/server-config.js';
import { getGnomadService } from '@/services/gnomad/gnomad-service.js';
import type { Dataset } from '@/services/gnomad/types.js';

export const variantResource = resource('gnomad://variant/{dataset}/{variantId}', {
  description:
    'Population record for one gnomAD variant — AC/AN/AF overall and per ancestry, counts, flags, consequence, in-silico predictors, and joined ClinVar significance. Mirrors gnomad_get_variant. The dataset segment (e.g. gnomad_r4) makes the URI self-describing.',
  name: 'gnomAD variant record',
  mimeType: 'application/json',
  params: z.object({
    dataset: z
      .enum(GNOMAD_DATASETS)
      .describe('gnomAD dataset segment: gnomad_r4, gnomad_r3, gnomad_r2_1, or exac.'),
    variantId: z
      .string()
      .describe('Variant ID — chrom-pos-ref-alt (e.g. 1-55051215-G-GA) or an rsID (rs11591147).'),
  }),
  errors: [
    {
      reason: 'variant_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The variant is absent from the requested dataset.',
      recovery:
        'Confirm the ID and dataset, or run gnomad_get_coverage to check the position is callable before concluding true absence.',
    },
  ],

  async handler(params, ctx) {
    const svc = getGnomadService();
    const dsCtx = svc.resolveDatasetContext(params.dataset as Dataset);
    const record = await svc.getVariant(params.variantId, dsCtx, ctx);
    if (!record) {
      throw ctx.fail(
        'variant_not_found',
        `Variant "${params.variantId}" not found in ${params.dataset}.`,
        {
          ...ctx.recoveryFor('variant_not_found'),
        },
      );
    }
    return record;
  },
});
