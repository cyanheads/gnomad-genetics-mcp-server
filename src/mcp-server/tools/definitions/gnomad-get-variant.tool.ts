/**
 * @fileoverview gnomad_get_variant — full population record for one or more
 * variants: AC/AN/AF overall and per genetic-ancestry group, homozygote/
 * hemizygote counts, quality flags, transcript consequence, in-silico
 * predictors, and joined ClinVar significance. The batch is dispatched
 * concurrently under GnomadService's upstream-concurrency cap, with per-item
 * partial success — one bad ID never fails the call, each failed[] item carries
 * its typed reason and declared recovery hint, and found[]/failed[] stay in
 * input order.
 * @module mcp-server/tools/definitions/gnomad-get-variant.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getGnomadService } from '@/services/gnomad/gnomad-service.js';
import {
  batchVariantIdField,
  datasetField,
  normalizeVariantIdentifier,
  referenceGenomeField,
} from '../shared-schemas.js';

/**
 * Per-call batch cap, read once at module load from GNOMAD_MAX_VARIANT_BATCH
 * (default 25). The server runs over stdio/HTTP where process env is populated
 * at startup, so reading config here lets the configured cap flow into both the
 * advertised input schema (the `maxItems` in tools/list) and parse-time
 * validation — keeping the env var, the description, and the actual limit in sync.
 */
const MAX_VARIANT_BATCH = getServerConfig().maxVariantBatch;

const PopulationFreq = z
  .object({
    id: z
      .string()
      .describe(
        'Genetic-ancestry group: afr, amr, asj, eas, fin, mid, nfe, sas, remaining, or ami (genomes only).',
      ),
    source: z
      .enum(['exome', 'genome'])
      .describe('Which gnomAD callset this group vector came from.'),
    ac: z.number().describe('Allele count in this group.'),
    an: z.number().describe('Allele number (called chromosomes) in this group.'),
    af: z.number().nullable().describe('Allele frequency (ac/an); null when an is 0.'),
    homozygote_count: z.number().describe('Homozygote count in this group.'),
    hemizygote_count: z
      .number()
      .nullable()
      .describe('Hemizygote count (X/Y only); null otherwise.'),
  })
  .describe('One genetic-ancestry group AC/AN/AF vector.');

const InSilico = z
  .object({
    id: z
      .string()
      .describe(
        'Predictor name. Ids vary by dataset — gnomad_r4: cadd, revel_max, spliceai_ds_max, pangolin_largest_ds, phylop, sift_max, polyphen_max; gnomad_r3: cadd, revel, splice_ai, primate_ai; gnomad_r2_1 and exac carry none.',
      ),
    value: z
      .number()
      .nullable()
      .describe(
        'Predictor score; null when not provided for this variant, or when gnomAD gave text with no number (the text is then in annotation).',
      ),
    annotation: z
      .string()
      .nullable()
      .describe(
        'Text gnomAD attaches to the score — on gnomad_r3, the SpliceAI event (e.g. acceptor_gain, no_consequence). Holds the raw text when value is null for lack of a number; null for a plain score.',
      ),
  })
  .describe('One in-silico predictor score.');

const ClinVar = z
  .object({
    clinical_significance: z
      .string()
      .nullable()
      .describe(
        'ClinVar clinical significance (e.g. Pathogenic, Likely benign); null when no entry.',
      ),
    review_status: z.string().nullable().describe('ClinVar review status text.'),
    gold_stars: z.number().nullable().describe('ClinVar 0–4 star review rating.'),
    clinvar_variation_id: z.string().nullable().describe('ClinVar VariationID.'),
  })
  .describe('Joined ClinVar significance from gnomAD. Null when the variant has no ClinVar entry.');

const VariantRecordSchema = z
  .object({
    variant_id: z.string().describe('Resolved chrom-pos-ref-alt variant ID.'),
    rsids: z.array(z.string()).describe('dbSNP rsIDs for this variant.'),
    reference_genome: z.string().describe('Reference build the record is on (GRCh38 or GRCh37).'),
    dataset: z.string().describe('Effective gnomAD dataset.'),
    ac: z.number().describe('Overall allele count across carried callset(s).'),
    an: z.number().describe('Overall allele number across carried callset(s).'),
    af: z.number().nullable().describe('Overall allele frequency; null when an is 0.'),
    homozygote_count: z.number().describe('Overall homozygote count.'),
    hemizygote_count: z
      .number()
      .nullable()
      .describe('Overall hemizygote count (X/Y only); null otherwise.'),
    populations: z
      .array(PopulationFreq)
      .describe('Per-ancestry frequency vector — never collapsed to a single global AF.'),
    source: z
      .array(z.enum(['exome', 'genome']))
      .describe('Which gnomAD callset(s) carry this variant.'),
    flags: z.array(z.string()).describe('Quality flags (e.g. lcr, segdup, lc_lof).'),
    consequence: z
      .string()
      .nullable()
      .describe('Worst/transcript VEP consequence term; null when none.'),
    transcript_id: z
      .string()
      .nullable()
      .describe('Transcript the consequence is on; null when none.'),
    gene_symbol: z
      .string()
      .nullable()
      .describe('Gene symbol for the reported consequence; null when none.'),
    in_silico: z.array(InSilico).describe('In-silico predictor scores present for this variant.'),
    clinvar: ClinVar.nullable().describe('ClinVar annotation, or null when no entry exists.'),
    clinvar_unavailable: z
      .boolean()
      .describe('True when the optional ClinVar resolver failed; false when no entry exists.'),
  })
  .describe('Full population record for one variant.');

/**
 * Every reason a failed[] item can carry: the tool's own per-item rejections
 * (malformed, absent) and each reason GnomadService.getVariant throws. Each is
 * declared in the tool's errors[], whose recovery hint the item carries.
 */
const FailureReason = z
  .enum([
    'invalid_variant_id',
    'variant_not_found',
    'mitochondrial_unsupported',
    'ambiguous_rsid',
    'graphql_error',
    'upstream_build_mismatch',
    'upstream_unavailable',
    'upstream_timeout',
    'upstream_access',
    'invalid_upstream_response',
  ])
  .describe(
    "Why this ID failed — a reason declared in this tool's error contract. Branch on it rather than on the message.",
  );

const FailedItem = z
  .object({
    variant: z.string().describe('The input ID that failed to resolve.'),
    error: z.string().describe('What went wrong for this ID.'),
    reason: FailureReason,
    recovery: z
      .string()
      .describe('The next step for this ID — the recovery hint declared for its reason.'),
    candidates: z
      .array(z.string())
      .optional()
      .describe('Concrete variant IDs to retry when an rsID is ambiguous.'),
  })
  .describe('One failed input ID, why it failed, and what to do next.');

/**
 * Per-item batch outcome — a resolved record or a typed failure. Each input ID
 * maps to one of these, so one bad ID can't fail the batch. Bucketed in input
 * order after the concurrent dispatch settles.
 */
type VariantLookupOutcome =
  | { ok: true; record: z.infer<typeof VariantRecordSchema> }
  | { ok: false; failure: z.infer<typeof FailedItem> };

export const gnomadGetVariant = tool('gnomad_get_variant', {
  title: 'gnomad-genetics-mcp-server: get variant',
  description: `Fetch the full gnomAD population record for one or more variants — allele count/number/frequency overall and broken down per genetic-ancestry group, homozygote and hemizygote counts, quality flags, transcript consequence, in-silico predictor scores, and joined ClinVar clinical significance. The "how common, is it benign" answer in one call. Accepts a batch of up to ${MAX_VARIANT_BATCH} IDs (chrom-pos-ref-alt or rsID) with per-item partial success: a malformed or absent ID lands in failed[] — with its reason and a recovery hint — without failing the others. An empty found[] for a well-formed ID means the variant is not in the chosen dataset — pair with gnomad_get_coverage to confirm the position is callable before concluding true absence.\nData source: gnomAD (Broad Institute) — https://gnomad.broadinstitute.org/`,
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    variants: z
      .array(batchVariantIdField)
      .min(1)
      .max(MAX_VARIANT_BATCH)
      .describe(
        `1–${MAX_VARIANT_BATCH} variant IDs (chrom-pos-ref-alt or rsID) to look up in one batched call.`,
      ),
    dataset: datasetField,
    reference_genome: referenceGenomeField,
  }),
  output: z.object({
    found: z.array(VariantRecordSchema).describe('Variants resolved to a population record.'),
    failed: z
      .array(FailedItem)
      .describe(
        'Per-item failures, in input order: malformed IDs, variants absent from the dataset, or upstream errors — each with its reason and recovery hint.',
      ),
    dataset: z.string().describe('Effective gnomAD dataset used for the batch.'),
    reference_genome: z.string().describe('Effective reference build used for the batch.'),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Non-fatal notice when optional ClinVar annotation was unavailable.'),
  },
  errors: [
    {
      reason: 'incoherent_build',
      code: JsonRpcErrorCode.ValidationError,
      when: 'reference_genome was supplied but does not match the dataset.',
      recovery:
        'Omit reference_genome to let it derive, or pass the build matching the dataset (v4/v3=GRCh38, v2.1/ExAC=GRCh37).',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_variant_id',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A variant ID is outside the chrom-pos-ref-alt or rsID grammar; reported per item in failed[].',
      recovery:
        'Use chrom-pos-ref-alt with chromosome 1–22, X, or Y (optional chr prefix); a positive position; A/C/G/T alleles; or an rsID.',
    },
    {
      reason: 'variant_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'A well-formed ID is absent from the requested dataset; reported per item in failed[].',
      recovery:
        'Confirm the ID and dataset, or run gnomad_get_coverage to check the position is callable before concluding true absence.',
    },
    {
      reason: 'mitochondrial_unsupported',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A variant ID names the mitochondrial chromosome (M, MT, or chrM); reported per item in failed[].',
      recovery:
        'Mitochondrial variants are outside this server; look them up in the gnomAD browser at https://gnomad.broadinstitute.org/. IDs on chromosomes 1–22, X, and Y are served.',
      thrownBy: 'service',
    },
    {
      reason: 'ambiguous_rsid',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An rsID maps to more than one variant in the dataset; reported per item in failed[].',
      recovery:
        'Retry with one of the chrom-pos-ref-alt IDs in candidates, or resolve the rsID to a single variant ID with dbSNP or Ensembl.',
      thrownBy: 'service',
    },
    {
      reason: 'graphql_error',
      code: JsonRpcErrorCode.ValidationError,
      when: 'gnomAD rejected the lookup for one ID with a GraphQL error; reported per item in failed[].',
      recovery:
        'Check the ID against the dataset before retrying: gnomAD rejected this lookup as sent, so the same request fails again.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_build_mismatch',
      code: JsonRpcErrorCode.ValidationError,
      when: 'gnomAD answered one ID with a variant on a different reference build; reported per item in failed[].',
      recovery:
        'Treat this ID as unavailable in this dataset: retry it later, or look it up in another dataset on the same build.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'gnomAD stayed unavailable or throttled through every retry for one ID; reported per item in failed[].',
      recovery:
        'Wait a few seconds, then retry only the failed IDs. gnomAD is a community-funded API — keep batches small and request volume low.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'Every attempt to reach gnomAD for one ID timed out; reported per item in failed[].',
      recovery:
        'Wait a few seconds, then retry only the failed IDs, in smaller batches when several timed out.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_access',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'gnomAD refused the request for one ID (access denied); reported per item in failed[].',
      recovery:
        'Do not retry: gnomAD is refusing requests from this server. Tell the user the lookup is blocked upstream and point them to https://gnomad.broadinstitute.org/.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_upstream_response',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'gnomAD kept answering one ID with a response that failed validation; reported per item in failed[].',
      recovery:
        'Wait a few seconds, then retry only the failed IDs; gnomAD returned a response this server could not validate.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const svc = getGnomadService();
    const dsCtx = svc.resolveDatasetContext(input.dataset, input.reference_genome);

    const failure = (
      variant: string,
      reason: z.infer<typeof FailureReason>,
      error: string,
      candidates?: string[],
    ): VariantLookupOutcome => ({
      ok: false,
      failure: {
        variant,
        error,
        reason,
        recovery: ctx.recoveryFor(reason).recovery.hint,
        ...(candidates?.length ? { candidates } : {}),
      },
    });

    // Dispatch every ID concurrently; GnomadService's maxConcurrency semaphore
    // (GNOMAD_MAX_CONCURRENCY, default 2) — acquired per upstream GraphQL call —
    // bounds the actual fan-out, so this stays polite without a serial loop.
    // Promise.all preserves input order in its result array regardless of
    // resolution order, so bucketing the settled outcomes below keeps
    // found[]/failed[] deterministic. A failure carrying a declared reason
    // becomes that ID's outcome, preserving per-item partial success — one bad
    // ID never fails the batch. A cancelled call, or a failure no declared
    // reason covers, is not about one ID and fails the whole call.
    const outcomes = await Promise.all(
      input.variants.map(async (variantId): Promise<VariantLookupOutcome> => {
        const normalized = normalizeVariantIdentifier(variantId);
        if (!normalized) {
          return failure(
            variantId,
            'invalid_variant_id',
            'Malformed ID. Expected chrom-pos-ref-alt (e.g. 1-55051215-G-GA) with ACGT alleles, or an rsID (e.g. rs11591147).',
          );
        }
        try {
          const record = await svc.getVariant(normalized.canonical, dsCtx, ctx);
          if (record) return { ok: true, record };
          return failure(variantId, 'variant_not_found', `Not found in ${dsCtx.dataset}.`);
        } catch (err) {
          if (ctx.signal.aborted || !(err instanceof McpError)) throw err;
          const reason = FailureReason.safeParse(err.data?.reason);
          if (!reason.success) throw err;
          const candidates = err.data?.candidates;
          return failure(
            variantId,
            reason.data,
            err.message,
            Array.isArray(candidates) ? candidates : undefined,
          );
        }
      }),
    );

    const found: z.infer<typeof VariantRecordSchema>[] = [];
    const failed: z.infer<typeof FailedItem>[] = [];
    for (const outcome of outcomes) {
      if (outcome.ok) found.push(outcome.record);
      else failed.push(outcome.failure);
    }

    ctx.log.info('gnomad_get_variant resolved', {
      dataset: dsCtx.dataset,
      requested: input.variants.length,
      found: found.length,
      failed: failed.length,
    });

    const unavailable = found.filter((record) => record.clinvar_unavailable);
    if (unavailable.length) {
      ctx.enrich.notice(
        `ClinVar annotation was unavailable for: ${unavailable.map((record) => record.variant_id).join(', ')}. Population data is complete.`,
      );
    }
    return { found, failed, dataset: dsCtx.dataset, reference_genome: dsCtx.reference_genome };
  },

  format: (result) => {
    const af = (v: number | null) => (v != null ? `${v} (${v.toExponential(3)})` : 'Not available');
    const lines: string[] = [`**Dataset:** ${result.dataset} (${result.reference_genome})`];
    for (const v of result.found) {
      lines.push('', `## ${v.variant_id}${v.rsids.length ? ` (${v.rsids.join(', ')})` : ''}`);
      lines.push(`**Dataset:** ${v.dataset} | **Build:** ${v.reference_genome}`);
      lines.push(
        `**Gene:** ${v.gene_symbol ?? 'Not available'} | **Consequence:** ${v.consequence ?? 'Not available'}`,
      );
      lines.push(
        `**Overall:** AC ${v.ac} / AN ${v.an} | AF ${af(v.af)} | hom ${v.homozygote_count}${v.hemizygote_count != null ? ` | hemi ${v.hemizygote_count}` : ''}`,
      );
      lines.push(
        `**Callsets:** ${v.source.join(', ') || 'none'} | **Flags:** ${v.flags.length ? v.flags.join(', ') : 'none'} | **Transcript:** ${v.transcript_id ?? 'Not available'}`,
      );
      if (v.populations.length) {
        lines.push('**Per-ancestry:**');
        for (const p of v.populations) {
          lines.push(
            `- ${p.id} (${p.source}): AC ${p.ac} / AN ${p.an} | AF ${af(p.af)} | hom ${p.homozygote_count}${p.hemizygote_count != null ? ` | hemi ${p.hemizygote_count}` : ''}`,
          );
        }
      }
      if (v.in_silico.length) {
        lines.push(
          `**In-silico:** ${v.in_silico.map((s) => `${s.id}=${s.value != null ? s.value : 'n/a'}${s.annotation != null ? ` (${s.annotation})` : ''}`).join(', ')}`,
        );
      }
      if (v.clinvar) {
        lines.push(
          `**ClinVar:** ${v.clinvar.clinical_significance ?? 'Not available'} | stars ${v.clinvar.gold_stars ?? 'Not available'} | review ${v.clinvar.review_status ?? 'Not available'} | VariationID ${v.clinvar.clinvar_variation_id ?? 'Not available'}`,
        );
      } else {
        lines.push(
          v.clinvar_unavailable
            ? '**ClinVar:** unavailable (optional resolver failed)'
            : '**ClinVar:** no entry',
        );
      }
    }
    if (result.failed.length) {
      lines.push('', '### Failed');
      for (const f of result.failed) {
        lines.push(
          `- **${f.variant}:** ${f.error}${f.candidates?.length ? ` Candidates: ${f.candidates.join(', ')}` : ''} (reason ${f.reason})`,
          `  - Recovery: ${f.recovery}`,
        );
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
