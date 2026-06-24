/**
 * @fileoverview Shared Zod field fragments reused across gnomAD tool inputs —
 * the dataset/reference_genome pair every read tool exposes, and the validation
 * patterns for variant IDs, gene refs, and regions. Field-level fragments, not a
 * tool abstraction: each tool composes them into its own z.object().
 * @module mcp-server/tools/shared-schemas
 */

import { z } from '@cyanheads/mcp-ts-core';
import { GNOMAD_DATASETS } from '@/config/server-config.js';
import type { GenomeTarget } from '@/services/gnomad/types.js';

/** Dataset selector — defaults applied in the service from server config. */
export const datasetField = z
  .enum(GNOMAD_DATASETS)
  .optional()
  .describe(
    'gnomAD dataset: gnomad_r4 (GRCh38, default), gnomad_r3 (GRCh38), gnomad_r2_1 (GRCh37), exac (GRCh37). Echoed in output.',
  );

/** Reference build selector — derived from dataset when omitted; must be coherent if both given. */
export const referenceGenomeField = z
  .enum(['GRCh38', 'GRCh37'])
  .optional()
  .describe(
    'Reference build. Derived from dataset when omitted (v4/v3=GRCh38, v2.1/ExAC=GRCh37). If supplied it must match the dataset, or the call is rejected. Keep aligned with ensembl coordinates.',
  );

/** Variant ID: chrom-pos-ref-alt (e.g. 1-55051215-G-GA). */
export const VARIANT_ID_REGEX = /^[0-9XYM]+-\d+-[ACGT]+-[ACGT]+$/i;
/** rsID: rs followed by digits (e.g. rs11591147). */
export const RSID_REGEX = /^rs\d+$/i;
/** Region: chrom-start-stop (e.g. 1-55039447-55064852). */
export const REGION_REGEX = /^[0-9XYM]+-\d+-\d+$/i;

/** Combined matcher — accepts a chrom-pos-ref-alt variantId OR an rsID. */
export const VARIANT_OR_RSID_REGEX = new RegExp(
  `(${VARIANT_ID_REGEX.source})|(${RSID_REGEX.source})`,
  'i',
);

/**
 * A single variant identifier for a BATCH field — a plain string so one
 * malformed element can't reject the whole array. Format is validated per-item
 * in the handler and surfaced through failed[], honoring partial success. The
 * pattern is documented in the description so inspecting clients still see it.
 */
export const batchVariantIdField = z
  .string()
  .min(1)
  .describe(
    'Variant ID — chrom-pos-ref-alt (1-based, e.g. 1-55051215-G-GA) or an rsID (rs11591147). Obtain a variantId from ensembl_predict_variant or a VCF. Malformed IDs are reported per-item in failed[], not rejected wholesale.',
  );

/** Gene reference — HGNC symbol or Ensembl gene ID. */
export const geneField = z
  .string()
  .min(2)
  .describe(
    'Gene — HGNC symbol (e.g. PCSK9) or Ensembl gene ID (e.g. ENSG00000169174). Obtain a stable ID from ensembl_lookup_gene.',
  );

/**
 * Resolve the mutually-exclusive gene / transcript_id / region inputs (shared by
 * the list and coverage tools) into exactly one GenomeTarget. Throws via the
 * caller's `invalid_target` contract when not exactly one is present.
 */
export function resolveGenomeTarget(
  inputs: {
    gene?: string | undefined;
    transcript_id?: string | undefined;
    region?: string | undefined;
  },
  ctx: { fail: (reason: 'invalid_target', msg?: string) => Error },
): GenomeTarget {
  const provided = [
    inputs.gene ? ({ kind: 'gene', value: inputs.gene } as const) : undefined,
    inputs.transcript_id
      ? ({ kind: 'transcript', value: inputs.transcript_id } as const)
      : undefined,
    inputs.region ? ({ kind: 'region', value: inputs.region } as const) : undefined,
  ].filter((t): t is GenomeTarget => t !== undefined);
  if (provided.length !== 1) {
    throw ctx.fail(
      'invalid_target',
      `Supply exactly one of gene, transcript_id, or region — received ${provided.length}.`,
    );
  }
  return provided[0] as GenomeTarget;
}
