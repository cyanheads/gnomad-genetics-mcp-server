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
import { normalizeVariantIdentifier } from '../../tools/shared-schemas.js';

export const variantResource = resource('gnomad://variant/{dataset}/{variantId}', {
  description:
    'Population record for one gnomAD variant — AC/AN/AF overall and per ancestry, counts, flags, consequence, in-silico predictors, and joined ClinVar significance. Mirrors gnomad_get_variant. The dataset segment (e.g. gnomad_r4) makes the URI self-describing.\nData source: gnomAD (Broad Institute) — https://gnomad.broadinstitute.org/',
  name: 'gnomAD variant record',
  mimeType: 'application/json',
  params: z.object({
    dataset: z
      .enum(GNOMAD_DATASETS)
      .describe('gnomAD dataset segment: gnomad_r4, gnomad_r3, gnomad_r2_1, or exac.'),
    variantId: z
      .string()
      .describe(
        'Variant ID — chrom-pos-ref-alt (e.g. 1-55051215-G-GA) on chromosome 1–22, X, or Y, or an rsID (rs11591147). Mitochondrial IDs are not served.',
      ),
  }),
  errors: [
    {
      reason: 'invalid_variant_id',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The variant identifier is outside the supported coordinate or rsID grammar.',
      recovery:
        'Use chrom-pos-ref-alt with chromosome 1–22, X, or Y (optional chr prefix); a positive position; A/C/G/T alleles; or an rsID.',
    },
    {
      reason: 'mitochondrial_unsupported',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The variant ID names the mitochondrial chromosome (M, MT, or chrM).',
      recovery:
        'Mitochondrial variants are outside this server; look them up in the gnomAD browser at https://gnomad.broadinstitute.org/. IDs on chromosomes 1–22, X, and Y are served.',
      thrownBy: 'service',
    },
    {
      reason: 'variant_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The variant is absent from the requested dataset.',
      recovery:
        'Confirm the ID and dataset, or run gnomad_get_coverage to check the position is callable before concluding true absence.',
    },
    {
      reason: 'ambiguous_rsid',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The rsID maps to more than one variant in the dataset.',
      recovery:
        'Read the resource again with one of the chrom-pos-ref-alt IDs in candidates as the variantId, or resolve the rsID to a single variant ID with dbSNP or Ensembl.',
      thrownBy: 'service',
    },
    {
      reason: 'graphql_error',
      code: JsonRpcErrorCode.ValidationError,
      when: 'gnomAD rejected the lookup with a GraphQL error.',
      recovery:
        'Check the variant ID against the dataset segment before reading again: gnomAD rejected this lookup as sent, so the same read fails again.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_build_mismatch',
      code: JsonRpcErrorCode.ValidationError,
      when: 'gnomAD answered with a variant on a different reference build.',
      recovery:
        'Treat this variant as unavailable in this dataset: read it again later, or read it from another dataset on the same build.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'gnomAD stayed unavailable or throttled through every retry.',
      recovery:
        'gnomAD is degraded or throttling; wait a few seconds and read the variant again. gnomAD is a community-funded API — keep request volume low.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'Every attempt to reach gnomAD timed out.',
      recovery: 'gnomAD did not answer in time; wait a few seconds, then read the variant again.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_access',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'gnomAD refused the request (access denied).',
      recovery:
        'Do not retry: gnomAD is refusing requests from this server. Tell the user the lookup is blocked upstream and point them to https://gnomad.broadinstitute.org/.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_upstream_response',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'gnomAD kept answering with a response that failed validation.',
      recovery:
        'Wait a few seconds and read the variant again; gnomAD returned a response this server could not validate.',
      thrownBy: 'service',
    },
  ],

  async handler(params, ctx) {
    const svc = getGnomadService();
    const dsCtx = svc.resolveDatasetContext(params.dataset as Dataset);
    const normalized = normalizeVariantIdentifier(params.variantId);
    if (!normalized) {
      throw ctx.fail('invalid_variant_id', 'Invalid variant ID.');
    }
    const record = await svc.getVariant(normalized.canonical, dsCtx, ctx);
    if (!record) {
      throw ctx.fail(
        'variant_not_found',
        `Variant "${params.variantId}" not found in ${params.dataset}.`,
      );
    }
    return record;
  },
});
