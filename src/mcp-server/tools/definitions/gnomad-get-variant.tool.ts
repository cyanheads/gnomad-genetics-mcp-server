/**
 * @fileoverview gnomad_get_variant — full population record for one or more
 * variants: AC/AN/AF overall and per genetic-ancestry group, the filtering
 * allele frequency (FAF95), homozygote/hemizygote counts, quality flags,
 * per-callset counts, FAF95, and QC filters with the
 * record's qc_status, the most severe transcript consequence and the one on the
 * gene's primary transcript, in-silico predictors, and joined
 * ClinVar significance. The batch is dispatched
 * concurrently under GnomadService's upstream-concurrency cap, with per-item
 * partial success — one bad ID never fails the call, each failed[] item carries
 * its typed reason and declared recovery hint, and found[]/failed[] stay in
 * input order. Absent coordinate IDs share best-effort liftover requests (one
 * per 25 IDs) after the batch settles, which name the IDs each lifts to from
 * the other build.
 * @module mcp-server/tools/definitions/gnomad-get-variant.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { getVariantBatchCap } from '@/config/server-config.js';
import { getGnomadService, recordFafParent } from '@/services/gnomad/gnomad-service.js';
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
const MAX_VARIANT_BATCH = getVariantBatchCap();

/**
 * The per-group and per-callset count vectors read as the record's overall
 * counts do, so their fields are labels; the overall fields carry the null and
 * X/Y rules once.
 */
const PopulationFreq = z
  .object({
    id: z
      .string()
      .describe(
        'Genetic-ancestry group: afr, amr, asj, eas, fin, mid, nfe, sas, ami (genomes only), and the catch-all group — remaining on gnomad_r4 and gnomad_r4_non_ukb, oth on every other dataset.',
      ),
    source: z.enum(['exome', 'genome']).describe('The callset this vector comes from.'),
    ac: z.number().describe('Allele count in this group.'),
    an: z.number().describe('Allele number in this group.'),
    af: z.number().nullable().describe('Allele frequency in this group.'),
    homozygote_count: z.number().describe('Homozygote count in this group.'),
    hemizygote_count: z.number().nullable().describe('Hemizygote count in this group.'),
  })
  .describe("One genetic-ancestry group's counts in one callset.");

const JointPopulationFreq = PopulationFreq.omit({ source: true })
  .extend({ id: z.string().describe('Genetic-ancestry group, as in populations.') })
  .describe("One genetic-ancestry group's counts in gnomAD's joint exome + genome data.");

const QcStatus = z.enum(['pass', 'filtered']).describe("gnomAD's QC verdict for the variant.");

const Faf95 = z.object({
  value: z.number().describe('FAF95 value (0–1).'),
  group: z
    .string()
    .nullable()
    .describe('Its ancestry group (e.g. nfe); null when gnomAD names none.'),
});

const Callset = z
  .object({
    ac: z.number().describe('Allele count in this callset.'),
    an: z.number().describe('Allele number in this callset.'),
    af: z.number().nullable().describe('Allele frequency in this callset.'),
    homozygote_count: z.number().describe('Homozygote count in this callset.'),
    hemizygote_count: z.number().nullable().describe('Hemizygote count in this callset.'),
    filters: z
      .array(z.string())
      .nullable()
      .describe(
        'QC filters on this call; empty when it passed, null when gnomAD returned no list.',
      ),
    faf95: Faf95.nullable().describe(
      "This callset's own FAF95; null on the same terms as the record's faf95.",
    ),
  })
  .nullable()
  .describe('Null when this callset does not carry the variant.');

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
        'Predictor score; null when not provided, or when gnomAD gave text with no number (then in annotation).',
      ),
    annotation: z
      .string()
      .nullable()
      .describe(
        'Text gnomAD attaches to the score — on gnomad_r3, the SpliceAI event (e.g. acceptor_gain) — or the raw text when value is null for lack of a number; null for a plain score.',
      ),
  })
  .describe('One in-silico predictor score.');

const ClinVar = z
  .object({
    clinical_significance: z
      .string()
      .nullable()
      .describe('ClinVar clinical significance (e.g. Pathogenic, Likely benign).'),
    review_status: z.string().nullable().describe('ClinVar review status text.'),
    gold_stars: z.number().nullable().describe('ClinVar 0–4 star review rating.'),
    clinvar_variation_id: z.string().nullable().describe('ClinVar VariationID.'),
  })
  .describe('ClinVar significance as gnomAD joins it.');

/** The primary transcript's fields mirror the record's consequence fields, which carry the examples. */
const PrimaryTranscript = z
  .object({
    transcript_id: z.string().describe('Ensembl transcript ID (unversioned).'),
    is_mane_select: z
      .boolean()
      .nullable()
      .describe(
        "True for the gene's MANE Select transcript. For a canonical entry, false, or null where gnomAD reports no MANE status: a gene without a MANE Select (such as a lncRNA), and every gene on a GRCh37 dataset.",
      ),
    consequence: z
      .string()
      .nullable()
      .describe('Most severe VEP consequence term on this transcript; null when none.'),
    hgvsc: z.string().nullable().describe('HGVSc on this transcript; null when none.'),
    hgvsp: z.string().nullable().describe('HGVSp on this transcript; null when none.'),
    lof: z.string().nullable().describe("LOFTEE's call on this transcript; null when none."),
    lof_filter: z.string().nullable().describe('LOFTEE filter on that call; null when none.'),
    lof_flags: z.string().nullable().describe('LOFTEE flags on that call; null when none.'),
  })
  .describe("The variant's consequence on its gene's primary transcript.");

const LofCuration = z
  .object({
    gene_id: z.string().describe('Ensembl gene ID the curation is for.'),
    gene_symbol: z.string().nullable().describe('Its gene symbol; null when gnomAD gives none.'),
    verdict: z.string().describe('The curators’ verdict (e.g. LoF, Likely LoF, Not LoF).'),
    flags: z
      .array(z.string())
      .describe(
        'The reasons the curators recorded, as gnomAD writes them (e.g. Weak Exon Conservation); empty when none.',
      ),
    project: z
      .string()
      .describe('The curation project the verdict comes from (e.g. metabolic_conditions_genes).'),
  })
  .describe("One of gnomAD's manual loss-of-function curations of the variant.");

const VariantRecordSchema = z
  .object({
    variant_id: z.string().describe('Resolved chrom-pos-ref-alt variant ID.'),
    rsids: z.array(z.string()).describe('dbSNP rsIDs for this variant.'),
    reference_genome: z.string().describe('Reference build the record is on.'),
    dataset: z.string().describe('Effective gnomAD dataset.'),
    ac: z.number().describe('Overall allele count.'),
    an: z
      .number()
      .describe(
        "Overall allele number. On gnomad_r4, gnomAD's joint AN over every callable sample in both callsets, including a callset that does not carry the variant.",
      ),
    af: z.number().nullable().describe('Overall allele frequency, ac/an; null when an is 0.'),
    homozygote_count: z.number().describe('Overall homozygote count.'),
    hemizygote_count: z
      .number()
      .nullable()
      .describe('Overall hemizygote count (0 off X/Y); null when gnomAD reports none.'),
    faf95: Faf95.extend({
      source: z
        .enum(['joint', 'exome', 'genome'])
        .describe("Where the value comes from: gnomAD's joint data, or that callset."),
    })
      .nullable()
      .describe(
        "gnomAD's filtering allele frequency (GroupMax FAF95): the lower bound of the 95% confidence interval of a genetic-ancestry group's AF, from the group with the highest bound, over non-bottlenecked groups only. From the joint data on gnomad_r4, even when that value is null; elsewhere the higher of the callsets' faf95, which source names. Null for AC 0 and singleton variants, on exac, and on a gnomad_r4 or gnomad_r3 subset, whose record carries the parent release's FAF (a notice names the parent; gnomad_list_gene_variants' faf95_max is gnomad_r4_non_ukb's own).",
      ),
    populations: z
      .array(PopulationFreq)
      .describe(
        'Per-ancestry counts of each carrying callset — never collapsed to a single global AF.',
      ),
    joint_populations: z
      .array(JointPopulationFreq)
      .describe("Per-ancestry counts in gnomAD's joint data, over the same samples as an."),
    callsets: z
      .object({ exome: Callset, genome: Callset })
      .describe(
        "Each callset's own counts and QC filters. A variant can fail QC in one callset and pass in the other. Filter names vary by dataset: on gnomad_r4 AC0 (no high-quality carrier after genotype QC), AS_VQSR, and InbreedingCoeff; RF on gnomad_r2_1.",
      ),
    source: z
      .array(z.enum(['exome', 'genome']))
      .describe('Which gnomAD callset(s) carry this variant.'),
    flags: z.array(z.string()).describe('Quality flags (e.g. lcr, segdup, lc_lof).'),
    qc_status: QcStatus,
    consequence: z
      .string()
      .nullable()
      .describe(
        "The most severe VEP consequence term across the variant's transcripts, as gnomAD reports it; null when none.",
      ),
    transcript_id: z
      .string()
      .nullable()
      .describe(
        "Ensembl transcript ID (unversioned) the consequence is on, which hgvsc, hgvsp, lof, lof_filter, and lof_flags also describe; not necessarily the gene's MANE Select or canonical transcript — it can be a minor isoform, so read it beside primary_transcript. Null when none.",
      ),
    hgvsc: z
      .string()
      .nullable()
      .describe('HGVS coding or transcript notation (e.g. c.406G>T); null when none.'),
    hgvsp: z
      .string()
      .nullable()
      .describe(
        'HGVS protein notation (e.g. p.Glu136Ter); null when gnomAD gives none, as for a UTR or intronic change.',
      ),
    lof: z
      .string()
      .nullable()
      .describe(
        "LOFTEE's loss-of-function call — HC high-confidence, LC low-confidence, or OS other splice; null when it made none.",
      ),
    lof_filter: z
      .string()
      .nullable()
      .describe(
        'The LOFTEE filter that made that call low-confidence (e.g. END_TRUNC); null when none.',
      ),
    lof_flags: z
      .string()
      .nullable()
      .describe(
        "LOFTEE's flags on that call, as gnomAD writes them (e.g. PHYLOCSF_WEAK); null when none.",
      ),
    primary_transcript: PrimaryTranscript.nullable().describe(
      "The consequence on the gene's primary transcript: its MANE Select entry, else its canonical entry. Null when the variant has no transcript consequence or lies outside both transcripts (e.g. on CDKN2A's p14ARF exon 1β, which only minor isoforms carry).",
    ),
    gene_symbol: z
      .string()
      .nullable()
      .describe('Gene symbol for the reported consequence; null when none.'),
    lof_curations: z
      .array(LofCuration)
      .describe(
        "gnomAD's manual loss-of-function curations of this variant, which can overturn a LOFTEE call; empty when gnomAD has none.",
      ),
    in_silico: z.array(InSilico).describe('In-silico predictor scores present for this variant.'),
    clinvar: ClinVar.nullable().describe('Null when the variant has no ClinVar entry.'),
    clinvar_unavailable: z
      .boolean()
      .describe(
        'True when the ClinVar lookup failed or ran out of time, so clinvar is null for want of an answer.',
      ),
  })
  .describe('Full population record for one variant.');

/**
 * Every reason a failed[] item can carry: the tool's own per-item rejections
 * (malformed, absent, absent with a liftover hint) and each reason
 * GnomadService.getVariant throws. Each is declared in the tool's errors[],
 * whose recovery hint the item carries.
 */
const FailureReason = z
  .enum([
    'invalid_variant_id',
    'variant_not_found',
    'variant_not_found_other_build',
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
      .describe(
        "Variant IDs to retry with: an ambiguous rsID's chrom-pos-ref-alt IDs, or the IDs a variant_not_found_other_build string lifts over to.",
      ),
  })
  .describe('One failed input ID, why it failed, and what to do next.');

/**
 * Per-item batch outcome — a resolved record or a typed failure. Each input ID
 * maps to one of these, so one bad ID can't fail the batch. A variant_not_found
 * failure keeps the canonical ID it sent as `absentId`, which the liftover pass
 * looks up once the batch settles. Bucketed in input order.
 */
type VariantLookupOutcome =
  | { ok: true; record: z.infer<typeof VariantRecordSchema> }
  | { ok: false; failure: z.infer<typeof FailedItem>; absentId?: string };

export const gnomadGetVariant = tool('gnomad_get_variant', {
  title: 'gnomad-genetics-mcp-server: get variant',
  description: `Fetch the full gnomAD population record for one or more variants: allele count, number, and frequency overall and per genetic-ancestry group, homozygote and hemizygote counts, the filtering allele frequency (faf95) — the value to test against a disease threshold such as ACMG/AMP BA1 or BS1, which raw AF is not — quality flags, each callset's own counts and QC filters, the most severe consequence with its HGVS and LOFTEE call beside the same on the gene's MANE Select (else canonical) transcript, gnomAD's manual LoF curations, in-silico scores, and joined ClinVar significance. On gnomad_r4 the overall counts and joint_populations read gnomAD's joint exome + genome data; every other dataset, gnomad_r4_non_ukb and the other subsets included, publishes no joint data, so its overall counts sum the callsets carrying the variant, a QC-failed one included, and joint_populations is empty. qc_status follows gnomAD's browser: pass when at least one callset carrying the variant passed QC, filtered when none did — the browser hides these by default — so treat a filtered variant's counts as low-confidence rather than an observed frequency. Accepts up to ${MAX_VARIANT_BATCH} IDs with partial success: every declared reason except incoherent_build is reported per item in failed[], with its recovery hint, without failing the other IDs. A coordinate ID carries no build: an absent one whose string also lifts over from the other build fails as variant_not_found_other_build, with the lifted IDs in candidates, while a string valid on both builds can name a different variant on each, which no not-found path can see — so keep IDs on the dataset's build. variant_not_found means the variant is not in the chosen dataset — pair with gnomad_get_coverage to confirm the position is callable before concluding true absence.\nData source: gnomAD (Broad Institute) — https://gnomad.broadinstitute.org/`,
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    variants: z
      .array(batchVariantIdField)
      .min(1)
      .max(MAX_VARIANT_BATCH)
      .describe(`1–${MAX_VARIANT_BATCH} variant IDs to look up.`),
    dataset: datasetField,
    reference_genome: referenceGenomeField,
  }),
  output: z.object({
    found: z.array(VariantRecordSchema).describe('Variants resolved to a population record.'),
    failed: z.array(FailedItem).describe('Per-item failures, in input order.'),
    dataset: z.string().describe('Effective gnomAD dataset used for the batch.'),
    reference_genome: z.string().describe('Effective reference build used for the batch.'),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        "Set when ClinVar annotation was unavailable for a record, and on a subset whose records' faf95 is null, naming the parent release to read it from.",
      ),
  },
  enrichmentTrailer: { notice: { render: escapeMarkdownInline } },
  errors: [
    {
      reason: 'incoherent_build',
      code: JsonRpcErrorCode.ValidationError,
      when: 'reference_genome was supplied but does not match the dataset.',
      recovery:
        'Omit reference_genome to let it derive, or pass the build matching the dataset (gnomad_r4, gnomad_r3, and their subsets are GRCh38; gnomad_r2_1, its subsets, and exac are GRCh37).',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_variant_id',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A variant ID is outside the chrom-pos-ref-alt or rsID grammar.',
      recovery:
        'Use chrom-pos-ref-alt with chromosome 1–22, X, or Y (optional chr prefix); a positive position; A/C/G/T alleles; or an rsID.',
    },
    {
      reason: 'variant_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'A well-formed ID is absent from the dataset with no liftover candidate: rsIDs are never lifted, and a liftover lookup that fails or runs out of time leaves this reason.',
      recovery:
        "A coordinate ID carries no build, so confirm it is on the dataset's reference build, then run gnomad_get_coverage to check the position is callable before concluding true absence.",
    },
    {
      reason: 'variant_not_found_other_build',
      code: JsonRpcErrorCode.NotFound,
      when: 'A coordinate ID is absent from the dataset and, read as an ID on the other build, lifts over to the IDs in candidates.',
      recovery:
        'This ID is absent from the dataset, and the same string also resolves on the other reference build. If the ID was written for that build, retry with a candidate. If it was not, treat it as absent and run gnomad_get_coverage to check the position is callable.',
    },
    {
      reason: 'mitochondrial_unsupported',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A variant ID names the mitochondrial chromosome (M, MT, or chrM).',
      recovery:
        'Mitochondrial variants are outside this server; look them up in the gnomAD browser at https://gnomad.broadinstitute.org/. IDs on chromosomes 1–22, X, and Y are served.',
      thrownBy: 'service',
    },
    {
      reason: 'ambiguous_rsid',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An rsID maps to more than one variant in the dataset.',
      recovery:
        'Retry with one of the chrom-pos-ref-alt IDs in candidates, or resolve the rsID to a single variant ID with dbSNP or Ensembl.',
      thrownBy: 'service',
    },
    {
      reason: 'graphql_error',
      code: JsonRpcErrorCode.ValidationError,
      when: 'gnomAD rejected the lookup for one ID with a GraphQL error.',
      recovery:
        'Check the ID against the dataset before retrying: gnomAD rejected this lookup as sent, so the same request fails again.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_build_mismatch',
      code: JsonRpcErrorCode.ValidationError,
      when: 'gnomAD answered one ID with a variant on a different reference build.',
      recovery:
        'Treat this ID as unavailable in this dataset: retry it later, or look it up in another dataset on the same build.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'gnomAD stayed unavailable or throttled through every retry for one ID.',
      recovery:
        'Wait a few seconds, then retry only the failed IDs. gnomAD is a community-funded API — keep batches small and request volume low.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'gnomAD attempts timed out, or the shared 45 s batch budget expired, for one ID.',
      recovery:
        'Wait a few seconds, then retry only the failed IDs, in smaller batches when several timed out.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_access',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'gnomAD refused the request for one ID (access denied).',
      recovery:
        'Do not retry: gnomAD is refusing requests from this server. Tell the user the lookup is blocked upstream and point them to https://gnomad.broadinstitute.org/.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_upstream_response',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'gnomAD kept answering one ID with a response that failed validation.',
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
    ): z.infer<typeof FailedItem> => ({
      variant,
      error,
      reason,
      recovery: ctx.recoveryFor(reason).recovery.hint,
      ...(candidates?.length ? { candidates } : {}),
    });

    // Dispatch every ID concurrently; GnomadService's maxConcurrency semaphore
    // (GNOMAD_MAX_CONCURRENCY, default 2) — acquired per upstream GraphQL call —
    // bounds the actual fan-out, so this stays polite without a serial loop.
    // Promise.all preserves input order in its result array regardless of
    // resolution order, so bucketing the settled outcomes below keeps
    // found[]/failed[] deterministic. A failure carrying a declared reason
    // becomes that ID's outcome, preserving per-item partial success — one bad
    // ID never fails the batch. A cancelled call, or a failure no declared
    // reason covers, is not about one ID and fails the whole call. One start
    // time for the batch gives every upstream request the same
    // deadline, however long the item queued behind the concurrency cap.
    const startedAt = Date.now();
    const outcomes = await Promise.all(
      input.variants.map(async (variantId): Promise<VariantLookupOutcome> => {
        const normalized = normalizeVariantIdentifier(variantId);
        if (!normalized) {
          return {
            ok: false,
            failure: failure(
              variantId,
              'invalid_variant_id',
              'Malformed ID. Expected chrom-pos-ref-alt (e.g. 1-55051215-G-GA) with ACGT alleles, or an rsID (e.g. rs11591147).',
            ),
          };
        }
        try {
          const record = await svc.getVariant(normalized.canonical, dsCtx, ctx, { startedAt });
          if (record) return { ok: true, record };
          return {
            ok: false,
            failure: failure(variantId, 'variant_not_found', `Not found in ${dsCtx.dataset}.`),
            absentId: normalized.canonical,
          };
        } catch (err) {
          if (ctx.signal.aborted || !(err instanceof McpError)) throw err;
          const reason = FailureReason.safeParse(err.data?.reason);
          if (!reason.success) throw err;
          const candidates = err.data?.candidates;
          return {
            ok: false,
            failure: failure(
              variantId,
              reason.data,
              err.message,
              Array.isArray(candidates) ? candidates : undefined,
            ),
          };
        }
      }),
    );

    // An absent ID's string may also name a variant on the other build.
    // Best-effort liftover requests (one per 25 absent IDs), under the batch's
    // deadline, turn each that lifts into variant_not_found_other_build; the
    // service skips rsIDs, so a batch with no absent coordinate ID sends none.
    const absentIds = outcomes.flatMap((outcome) =>
      !outcome.ok && outcome.absentId ? [outcome.absentId] : [],
    );
    const lifted = absentIds.length
      ? await svc.liftoverCandidates(absentIds, dsCtx, ctx, { startedAt })
      : new Map<string, string[]>();

    const found: z.infer<typeof VariantRecordSchema>[] = [];
    const failed: z.infer<typeof FailedItem>[] = [];
    for (const outcome of outcomes) {
      if (outcome.ok) {
        found.push(outcome.record);
        continue;
      }
      const candidates = outcome.absentId ? lifted.get(outcome.absentId) : undefined;
      failed.push(
        candidates
          ? failure(
              outcome.failure.variant,
              'variant_not_found_other_build',
              `Not found in ${dsCtx.dataset}. Read as an ID on the other reference build, the same string lifts over to the ${dsCtx.reference_genome} ${candidates.length === 1 ? 'ID' : 'IDs'} in candidates.`,
              candidates,
            )
          : outcome.failure,
      );
    }

    ctx.log.info('gnomad_get_variant resolved', {
      dataset: dsCtx.dataset,
      requested: input.variants.length,
      found: found.length,
      failed: failed.length,
    });

    // ctx.enrich.notice is last-wins, so every part is collected and written once.
    const notices: string[] = [];
    const fafParent = recordFafParent(dsCtx);
    if (fafParent && found.length) {
      notices.push(
        `faf95 is null on ${dsCtx.dataset} records: gnomAD's variant record for a ${fafParent} subset carries ${fafParent}'s filtering allele frequency, not the subset's. Look the variant up on ${fafParent} for that release's faf95${fafParent === 'gnomad_r4' ? `, or list it with gnomad_list_gene_variants on ${dsCtx.dataset}, whose faf95_max is the subset's own` : ''}.`,
      );
    }
    const unavailable = found.filter((record) => record.clinvar_unavailable);
    if (unavailable.length) {
      notices.push(
        `ClinVar annotation was unavailable for: ${unavailable.map((record) => record.variant_id).join(', ')}. Population data is complete.`,
      );
    }
    if (notices.length) ctx.enrich.notice(notices.join(' '));
    return { found, failed, dataset: dsCtx.dataset, reference_genome: dsCtx.reference_genome };
  },

  format: (result) => {
    const af = (v: number | null) => (v != null ? `${v} (${v.toExponential(3)})` : 'Not available');
    const group = (label: string, p: Omit<z.infer<typeof JointPopulationFreq>, 'id'>) =>
      `- ${label}: AC ${p.ac} / AN ${p.an} | AF ${af(p.af)} | hom ${p.homozygote_count}${p.hemizygote_count != null ? ` | hemi ${p.hemizygote_count}` : ''}`;
    const qcFilters = (filters: string[] | null) =>
      filters == null
        ? 'not reported'
        : filters.length
          ? filters.map(escapeMarkdownInline).join(', ')
          : 'none (passed)';
    // A transcript's HGVS and LOFTEE fields in field order, a null one as none.
    const transcriptCalls = (
      t: Pick<
        z.infer<typeof PrimaryTranscript>,
        'hgvsc' | 'hgvsp' | 'lof' | 'lof_filter' | 'lof_flags'
      >,
    ) =>
      `HGVSc ${escapeMarkdownInline(t.hgvsc ?? 'none')} | HGVSp ${escapeMarkdownInline(t.hgvsp ?? 'none')} | LoF ${escapeMarkdownInline(t.lof ?? 'none')} | LoF filter ${escapeMarkdownInline(t.lof_filter ?? 'none')} | LoF flags ${escapeMarkdownInline(t.lof_flags ?? 'none')}`;
    const lines: string[] = [`**Dataset:** ${result.dataset} (${result.reference_genome})`];
    for (const v of result.found) {
      lines.push(
        '',
        `**Variant:** ${escapeMarkdownInline(v.variant_id)}${v.rsids.length ? ` (${v.rsids.map(escapeMarkdownInline).join(', ')})` : ''}`,
      );
      lines.push(`**Dataset:** ${v.dataset} | **Build:** ${v.reference_genome}`);
      lines.push(
        `**Gene:** ${escapeMarkdownInline(v.gene_symbol ?? 'Not available')} | **Consequence:** ${escapeMarkdownInline(v.consequence ?? 'Not available')}`,
      );
      lines.push(
        `**Overall:** AC ${v.ac} / AN ${v.an} | AF ${af(v.af)} | hom ${v.homozygote_count}${v.hemizygote_count != null ? ` | hemi ${v.hemizygote_count}` : ''}`,
        `**FAF95 (filtering AF):** ${v.faf95 ? `${af(v.faf95.value)} | group ${escapeMarkdownInline(v.faf95.group ?? 'not reported')} | source ${v.faf95.source}` : 'Not available'}`,
      );
      lines.push(
        `**Callsets:** ${v.source.join(', ') || 'none'} | **Flags:** ${v.flags.length ? v.flags.map(escapeMarkdownInline).join(', ') : 'none'} | **Transcript:** ${escapeMarkdownInline(v.transcript_id ?? 'Not available')}`,
      );
      if (v.transcript_id != null) {
        lines.push(
          `**Consequence transcript:** ${escapeMarkdownInline(v.transcript_id)} | ${transcriptCalls(v)}`,
        );
      }
      const primary = v.primary_transcript;
      lines.push(
        primary
          ? `**Primary transcript:** ${escapeMarkdownInline(primary.transcript_id)} | MANE Select ${primary.is_mane_select == null ? 'not reported' : primary.is_mane_select ? 'yes' : 'no'} | consequence ${escapeMarkdownInline(primary.consequence ?? 'none')} | ${transcriptCalls(primary)}`
          : v.transcript_id == null
            ? '**Primary transcript:** Not available'
            : `**Primary transcript:** none — gnomAD lists no consequence on ${v.gene_symbol ? `${escapeMarkdownInline(v.gene_symbol)}'s` : "the gene's"} MANE Select or canonical transcript`,
      );
      if (v.lof_curations.length) {
        lines.push('**LoF curations:**');
        for (const c of v.lof_curations) {
          lines.push(
            `- ${escapeMarkdownInline(c.gene_symbol ?? 'no symbol')} (${escapeMarkdownInline(c.gene_id)}): ${escapeMarkdownInline(c.verdict)} | project ${escapeMarkdownInline(c.project)} | flags ${c.flags.length ? c.flags.map(escapeMarkdownInline).join(', ') : 'none'}`,
          );
        }
      }
      lines.push(`**QC status:** ${v.qc_status}`);
      for (const name of ['exome', 'genome'] as const) {
        const callset = v.callsets[name];
        if (callset) {
          const faf = callset.faf95
            ? ` | FAF95 ${callset.faf95.value}${callset.faf95.group != null ? ` (${escapeMarkdownInline(callset.faf95.group)})` : ''}`
            : '';
          lines.push(`${group(name, callset)} | filters ${qcFilters(callset.filters)}${faf}`);
        }
      }
      if (v.populations.length) {
        lines.push('**Per-ancestry:**');
        for (const p of v.populations) {
          lines.push(group(`${escapeMarkdownInline(p.id)} (${p.source})`, p));
        }
      }
      if (v.joint_populations.length) {
        lines.push('**Joint per-ancestry (exomes + genomes):**');
        for (const p of v.joint_populations) lines.push(group(escapeMarkdownInline(p.id), p));
      }
      if (v.in_silico.length) {
        lines.push(
          `**In-silico:** ${v.in_silico.map((s) => `${escapeMarkdownInline(s.id)}=${s.value ?? 'n/a'}${s.annotation != null ? ` (${escapeMarkdownInline(s.annotation)})` : ''}`).join(', ')}`,
        );
      }
      if (v.clinvar) {
        lines.push(
          `**ClinVar:** ${escapeMarkdownInline(v.clinvar.clinical_significance ?? 'Not available')} | stars ${v.clinvar.gold_stars ?? 'Not available'} | review ${escapeMarkdownInline(v.clinvar.review_status ?? 'Not available')} | VariationID ${escapeMarkdownInline(v.clinvar.clinvar_variation_id ?? 'Not available')}`,
        );
      } else {
        lines.push(
          v.clinvar_unavailable
            ? '**ClinVar:** unavailable (lookup failed or timed out)'
            : '**ClinVar:** no entry',
        );
      }
    }
    if (result.failed.length) {
      lines.push('', '### Failed');
      for (const f of result.failed) {
        lines.push(
          `- **${escapeMarkdownInline(f.variant)}:** ${escapeMarkdownInline(f.error)}${f.candidates?.length ? ` Candidates: ${f.candidates.map(escapeMarkdownInline).join(', ')}` : ''} (reason ${f.reason})`,
          `  - Recovery: ${escapeMarkdownInline(f.recovery)}`,
        );
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
