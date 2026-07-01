/**
 * @fileoverview gnomad_get_variant — full population record for one or more
 * variants: AC/AN/AF overall and per genetic-ancestry group, homozygote/
 * hemizygote counts, quality flags, transcript consequence, in-silico
 * predictors, and joined ClinVar significance. The batch is dispatched
 * concurrently under GnomadService's upstream-concurrency cap, with per-item
 * partial success — one bad ID never fails the call, and found[]/failed[] stay
 * in input order.
 * @module mcp-server/tools/definitions/gnomad-get-variant.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getGnomadService } from '@/services/gnomad/gnomad-service.js';
import {
  batchVariantIdField,
  datasetField,
  referenceGenomeField,
  VARIANT_OR_RSID_REGEX,
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
    id: z.string().describe('Predictor name (e.g. revel_max, cadd, spliceai_ds_max).'),
    value: z
      .number()
      .nullable()
      .describe('Predictor score; null when not provided for this variant.'),
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
  })
  .describe('Full population record for one variant.');

/**
 * Per-item batch outcome — a resolved record or a typed failure. Each input ID
 * maps to one of these; the map never rejects, so one bad ID can't fail the
 * batch. Bucketed in input order after the concurrent dispatch settles.
 */
type VariantLookupOutcome =
  | { ok: true; record: z.infer<typeof VariantRecordSchema> }
  | { ok: false; failure: { variant: string; error: string } };

export const gnomadGetVariant = tool('gnomad_get_variant', {
  title: 'gnomad-genetics-mcp-server: get variant',
  description: `Fetch the full gnomAD population record for one or more variants — allele count/number/frequency overall and broken down per genetic-ancestry group, homozygote and hemizygote counts, quality flags, transcript consequence, in-silico predictor scores, and joined ClinVar clinical significance. The "how common, is it benign" answer in one call. Accepts a batch of up to ${MAX_VARIANT_BATCH} IDs (chrom-pos-ref-alt or rsID) with per-item partial success: a malformed or absent ID lands in failed[] without failing the others. An empty found[] for a well-formed ID means the variant is not in the chosen dataset — pair with gnomad_get_coverage to confirm the position is callable before concluding true absence.`,
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
      .array(
        z
          .object({
            variant: z.string().describe('The input ID that failed to resolve.'),
            error: z.string().describe('What went wrong and how to resolve it.'),
          })
          .describe('One failed input ID and why it failed.'),
      )
      .describe(
        'Per-item failures: malformed IDs, variants absent from the dataset, or upstream errors.',
      ),
    dataset: z.string().describe('Effective gnomAD dataset used for the batch.'),
    reference_genome: z.string().describe('Effective reference build used for the batch.'),
  }),
  errors: [
    {
      reason: 'incoherent_build',
      code: JsonRpcErrorCode.ValidationError,
      when: 'reference_genome was supplied but does not match the dataset.',
      recovery:
        'Omit reference_genome to let it derive, or pass the build matching the dataset (v4/v3=GRCh38, v2.1/ExAC=GRCh37).',
    },
  ],

  async handler(input, ctx) {
    const svc = getGnomadService();
    const dsCtx = svc.resolveDatasetContext(input.dataset, input.reference_genome);

    // Dispatch every ID concurrently; GnomadService's maxConcurrency semaphore
    // (GNOMAD_MAX_CONCURRENCY, default 2) — acquired per upstream GraphQL call —
    // bounds the actual fan-out, so this stays polite without a serial loop.
    // Promise.all preserves input order in its result array regardless of
    // resolution order, so bucketing the settled outcomes below keeps
    // found[]/failed[] deterministic. Each item resolves to an outcome and never
    // rejects, preserving per-item partial success — one bad ID never fails the
    // batch.
    const outcomes = await Promise.all(
      input.variants.map(async (variantId): Promise<VariantLookupOutcome> => {
        if (!VARIANT_OR_RSID_REGEX.test(variantId)) {
          return {
            ok: false,
            failure: {
              variant: variantId,
              error:
                'Malformed ID. Expected chrom-pos-ref-alt (e.g. 1-55051215-G-GA) with ACGT alleles, or an rsID (e.g. rs11591147).',
            },
          };
        }
        try {
          const record = await svc.getVariant(variantId, dsCtx, ctx);
          if (record) return { ok: true, record };
          return {
            ok: false,
            failure: {
              variant: variantId,
              error: `Not found in ${dsCtx.dataset}. Confirm the ID and build, or run gnomad_get_coverage to check the position is callable before concluding true absence.`,
            },
          };
        } catch (err) {
          return {
            ok: false,
            failure: {
              variant: variantId,
              error: err instanceof Error ? err.message : String(err),
            },
          };
        }
      }),
    );

    const found: z.infer<typeof VariantRecordSchema>[] = [];
    const failed: { variant: string; error: string }[] = [];
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
          `**In-silico:** ${v.in_silico.map((s) => `${s.id}=${s.value != null ? s.value : 'n/a'}`).join(', ')}`,
        );
      }
      if (v.clinvar) {
        lines.push(
          `**ClinVar:** ${v.clinvar.clinical_significance ?? 'Not available'} | stars ${v.clinvar.gold_stars ?? 'Not available'} | review ${v.clinvar.review_status ?? 'Not available'} | VariationID ${v.clinvar.clinvar_variation_id ?? 'Not available'}`,
        );
      } else {
        lines.push('**ClinVar:** no entry');
      }
    }
    if (result.failed.length) {
      lines.push('', '### Failed');
      for (const f of result.failed) lines.push(`- **${f.variant}:** ${f.error}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
