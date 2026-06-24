# gnomad-genetics-mcp-server — Design

Human population genetics over [gnomAD](https://gnomad.broadinstitute.org) (the Genome Aggregation Database, Broad Institute). Answers the two questions clinical and rare-disease variant interpretation gates on: **how common is this variant** (population allele frequency, broken down by genetic-ancestry group) and **how tolerant is this gene to being broken** (loss-of-function constraint — pLI / LOEUF). Backed by one keyless GraphQL endpoint; ClinVar clinical significance rides along inside gnomAD's own variant response. Complements `ensembl-mcp-server` (which annotates *what* a variant does) by supplying the frequency and constraint context that turns "this variant exists" into "this variant is plausibly causal."

---

## MCP Surface

### Tools

| Tool | Summary | readOnlyHint | openWorldHint | Key inputs | Output shape |
|---|---|---|---|---|---|
| `gnomad_get_variant` | Full population record for one or more variants — AC/AN/AF overall and per ancestry group, homozygote/hemizygote counts, quality flags, transcript consequence, in-silico predictors, and joined ClinVar significance. The "how common / is it benign" answer in one call. Per-id batch (up to 25 IDs) with partial success. | `true` | `true` | `variants[]` (1–25 items; each a `chrom-pos-ref-alt` variantId validated by regex `^[0-9XYM]+-\d+-[ACGT]+-[ACGT]+$` or an rsID `^rs\d+$`; obtain a variantId from `ensembl_predict_variant` or a VCF), `dataset`, `reference_genome` | `{ found[], failed[], dataset, reference_genome }` |
| `gnomad_get_gene_constraint` | Loss-of-function constraint for a gene — pLI, LOEUF (`oe_lof_upper`) with CI, missense/synonymous/LoF Z-scores, observed/expected ratios. The metric that weights a candidate LoF variant. By gene symbol or Ensembl gene ID. | `true` | `true` | `gene` (HGNC symbol e.g. `PCSK9`, or Ensembl gene ID `ENSG…` — obtain from `ensembl_lookup_gene`), `dataset`, `reference_genome` | `{ gene_id, symbol, dataset, reference_genome, pli, oe_lof, oe_lof_lower, oe_lof_upper, oe_mis, oe_syn, lof_z, mis_z, syn_z, obs/exp_*, constraint_flags[] }` (flat — constraint fields are top-level, not nested) |
| `gnomad_list_gene_variants` | All variants in a gene / transcript / region with allele frequencies and predicted consequences. Filter by consequence class and frequency threshold. Large sets spill to a DataCanvas table for SQL (rank by AF, count by consequence); returns `canvas_id` + `table_name` for use with `gnomad_dataframe_query`. | `true` | `true` | one of `gene` / `transcript_id` / `region`; `consequence_class?` (`'lof' \| 'missense' \| 'synonymous' \| 'other'`), `max_af?` (0–1, float), `canvas_id?`, `dataset`, `reference_genome` | `{ preview[], canvas_id, table_name, spilled, total, dataset, reference_genome }` |
| `gnomad_get_coverage` | Sequencing coverage across a gene / transcript / region — mean & median depth and the mean fraction of samples over depth thresholds (1/5/10/15/20/25/30/50/100×), aggregated per callset track. Disambiguates a true absent variant from an uncallable position before concluding "not seen in gnomAD." | `true` | `true` | one of `gene` / `transcript_id` / `region`; `dataset`, `reference_genome`, `coverage_source?` (`'exome' \| 'genome'`; omit to return every available track) | `{ target, target_kind, summaries[] (per-track depth + fraction-over thresholds), dataset, reference_genome }` |
| `gnomad_dataframe_query` | Run a read-only SQL `SELECT` against a canvas table staged by `gnomad_list_gene_variants` or `gnomad_search_clinvar` (rank by AF, group by consequence, count LoF). Use the `canvas_id` and `table_name` returned by those tools. | `true` | `false` | `canvas_id` (from a prior `gnomad_list_gene_variants` or `gnomad_search_clinvar` call), `sql` (SELECT only) | `{ rows[], row_count, columns[], truncated }` |
| `gnomad_dataframe_describe` | List the tables staged on a canvas and their columns (name + type) before writing SQL. Use the `canvas_id` from a `gnomad_list_gene_variants` or `gnomad_search_clinvar` call to see what's queryable. | `true` | `false` | `canvas_id` (from a prior spill call) | `{ tables[] }` (each `{ name, row_count, columns[] }`) |
| `gnomad_dataframe_drop` | *(opt-in; off by default)* Drop a named table from a canvas to reclaim memory. Registered only when `GNOMAD_DATAFRAME_DROP_ENABLED=true`; absent from `tools/list` otherwise. | `false` | `false` | `canvas_id`, `table_name` (table to drop) | `{ dropped }` (boolean) |
| `gnomad_search_clinvar` | *(optional second source)* Gene-level ClinVar detail beyond what gnomAD joins per variant — pathogenic / likely-pathogenic variant lists, review status (star rating), submission counts — via NCBI E-utilities. Turns variant-level significance into a gene-panel curation view. Spills to canvas; returns `canvas_id` + `table_name` for use with `gnomad_dataframe_query`. | `true` | `true` | `gene` (HGNC symbol), `clinical_significance?`, `min_review_stars?` (0–4 integer) | `{ preview[], canvas_id, table_name, spilled, total }` |

> **Naming note.** Repo is `gnomad-genetics-mcp-server`; the tool prefix is the short `gnomad_` (intentional — the longer name disambiguates the repo in a server list; the prefix stays terse for every tool call). Display identity (`createApp` `name`/`title`, manifest `display_name`, docs headers) is the full hyphenated `gnomad-genetics-mcp-server` everywhere — never a Title-Cased "Pretty Name".

> **Three canvas-accessor tools — the fleet-standard DataCanvas set.** `gnomad_list_gene_variants` and `gnomad_search_clinvar` are the only canvas emitters; both stage their full result under a known table name. The accessor surface is the standardized trio: `gnomad_dataframe_query` (run SQL — mandatory once anything emits a `canvas_id`), `gnomad_dataframe_describe` (list staged tables + columns before querying), and `gnomad_dataframe_drop` (opt-in behind `GNOMAD_DATAFRAME_DROP_ENABLED=true`, conditionally registered and absent from `tools/list` when off). See Design Decisions for why describe ships even though the spill tools document their schemas.

### Resources

| URI template | Returns | Notes |
|---|---|---|
| `gnomad://variant/{dataset}/{variantId}` | Same population record as `gnomad_get_variant` for a single variant. | Convenience for clients that support injectable context; the tool is the reliable path. `dataset` segment (e.g. `gnomad_r4`) keeps the URI self-describing — a frequency without its dataset silently misleads. |
| `gnomad://gene/{dataset}/{gene}/constraint` | Same constraint record as `gnomad_get_gene_constraint`. | `gene` = symbol or Ensembl ID. |

Resources are read-only single-entity lookups mirroring the two scalar tools. List tools (`gnomad_list_gene_variants`, coverage, ClinVar) are **not** exposed as resources — their results are analytical row sets, not stable single-URI documents.

### Prompts

| Name | Purpose | Args |
|---|---|---|
| `gnomad_variant_triage` | Guided rare-disease variant-triage workflow: resolve the variant → pull its population record → check gene constraint → confirm the position is well-covered before calling it "absent." Emits the tool chain a clinical analyst runs, in order. | `variant` (variantId or rsID), `gene?`, `dataset?` |

One prompt in v1 — the variant-triage chain is the server's signature workflow and benefits from a structured template (the coverage step is the one analysts most often skip). Other interactions are direct tool calls and don't need prompts.

---

## Overview

gnomAD aggregates exome and genome sequencing across ~807K individuals (v4: 730,947 exomes + 76,215 genomes) into the human-genetics reference for population allele frequency and gene-level constraint. There is **no REST surface** — the only programmatic interface is a GraphQL endpoint at `https://gnomad.broadinstitute.org/api`. The service layer therefore owns a small set of parameterized GraphQL query documents (one per tool), requesting only the fields each tool returns and validating the typed response.

The core value is **population context for variant interpretation**. A candidate pathogenic variant must be rare — gnomAD says how rare, and crucially *in which ancestry*: a variant common in one genetic-ancestry group and absent in another is exactly the signal clinical interpretation needs, so the server returns the full per-ancestry allele-frequency vector rather than collapsing to a single global AF. Gene constraint (pLI / LOEUF) supplies the orthogonal axis: a loss-of-function variant matters far more in a gene that is intolerant to being broken. ClinVar clinical significance is joined per-variant inside gnomAD's own response, so the server is keyless and single-source for the entire core surface.

Primary agent workflows: (1) **frequency lookup** — "how common is `1-55051215-G-GA`, overall and by ancestry?" → `gnomad_get_variant`; (2) **constraint assessment** — "is PCSK9 LoF-intolerant?" → `gnomad_get_gene_constraint`; (3) **gene variant catalog** — "show me the rare LoF variants in BRCA2" → `gnomad_list_gene_variants` (spills to canvas) → `gnomad_dataframe_query` to rank/count; (4) **rare-disease triage** — variant absent from gnomAD? → pair `gnomad_get_variant` with `gnomad_get_coverage` to prove the position is callable before concluding absence is real. The server composes with `ensembl-mcp-server` (variant consequence / VEP + gene coordinates — **shared reference build**), `clinicaltrials-mcp-server`, `openfda-mcp-server` / `pubmed-mcp-server`, and a protein server for the gene product.

## Requirements

**Functional**

- Fetch the full population record for a variant by `chrom-pos-ref-alt` variantId or rsID — AC/AN/AF overall and for every genetic-ancestry group, homozygote and (for hemizygous regions) hemizygote counts, quality flags, the worst/transcript consequence, in-silico predictor scores, and joined ClinVar clinical significance.
- Accept a **batch** of variant IDs in one `gnomad_get_variant` call with per-item partial success (one bad ID does not fail the call).
- Fetch gene loss-of-function constraint by gene symbol or Ensembl gene ID: pLI, LOEUF (`oe_lof_upper`) + its lower bound, observed/expected for LoF/missense/synonymous, and the three Z-scores.
- List all variants in a gene, transcript, or region with AF + predicted consequence, filterable by consequence class and a max-AF threshold; spill the full set to a DataCanvas table and expose SQL over it.
- Report sequencing coverage (mean/median depth, fraction-of-samples-over-threshold) for a gene / transcript / region, separable by exome vs. genome coverage track.
- *(optional)* Gene-level ClinVar detail via NCBI E-utilities for curation depth beyond the per-variant join.
- Echo the **effective `dataset` and `reference_genome`** in every tool's output.

**Non-functional / constraints**

- **Dataset and reference build are two distinct GraphQL arguments**, not one. `dataset` is a `DatasetId` enum (`gnomad_r4` default, also `gnomad_r3`, `gnomad_r2_1`, `exac`, …); `reference_genome` is a `ReferenceGenomeId` enum (`GRCh38` default for v4, `GRCh37` for v2). They must be coherent (v4 ⇒ GRCh38, v2 ⇒ GRCh37) — the service derives a default `reference_genome` from `dataset` when the caller omits it, and validates the pair. Keep the build aligned with `ensembl-mcp-server` or the agent gets silent coordinate mismatches.
- **Keyless** for the entire core (gnomAD GraphQL needs no auth). `gnomad_search_clinvar` (NCBI E-utilities) is also keyless but honors an optional `NCBI_API_KEY` for a higher rate limit.
- **Polite client.** gnomAD's API is free, rate-limited, and community-funded. The service layer uses conservative concurrency, exponential backoff on 429/5xx, and a short per-request timeout. A hosted instance must not bulk-scrape — document this as the single hosting caveat. NCBI E-utilities cap at 3 req/s keyless (10 with a key).
- **Licensing / attribution.** gnomAD data is openly licensed; surface gnomAD (Broad Institute) as the source. ClinVar credit goes to NCBI.
- **v4 constraint is beta.** The gnomAD team flags v4.0 constraint as experimental; surface a `constraint_flags[]` / note when present and don't fabricate certainty. (Recommended LOEUF intolerance threshold shifted to <0.6 for v4 vs <0.35 for v2 — informational, not enforced.)

**Out of scope (v1):** structural variants, mitochondrial variants, copy-number variants, the v4 short-tandem-repeat catalog, liftover between builds, and any write/annotation-submission path. gnomAD is read-only reference data — there is nothing to mutate.

## Data Model

Identifiers and the shapes the tools surface. GraphQL field names below match the live schema (`gene.gnomad_constraint`, `variant.<dataset>.…`).

```ts
/** Reference build — a GraphQL ReferenceGenomeId enum. */
type ReferenceGenome = 'GRCh38' | 'GRCh37';

/** Dataset — a GraphQL DatasetId enum. Default 'gnomad_r4'. */
type Dataset = 'gnomad_r4' | 'gnomad_r3' | 'gnomad_r2_1' | 'exac';

/**
 * variantId — `chrom-pos-ref-alt`, 1-based, e.g. "1-55051215-G-GA".
 * chrom: 1-22 | X | Y | M. ref/alt: [ACGT]+. Validated by regex (see Zod).
 * Obtain one from ensembl_predict_variant / a VCF, or pass an rsID instead.
 */
type VariantId = string;

/** rsID — dbSNP refSNP, "rs" + digits, e.g. "rs11591147". */
type RsId = string;

/** Gene reference — symbol (PCSK9) or Ensembl gene ID (ENSG00000169174). */
type GeneRef = string;

/** Region — `chrom-start-stop`, 1-based inclusive, e.g. "1-55039447-55064852". */
type Region = string;

/** Genetic-ancestry group codes. Exomes carry all except ami; genomes add ami (Amish). */
type AncestryGroup = 'afr' | 'amr' | 'asj' | 'eas' | 'fin' | 'mid' | 'nfe' | 'sas' | 'remaining' | 'ami';

/** One genetic-ancestry group's counts. AF = AC / AN (null when AN == 0). */
interface PopulationFreq {
  id: AncestryGroup;        // afr | amr | asj | eas | fin | mid | nfe | sas | remaining | ami (genomes only)
  ac: number;               // allele count
  an: number;               // allele number (called chromosomes)
  af: number | null;        // allele frequency
  homozygote_count: number;
  hemizygote_count: number | null; // X/Y only
}

/** The population record gnomad_get_variant returns per variant. */
interface VariantRecord {
  variant_id: VariantId;
  rsids: RsId[];
  reference_genome: ReferenceGenome;
  dataset: Dataset;
  // overall, then the full per-ancestry vector — never collapsed to a single global AF
  ac: number; an: number; af: number | null;
  homozygote_count: number; hemizygote_count: number | null;
  populations: PopulationFreq[];
  source: ('exome' | 'genome')[];   // which gnomAD callset(s) carry it
  flags: string[];                  // quality flags, e.g. "lcr", "segdup", "lc_lof"
  consequence: string | null;       // worst/transcript VEP consequence term
  transcript_id: string | null;     // transcript the consequence is on
  in_silico: { revel?: number; cadd?: number; spliceai_ds_max?: number; /* … */ };
  clinvar: {                        // joined inside gnomAD's variant response — free, no NCBI call
    clinical_significance: string | null;  // e.g. "Pathogenic", "Likely benign"
    review_status: string | null;          // ClinVar review status text
    gold_stars: number | null;              // 0–4 star rating
    clinvar_variation_id: string | null;
  } | null;
}

/** gnomAD gene constraint — the gene.gnomad_constraint subobject. */
interface GeneConstraint {
  pli: number | null;          // pLI — P(LoF intolerant); >0.9 intolerant
  oe_lof: number | null;       // observed/expected LoF ratio
  oe_lof_lower: number | null; // LOEUF CI lower bound
  oe_lof_upper: number | null; // LOEUF (the headline metric); <0.6 intolerant in v4
  oe_mis: number | null; oe_syn: number | null;
  lof_z: number | null; mis_z: number | null; syn_z: number | null;
  obs_lof: number | null; exp_lof: number | null;
  obs_mis: number | null; exp_mis: number | null;
  obs_syn: number | null; exp_syn: number | null;
}

/** One row of the gnomad_list_gene_variants canvas table. */
interface GeneVariantRow {
  variant_id: VariantId;
  af: number | null; ac: number; an: number;
  consequence: string | null;     // VEP term
  consequence_class: 'lof' | 'missense' | 'synonymous' | 'other';
  homozygote_count: number;
  clinvar_significance: string | null;
  flags: string[];
}

/**
 * gnomad_get_coverage — depth + callability, aggregated per callset track (the
 * as-built shape). gnomAD returns per-position coverage bins upstream; the
 * service summarizes them into one CoverageSummary per track rather than
 * surfacing every position, so the tool returns summaries[], not positions[].
 */
interface CoverageSummary {
  source: 'exome' | 'genome';
  positions: number;                 // number of base positions summarized
  mean_depth: number | null; median_depth: number | null;
  fraction_over_1: number | null; fraction_over_5: number | null; fraction_over_10: number | null;
  fraction_over_15: number | null; fraction_over_20: number | null; fraction_over_25: number | null;
  fraction_over_30: number | null; fraction_over_50: number | null; fraction_over_100: number | null; // mean fraction 0–1
}
```

**Per-ancestry group set differs by callset.** v4 exomes: `afr amr asj eas fin mid nfe sas remaining`. v4 genomes add `ami` (Amish). The handler returns whatever groups the queried callset(s) carry — it does not assume a fixed list. (v2 uses a slightly different group set; the schema returns the dataset's own groups.)

**No server-side record identity.** Every tool is a read against upstream; there is no local mutable state to version. The only identity to track is the canvas `canvas_id` (opaque 10-char token from the framework) holding a spilled variant/ClinVar list.

## Services

| Service | Wraps / owns | Key methods | Used by |
|---|---|---|---|
| `gnomad` (`src/services/gnomad/gnomad-service.ts`) | The gnomAD GraphQL endpoint. Owns the parameterized query documents (one per tool), `reference_genome`-from-`dataset` derivation + pair validation, conservative concurrency, `withRetry` backoff (1–2 s base, tuned for a rate-limited upstream), and typed-response validation. | `getVariant(ids, dataset, refGenome)` → per-id results (batched where the schema allows, else concurrency-limited fan-out with partial success); `getGeneConstraint(gene, …)`; `listGeneVariants(target, filters, …)` → `AsyncIterable<GeneVariantRow>` for spill; `getCoverage(target, …)` | all core tools |
| `clinvar` (`src/services/clinvar/clinvar-service.ts`) — *optional source* | NCBI E-utilities (`esearch` → `esummary`). Honors `NCBI_API_KEY`, 3/10 req·s pacing, backoff. | `searchGene(gene, filters)` → `AsyncIterable<ClinVarRow>` for spill | `gnomad_search_clinvar` |
| canvas accessor (`src/services/canvas-accessor.ts`) | Module-level `getCanvas()` / `setCanvas()` over the framework's optional `DataCanvas` (wired in `createApp({ setup })`). Not a domain service — the access shim the canvas skill prescribes. | `getCanvas()`, `setCanvas(core.canvas)` | `gnomad_list_gene_variants`, `gnomad_search_clinvar`, `gnomad_dataframe_query`, `gnomad_dataframe_describe`, `gnomad_dataframe_drop` |

Each service follows the framework init/accessor pattern (`initGnomadService()` in `setup()`, `getGnomadService()` at request time). Handlers stay pure and throw; the service wraps the full fetch+parse pipeline in `withRetry` so a transient 429/5xx surfaces as `ServiceUnavailable`, not a parse error. The spill path uses the framework `spillover()` helper against the canvas instance — list services expose row producers as `AsyncIterable` so a large gene's variants stream into the table rather than buffering.

## Config

`src/config/server-config.ts` — a lazy-parsed Zod schema, separate from framework config, via `parseEnvConfig` (so errors name the env var, not the schema path).

| Env var | Config field | Required | Default | Purpose |
|---|---|---|---|---|
| `GNOMAD_API_BASE_URL` | `gnomadApiBaseUrl` | no | `https://gnomad.broadinstitute.org/api` | Override the GraphQL endpoint (testing / mirror). |
| `GNOMAD_DEFAULT_DATASET` | `defaultDataset` | no | `gnomad_r4` | Dataset used when a tool call omits `dataset`. |
| `GNOMAD_REQUEST_TIMEOUT_MS` | `requestTimeoutMs` | no | `30000` | Per-request timeout against the GraphQL endpoint. |
| `GNOMAD_MAX_CONCURRENCY` | `maxConcurrency` | no | `2` | Cap on concurrent upstream requests — politeness against a community-funded API. |
| `GNOMAD_MAX_VARIANT_BATCH` | `maxVariantBatch` | no | `25` | Maximum variant IDs accepted per `gnomad_get_variant` call. Validated in Zod (`z.array(…).max(n)`); callers receiving `failed[]` entries for format errors should re-check IDs, not retry the whole batch. |
| `CLINVAR_BASE_URL` | `clinvarBaseUrl` | no | `https://eutils.ncbi.nlm.nih.gov/entrez/eutils` | NCBI E-utilities base (optional ClinVar tool). |
| `NCBI_API_KEY` | `ncbiApiKey` | no | — | Optional NCBI key. Without it, `gnomad_search_clinvar` runs at the 3 req/s keyless cap; with it, 10 req/s. The rest of the server is unaffected. |
| `CANVAS_PROVIDER_TYPE` | (framework) | no | `none` | Set to `duckdb` to enable the DataCanvas spill behind `gnomad_list_gene_variants` / `gnomad_search_clinvar`. When `none`, those tools return a capped inline preview with `spilled: false` and `canvas_id: ''` — the canvas/SQL path is unavailable. `@duckdb/node-api` is a Tier-3 peer dep; not available on Cloudflare Workers. |
| `GNOMAD_DATAFRAME_DROP_ENABLED` | `dataframeDropEnabled` | no | `false` | Gate for the opt-in `gnomad_dataframe_drop` tool. Default off — the tool is conditionally registered and absent from `tools/list` unless this is `true`. Read with `z.stringbool()`. |

No required env vars — the server runs keyless out of the box. ClinVar and canvas are both opt-in via the variables above.

## Implementation Order

Each step is independently buildable and testable.

1. **Config + identity.** `server-config.ts` (schema above); set `createApp` `name`/`title` to `gnomad-genetics-mcp-server`; remove echo definitions; wire the canvas accessor in `setup()`.
2. **`gnomad` service.** GraphQL client + the four query documents (variant, gene constraint, gene/region variants, coverage), `dataset`→`reference_genome` derivation + pair validation, `withRetry`, typed-response Zod parse. Test against a sparse real payload (a variant absent in one ancestry, a gene with null constraint) — required-vs-optional fields must match upstream nullability.
3. **`gnomad_get_variant`** (batch + partial success) and **`gnomad_get_gene_constraint`** — the two scalar read tools. Validate in Zod: `variants` array uses `.max(GNOMAD_MAX_VARIANT_BATCH)` + per-item `.regex(/^[0-9XYM]+-\d+-[ACGT]+-[ACGT]+$/)` (variantId) or `.regex(/^rs\d+$/)` (rsID); `gene` accepts `ENSG…` or a bare symbol with `.min(2)`; `region` uses `.regex(/^[0-9XYM]+-\d+-\d+$/)`. These constraints live in Zod, not only in description prose, so the schema propagates to `inputSchema` clients inspect.
4. **`gnomad_get_coverage`** — depth/callability over a target; exome/genome source switch.
5. **Canvas wiring + `gnomad_list_gene_variants` + the accessor trio** (`gnomad_dataframe_query`, `gnomad_dataframe_describe`, and the opt-in `gnomad_dataframe_drop`) — the spill emitter and its consumers ship together (a `canvas_id` with no query tool is dead output; describe and drop round out the fleet-standard set). Consequence-class + max-AF filters; spill via `spillover()`; degrade to a capped inline preview when canvas is disabled. Register `gnomad_dataframe_drop` only when `GNOMAD_DATAFRAME_DROP_ENABLED=true`.
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

The dependency that matters: an absent result from step 1 is *uninterpretable* without step 3. The prompt makes the coverage step explicit because it is the one analysts skip.

**2. Gene LoF catalog — "show me the rare LoF variants in BRCA2, ranked by frequency."**

| # | Call | Purpose | Cross-tool hop |
|---|---|---|---|
| 1 | `gnomad_list_gene_variants(gene: "BRCA2", consequence_class: "lof", max_af: 0.001)` | Stage every matching variant on a canvas; inline a preview. | Returns `canvas_id` + `table_name` (`gene_variants`). |
| 2 | `gnomad_dataframe_query(canvas_id, sql: "SELECT variant_id, af, consequence FROM gene_variants ORDER BY af DESC LIMIT 50")` | Rank / count / group across the **full** set, not the preview. | **`canvas_id` and `table_name` come only from step 1's output** — the hop is explicit in both schemas. |

**3. Cross-server build-aligned interpretation** — `ensembl_predict_variant` (GRCh38) yields a `chrom-pos-ref-alt` and consequence → `gnomad_get_variant(…, reference_genome: GRCh38)` for frequency. The hop's correctness condition is **build alignment**: both calls on GRCh38, or the coordinates refer to different assemblies. The design surfaces `reference_genome` on every tool and echoes it in output so the mismatch is visible.

**4. Batch frequency screen** — `gnomad_get_variant(variants: [...up to N ids])` returns `found[]` + `failed[]`; the agent acts on the survivors and re-checks the failures' ID formats. No second tool needed — partial success is in the one call.

## Design Decisions

- **`dataset` and `reference_genome` are separate parameters, both echoed in output.** The live GraphQL schema takes them as two distinct enums (`DatasetId`, `ReferenceGenomeId`); idea.md's single "dataset/build" axis would have under-modeled it. The service derives a default `reference_genome` from `dataset` and validates coherence (v4⇒GRCh38), but both are exposed — a frequency from the wrong build silently misleads, so the choice can't be buried in a default.
- **Per-ancestry vector is returned in full, never collapsed.** The whole point of gnomAD for clinical use is that a variant common in one genetic-ancestry group and absent in another is the signal. Each group ships its own AC/AN/AF; the handler returns whatever groups the queried callset carries (exome vs. genome differ by `ami`).
- **ClinVar rides inside gnomAD's variant response for the core; the NCBI tool is optional.** gnomAD joins ClinVar significance per-variant for free, keeping the core keyless and single-source. `gnomad_search_clinvar` (NCBI E-utilities) is a deferred-to-optional extension for gene-panel curation depth, not a core dependency — it's the only thing that adds a second upstream and an optional key.
- **Only the two list tools spill; the spill emitters ship paired with the standardized canvas-accessor trio.** Per-gene variant lists are analytical (rank by AF, count by consequence, group) and can exceed any context budget — the canvas's earns-its-keep test passes on *shape*, not just size. The scalar tools (`get_variant`, `get_gene_constraint`) and `get_coverage` return bounded records and inline directly. A `canvas_id` with no query tool is dead output, so `gnomad_dataframe_query` is mandatory the moment anything spills; `gnomad_dataframe_describe` and the opt-in `gnomad_dataframe_drop` complete the three-tool accessor surface.
- **`gnomad_dataframe_describe` ships, even though the spill tools document their schemas.** The framework canvas guidance (Checklist + simple-shape Tools row) standardizes on describe so an agent can discover staged table/column names. Both spill tools do return a fixed, documented column set (`GeneVariantRow` / ClinVar row) in their own output, which once argued for dropping describe as redundant — but fleet-wide consistency on the canvas-accessor surface wins over the per-server optimization: every analytics server ships the same `query` / `describe` / `drop` trio, so agents and operators meet one predictable shape. Describe also stays correct if the column set ever turns dynamic.
- **Reusing a `canvas_id` REPLACES the staged table — it never accumulates.** Both spill tools register their result under a fixed table name (`gene_variants` / `clinvar_variants`). The framework's `registerTable` is drop-and-create on an existing name (`DROP TABLE IF EXISTS` → `CREATE TABLE`), so passing a prior `canvas_id` back into the same tool overwrites that table with the new call's rows rather than appending. To analyze two genes side by side, query each before re-staging, or use separate canvases — the `canvas_id` input descriptions state this so an agent doesn't assume the two result sets coexist.
- **`gnomad_dataframe_drop` is opt-in, off by default, and conditionally registered.** Dropping a staged table is a mutation (`readOnlyHint: false`); the default-keyless research surface stays read-only, so the tool is gated behind `GNOMAD_DATAFRAME_DROP_ENABLED=true` and never appears in `tools/list` when off. Operators who want manual canvas-memory reclamation flip the flag; everyone else gets a strictly read-only surface. (Per-table TTL already reclaims memory automatically, so drop is a convenience, not a requirement.)
- **`gnomad_get_variant` is batch-with-partial-success; `gnomad_get_gene_constraint` is single-target.** Variant frequency screens commonly need many IDs at once and benefit from one call with `found[]`/`failed[]`. Constraint is looked up one gene at a time in real workflows and gnomAD's gene query is single-gene — no batch payoff.
- **Coverage is its own tool, not folded into `get_variant`.** "Absent" is only meaningful against callability, but coverage is a region-shaped depth profile (many positions × depth thresholds), a fundamentally different output shape from a single variant record. Keeping it separate lets the agent pull it *only* when a variant comes back absent (workflow 1, step 3), rather than paying for a coverage profile on every frequency lookup.
- **`region` / `transcript_id` / `gene` are mutually-exclusive inputs on the list + coverage tools.** All three address "a stretch of the genome"; accepting one of three (validated: exactly one present) keeps the surface tight without three near-duplicate tools.
- **One prompt (`gnomad_variant_triage`), no app tools.** The triage chain is the server's signature workflow and the coverage step is reliably skipped — a structured prompt earns its place. App tools don't: every surface here is read-by-LLM, not scrubbed-by-human in real time, so the iframe/CSP/format-twin cost has no payoff.

## Known Limitations

- **Community-funded rate limits.** gnomAD's API is free but throttles; aggressive use gets 429s. The server caps concurrency (default 2) and backs off, which makes large gene-variant pulls and big batches slower but well-behaved. A hosted instance must not bulk-scrape — the single hosting caveat.
- **v4 constraint is beta.** The gnomAD team labels v4.0 constraint experimental; metrics can shift. The tool surfaces constraint flags/notes and does not present beta numbers as settled. Users wanting an established metric use v2.1.1 constraint.
- **No liftover.** The server does not translate coordinates between GRCh37 and GRCh38 — the caller (or `ensembl`) must supply IDs in the build matching the chosen `dataset`. Mismatches are made *visible* (echoed `reference_genome`) but not auto-corrected.
- **Sparse / null fields are real.** Many variants lack in-silico scores, ClinVar entries, or counts in a given ancestry; many genes have null constraint. Optional-vs-required field modeling follows actual upstream nullability — the server preserves uncertainty and never fabricates a value from a missing field.
- **Exome vs. genome split.** AC/AN, coverage, and the ancestry-group set differ between the exome and genome callsets. The variant record reports which callset(s) carry the variant; coverage exposes an explicit exome/genome source switch. Conflating the two would misstate both frequency and callability.
- **`gnomad_dataframe_query` requires `CANVAS_PROVIDER_TYPE=duckdb`.** Without it the list tools return a capped inline preview with `spilled: false` and `canvas_id: ''`; the canvas/SQL path is unavailable, and unavailable entirely on Cloudflare Workers (DuckDB has no V8-isolate build).

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
- Cross-build liftover; any write / annotation-submission path
- A multi-variant constraint-weighted prioritization workflow tool (could combine list + constraint + coverage into one ranked call) — revisit if a single composite "prioritize variants in this gene" action proves a common ask.
