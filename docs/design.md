# gnomad-genetics-mcp-server — Design

Human population genetics over [gnomAD](https://gnomad.broadinstitute.org) (the Genome Aggregation Database, Broad Institute). Answers the two questions clinical and rare-disease variant interpretation gates on: **how common is this variant** (population allele frequency, broken down by genetic-ancestry group) and **how tolerant is this gene to being broken** (loss-of-function constraint — pLI / LOEUF). Backed by one keyless GraphQL endpoint; ClinVar clinical significance rides along inside gnomAD's own variant response. Complements `ensembl-mcp-server` (which annotates *what* a variant does) by supplying the frequency and constraint context that turns "this variant exists" into "this variant is plausibly causal."

---

## MCP Surface

### Tools

| Tool | Summary | readOnlyHint | openWorldHint | Key inputs | Output shape |
|---|---|---|---|---|---|
| `gnomad_get_variant` | Full population record for one or more variants — AC/AN/AF overall and per ancestry group, homozygote/hemizygote counts, quality flags, per-callset counts and QC filters with a `qc_status`, the most severe transcript consequence beside the consequence on the gene's MANE Select (else canonical) transcript (`primary_transcript`), in-silico predictors, and joined ClinVar significance. The "how common / is it benign" answer in one call. Per-id batch (up to 25 IDs) with partial success. | `true` | `true` | `variants[]` (1–25 items; each a `chrom-pos-ref-alt` variantId on chromosomes 1–22/X/Y with optional `chr` prefix and positive position (M/MT fail per item as `mitochondrial_unsupported`), or an rsID; coordinate IDs normalize to upper-case unprefixed form, a colon-separated ID to its dashed form, and an rsID to lower case, under `GNOMAD_NORMALIZE_IDS`), `dataset`, `reference_genome` | `{ found[], failed[], dataset, reference_genome }` (each `failed[]` item `{ variant, error, reason, recovery, candidates? }` — `reason` from the tool's declared set, `recovery` its declared hint) |
| `gnomad_get_gene_constraint` | Loss-of-function constraint for a gene — pLI, LOEUF (`oe_lof_upper`) with CI, missense/synonymous/LoF Z-scores, observed/expected ratios, labeled with the constraint release they come from. The metric that weights a candidate LoF variant. By gene symbol or Ensembl gene ID. | `true` | `true` | `gene` (HGNC symbol e.g. `PCSK9`, or Ensembl gene ID `ENSG…` — obtain from `ensembl_lookup_gene`), `dataset`, `reference_genome` | `{ gene_id, symbol, dataset, reference_genome, constraint_release, pli, oe_lof, oe_lof_lower, oe_lof_upper, oe_mis, oe_syn, lof_z, mis_z, syn_z, obs/exp_*, constraint_flags[] }` (flat — constraint fields are top-level, not nested; on `exac` the ratios, LOEUF, and flags are always null/empty) |
| `gnomad_list_gene_variants` | All variants in a gene / transcript / region with allele frequencies, predicted consequences with the transcript each is on (marked, on a gene target, against the gene's MANE Select or canonical transcript), and per-callset QC filters with a `qc_status`. Filter by gnomAD's consequence category and frequency threshold; `qc_filtered` counts every matching row that failed QC, and `pass_only` drops those rows after the count and, where a row has no joint data, reads its counts from the callsets that passed QC. Returns one `offset`/`limit` page of the matching rows, re-fetching the target per page; at offset 0 a set too large to inline also spills to a DataCanvas table for SQL (rank by AF, count by consequence), returning `canvas_id` + `table_name` for `gnomad_dataframe_describe`, then `gnomad_dataframe_query`. | `true` | `true` | one of `gene` / `transcript_id` / `region` (blank `gene` / `transcript_id` = omitted); `consequence_class?` (`'lof' \| 'missense' \| 'synonymous' \| 'other'`), `max_af?` (0–1, float), `pass_only?` (boolean; absent lists every match), `offset` (default 0), `limit` (default 25; clamped to 3,000), `canvas_id?`, `dataset`, `reference_genome` | `{ target, target_kind, filters, preview[], canvas_id, table_name, spilled, total, truncated, next_offset, qc_filtered, dataset, reference_genome }` |
| `gnomad_get_coverage` | Sequencing coverage across a gene / transcript / region — mean & median depth and the mean fraction of samples over depth thresholds (1/5/10/15/20/25/30/50/100×), aggregated per callset track. Disambiguates a true absent variant from an uncallable position before concluding "not seen in gnomAD." | `true` | `true` | one of `gene` / `transcript_id` / `region` (blank `gene` / `transcript_id` = omitted); `dataset`, `reference_genome`, `coverage_source?` (`'exome' \| 'genome'`; omit to return every available track) | `{ target, target_kind, summaries[] (per-track positions, target_positions, missing_positions, bucket_count, bucket_size, depth + fraction-over thresholds), dataset, reference_genome }` + optional notice |
| `gnomad_dataframe_query` | Run a read-only SQL `SELECT` against a canvas table staged by `gnomad_list_gene_variants` or `gnomad_search_clinvar` (rank by AF, group by consequence, count LoF). Use the `canvas_id` and `table_name` returned by those tools. Returns one page of the result: up to `limit` rows, ending before a row that would take the page's row JSON past 4,000,000 characters (a first row over that fails with `row_too_large`). BIGINT values arrive as JSON strings. Each page re-runs the SQL, so stable paging needs an `ORDER BY` over a unique key; `total` is `null` above the canvas row cap, which paging cannot pass. Registered only while the canvas is on. | `true` | `false` | `canvas_id` (from a prior `gnomad_list_gene_variants` or `gnomad_search_clinvar` call), `sql` (SELECT only), `offset` (default 0), `limit` (default 25; clamped to 3,000) | `{ rows[], columns[], offset, returned, total, truncated, next_offset }` + optional `notice` on a clamp |
| `gnomad_dataframe_describe` | List the tables staged on a canvas and their columns (name + type) before writing SQL. Use the `canvas_id` from a `gnomad_list_gene_variants` or `gnomad_search_clinvar` call to see what's queryable. Lists tables only. Registered only while the canvas is on. | `true` | `false` | `canvas_id` (from a prior spill call) | `{ tables[] }` (each `{ name, row_count, columns[] }`) |
| `gnomad_dataframe_drop` | *(opt-in; off by default)* Drop a named table from a canvas to reclaim memory. Callable only when `GNOMAD_DATAFRAME_DROP_ENABLED=true` and the canvas is on; otherwise wrapped in `disabledTool()` — absent from `tools/list`, listed as disabled on the HTTP landing page. | `false` | `false` | `canvas_id`, `table_name` (table to drop) | `{ dropped }` (boolean) |
| `gnomad_search_clinvar` | *(optional second source)* Gene-level ClinVar detail beyond what gnomAD joins per variant — pathogenic / likely-pathogenic variant lists, review status (star rating), submission counts — via NCBI E-utilities. Turns variant-level significance into a gene-panel curation view. Pages the ClinVar match list in windows of `limit` records (default 10, cap 1,500); each row carries gnomAD-compatible identifiers (`canonical_spdi`, `rsids`, `grch38_variant_id`) for `gnomad_get_variant`. With the canvas on, spills a window too large to inline to canvas and returns `canvas_id` + `table_name` for `gnomad_dataframe_describe`, then `gnomad_dataframe_query`; with it off, the whole window is inline. | `true` | `true` | `gene` (HGNC symbol), `clinical_significance?` (blank = no filter; seven terms map to ClinVar classification properties), `min_review_stars?` (0–4 integer), `offset` (default 0), `limit` (default 10; above 1,500 clamps to 1,500 with a notice, or fails under `GNOMAD_CLAMP_LIMITS=false`; counts fetched records, so only an unmapped significance term leaves a window short), `canvas_id?` | `{ gene, filters: { clinical_significance, min_review_stars }, preview[], canvas_id, table_name, spilled, total, total_found, truncated, next_offset, unavailable_ids[] }` |

> **Naming note.** Repo is `gnomad-genetics-mcp-server`; the tool prefix is the short `gnomad_` (intentional — the longer name disambiguates the repo in a server list; the prefix stays terse for every tool call). Display identity (`createApp` `name`/`title`, manifest `display_name`, docs headers) is the full hyphenated `gnomad-genetics-mcp-server` everywhere — never a Title-Cased "Pretty Name".

> **Three canvas-accessor tools — the fleet-standard DataCanvas set.** `gnomad_list_gene_variants` and `gnomad_search_clinvar` are the only canvas emitters; each stages a result too large to inline (or any result, when the caller passes a `canvas_id`) under a known table name, and its notice names the table, then `gnomad_dataframe_describe`, then `gnomad_dataframe_query`. The accessor surface is the standardized trio: `gnomad_dataframe_query` (run SQL — mandatory once anything emits a `canvas_id`), `gnomad_dataframe_describe` (list staged tables + columns before querying), and `gnomad_dataframe_drop` (opt-in behind `GNOMAD_DATAFRAME_DROP_ENABLED=true`, conditionally registered and absent from `tools/list` when off). With `CANVAS_PROVIDER_TYPE=none` none of the three is registered: each is wrapped in `disabledTool()`, with the gate read at definition time by `isCanvasEnabled()` (an unset, blank, or unsubstituted-placeholder value reads as enabled, since `src/index.ts` defaults it to `duckdb` after imports). See Design Decisions for why describe ships even though the spill tools document their schemas.

### Resources

| URI template | Returns | Notes |
|---|---|---|
| `gnomad://variant/{dataset}/{variantId}` | Same population record as `gnomad_get_variant` for a single variant. | Convenience for clients that support injectable context; the tool is the reliable path. `dataset` segment (e.g. `gnomad_r4`) keeps the URI self-describing — a frequency without its dataset silently misleads. |
| `gnomad://gene/{dataset}/{gene}/constraint` | Same constraint record as `gnomad_get_gene_constraint`, `constraint_release` included. | `gene` = symbol or Ensembl ID. The `dataset` segment routes the constraint source exactly as the tool's `dataset` does. |

Resources are read-only single-entity lookups mirroring the two scalar tools. List tools (`gnomad_list_gene_variants`, coverage, ClinVar) are **not** exposed as resources — their results are analytical row sets, not stable single-URI documents.

### Prompts

| Name | Purpose | Args |
|---|---|---|
| `gnomad_variant_triage` | Guided rare-disease variant-triage workflow: resolve the variant → pull its population record → check gene constraint → confirm the position is well-covered before calling it "absent." Emits the tool chain a clinical analyst runs, in order. | `variant` (variantId or rsID), `gene?` (blank = omitted), `dataset?` (`gnomad_r4` / `gnomad_r3` / `gnomad_r2_1` / `exac`; blank = omitted, so emitted calls use the server default; anything else is rejected with `-32602`) |

One prompt in v1 — the variant-triage chain is the server's signature workflow and benefits from a structured template (the coverage step is the one analysts most often skip). Other interactions are direct tool calls and don't need prompts.

---

## Overview

gnomAD aggregates exome and genome sequencing across ~807K individuals (v4: 730,947 exomes + 76,215 genomes) into the human-genetics reference for population allele frequency and gene-level constraint. There is **no REST surface** — the only programmatic interface is a GraphQL endpoint at `https://gnomad.broadinstitute.org/api`. The service layer therefore owns a small set of parameterized GraphQL query documents (one per tool), requesting only the fields each tool returns and validating the typed response.

The core value is **population context for variant interpretation**. A candidate pathogenic variant must be rare — gnomAD says how rare, and crucially *in which ancestry*: a variant common in one genetic-ancestry group and absent in another is exactly the signal clinical interpretation needs, so the server returns the full per-ancestry allele-frequency vector rather than collapsing to a single global AF. Gene constraint (pLI / LOEUF) supplies the orthogonal axis: a loss-of-function variant matters far more in a gene that is intolerant to being broken. ClinVar clinical significance is joined per-variant inside gnomAD's own response, so the server is keyless and single-source for the entire core surface.

Primary agent workflows: (1) **frequency lookup** — "how common is `1-55051215-G-GA`, overall and by ancestry?" → `gnomad_get_variant`; (2) **constraint assessment** — "is PCSK9 LoF-intolerant?" → `gnomad_get_gene_constraint`; (3) **gene variant catalog** — "show me the rare LoF variants in BRCA2" → `gnomad_list_gene_variants` (spills to canvas) → `gnomad_dataframe_query` to rank/count; (4) **rare-disease triage** — variant absent from gnomAD? → pair `gnomad_get_variant` with `gnomad_get_coverage` to prove the position is callable before concluding absence is real. The server composes with `ensembl-mcp-server` (variant consequence / VEP + gene coordinates — **shared reference build**), `clinicaltrials-mcp-server`, `openfda-mcp-server` / `pubmed-mcp-server`, and a protein server for the gene product.

## Requirements

**Functional**

- Fetch the full population record for a variant by `chrom-pos-ref-alt` variantId or rsID — AC/AN/AF overall and for every genetic-ancestry group, homozygote and (for hemizygous regions) hemizygote counts, quality flags, each callset's own counts and QC filters with a `qc_status`, the most severe transcript consequence beside the one on the gene's MANE Select (else canonical) transcript, in-silico predictor scores, and joined ClinVar clinical significance.
- Accept a **batch** of variant IDs in one `gnomad_get_variant` call with per-item partial success (one bad ID does not fail the call).
- Fetch gene loss-of-function constraint by gene symbol or Ensembl gene ID: pLI, LOEUF (`oe_lof_upper`) + its lower bound, observed/expected for LoF/missense/synonymous, and the three Z-scores.
- List all variants in a gene, transcript, or region with AF + predicted consequence, filterable by consequence class and a max-AF threshold; spill a set too large to inline to a DataCanvas table and expose SQL over it.
- Report sequencing coverage (mean/median depth, fraction-of-samples-over-threshold) for a gene / transcript / region, separable by exome vs. genome coverage track.
- *(optional)* Gene-level ClinVar detail via NCBI E-utilities for curation depth beyond the per-variant join.
- Echo the **effective `dataset` and `reference_genome`** in every tool's output.

**Non-functional / constraints**

- **Dataset and reference build are two distinct GraphQL arguments**, not one. `dataset` is a `DatasetId` enum (`gnomad_r4` default, also `gnomad_r3`, `gnomad_r2_1`, `exac`, …); `reference_genome` is a `ReferenceGenomeId` enum (`GRCh38` default for v4, `GRCh37` for v2). They must be coherent (v4 ⇒ GRCh38, v2 ⇒ GRCh37) — the service derives a default `reference_genome` from `dataset` when the caller omits it, and validates the pair. Keep the build aligned with `ensembl-mcp-server` or the agent gets silent coordinate mismatches.
- **Keyless** for the entire core (gnomAD GraphQL needs no auth). `gnomad_search_clinvar` (NCBI E-utilities) is also keyless but honors an optional `NCBI_API_KEY` for a higher rate limit.
- **Polite client.** gnomAD's API is free, rate-limited, and community-funded. The service layer uses conservative concurrency, exponential backoff on 429/5xx, and a short per-request timeout. A hosted instance must not bulk-scrape — document this as the single hosting caveat. NCBI E-utilities cap at 3 req/s keyless (10 with a key).
- **Licensing / attribution.** gnomAD data is openly licensed; surface gnomAD (Broad Institute) as the source. ClinVar credit goes to NCBI.
- **Constraint names its release.** `gene.gnomad_constraint` takes no arguments — the build picks the table — so `dataset` alone does not say which release answered. The service routes by dataset and labels each result: `gnomad_r4` → GRCh38 `gnomad_constraint`, `gnomAD v4.1.2`; `gnomad_r3` → the same table (gnomAD publishes no v3 constraint), `gnomAD v4.1.2`; `gnomad_r2_1` → GRCh37 `gnomad_constraint`, `gnomAD v2.1.1`; `exac` → GRCh37 `exac_constraint`, `ExAC r0.3`. gnomAD's LoF-intolerance guidance differs by release — LOEUF < 0.45 on v4.1.2, < 0.35 on v2.1.1, pLI only for ExAC (which publishes no ratios, LOEUF, or flags) — and is stated in descriptions, not enforced.

**Out of scope (v1):** structural variants, mitochondrial variants, copy-number variants, the v4 short-tandem-repeat catalog, translating coordinates between builds (an absent coordinate ID's liftover is reported only as a hint; see Design Decisions), and any write/annotation-submission path. gnomAD is read-only reference data — there is nothing to mutate.

## Data Model

Identifiers and the shapes the tools surface. GraphQL field names below match the live schema (`gene.gnomad_constraint`, `variant.<dataset>.…`).

```ts
/** Reference build — a GraphQL ReferenceGenomeId enum. */
type ReferenceGenome = 'GRCh38' | 'GRCh37';

/** Dataset — a GraphQL DatasetId enum. Default 'gnomad_r4'. */
type Dataset = 'gnomad_r4' | 'gnomad_r3' | 'gnomad_r2_1' | 'exac';

/**
 * variantId — `chrom-pos-ref-alt`, 1-based, e.g. "1-55051215-G-GA".
 * chrom: 1-22 | X | Y, optional `chr` prefix. ref/alt: [ACGT]+. Validated by regex (see Zod).
 * M / MT parse but are refused as `mitochondrial_unsupported` before any fetch —
 * gnomAD serves mitochondrial variants through separate fields this server does not query.
 * Obtain one from ensembl_predict_variant / a VCF, or pass an rsID instead.
 * A colon-separated ID (chr1:55039974:G:T) reads as its dashed form before validation (GNOMAD_NORMALIZE_IDS).
 */
type VariantId = string;

/** rsID — dbSNP refSNP, "rs" + digits, e.g. "rs11591147". Lowercased before lookup (GNOMAD_NORMALIZE_IDS). */
type RsId = string;

/**
 * Gene reference — symbol (PCSK9) or Ensembl gene ID (ENSG00000169174). An Ensembl gene ID is
 * upper-cased and version-stripped (`/^(ENSG\d+)(?:\.\d+)?$/i`); a `_PAR_Y` form and any symbol are sent unchanged.
 */
type GeneRef = string;

/**
 * Region — `chrom-start-stop`, 1-based inclusive, e.g. "1-55039447-55064852".
 * Under GNOMAD_NORMALIZE_IDS a `chrom:start-stop` spelling (optional chr prefix, commas only as
 * thousands groups) is rewritten to this form by a z.preprocess on the region union before its
 * pattern runs; the advertised pattern is unchanged.
 * chrom: 1-22 | X | Y, optional `chr` prefix, sent to gnomAD in canonical form.
 * start ≥ 1, stop < 1,000,000,000, start ≤ stop (else `invalid_region`);
 * stop − start < 2,500,000 (else `region_too_large`); M / MT → `mitochondrial_unsupported`.
 * All checked before any fetch — gnomAD answers each with an HTTP 500.
 */
type Region = string;

/**
 * Genetic-ancestry group codes. The catch-all group is `remaining` on gnomad_r4 and
 * `oth` on gnomad_r3, gnomad_r2_1, and exac. ami (Amish) appears in v4 and v3 genomes only.
 */
type AncestryGroup = 'afr' | 'amr' | 'asj' | 'eas' | 'fin' | 'mid' | 'nfe' | 'sas' | 'remaining' | 'oth' | 'ami';

/** One genetic-ancestry group's counts. AF = AC / AN (null when AN == 0). */
interface PopulationFreq {
  id: AncestryGroup;        // afr | amr | asj | eas | fin | mid | nfe | sas | remaining (r4) | oth (r3, r2_1, exac) | ami (genomes only)
  ac: number;               // allele count
  an: number;               // allele number (called chromosomes)
  af: number | null;        // allele frequency
  homozygote_count: number;
  hemizygote_count: number | null; // 0 off X/Y; null when gnomAD reports none
}

/** The population record gnomad_get_variant returns per variant. */
interface VariantRecord {
  variant_id: VariantId;
  rsids: RsId[];
  reference_genome: ReferenceGenome;
  dataset: Dataset;
  // overall, then the full per-ancestry vector — never collapsed to a single global AF.
  // Overall counts read gnomAD's joint exome + genome record where it carries an AC
  // (gnomad_r4; its AN spans every callable sample in both callsets), else the sum
  // across carried callsets (r3, r2_1, exac publish no joint record). ac, an, af
  // (= ac / an), and the zygosity counts always share one source.
  ac: number; an: number; af: number | null;
  homozygote_count: number; hemizygote_count: number | null;
  populations: (PopulationFreq & { source: 'exome' | 'genome' })[];  // per carrying callset
  joint_populations: PopulationFreq[];  // the joint record's groups; [] without joint data
  // Each callset's own view; null when that callset does not carry the variant (absent
  // from source). filters is gnomAD's QC verdict for the callset: [] passed; vocabulary
  // varies by dataset (AC0, AS_VQSR, InbreedingCoeff on r4; RF on r2_1); null when
  // gnomAD returned no list, which proves no pass.
  callsets: Record<'exome' | 'genome', {
    ac: number; an: number; af: number | null;  // af = ac / an
    homozygote_count: number; hemizygote_count: number | null;
    filters: string[] | null;
  } | null>;
  source: ('exome' | 'genome')[];   // which gnomAD callset(s) carry it — not what an spans
  flags: string[];                  // quality flags, e.g. "lcr", "segdup", "lc_lof"
  qc_status: 'pass' | 'filtered';   // pass when any carried callset has empty filters (gnomAD browser rule)
  consequence: string | null;       // most severe VEP term across transcripts (transcript_consequences[0])
  transcript_id: string | null;     // transcript the consequence is on — possibly a non-primary isoform
  primary_transcript: {             // the consequence's gene's MANE Select entry, else its canonical entry;
    transcript_id: string;          //   null when gnomAD lists neither (the variant lies outside both). Same reply.
    is_mane_select: boolean | null; // canonical fallback: null where no MANE status (gene without one; GRCh37)
    consequence: string | null;     // most severe term on this transcript
    hgvsc: string | null; hgvsp: string | null;
    lof: string | null;             // LOFTEE call (e.g. HC, LC)
  } | null;
  // ids vary by dataset — r4: cadd, revel_max, spliceai_ds_max, pangolin_largest_ds, phylop,
  // sift_max, polyphen_max; r3: cadd, revel, splice_ai, primate_ai; r2_1 / exac: none.
  // gnomAD sends each value as a string; r3 writes SpliceAI as "0.00 (no_consequence)",
  // which splits into value 0 + annotation "no_consequence". value is never non-finite:
  // text with no number keeps value null and the raw text in annotation.
  in_silico: { id: string; value: number | null; annotation: string | null }[];
  clinvar: {                        // joined inside gnomAD's variant response — free, no NCBI call
    clinical_significance: string | null;  // e.g. "Pathogenic", "Likely benign"
    review_status: string | null;          // ClinVar review status text
    gold_stars: number | null;              // 0–4 star rating
    clinvar_variation_id: string | null;
  } | null;
  clinvar_unavailable: boolean;     // the ClinVar lookup failed (clinvar null for want of an answer)
}

/**
 * Gene constraint — gene.gnomad_constraint for the gnomAD datasets,
 * gene.exac_constraint for exac, which carries no ratios, LOEUF, or flags
 * (those stay null / empty there).
 */
interface GeneConstraint {
  constraint_release: 'gnomAD v4.1.2' | 'gnomAD v2.1.1' | 'ExAC r0.3'; // fixed per dataset; the API names no release
  pli: number | null;          // pLI — P(LoF intolerant); >0.9 intolerant
  oe_lof: number | null;       // observed/expected LoF ratio
  oe_lof_lower: number | null; // LOEUF CI lower bound
  oe_lof_upper: number | null; // LOEUF (the headline metric); gnomAD: < 0.45 on v4.1.2, < 0.35 on v2.1.1
  oe_mis: number | null; oe_syn: number | null;
  lof_z: number | null; mis_z: number | null; syn_z: number | null;
  obs_lof: number | null; exp_lof: number | null;
  obs_mis: number | null; exp_mis: number | null;
  obs_syn: number | null; exp_syn: number | null;
  constraint_flags: string[];  // gnomAD's per-gene caveats (e.g. no_exp_lof, syn_outlier); [] on exac
}

/** One row of the gnomad_list_gene_variants canvas table, columns in this order. */
interface GeneVariantRow {
  variant_id: VariantId;
  af: number | null; ac: number; an: number;  // one source, as VariantRecord's overall counts
  consequence: string | null;     // VEP term: most severe in the gene (gene target), the named
                                  // transcript's (transcript target), most severe across transcripts (region)
  // gnomAD's categories (browser vepConsequences.ts): lof = transcript_ablation, splice_acceptor_variant,
  // splice_donor_variant, stop_gained, frameshift_variant; missense = missense_variant, stop_lost,
  // start_lost, inframe_insertion, inframe_deletion; synonymous = synonymous_variant; other = the rest,
  // terms gnomAD lists in no category, and null.
  consequence_class: 'lof' | 'missense' | 'synonymous' | 'other';
  homozygote_count: number;
  source: string;                 // carried callsets, pipe-joined ("exome|genome")
  flags: string;                  // quality flags, pipe-joined ("" when none)
  exome_filters: string | null;   // exome QC filters, pipe-joined: "" passed, null when exomes do not carry it
  genome_filters: string | null;  // the same for genomes
  qc_status: 'pass' | 'filtered'; // as VariantRecord.qc_status
  transcript_id: string | null;   // transcript the consequence is on; null when none (intergenic)
  // gene targets only, gnomAD's gene-table † rule: transcript_id is the gene's MANE Select, else (no MANE
  // Select, as on GRCh37) its canonical transcript, else another; null on transcript / region targets
  // and for a gene with neither.
  consequence_transcript: 'mane_select' | 'canonical' | 'other' | null;
}

/**
 * gnomad_get_coverage — depth + callability, aggregated per callset track (the
 * as-built shape). gnomAD returns histogram buckets upstream, sized
 * max(floor(size / 500), 1) bp: size is stop − start + 150 for a region (so
 * spans under 850 bp keep 1 bp buckets) and the summed stop − start of the
 * merged exons ±75 bp for a gene or transcript. The histogram zero-fills every
 * bucket between its first and last record, introns included. The service
 * summarizes the buckets overlapping start..stop or the padded exons — a
 * zero bucket inside them counts, one outside never does — into one
 * CoverageSummary per track, so the tool returns summaries[], not buckets[].
 * Nothing is returned past a track's first or last record (the exome
 * capture's edges), so those target bases drop out of positions rather than
 * count as zero. target_positions and missing_positions disclose that gap;
 * missing bases have unknown callability. Supported empty/null tracks produce
 * notices, respecting coverage_source. v3 serves genome only and ExAC exome
 * only; an unsupported sibling is quiet unless explicitly requested.
 */
interface CoverageSummary {
  source: 'exome' | 'genome';
  positions: number;                 // target bases inside the summarized buckets
  target_positions: number;          // all bases in the merged target intervals
  missing_positions: number;         // target_positions − positions; callability unknown
  bucket_count: number;              // buckets summarized
  bucket_size: number;               // bucket width, bp
  mean_depth: number | null; median_depth: number | null; // across buckets
  fraction_over_1: number | null; fraction_over_5: number | null; fraction_over_10: number | null;
  fraction_over_15: number | null; fraction_over_20: number | null; fraction_over_25: number | null;
  fraction_over_30: number | null; fraction_over_50: number | null; fraction_over_100: number | null; // mean fraction 0–1
}
```

**Per-ancestry group set differs by callset and release.** v4 exomes: `afr amr asj eas fin mid nfe sas remaining`; v4 genomes add `ami` (Amish). v3 genomes carry `oth` in place of `remaining`, plus `ami`; v2.1 and ExAC carry `afr amr asj eas fin nfe oth sas` (ExAC without `asj`). gnomAD also returns sex splits (`afr_XX`), `XX`/`XY` aggregates, v2.1 subgroups (`eas_jpn`, `nfe_bgr`), and 1000 Genomes/HGDP subpopulations (`1kg:*`, `hgdp:*`); the service keeps exact matches to the `AncestryGroup` set, so each callset's groups sum to its AC and AN. `oth` keeps its upstream ID rather than being renamed to `remaining`: the releases compose the group differently, so the ID stays as gnomAD sends it.

**No server-side record identity.** Every tool is a read against upstream; there is no local mutable state to version. The only identity to track is the canvas `canvas_id` (opaque 10-char token from the framework) holding a spilled variant/ClinVar list.

## Services

| Service | Wraps / owns | Key methods | Used by |
|---|---|---|---|
| `gnomad` (`src/services/gnomad/gnomad-service.ts`) | The gnomAD GraphQL endpoint. Owns the parameterized query documents (one per tool), `reference_genome`-from-`dataset` derivation + pair validation, conservative concurrency, `withRetry` backoff (1–2 s base, tuned for a rate-limited upstream), and typed-response validation. | `getVariant(ids, dataset, refGenome)` → per-id results (batched where the schema allows, else concurrency-limited fan-out with partial success); `getGeneConstraint(gene, …)`; `listGeneVariants(target, filters, …)` → `GeneVariantRow[]` (the filtered rows, materialized from one GraphQL response); `getCoverage(target, …)` | all core tools |
| `clinvar` (`src/services/clinvar/clinvar-service.ts`) — *optional source* | NCBI E-utilities (`esearch` → `esummary`). Honors `NCBI_API_KEY`, 3/10 req·s pacing, backoff. | `searchGene(gene, filters, ctx)` → one window: `{ rows, totalFound, truncated, nextOffset, unavailableIds }` (`filters` carries `offset`/`limit` → ESearch `retstart`/`retmax`) | `gnomad_search_clinvar` |
| canvas accessor (`src/services/canvas-accessor.ts`) | Module-level `getCanvas()` / `setCanvas()` over the framework's optional `DataCanvas` (wired in `createApp({ setup })`). Not a domain service — the access shim the canvas skill prescribes. | `getCanvas()`, `setCanvas(core.canvas)` | `gnomad_list_gene_variants`, `gnomad_search_clinvar`, `gnomad_dataframe_query`, `gnomad_dataframe_describe`, `gnomad_dataframe_drop` |

Each service follows the framework init/accessor pattern (`initGnomadService()` in `setup()`, `getGnomadService()` at request time). Handlers stay pure and throw; the service wraps the full fetch+parse pipeline in `withRetry` so a transient 429/5xx surfaces as `ServiceUnavailable`, not a parse error. Both upstreams answer a list request in one payload (gnomAD returns a gene's whole variant list in one GraphQL response; ClinVar returns one ESearch window of ESummary batches), so the services return materialized row arrays. The two row tools stage them through `stageRows()` (`src/mcp-server/tools/canvas-staging.ts`), which decides fit-vs-spill on the array before touching the canvas and hands the framework `spillover()` helper (or `registerTable()` for a fitting reuse) an explicit column schema declared from the row type.

## Config

`src/config/server-config.ts` — a lazy-parsed Zod schema, separate from framework config, via `parseEnvConfig` (so errors name the env var, not the schema path).

The first entrypoint dependency, `src/config/environment.ts`, loads cwd `.env` before definitions evaluate on Node or Bun; exported variables win. The variant cap, drop gate, and clamp switch read only their own normalized schema field without populating the full-config cache, and the canvas gate reads `CANVAS_PROVIDER_TYPE` alone. Invalid field values use their schema default solely while constructing definitions. Complete strict validation runs in `setup()` before a transport starts, through the framework's clean configuration-error boundary (`DEBUG=true` includes the stack).

| Env var | Config field | Required | Default | Purpose |
|---|---|---|---|---|
| `GNOMAD_API_BASE_URL` | `gnomadApiBaseUrl` | no | `https://gnomad.broadinstitute.org/api` | Override the GraphQL endpoint (testing / mirror). |
| `GNOMAD_DEFAULT_DATASET` | `defaultDataset` | no | `gnomad_r4` | Dataset used when a tool call omits `dataset`. |
| `GNOMAD_REQUEST_TIMEOUT_MS` | `requestTimeoutMs` | no | `30000` | Per-attempt gnomAD/NCBI timeout, bounded by the shared 45 s call deadline. |
| `GNOMAD_MAX_CONCURRENCY` | `maxConcurrency` | no | `2` | Cap on concurrent upstream requests — politeness against a community-funded API. |
| `GNOMAD_MAX_VARIANT_BATCH` | `maxVariantBatch` | no | `25` | Maximum variant IDs accepted per `gnomad_get_variant` call. Validated in Zod (`z.array(…).max(n)`); callers receiving `failed[]` entries with `reason: invalid_variant_id` should re-check those IDs, not retry the whole batch. |
| `CLINVAR_BASE_URL` | `clinvarBaseUrl` | no | `https://eutils.ncbi.nlm.nih.gov/entrez/eutils` | NCBI E-utilities base (optional ClinVar tool). |
| `NCBI_API_KEY` | `ncbiApiKey` | no | — | Optional NCBI key. Without it, `gnomad_search_clinvar` runs at the 3 req/s keyless cap; with it, 10 req/s. The rest of the server is unaffected. |
| `CANVAS_PROVIDER_TYPE` | (framework) | no | `duckdb` | Backs the DataCanvas spill behind `gnomad_list_gene_variants` / `gnomad_search_clinvar`; `src/index.ts` sets `duckdb` when the variable is unset or empty. `none` disables it: `gnomad_list_gene_variants` returns every row of its `offset`/`limit` page, and `gnomad_search_clinvar` every row of its window, with `spilled: false` and `canvas_id: ''`, and the three dataframe tools are not registered. The `.mcpb` bundle pins `none`. `@duckdb/node-api` is a direct dependency; not available on Cloudflare Workers. |
| `GNOMAD_DATAFRAME_DROP_ENABLED` | `dataframeDropEnabled` | no | `false` | Gate for the opt-in `gnomad_dataframe_drop` tool. Default off — the tool is wrapped in `disabledTool()` and absent from `tools/list` unless this is `true` and the canvas is on. Read with `z.stringbool()`. |
| `GNOMAD_CLAMP_LIMITS` | `clampLimits` | no | `true` | When true, a `limit` above its tool's cap is clamped to the cap with a notice; the schema advertises a default and a minimum but no maximum. `false` advertises the cap as `maximum` and rejects larger values. Read once as the tool definitions evaluate, with `z.stringbool()`, so an invalid value fails startup. |
| `GNOMAD_NORMALIZE_IDS` | `normalizeIds` | no | `true` | Rewrite one-reading identifier spellings before validation (see Implementation Order step 3). Read through `getServerConfig()` at parse/handle time, never at import; `z.stringbool()`, so an invalid value fails startup. `false` restores strict validation, and `tools/list` is identical either way. |

No required env vars — the server runs keyless out of the box, with the canvas on (`CANVAS_PROVIDER_TYPE=none` turns it off).

## Implementation Order

Each step is independently buildable and testable.

1. **Config + identity.** `server-config.ts` (schema above); set `createApp` `name`/`title` to `gnomad-genetics-mcp-server`; remove echo definitions; wire the canvas accessor in `setup()`.
2. **`gnomad` service.** GraphQL client + the four query documents (variant, gene constraint, gene/region variants, coverage), `dataset`→`reference_genome` derivation + pair validation, `withRetry`, typed-response Zod parse. Test against a sparse real payload (a variant absent in one ancestry, a gene with null constraint) — required-vs-optional fields must match upstream nullability.
3. **`gnomad_get_variant`** (batch + partial success) and **`gnomad_get_gene_constraint`** — the two scalar read tools. The `variants` array uses `.max(GNOMAD_MAX_VARIANT_BATCH)` and validates each item independently so malformed coordinates remain per-item failures. Coordinate IDs accept an optional `chr` prefix, only chromosomes 1–22/X/Y (M/MT parse, then fail per item as `mitochondrial_unsupported` with no fetch), a positive position, and non-empty ACGT alleles; accepted IDs normalize to upper-case unprefixed form before upstream lookup. rsIDs are lowercased before lookup (gnomAD rejects any other case), and colon-separated coordinate IDs read as their dashed form; both are gated by `GNOMAD_NORMALIZE_IDS`. Coordinate IDs still get no minimal representation or left-alignment. `gene` trims before `.min(2)` validation; `region` uses `.regex(/^(?:chr)?[0-9A-Z]+-\d+-\d+$/i)` for shape only, behind a `z.preprocess` that rewrites a `chrom:start-stop` spelling first, and the service region parser owns the chromosome set, coordinate bounds, and span limit.
4. **`gnomad_get_coverage`** — depth/callability over a target; exome/genome source switch.
5. **Canvas wiring + `gnomad_list_gene_variants` + the accessor trio** (`gnomad_dataframe_query`, `gnomad_dataframe_describe`, and the opt-in `gnomad_dataframe_drop`) — the spill emitter and its consumers ship together (a `canvas_id` with no query tool is dead output; describe and drop round out the fleet-standard set). Consequence-class + max-AF filters; spill via `spillover()`; page by offset/limit, inline-only when the canvas is disabled. Register the dataframe tools only while the canvas is on, and `gnomad_dataframe_drop` only when `GNOMAD_DATAFRAME_DROP_ENABLED=true` too.
6. **Resources** — `gnomad://variant/{dataset}/{variantId}` and `gnomad://gene/{dataset}/{gene}/constraint`, reusing the service methods.
7. **`gnomad_variant_triage` prompt** — the resolve→frequency→constraint→coverage chain.
8. *(optional)* **`clinvar` service + `gnomad_search_clinvar`** — gated, ships only if gene-level curation depth is wanted. Spills to canvas like the gene-variants tool.
9. **Polish** — descriptions/DX pass (`tool-defs-analysis`), `format()` parity, tests, `devcheck`.

## Workflow Analysis

**1. Rare-disease candidate triage — "is `1-55051215-G-GA` plausibly causal in PCSK9?"** (the signature chain; backs the `gnomad_variant_triage` prompt)

| # | Call | Purpose | Cross-tool hop |
|---|---|---|---|
| 1 | `gnomad_get_variant(variants: ["1-55051215-G-GA"], dataset: gnomad_r4)` | Population frequency + per-ancestry vector + ClinVar join. | — |
| 2 | `gnomad_get_gene_constraint(gene: "PCSK9")` | Is the gene LoF-intolerant? Weights a LoF variant. | gene symbol is caller-known or from `ensembl_lookup_gene`. |
| 3 | `gnomad_get_coverage(gene: "PCSK9")` | **Only if the variant came back absent/ultra-rare** — prove the position is callable before concluding "not in gnomAD." | — |

The dependency that matters: an absent result from step 1 is *uninterpretable* without step 3, and a `variant_not_found_other_build` result needs its build settled first — the prompt's step 3 opens with that check. The prompt makes the coverage step explicit because it is the one analysts skip.

**2. Gene LoF catalog — "show me the rare LoF variants in BRCA2, ranked by frequency."**

| # | Call | Purpose | Cross-tool hop |
|---|---|---|---|
| 1 | `gnomad_list_gene_variants(gene: "BRCA2", consequence_class: "lof", max_af: 0.001, pass_only: true)` | Stage every matching variant that passed QC on a canvas when the set is too large to inline (`qc_filtered` still counts the dropped QC-failed rows, which sort first at AF 0); return the first `limit` rows inline. | Returns `canvas_id` + `table_name` (`gene_variants`), and a notice naming both follow-up tools. |
| 2 | `gnomad_dataframe_describe(canvas_id)` | Confirm the staged table and its columns before writing SQL. | Takes step 1's `canvas_id`. |
| 3 | `gnomad_dataframe_query(canvas_id, sql: "SELECT variant_id, af, consequence FROM gene_variants ORDER BY af DESC, variant_id")` | Rank / count / group across the **full** set, not the preview. A page carries up to `limit` rows (default 25); follow `next_offset` for more, or add a SQL `LIMIT` when only the top rows matter. | **`canvas_id` and `table_name` come only from step 1's output** — the hop is explicit in both schemas. |

**3. Cross-server build-aligned interpretation** — `ensembl_predict_variant` (GRCh38) yields a `chrom-pos-ref-alt` and consequence → `gnomad_get_variant(…, reference_genome: GRCh38)` for frequency. The hop's correctness condition is **build alignment**: both calls on GRCh38, or the coordinates refer to different assemblies. The design surfaces `reference_genome` on every tool and echoes it in output so the mismatch is visible.

**4. Batch frequency screen** — `gnomad_get_variant(variants: [...up to N ids])` returns `found[]` + `failed[]`; the agent acts on the survivors and follows each failure's `recovery` hint — re-check a malformed ID, settle the build for a `variant_not_found_other_build` one, confirm coverage for an absent one, retry only the upstream failures. No second tool needed — partial success is in the one call.

## Design Decisions

- **`dataset` and `reference_genome` are separate parameters, both echoed in output.** The live GraphQL schema takes them as two distinct enums (`DatasetId`, `ReferenceGenomeId`); idea.md's single "dataset/build" axis would have under-modeled it. The service derives a default `reference_genome` from `dataset` and validates coherence (v4⇒GRCh38), but both are exposed — a frequency from the wrong build silently misleads, so the choice can't be buried in a default.
- **Per-ancestry vector is returned in full, never collapsed.** The whole point of gnomAD for clinical use is that a variant common in one genetic-ancestry group and absent in another is the signal. Each group ships its own AC/AN/AF; the handler returns every top-level group the queried callset carries from the fixed `AncestryGroup` set (exome vs. genome differ by `ami`; releases differ by `remaining` vs. `oth`), so the groups of one callset sum to its counts. The set is matched exactly, so sex splits, subgroups, and HGDP/1000 Genomes subpopulations never enter the vector — a group missing from the set would drop silently, which is why `oth` sits beside `remaining`.
- **Overall counts share one source, and that source is gnomAD's joint record where one exists.** `ac`, `an`, `af`, and the zygosity counts on both `gnomad_get_variant` and `gnomad_list_gene_variants` come from the same record, `af` is always `ac / an`, and `max_af` filters on that `af` — so a list row never pairs a summed count with a single-callset frequency. On `gnomad_r4` that record is `joint`, whose AN counts every callable sample in both callsets, as gnomAD's own browser does for its Total row; elsewhere it is the sum across carried callsets — under `pass_only`, across the carried callsets that passed QC, as gnomAD's browser table drops a failed callset before merging (`VariantList/filterVariants.ts`); a `joint` record is read whole either way. A row no callset passed keeps the full sum, so `qc_filtered`, counted before `pass_only` drops that row, matches the same rows with and without `pass_only`. `gnomad_get_variant` always reads the full sum and carries each callset's own counts in `callsets`. The list selects only the joint totals: `joint.populations` feeds no column and would multiply the response about 3.6× (PCSK9 on `gnomad_r4`, as of November 2026). `gnomad_get_variant` selects them and returns them as `joint_populations`, beside the per-callset `populations`.
- **QC status is reported, never applied by default.** Each callset's `filters` reaches the caller (`callsets.*.filters` on the record, `exome_filters` / `genome_filters` on list rows), and `qc_status` applies gnomAD's browser rule: `pass` when any callset carrying the variant has empty filters. Without it, AC0 rows (no high-quality carrier) read as observed variants at AF 0 and pass every `max_af` — 1,499 of PCSK9's 4,544 `gnomad_r4` rows fail QC, as of November 2026. Rows stay listed because hiding them is a browser display default, would turn a single-position `region` into a false absence, and drops filtered rows that still carry AC; `pass_only` opts into the browser's view after `qc_filtered` has counted them — its rows and its counts: a row without joint data then reads `ac`, `an`, `af`, and `homozygote_count` from its passing callsets only, and `max_af` filters on that `af` (PCSK9 on `gnomad_r2_1` at `max_af` 1e-5: 569 rows, not 575, as of November 2026). Filtering staged rows on `qc_status` keeps the summed counts. The rule reads only empty versus non-empty, since the filter vocabulary differs by dataset (`RF` on `gnomad_r2_1`, `VQSRTranche*` on `exac`). `joint.filters` never decides QC: it carries joint-level flags (`discrepant_frequencies`) and disagrees between the detail and list documents for the same variant.
- **`consequence_class` is gnomAD's own consequence category.** The class names are gnomAD's category keys, so the terms follow its browser's table (`vepConsequences.ts`): pLoF holds transcript ablation, splice acceptor/donor, stop gained, and frameshift; missense also holds inframe indels, start lost, and stop lost; any term the table omits, and a null consequence, is `other`, as the browser's filter reads them. The initial set put start/stop lost and `transcript_amplification` in `lof` and inframe indels in `other`, so a `lof` count disagreed with gnomAD's pLoF filter of the same name (CDKN2A: 93 against 71).
- **`consequence` keeps gnomAD's most-severe term; the primary-transcript view sits beside it.** The term is the one gnomAD's own tables show, and `consequence_class` and its filter derive from it, so switching it to the MANE term would break parity and silently re-scope every class count. Instead `gnomad_get_variant` adds `primary_transcript`, read from the `transcript_consequences` already in the reply, and list rows carry `transcript_id` plus, on gene targets, `consequence_transcript`, which reproduces the browser's † rule against the gene's MANE Select (else canonical) transcript. The rule is gene-level, not each row's own `is_mane_select`/`is_canonical` flags: those cannot tell a canonical-but-not-MANE row on a GRCh38 gene from the transcript the browser compares against. A per-transcript list read is no alternative: `transcript().variants` is refused for TTN, and `consequence_in_canonical_transcript` is null on every row sampled.
- **ClinVar rides inside gnomAD's variant response for the core; the NCBI tool is optional.** gnomAD joins ClinVar significance per-variant for free, keeping the core keyless and single-source. `gnomad_search_clinvar` (NCBI E-utilities) is a deferred-to-optional extension for gene-panel curation depth, not a core dependency — it's the only thing that adds a second upstream and an optional key.
- **Only the two list tools spill; the spill emitters ship paired with the standardized canvas-accessor trio.** Per-gene variant lists are analytical (rank by AF, count by consequence, group) and can exceed any context budget — the canvas's earns-its-keep test passes on *shape*, not just size. The scalar tools (`get_variant`, `get_gene_constraint`) and `get_coverage` return bounded records and inline directly. A `canvas_id` with no query tool is dead output, so `gnomad_dataframe_query` is mandatory the moment anything spills; `gnomad_dataframe_describe` and the opt-in `gnomad_dataframe_drop` complete the three-tool accessor surface.
- **DataCanvas is on by default; the `.mcpb` bundle is inline-only.** The list tools' full value is the SQL path, so `src/index.ts` sets `CANVAS_PROVIDER_TYPE=duckdb` after `.env` loads whenever normalization treats the variable as unset (absent, blank, or a whole unsubstituted placeholder). The bundle strips DuckDB's native bindings to stay portable, so `manifest.json` pins `none`: a bundle running `duckdb` would start normally and then fail on its first staging call.
- **`gnomad_dataframe_describe` ships, even though the spill tools document their schemas.** The framework canvas guidance (Checklist + simple-shape Tools row) standardizes on describe so an agent can discover staged table/column names. Both spill tools do return a fixed, documented column set (`GeneVariantRow` / ClinVar row) in their own output, which once argued for dropping describe as redundant — but fleet-wide consistency on the canvas-accessor surface wins over the per-server optimization: every analytics server ships the same `query` / `describe` / `drop` trio, so agents and operators meet one predictable shape. Describe also stays correct if the column set ever turns dynamic.
- **Reusing a `canvas_id` REPLACES the staged table — it never accumulates.** Both spill tools register their result under a fixed table name (`gene_variants` / `clinvar_variants`). The framework's `registerTable` is drop-and-create on an existing name (`DROP TABLE IF EXISTS` → `CREATE TABLE`), so passing a prior `canvas_id` back into the same tool overwrites that table with the new call's rows rather than appending. A supplied `canvas_id` writes the table even when the result fits inline, so the table never holds an earlier call's rows; a zero-row result drops it instead (an empty table would earn a describe/query pointer to nothing). The ClinVar Ensembl-ID short-circuit is the one exception: it searched nothing, so it returns `canvas_id: ''` and leaves a supplied canvas and its table as they were rather than acquiring the canvas only to fail on an unknown id or discard a table the caller still wants. To analyze two genes side by side, query each before re-staging, or use separate canvases — the `canvas_id` input descriptions state this so an agent doesn't assume the two result sets coexist.
- **No canvas is minted for a result that fits inline without a `canvas_id`.** The rows are already materialized, so the fit-vs-spill decision (the same JSON-character rule `spillover()` applies) runs before `acquire()`. Minted canvases count against the per-tenant cap (`CANVAS_MAX_CANVASES_PER_TENANT`), and with auth off every caller shares one tenant, so empty canvases from small lookups would exhaust it. Such a response carries `canvas_id: ''`, which renders as "no canvas table for this call" — never as a disabled canvas.
- **Inline budgets decide staging; a page or window is the inline answer.** Rows land on both surfaces (`structuredContent.preview` and the `format()` text), so the budgets are set from measured real PCSK9 rows. `gnomad_list_gene_variants` stages every row at offset 0 once the matching rows pass 14,000 JSON characters; its inline rows are the page (`limit`, default 25, about 14 KB per response on real PCSK9 rows), and with the canvas off every row of the page is returned. `gnomad_search_clinvar` previews 11,000 JSON characters (~1.98 serialized bytes per character, plus a longer composed notice) while the canvas is on; with it off there is no table to hold the rest, so it returns every row of its window and `limit` is the only page boundary, since a budget cut there made `next_offset` skip the rows past the cut. The cut is a longest-prefix-within-budget rule, not a row count: a row cap sized on the average row let heavy genes (BRCA1's ClinVar rows run about twice the PCSK9 average) overshoot.
- **`gnomad_list_gene_variants` pages by offset/limit and stages only at offset 0.** gnomAD's `gene.variants` takes no paging argument, so every page re-fetches the target with the same request body. There is no local cache, and gnomAD's proxy cache answers the repeat. Each spilling call acquires a new canvas, and a later page would rewrite the table the first page staged, so `offset > 0` never stages or acquires a canvas, and a supplied `canvas_id` keeps its table. The default `limit` is 25. The cap of 3,000 is where a page of real TTN rows reaches about 1 MB of structuredContent. Filters apply before paging, so `total` and `next_offset` count the rows the filters keep.
- **The list tool echoes `target`, `target_kind`, and `filters`.** These are the `resolveGenomeTarget()` pair `gnomad_get_coverage` echoes, so a normalization reaches both tools alike. `filters` carries the row filters only: `offset`, `limit`, and `canvas_id` stay out, and `pass_only` is `true` or null. `gnomad_search_clinvar` echoes `gene` and `filters` the same way.
- **An over-cap `limit` is clamped, not rejected, by default.** With `GNOMAD_CLAMP_LIMITS` on, the schema advertises a default and a minimum but no maximum, and a value above the cap is lowered to it with a notice, an info log line, and a `gnomad.input.limit_clamped` count; off, the cap is the schema `maximum`. Caps: `gnomad_dataframe_query` and `gnomad_list_gene_variants` 3,000, `gnomad_search_clinvar` 1,500 (where a full window of the longest real records, BRCA1's, reaches about 1 MB per surface). Why: a caller asking for more than the cap gets a page and a notice instead of a validation failure.
- **`gnomad_dataframe_query` pages in DuckDB over a per-call view of the caller's SQL.** The SQL is registered as a view for the length of the call (registration runs the canvas gate over the SQL as sent, so refusals are the ones a direct query gets) and dropped when the call ends, cancelled or not. The page reads that view under LIMIT/OFFSET, each row measured as one struct of all its columns, and a running sum ends the page before the row that would take its row JSON past 4,000,000 characters. At most `limit` rows (default 25, cap 3,000) plus one count capped at `CANVAS_DEFAULT_ROW_LIMIT` + 1 leave the engine. Result column names come from `DESCRIBE` of the SQL, so duplicate and case-only names match a direct query; `total` is `null` above the row cap, where paging stops. Consequence: `gnomad_dataframe_describe` lists tables only (`describe({ kind: 'table' })`), so a view an in-flight query holds never appears there. Each page re-runs the SQL, so stable paging needs an `ORDER BY` over a unique key.
- **`gnomad_dataframe_drop` is opt-in and off by default.** Dropping a staged table is a mutation (`readOnlyHint: false`); the default-keyless research surface stays read-only, so the tool is gated behind `GNOMAD_DATAFRAME_DROP_ENABLED=true` through `disabledTool()`: when off it never appears in `tools/list` and shows as disabled on the HTTP landing page. Operators who want manual canvas-memory reclamation flip the flag; everyone else gets a strictly read-only surface. (Per-table TTL already reclaims memory automatically, so drop is a convenience, not a requirement.)
- **`gnomad_search_clinvar` pages by offset and reports `total_found`.** A popular gene has thousands of ClinVar records, so one call returns a window of `limit` ESearch IDs (default 10, cap 1,500) and says how many candidates exist (`total_found`, the ESearch count before the post-fetch filters) and where the next window starts; a silent cap read as the complete set. The significance and star floor also go into the ESearch term. Seven terms (`pathogenic`, `likely pathogenic`, `uncertain significance`, `vus`, `likely benign`, `benign`, `conflicting`) go out as ClinVar's germline-classification `[prop]` clauses, from one map that pairs each clause with the whole-word pattern the post-filter applies. Every record of 19 genes was compared (64,850 records, including BRCA1, BRCA2, TP53, KRAS, CFTR, CFH, and CFI, as of November 2026), and each clause returns exactly the records its pattern keeps, so a mapped window is dense and `total_found` is the match count. The low-penetrance and VUS-tier properties are listed because those records carry no plain `clinsig_pathogenic` / `clinsig_likely_pathogenic` / `clinsig_vus`; leaving them out drops 68 of CFH's 265 `pathogenic` matches. Any other term goes out as a quoted `[clinical_significance]` phrase, which NCBI rewrites to `[All Fields]` and matches across all fields, so the post-fetch filters stay authoritative and `limit` counts candidates, not returned rows. The significance is normalized once (`"` dropped, underscores read as spaces, trimmed, lowercased), so the term, the post-filter, the notices, and the `filters` echo all use the same value.
- **The ClinVar gene goes out as a quoted phrase, `"<gene>"[gene]`.** An unquoted gene carrying query syntax (`PCSK9)`, `((`, a trailing `OR`) detached the `[gene]` tag and NCBI searched all fields, returning other genes' records under the requested label. Quoting keeps any input inside the gene index without adding an input rule; measured live, quoted and unquoted counts match for plain and hyphenated symbols (PCSK9, TTR, BRCA1, HLA-A, NKX2-5, MT-TL1, C9orf72). `"` is removed from the gene first, and a gene that is then empty matches nothing without a request, because NCBI ignores an empty quoted phrase and falls back to all of ClinVar.
- **Staged tables carry a column schema declared from the row type.** Left to inference, a column's type came from whichever rows landed in the preview: a gene whose first rows all had `af` 0 or null staged `af` as BIGINT and truncated every fractional frequency to 0. Each row tool declares its columns with `rowSchema<Row>()` — strings VARCHAR, fractional numbers DOUBLE, integer counts BIGINT, nullability from the row type — and a missing or extra column, a string/number mismatch, or wrong nullability is a compile error. DOUBLE vs BIGINT is the declaration's call, since the type system can't tell a fraction from a count; the staged-column-type tests pin `af` as DOUBLE.
- **ClinVar rows carry a `grch38_variant_id` only where the mapping is exact.** It is derived from the canonical SPDI for single-allele GRCh38 records whose alleles are both non-empty and differ at their first and last base (SNVs, MNVs, delins). Canonical SPDI repeat-expands indels and drops the VCF anchor base, so anchoring them would need a reference lookup per record; those rows keep `canonical_spdi` and `rsids` but a null `grch38_variant_id` rather than a guessed one.
- **`exac` reads `gene.exac_constraint`; every constraint result names its release.** gnomAD selects the constraint table by build alone, so without routing `exac` would carry gnomAD v2.1.1 metrics and `gnomad_r3` v4 metrics under their own dataset names — and a gene can sit on opposite sides of the pLI 0.9 cutoff between releases (TP53: 0.53 in v2.1.1, 0.91 in ExAC). One query selects both objects and the service reads the one the dataset names; ExAC's metrics pass the same domain checks as gnomAD's (pLI in 0–1, non-negative counts, signed Z-scores). Recalculating ExAC ratios from its counts is out of scope — they stay null rather than derived.
- **`gnomad_get_variant` is batch-with-partial-success; `gnomad_get_gene_constraint` is single-target.** Variant frequency screens commonly need many IDs at once and benefit from one call with `found[]`/`failed[]`. Constraint is looked up one gene at a time in real workflows and gnomAD's gene query is single-gene — no batch payoff.
- **A `failed[]` item carries a declared reason and its declared hint; anything else fails the call.** Each item's `reason` is one the tool's `errors[]` declares — its own rejections (`invalid_variant_id`, `variant_not_found`, `variant_not_found_other_build`) or a reason the service throws — and `recovery` is read from that declaration, so a batch caller branches on the same reasons and hints a single-variant surface returns. A cancelled call, or a failure carrying no declared reason, is not about one ID: it fails the whole call rather than landing in `failed[]` with a guessed reason.
- **An absent coordinate ID gets one best-effort liftover hint per batch.** A coordinate ID carries no build, so a GRCh38 ID on `gnomad_r2_1` looks up an unrelated GRCh37 position, and coverage there can read as callable. After the batch settles, the canonical forms of the absent coordinate IDs go into aliased `liftover` documents of up to 25 IDs each, with the direction set by the dataset's build: on GRCh38 the ID is a GRCh37 `source_variant_id` and the candidate is its `liftover`; on GRCh37 it is a GRCh38 `liftover_variant_id` and the candidate is its `source`. A hit fails the item as `variant_not_found_other_build` with the lifted IDs in `candidates`; the wording never asserts a mismatch, because a valid ID truly absent from the dataset lifts too (`11-2181023-T-C` on `gnomad_r4`). rsIDs never go in: gnomAD fails the whole document with an HTTP 500 on one. The lift is best-effort like the ClinVar join — a GraphQL error, an HTTP failure, a timeout, a reply whose entries name IDs other than the ones asked for, or an already-spent deadline leaves plain `variant_not_found` for that document's IDs — and a cancelled call still rejects. The liftover result's `datasets` list omits releases that hold the variant, so it is never a filter. A batch where every ID is found sends no liftover request; one with absent coordinate IDs adds one request per 25 of them, sent in turn — a single request at the default batch cap of 25 — whose latency grows with the alias count.
- **A null `gene` / `transcript` root is not-found on the list and coverage tools.** gnomAD answers an ID it does not hold with `Gene not found` / `Transcript not found` beside a null root; the service raises `gene_not_found` / `transcript_not_found` (NotFound, not retryable) naming the reference build, ahead of the mitochondrial check. A transient message beside the null root still retries. A region target never raises either; a known feature with no rows stays an empty success.
- **Identifier normalization is one module (`src/services/gnomad/identifier-normalization.ts`).** Every rewrite applies only to spellings with one clear reading, logs once, and increments `gnomad.identifiers.normalized{kind}` (the counter is created on first use, so it binds the started meter). Gene symbols are never case-folded. `gnomad_search_clinvar`'s Ensembl-ID short-circuit matches versioned IDs regardless of the switch, since it rewrites nothing.
- **Each tool and resource declares every reason its services raise, and the declaration is the only source of a recovery hint.** The sanitizer and the response validators set a typed `reason` and no `recovery`, so the framework fills the hint of whichever surface failed — a resource says to read again where a tool says to retry, and ClinVar names NCBI where gnomAD names gnomAD. A service throw would set `recovery` only for a hint that carries call-specific values; none does. A failed body read is classified like a failed fetch (`upstream_timeout` at the deadline, `upstream_unavailable` on a stream reset), so no upstream failure reaches a caller without a reason. gnomAD's HTTP 500 region messages are relayed only on the variant-list and coverage queries, the operations that take a region, which keeps `invalid_region` and `region_too_large` off the variant and constraint surfaces.
- **ClinVar failures are attributed by request, never by message or `path`.** gnomAD's errors carry `message` alone, and its variant and ClinVar resolvers emit the same messages (`Invalid variant ID`, `Request timed out`, `Service overloaded`, `An unknown error occurred`), so a combined reply cannot say which root failed. A coordinate ID sends one combined request; only when that reply carries errors beside a populated `variant` is it discarded and the lookup re-sent as a variant-only request, then a ClinVar-only request, each judged alone. The variant-only reply keeps the population rules (a transient error retries and ends as `upstream_unavailable`, any other fails as `graphql_error`, pure not-found is absence); any failure of a ClinVar-only request, an rsID's included, returns the record with `clinvar_unavailable: true` (and, on the tool, a notice). Always sending the two halves separately would double the requests for every found ID against gnomAD's per-IP request limit (30 a minute by default in its source); this shape keeps the clean and absent paths at one request and adds two on the rare error path. The halves run in sequence, so a failed variant never spends a ClinVar request.
- **Every upstream-backed call shares one 45 s deadline.** `UPSTREAM_CALL_BUDGET_MS` covers semaphore and NCBI pacing waits, retry backoff, headers, body reads, rsID resolution, split variant requests, the liftover hint for absent IDs, and every ESummary batch. Every variant in a batch, and the batch's liftover requests, share its start — the variant resource passes one start to its lookup and its lift — so a lift starts only while time remains and ends at the deadline; unfinished primary items return `upstream_timeout` while completed items remain in input order. A validated population record survives ClinVar-only failure or expiry with `clinvar_unavailable: true`. Cancellation removes queued work and rejects the call with the caller's reason. The fixed bound leaves margin below a 60 s client timeout; per-attempt timeouts remain separately configurable.
- **A pathless "Variant not found" beside `variant: null` is absence on the coordinate-ID query**, whatever `clinvar_variant` carries, since ClinVar can know a variant gnomAD lacks; it costs one request. Any other error beside a null `variant` stays fatal: a transient one retries the combined request and ends as `upstream_unavailable`, the rest fail as `graphql_error`.
- **Coverage is its own tool, not folded into `get_variant`.** "Absent" is only meaningful against callability, but coverage is a region-shaped depth profile (many positions × depth thresholds), a fundamentally different output shape from a single variant record. Keeping it separate lets the agent pull it *only* when a variant comes back absent (workflow 1, step 3), rather than paying for a coverage profile on every frequency lookup.
- **Coverage summaries cover exactly the buckets gnomAD queried for the target, and say so.** gnomAD's coverage is a histogram whose buckets widen with the target (15 bp across PCSK9) and whose zero-filled buckets span every intron between a gene's exons. Averaging every returned bucket diluted PCSK9's genome depth from 32.5 to 10.2; summarizing only the buckets overlapping `start..stop` or the exons ±75 bp keeps a measured zero inside the target and drops the introns gnomAD never read. `positions` counts observed target bases inside returned buckets; `target_positions` counts all target bases, and their difference is `missing_positions`, whose callability is unknown. `bucket_size` / `bucket_count` state the resolution so a mean is never read as per-base. Bucket size follows gnomAD's own formula rather than the returned count, because exome buckets can be absent at the edges of the capture.
- **`region` / `transcript_id` / `gene` are mutually-exclusive inputs on the list + coverage tools.** All three address "a stretch of the genome"; accepting one of three (validated: exactly one present) keeps the surface tight without three near-duplicate tools.
- **One prompt (`gnomad_variant_triage`), no app tools.** The triage chain is the server's signature workflow and the coverage step is reliably skipped — a structured prompt earns its place. App tools don't: every surface here is read-by-LLM, not scrubbed-by-human in real time, so the iframe/CSP/format-twin cost has no payoff.

## Known Limitations

- **Community-funded rate limits.** gnomAD's API is free but throttles; aggressive use gets 429s. The server caps concurrency (default 2) and backs off, which makes large gene-variant pulls and big batches slower but well-behaved. A hosted instance must not bulk-scrape — the single hosting caveat.
- **Constraint release labels are static.** gnomAD's API carries no release identifier, so `constraint_release` comes from a fixed dataset → release map in the service. When gnomAD republishes a table (GRCh38 moved to v4.1.2 on 2026-09-28, values unchanged from v4.1.1), the map needs a matching edit. `gnomad_r3` has no constraint of its own and serves the GRCh38 v4.1.2 table, which the label and the tool's text state.
- **Liftover is a hint, never a translation.** The server does not rewrite coordinates between GRCh37 and GRCh38 or retry on the caller's behalf — the caller (or `ensembl`) supplies IDs on the dataset's build. An absent coordinate ID whose string also lifts over from the other build fails as `variant_not_found_other_build` with the lifted IDs in `candidates`. A string valid on both builds that names a different variant on each is invisible to that path: `11-2181053-G-T` is found on `gnomad_r4` and also lifts to `11-2159823-G-T`, and the lookup returns that record with no failure. Echoed `reference_genome` stays the only guard there.
- **Sparse / null fields are real.** Many variants lack in-silico scores, ClinVar entries, or counts in a given ancestry; many genes have null constraint. Optional-vs-required field modeling follows actual upstream nullability — the server preserves uncertainty and never fabricates a value from a missing field.
- **Exome vs. genome split.** AC/AN, coverage, and the ancestry-group set differ between the exome and genome callsets. The variant record reports which callset(s) carry the variant (`source`) and keeps `populations` per callset; coverage exposes an explicit exome/genome source switch. On `gnomad_r4` the overall counts and `joint_populations` come from gnomAD's joint record instead, whose AN covers every callable sample in both callsets — so overall `an` can span a callset that does not carry the variant, and `source` no longer tells you what `an` counts. Summing only the carried callsets there overstates a single-callset variant's AF (up to 20× for a genome-only PCSK9 variant). Datasets without a joint record (`gnomad_r3`, `gnomad_r2_1`, `exac`) keep that carried-callset sum, a QC-failed callset included — except on `gnomad_list_gene_variants` under `pass_only`, which sums only the callsets that passed (on `gnomad_r2_1`, `1-55505483-C-G` reads `an` 31408 there and 210338 otherwise, as of November 2026).
- **`gnomad_dataframe_query` needs the canvas, which `CANVAS_PROVIDER_TYPE=none` disables.** With it off the dataframe tools are not registered, and the list tools return every row of each page or window inline with `spilled: false` and `canvas_id: ''`; exhaustive analysis means paging, since there is no SQL path. The canvas/SQL path is unavailable there and in the `.mcpb` bundle, which pins `none`, and unavailable entirely on Cloudflare Workers (DuckDB has no V8-isolate build).
- **Every list page re-fetches the whole target.** A walk of TTN (112,412 variants on `gnomad_r4` as of November 2026) is 38 fetches at `limit` 3,000. The tool materializes the whole target for every page at any `limit`. Narrow with `consequence_class`, `max_af`, or `pass_only`, or use a region.
- **An engine error raised while a `gnomad_dataframe_query` page runs can mislead on location.** A `sql_execution_error` (e.g. a failed CAST) can carry a `LINE` context that points into the server's paging statement rather than the SQL as sent; the error text before it names the failure.

## v1 Scope vs. Deferred

**v1 (core, keyless, single-source):**

- `gnomad_get_variant` (batch + partial success), `gnomad_get_gene_constraint`, `gnomad_get_coverage`
- `gnomad_list_gene_variants` + the DataCanvas accessor trio: `gnomad_dataframe_query`, `gnomad_dataframe_describe`, and `gnomad_dataframe_drop` (opt-in behind `GNOMAD_DATAFRAME_DROP_ENABLED`, off by default)
- Resources `gnomad://variant/{dataset}/{variantId}`, `gnomad://gene/{dataset}/{gene}/constraint`
- Prompt `gnomad_variant_triage`
- `dataset` + `reference_genome` on every tool, echoed in output; per-ancestry frequency vector; ClinVar significance via gnomAD's own join

**Optional extension (ships only if curation depth is wanted):**

- `gnomad_search_clinvar` + `clinvar` service (NCBI E-utilities, optional `NCBI_API_KEY`)

**Deferred (out of v1):**

- Structural variants, mitochondrial variants, CNVs, short-tandem-repeat catalog
- Translating or auto-retrying IDs across builds (the liftover hint only names candidates); any write / annotation-submission path
- A multi-variant constraint-weighted prioritization workflow tool (could combine list + constraint + coverage into one ranked call) — revisit if a single composite "prioritize variants in this gene" action proves a common ask.
