/**
 * @fileoverview Shared Zod field fragments reused across gnomAD tool inputs —
 * the dataset/reference_genome pair every read tool exposes, and the validation
 * patterns for variant IDs, gene refs, and regions. Field-level fragments, not a
 * tool abstraction: each tool composes them into its own z.object().
 * @module mcp-server/tools/shared-schemas
 */

import { z } from '@cyanheads/mcp-ts-core';
import { GNOMAD_DATASETS } from '@/config/server-config.js';
import { normalizeIdentifier } from '@/services/gnomad/identifier-normalization.js';
import type { GenomeTarget } from '@/services/gnomad/types.js';

/**
 * Every dataset value by parent release and build. Resource URI segments and
 * prompt arguments carry no schema on the wire, so their descriptions list
 * the values; this one sentence serves them and datasetField alike.
 */
export const DATASET_CHOICES =
  'gnomad_r4 and its subset gnomad_r4_non_ukb (GRCh38); gnomad_r3 and its subsets gnomad_r3_controls_and_biobanks, gnomad_r3_non_cancer, gnomad_r3_non_neuro, gnomad_r3_non_topmed, gnomad_r3_non_v2 (GRCh38); gnomad_r2_1 and its subsets gnomad_r2_1_controls, gnomad_r2_1_non_cancer, gnomad_r2_1_non_neuro, gnomad_r2_1_non_topmed (GRCh37); exac (GRCh37)';

/** Dataset selector — defaults applied in the service from server config. */
export const datasetField = z
  .enum(GNOMAD_DATASETS)
  .optional()
  .describe(
    `gnomAD dataset, default gnomad_r4: ${DATASET_CHOICES}. A subset keeps only part of its parent release's samples (non_cancer leaves out cancer-study samples, non_ukb UK Biobank's) and can leave a callset unchanged: gnomad_r4_non_ukb genome counts equal gnomad_r4's, and gnomad_r2_1_non_cancer genome counts equal gnomad_r2_1's. No subset publishes joint data, and gnomAD publishes no subset coverage or constraint, so those come from the parent. Echoed in output.`,
  );

/** Reference build selector — derived from dataset when omitted; must be coherent if both given. */
export const referenceGenomeField = z
  .enum(['GRCh38', 'GRCh37'])
  .optional()
  .describe(
    'Reference build. Derived from dataset when omitted: GRCh38 for gnomad_r4, gnomad_r3, and their subsets; GRCh37 for gnomad_r2_1, its subsets, and exac. If supplied it must match the dataset, or the call is rejected. Keep aligned with ensembl coordinates.',
  );

/**
 * Variant ID: chrom-pos-ref-alt (e.g. 1-55051215-G-GA). M and MT parse so the
 * service can reject them as mitochondrial_unsupported rather than malformed.
 */
export const VARIANT_ID_REGEX = /^(?:chr)?(?:[1-9]|1\d|2[0-2]|X|Y|MT|M)-[1-9]\d*-[ACGT]+-[ACGT]+$/i;
/** rsID: rs followed by digits (e.g. rs11591147). */
export const RSID_REGEX = /^rs\d+$/i;
/**
 * Region: chrom-start-stop (e.g. 1-55039447-55064852). Shape only — the service
 * region parser owns the chromosome set, the coordinate bounds, and the span
 * limit, so an unserved chromosome fails as invalid_region, not a parse error.
 */
export const REGION_REGEX = /^(?:chr)?[0-9A-Z]+-\d+-\d+$/i;

/** Combined matcher — accepts a chrom-pos-ref-alt variantId OR an rsID. */
export const VARIANT_OR_RSID_REGEX = new RegExp(
  `^(?:${VARIANT_ID_REGEX.source.slice(1, -1)}|${RSID_REGEX.source.slice(1, -1)})$`,
  'i',
);

/**
 * Parse and canonicalize one supported coordinate ID or rsID. Under
 * GNOMAD_NORMALIZE_IDS an rsID is lowercased and a colon-separated ID
 * (chr1:55039974:G:T) reads as its dashed form before validation.
 */
export function normalizeVariantIdentifier(
  value: string,
): { kind: 'variant' | 'rsid'; canonical: string } | null {
  if (RSID_REGEX.test(value))
    return { kind: 'rsid', canonical: normalizeIdentifier('rsid', value) };
  const id = normalizeIdentifier('variant', value, (dashed) => VARIANT_ID_REGEX.test(dashed));
  if (!VARIANT_ID_REGEX.test(id)) return null;
  return { kind: 'variant', canonical: id.replace(/^chr/i, '').toUpperCase() };
}

/**
 * Wrap a tool's region union so a colon spelling (chr1:55,039,447-55,064,852)
 * reaches it as chrom-start-stop under GNOMAD_NORMALIZE_IDS. The advertised
 * schema stays the union's own: z.preprocess emits only its output side.
 */
export function normalizedRegion<T extends z.ZodType>(schema: T) {
  return z.preprocess(
    (value) => (typeof value === 'string' ? normalizeIdentifier('region', value) : value),
    schema,
  );
}

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
    'Variant ID — chrom-pos-ref-alt (1-based, e.g. 1-55051215-G-GA) on chromosome 1–22, X, or Y with an optional chr prefix, or an rsID (rs11591147). Mitochondrial IDs (M, MT, chrM) are not served. Obtain a variantId from ensembl_predict_variant or a VCF. Malformed IDs are reported per-item in failed[], not rejected wholesale.',
  );

/** Gene reference — HGNC symbol or Ensembl gene ID. */
export const geneField = z
  .string()
  .trim()
  .min(2)
  .describe(
    'Gene — HGNC symbol (e.g. PCSK9) or Ensembl gene ID (e.g. ENSG00000169174). Obtain a stable ID from ensembl_lookup_gene.',
  );

/**
 * Optional gene reference for the tools that take one of gene / transcript_id /
 * region. A value blank after trimming reads as omitted — form clients send ''
 * for unset fields — so resolveGenomeTarget falls through to the other target;
 * any other value still needs geneField's shape. A rejected value reports both
 * alternatives joined by "or", so geneField leads and the blank member's
 * message completes the sentence.
 */
export const optionalGeneField = z
  .union([
    geneField,
    z
      .string()
      .trim()
      .max(0, 'blank to omit the gene')
      .describe('Blank — the gene is treated as omitted.'),
  ])
  .optional()
  .describe(
    'Gene — HGNC symbol (e.g. PCSK9) or Ensembl gene ID (e.g. ENSG00000169174). Obtain a stable ID from ensembl_lookup_gene. Mitochondrial genes (e.g. MT-TL1) are not served. Mutually exclusive with transcript_id and region; blank means omitted.',
  );

/**
 * Resolve the mutually-exclusive gene / transcript_id / region inputs (shared by
 * the list and coverage tools) into exactly one GenomeTarget. Throws via the
 * caller's `invalid_target` contract when not exactly one is present. Under
 * GNOMAD_NORMALIZE_IDS an Ensembl gene or transcript ID is upper-cased and
 * loses its version (ENST00000302118.5 → ENST00000302118); a symbol is never
 * case-folded. The region arrives already normalized by its schema.
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
  const target = provided[0] as GenomeTarget;
  return target.kind === 'region'
    ? target
    : { kind: target.kind, value: normalizeIdentifier(target.kind, target.value) };
}
