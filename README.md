<div align="center">
  <h1>@cyanheads/gnomad-genetics-mcp-server</h1>
  <p><b>Ancestry allele frequencies, LoF constraint, variant lists, and coverage from gnomAD, joined with ClinVar clinical significance via MCP. STDIO or Streamable HTTP.</b>
  <div>8 Tools (+1 opt-in) • 2 Resources • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.6.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/gnomad-genetics-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/gnomad-genetics-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/gnomad-genetics-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4%2B-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/gnomad-genetics-mcp-server/releases/latest/download/gnomad-genetics-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=gnomad-genetics-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZ25vbWFkLWdlbmV0aWNzLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22gnomad-genetics-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fgnomad-genetics-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://gnomad-genetics.caseyjhand.com/mcp](https://gnomad-genetics.caseyjhand.com/mcp)

</div>

---

## Overview

Population genetics over gnomAD (Broad Institute), with ClinVar clinical significance joined in from NCBI. Look up per-ancestry allele frequencies, gene loss-of-function constraint, gene variant catalogs, and sequencing coverage, then query large result sets with SQL.

### Tools

| Tool | Description |
|:---|:---|
| `gnomad_get_variant` | Full population record for one or more variants — AC/AN/AF overall and per genetic-ancestry group, filtering allele frequency (`faf95`), homozygote/hemizygote counts, quality flags, per-callset counts and QC status, transcript consequence, in-silico predictors, and joined ClinVar significance. |
| `gnomad_get_variant_cooccurrence` | Whether two variants in one gene sit in trans or in cis — the probability of compound heterozygosity with the genotype and haplotype counts behind it, overall and per ancestry group. GRCh37 IDs only; always reads `gnomad_r2_1`. |
| `gnomad_get_gene_constraint` | Gene loss-of-function constraint — pLI, LOEUF (`oe_lof_upper`) with confidence interval and percentile, observed/expected ratios with missense and synonymous intervals, and Z-scores; mitochondrial genes return their own constraint. By HGNC symbol or Ensembl gene ID. |
| `gnomad_list_gene_variants` | Every variant in a gene, transcript, or region with allele frequencies, filtering allele frequencies, zygosity counts, predicted consequences, and QC status, filterable by consequence class, LOFTEE confidence, max allele frequency, max filtering allele frequency, and QC pass, paged by offset. |
| `gnomad_get_coverage` | Sequencing coverage across a gene, transcript, or region — mean/median depth and the fraction of samples over depth thresholds, per callset track. |
| `gnomad_search_clinvar` | Gene-level ClinVar detail via NCBI E-utilities — germline classification, review status, and conditions, plus somatic oncogenicity and clinical-impact classifications, submission counts, and gnomAD-compatible variant IDs, paged by offset. |
| `gnomad_dataframe_query` | Run a read-only SQL `SELECT` across canvas tables staged by the list tools. Listed only while the canvas is on. |
| `gnomad_dataframe_describe` | List the tables staged on a canvas and their columns before writing SQL. Listed only while the canvas is on. |
| `gnomad_dataframe_drop` | Drop a named table from a canvas to reclaim memory. Opt-in via `GNOMAD_DATAFRAME_DROP_ENABLED=true` — off by default, and listed only while the canvas is on. |

### Resources

| Resource | Description |
|:---|:---|
| `gnomad://variant/{dataset}/{variantId}` | Population record for one variant — mirrors `gnomad_get_variant`. |
| `gnomad://gene/{dataset}/{gene}/constraint` | Gene loss-of-function constraint — mirrors `gnomad_get_gene_constraint`. |

All resource data is also reachable via tools. The list tools (`gnomad_list_gene_variants`, `gnomad_get_coverage`, `gnomad_search_clinvar`) return analytical row sets rather than stable single-URI documents, so they are not exposed as resources — call the tools instead.

Upstream-backed tools and resource reads share one fixed 45 s deadline across queue waits, retries, response bodies, and chained requests. A variant batch shares that deadline across every item: completed results remain available and unfinished primary items report `upstream_timeout`. Caller cancellation rejects the call.

### Prompts

| Prompt | Description |
|:---|:---|
| `gnomad_variant_triage` | Guided rare-disease variant-triage workflow: population frequency → gene constraint → callability check, in order. |

### Datasets

`dataset` takes 14 values; `reference_genome` follows from it.

| Release | Build | Subsets |
|:--|:--|:--|
| `gnomad_r4` (default) | GRCh38 | `gnomad_r4_non_ukb` |
| `gnomad_r3` | GRCh38 | `gnomad_r3_controls_and_biobanks`, `gnomad_r3_non_cancer`, `gnomad_r3_non_neuro`, `gnomad_r3_non_topmed`, `gnomad_r3_non_v2` |
| `gnomad_r2_1` | GRCh37 | `gnomad_r2_1_controls`, `gnomad_r2_1_non_neuro`, `gnomad_r2_1_non_cancer`, `gnomad_r2_1_non_topmed` |
| `exac` | GRCh37 | — |

A subset keeps part of its parent release's samples (`non_cancer` leaves out cancer-study samples, `non_ukb` UK Biobank's) and can leave a callset unchanged: `gnomad_r4_non_ukb` genome counts equal `gnomad_r4`'s, and `gnomad_r2_1_non_cancer` genome counts equal `gnomad_r2_1`'s. No subset publishes joint exome + genome data, so its overall counts sum the carried callsets. gnomAD publishes no subset coverage or constraint, so `gnomad_get_coverage` and `gnomad_get_gene_constraint` read the parent release. A variant absent from a subset fails as `variant_not_found`, the same as one absent from gnomAD.

## Capability reference

### `gnomad_get_variant` <sub>tool</sub>

- Up to 25 IDs per call (raise via `GNOMAD_MAX_VARIANT_BATCH`), each a `chrom-pos-ref-alt` variantId on chromosome `1`–`22`, `X`, or `Y` with an optional `chr` prefix (e.g. `1-55051215-G-GA`) or an rsID (e.g. `rs11591147`). With `GNOMAD_NORMALIZE_IDS` on, an rsID is matched case-insensitively and a colon-separated ID (`1:55039974:G:T`, `chr1:…`) reads as `1-55039974-G-T`; `failed[].variant` keeps the caller's spelling
- A bad or absent ID lands in `failed[]` as `{ variant, error, reason, recovery }` without failing the rest; mitochondrial IDs (`M`, `MT`, `chrM`) fail as `mitochondrial_unsupported`, and an ambiguous rsID adds `candidates`. A coordinate ID carries no build: an absent one whose string also lifts over from the other build fails as `variant_not_found_other_build`, with the IDs it lifts to on the dataset's build in `candidates`. The lift is a hint — the server never rewrites or retries the ID — and costs one extra request per 25 absent coordinate IDs (one at the default batch cap), sent after the lookups and only when a coordinate ID came back absent; rsIDs are never lifted
- Returns the full per-ancestry frequency vector, the callset(s) carrying the variant, quality flags, consequence, predictor scores, and ClinVar significance. A validated population record survives ClinVar-only failure or expiry with `clinvar: null` and `clinvar_unavailable: true`
- On `gnomad_r4`, overall `ac`, `an`, `af`, and zygosity counts come from gnomAD's joint exome + genome data, whose `an` spans every callable sample in both callsets, even for a variant only one callset carries; `joint_populations` holds the same view per ancestry group. Every other dataset publishes no joint data (`gnomad_r4_non_ukb` and the other subsets, `gnomad_r3`, `gnomad_r2_1`, `exac`): it sums the carried callsets, a QC-failed callset included, and returns an empty `joint_populations`; `callsets` carries each one's own counts and filters. `populations` stays per callset, tagged by `source`
- `callsets.exome` and `callsets.genome` give each callset's own `ac`, `an`, `af`, zygosity counts, and QC `filters` (empty when that callset passed; the callset is null when it does not carry the variant). `qc_status` is `pass` when any callset carrying the variant passed, else `filtered` — gnomAD's browser rule. A filtered variant stays in `found[]`; its counts are low-confidence (`AC0`: no high-quality carrier)
- `faf95` is gnomAD's filtering allele frequency (GroupMax FAF95: the lower bound of the 95% confidence interval of the AF of the ancestry group with the highest bound, over non-bottlenecked groups) as `{ value, group, source }`, the figure to test against a disease threshold such as ACMG/AMP BA1 or BS1, which raw `af` is not. It reads gnomAD's joint value wherever a joint record exists (`gnomad_r4`), a null included, and otherwise the higher of the carried callsets' values, `source` naming which; each `callsets.*.faf95` is that callset's own `{ value, group }`. It is null when gnomAD reports none (AC 0, singletons, `exac`) and on `gnomad_r4` and `gnomad_r3` subsets, whose variant record carries the parent release's value rather than the subset's; a notice then names the parent. Read a subset's own value from `faf95_max` on `gnomad_list_gene_variants`, which `gnomad_r4_non_ukb` carries (`gnomad_r3` subsets carry none)
- `consequence` is the most severe term across transcripts, as gnomAD shows it, and `transcript_id` the isoform it sits on. `hgvsc`, `hgvsp`, `lof` (LOFTEE's call: HC high-confidence, LC low-confidence, or OS other splice), `lof_filter` (e.g. `END_TRUNC`), and `lof_flags` (e.g. `PHYLOCSF_WEAK`) describe that `transcript_id`, each null when there is none. `primary_transcript` gives the term on that gene's MANE Select transcript (its canonical one where there is none, as on GRCh37), with `is_mane_select`, `hgvsc`, `hgvsp`, `lof`, `lof_filter`, and `lof_flags`: a `stop_gained` on a minor isoform can be a 3′ UTR change on the MANE transcript. It is null when the variant lies outside both transcripts, as on an exon only minor isoforms carry. It is read from the same reply, at no extra request
- `lof_curations[]` holds gnomAD's manual loss-of-function curations of the variant, each `{ gene_id, gene_symbol, verdict, flags, project }`; it is empty for most variants, and a curation can overturn LOFTEE (a variant LOFTEE calls `HC` can carry a `Not LoF` verdict)
- Inspect each `failed[].reason`: only `variant_not_found` and `variant_not_found_other_build` report absence from the chosen dataset; timeouts and other failures leave presence unknown. On `variant_not_found_other_build`, settle the build first — retry with a candidate if the ID was written for the other build — then check `gnomad_get_coverage` before interpreting an absent variant. A lift does not prove a wrong-build ID: a valid ID truly absent from the dataset can lift too. A string valid on both builds can name a different variant on each, and that lookup succeeds with no sign of it, so keep IDs on the dataset's build

---

### `gnomad_get_variant_cooccurrence` <sub>tool</sub>

- Takes `variants`, exactly two GRCh37 `chrom-pos-ref-alt` IDs on chromosome `1`–`22`, `X`, or `Y` (one or three IDs are rejected as invalid input; an rsID or malformed ID fails as `invalid_variant_id` and a mitochondrial ID as `mitochondrial_unsupported`, both before any request). It takes no `dataset` or `reference_genome` and always reads `gnomad_r2_1`, the only dataset gnomAD serves co-occurrence for (every subset and every other release is refused); the output echoes `dataset: gnomad_r2_1` and `reference_genome: GRCh37`. A GRCh38 ID can name a different GRCh37 variant or none: convert it first with `gnomad_get_variant` on `gnomad_r2_1`, which lists GRCh37 `candidates` for it only when the ID fails there as `variant_not_found_other_build` (an ID `gnomad_r2_1` finds is a different variant)
- Estimates whether the pair sits on different haplotypes (in trans, compound heterozygous) or the same one (in cis) from gnomAD v2.1 exome genotypes, for a proband with two rare heterozygous variants in a recessive gene and no parental samples. Returns `p_compound_heterozygous` (null stays null, never 0), `genotype_counts` (`ref_ref` through `hom_hom`), `haplotype_counts` (`ref_ref`, `ref_alt`, `alt_ref`, `alt_alt`; fractional expectation-maximization (EM) estimates, unrounded), and `populations[]` with the same three fields per ancestry group (`afr`, `amr`, `asj`, `eas`, `fin`, `nfe`, `oth`, `sas`)
- Every count key names `variant_ids[0]`'s genotype or allele first and `variant_ids[1]`'s second. `variant_ids` is the pair in gnomAD's order, which can differ from the order sent, so read it before the counts
- A `notice` is on every result: the overall reading of the pair (likely in trans, likely in cis, or no prediction and why), gnomAD's browser rule (above 0.55 trans, below 0.02 cis, no prediction between, when null, or when both variants are singletons seen in the same individual; each ancestry group reads the same way), and gnomAD's caveat that the probabilities are not well calibrated, particularly where both variants are extremely rare. Where no sample carries both variants, the notice adds that the counts were computed from each variant's separate data and do not account for samples that may not be covered at both sites
- gnomAD answers only for two different coding or UTR variants of one gene, both in its exome samples with exome allele frequency of 5% or less. Any other pair fails as `cooccurrence_unavailable` with gnomAD's own sentence after one request, with no retry. gnomAD's browser also flags a pair found in phase as a multi-nucleotide variant; this tool does not check
- Other typed errors: `graphql_error`, `upstream_unavailable`, `upstream_timeout`, `upstream_access`, and `invalid_upstream_response`, each with a recovery hint

---

### `gnomad_get_gene_constraint` <sub>tool</sub>

- Accepts an HGNC symbol (`PCSK9`) or an Ensembl gene ID (`ENSG00000169174`)
- Returns pLI (>0.9 intolerant), LOEUF / `oe_lof_upper` with its lower bound and `oe_lof_percentile`, observed/expected ratios for LoF / missense / synonymous (`oe_mis` and `oe_syn` with 90% intervals as `oe_mis_lower` / `oe_mis_upper` and `oe_syn_lower` / `oe_syn_upper`), the three Z-scores, and `constraint_flags` (e.g. `no_exp_lof`, `syn_outlier`)
- `oe_lof_percentile` is gnomAD's LOEUF percentile bin among gnomAD v4.1.2 MANE Select transcripts, an integer 0–100 where lower is more constrained (KMT2A is 0, FLG 98). Only v4.1.2 publishes it, so it is null on `gnomad_r2_1`, its subsets, and `exac`, and wherever LOEUF is null
- `constraint_release` names the release the metrics come from. gnomAD publishes no subset constraint, so a subset reads its parent release's table and the output echoes the subset as `dataset`. Many genes have null constraint, reported as null:

  | `dataset` | Source | `constraint_release` | LoF-intolerance guidance |
  |:--|:--|:--|:--|
  | `gnomad_r4`, `gnomad_r4_non_ukb` | GRCh38 gnomAD constraint | `gnomAD v4.1.2` | LOEUF < 0.45 |
  | `gnomad_r3` and its subsets | GRCh38 gnomAD constraint (gnomAD publishes no v3 constraint) | `gnomAD v4.1.2` | LOEUF < 0.45 |
  | `gnomad_r2_1` and its subsets | GRCh37 gnomAD constraint | `gnomAD v2.1.1` | LOEUF < 0.35 |
  | `exac` | GRCh37 ExAC constraint | `ExAC r0.3` | pLI only |

- On `exac` the ratios, their intervals, LOEUF, and the LOEUF percentile are null and `constraint_flags` is empty
- A mitochondrial gene (`MT-CO1`, `MT-TL1`) has no nuclear constraint. gnomAD's mitochondrial constraint comes back in `mitochondrial_constraint`, a union tagged by `kind` and null for every nuclear gene. `kind: "protein"` carries `obs_`/`exp_`/`oe_` values with `oe_*_lower` / `oe_*_upper` intervals for `lof` (stop-gain SNVs only), `mis`, and `syn`; `kind: "rna"` (tRNA and rRNA genes) carries `observed`, `expected`, `oe`, `oe_lower`, and `oe_upper` over all SNVs. The values come from 56,434 gnomAD v4.1 genomes and are sums of maximum heteroplasmy over every possible SNV, not variant counts; the intervals are 90% bounds, gnomAD reads the upper bound (OEUF) as the conservative measure, and the nuclear LOEUF thresholds do not apply. It is the same table on every dataset, `exac` included, and `constraint_release` does not label it

---

### `gnomad_list_gene_variants` <sub>tool</sub>

- Supply exactly one of `gene`, `transcript_id`, or `region` (`chrom-start-stop`, 1-based inclusive, chromosome `1`–`22`, `X`, or `Y` with an optional `chr` prefix); a blank `gene` or `transcript_id` counts as omitted. With `GNOMAD_NORMALIZE_IDS` on, a `chrom:start-stop` region (thousands separators allowed) and a lowercase or versioned Ensembl gene or transcript ID are rewritten to the accepted form
- A region must span less than 2,500,000 bp and hold at most ~30,000 variants, otherwise it fails as `invalid_region` or `region_too_large`; mitochondrial targets fail as `mitochondrial_unsupported`. An unknown gene or transcript fails as `gene_not_found` / `transcript_not_found`, naming the reference build; a known gene with no matching rows returns `total: 0` with a no-match notice. RefSeq transcript IDs (`NM_…`) are not served
- Optional filters: one `consequence_class`, a maximum allele frequency (`max_af`), a maximum filtering allele frequency (`max_faf`, 0–1), and/or a LOFTEE confidence (`lof_confidence`: `HC` or `LC`). The classes are gnomAD's own categories: `lof` (pLoF: transcript ablation, splice acceptor/donor, stop gained, frameshift), `missense` (missense, inframe insertion/deletion, start lost, stop lost), `synonymous`, and `other` (every other term, and a null consequence)
- Each row names the `transcript_id` its `consequence` is on. On a gene target, `consequence_transcript` marks it as gnomAD's gene table does (†): `mane_select`, `canonical` (a gene without a MANE Select, as on GRCh37), or `other` when the consequence is on another isoform — check `primary_transcript` on `gnomad_get_variant` before reading such a row as truncating. It is null on transcript and region targets. `lof` is LOFTEE's call on that `transcript_id` (`HC`, `LC`, or `OS` other splice; null when LOFTEE made none), so on a row whose `consequence_transcript` is `other` it is a minor isoform's call; it is distinct from `consequence_class: lof`, which reads the consequence term. `lof_confidence` keeps rows whose `lof` equals it, and null and `OS` rows match neither
- Each row carries `hemizygote_count` (0 off X/Y; null when no summed record reports one) beside `homozygote_count`, and `faf95_max` with its ancestry group `faf95_max_group`: gnomAD's filtering allele frequency (GroupMax FAF95), the value to test against a disease threshold such as ACMG/AMP BA1 or BS1. It is gnomAD's joint value on `gnomad_r4` (the same figure as `faf95` on `gnomad_get_variant`), the subset's own highest callset value on `gnomad_r4_non_ukb`, and the higher callset value on `gnomad_r2_1` and its subsets. It is null when gnomAD reports none (AC 0, singletons) and on every row of `gnomad_r3`, its subsets, and `exac`. `max_faf` keeps rows with `faf95_max` at or below its value and always keeps rows with a null `faf95_max`; a notice counts the kept rows it could not test, or says it filtered nothing where the dataset carries no FAF
- Each row carries `exome_filters` and `genome_filters` (pipe-joined QC filters; `""` when that callset passed, null when it does not carry the variant) and `qc_status` (`pass` / `filtered`, gnomAD's browser rule). `qc_filtered` counts the matching rows that failed QC in every callset carrying them — in PCSK9 on `gnomad_r4`, 1,499 of 4,544 as of November 2026. Rows stay listed by default; `pass_only: true` drops them after the count and, on a row without joint data (every dataset but `gnomad_r4`, `gnomad_r4_non_ukb` included), reads `ac`, `an`, `af`, `homozygote_count`, `hemizygote_count`, and `faf95_max` from the callsets that passed QC only, as gnomAD's browser table does — `max_af` and `max_faf` then filter on those values. `gnomad_r4` rows keep their joint counts either way
- Pages with `offset` (default 0) and `limit` (default 25; a larger value is clamped to 3,000 with a notice, or rejected with `GNOMAD_CLAMP_LIMITS=false`). `total` counts every variant the filters keep, and `truncated` / `next_offset` say whether more remain (follow `next_offset` until `null`). Filters run before paging. gnomAD returns a target only whole, so each page re-fetches it: page a large gene with filters and a large `limit`
- At `offset` 0, a result too large to inline is also staged on the `gene_variants` canvas table, holding every matching variant, and returned as `canvas_id` and `table_name`; inspect it with `gnomad_dataframe_describe` and query it with `gnomad_dataframe_query`. Passing a `canvas_id` at offset 0 always writes `gene_variants` there, replacing the previous table. A page past offset 0 never stages and leaves a supplied canvas's table as it was. With the canvas off (`CANVAS_PROVIDER_TYPE=none`), every row of each page is returned inline
- `annotations: true` appends five columns describing each row's `transcript_id` after every default column, on the rows and in the staged `gene_variants` table: `hgvsc`, `hgvsp`, `lof_filter`, `lof_flags` (nullable strings), and `rsids` (dbSNP rsIDs pipe-joined, `''` when none; `gnomad_search_clinvar` joins its `rsids` with semicolons). Without it the five are absent, not null. It is a column toggle, not a filter. A reused `canvas_id` takes the new call's shape, so call `gnomad_dataframe_describe` before writing SQL after switching it
- Echoes `target`, `target_kind` (as `gnomad_get_coverage` does), and `filters` (`consequence_class`, `lof_confidence`, `max_af`, `max_faf`, `pass_only`, each null when unset; `annotations` is not a filter)

---

### `gnomad_get_coverage` <sub>tool</sub>

- Supply exactly one of `gene`, `transcript_id`, or `region` (same `chrom-start-stop` form and 2,500,000 bp limit as `gnomad_list_gene_variants`); a blank `gene` or `transcript_id` counts as omitted. Bad regions fail as `invalid_region` or `region_too_large`, mitochondrial targets as `mitochondrial_unsupported`, and an unknown gene or transcript as `gene_not_found` / `transcript_not_found`, naming the reference build. `target` echoes the resolved target (e.g. `ENST00000302118` for `enst00000302118` or `ENST00000302118.5`)
- Returns mean and median read depth plus the mean fraction of samples covered at each threshold (1× through 100×), summarized per callset track, with `bucket_size`, `bucket_count`, observed `positions`, total `target_positions`, and unobserved `missing_positions` for each. Missing bases leave callability unknown; statistics describe only returned buckets, with no invented zero depths
- `coverage_source` narrows to one track (`exome` / `genome`); omit to return every available track
- Notices disclose partial targets and missing supported tracks. An explicitly requested unsupported track is identified separately (`gnomad_r3` has genome only; ExAC has exome only)
- gnomAD publishes no coverage for subsets, so a subset `dataset` reads its parent release (`gnomad_r4_non_ukb` reads `gnomad_r4`) over all of the parent's samples. `dataset` echoes the requested value, `coverage_dataset` names the release read (equal to `dataset` for a release), and the first notice says the figures are the parent's, not the subset's alone. Track notices and the unsupported-track check name the parent

---

### `gnomad_search_clinvar` <sub>tool</sub>

- Takes an HGNC symbol only (an Ensembl gene ID returns guidance and searches nothing). Optional filters: `clinical_significance` and `min_review_stars` (0–4), both reading the germline classification only; somatic classifications are never matched. `clinical_significance` is case-insensitive and reads underscores as spaces. `pathogenic`, `likely pathogenic`, `uncertain significance`, `vus`, `likely benign`, `benign`, and `conflicting` search ClinVar's own classification index, so on their own their windows hold matching records only and `total_found` is the match count. `pathogenic` includes likely-pathogenic, combined, and low-penetrance classifications; `vus` adds VUS-high, VUS-mid, and VUS-low to Uncertain significance; `benign` includes Likely benign. Any other term (e.g. `risk factor`) is a whole-word filter over a text search, so its windows can return fewer rows than `limit`. `min_review_stars` also leaves short windows: ClinVar's review-status search matches the review status of a somatic classification too, and those records are dropped after the fetch. With a star floor or any other term, `total_found` is a candidate count
- Returns the germline `clinical_significance`, `review_status` with a 0–4 `gold_stars` rating, `last_evaluated`, and `conditions`; the somatic `oncogenicity_*` and `clinical_impact_*` classifications (each with `_classification`, `_review_status`, `_last_evaluated`, and `_conditions` as tumor types, null or empty when the record has none, and no star rating derived); molecular consequences; submission counts; and gnomAD-compatible identifiers (`canonical_spdi`, `rsids`, `grch38_variant_id`). The somatic classifications are separate columns, never folded into `clinical_significance`. IDs ClinVar has no summary for are listed in `unavailable_ids`
- `grch38_variant_id` is derived from the SPDI for SNVs, MNVs, and delins. For deletions, insertions, and duplications it is taken from gnomAD's own ClinVar mapping by ClinVar VariationID, filled with one extra gnomAD request per window inside the call's shared deadline. Most of those indel IDs are absent from gnomAD's callsets, so `gnomad_get_variant` answers `variant_not_found` (absence evidence to pair with `gnomad_get_coverage`). It is null for mitochondrial, multi-allele, copy-number, and imprecise structural records and for records newer than gnomAD's ClinVar release, which lags NCBI's; a notice says so when the mapping request failed or ran out of time. Pass it to `gnomad_get_variant` on a GRCh38 dataset (`gnomad_r4`, `gnomad_r3`, or one of their subsets)
- Pages with `offset` / `limit` (default 10; a `limit` above 1,500 is clamped to 1,500 with a notice, and `GNOMAD_CLAMP_LIMITS=false` rejects it instead); `total_found`, `truncated`, and `next_offset` say whether more remain. `limit` counts the records a window fetches; a window returns fewer rows when the post-fetch filter drops some, as with `min_review_stars` or a significance term outside the seven above, or when an ID lands in `unavailable_ids`
- A window too large to inline is staged on the `clinvar_variants` canvas table (query it with `gnomad_dataframe_describe` and `gnomad_dataframe_query`); passing a `canvas_id` always writes it there, replacing the previous table. With the canvas off (`CANVAS_PROVIDER_TYPE=none`, as in the `.mcpb` bundle), every row of the window is returned inline, so `limit` is the only page boundary. `NCBI_API_KEY` raises the rate limit from 3 to 10 req/s
- Echoes `gene` and `filters` (`clinical_significance` as applied: lowercased, underscores as spaces; `min_review_stars`). An omitted or blank filter is `null`, and `content[]` renders `**Filters:** none` when every filter is null

---

### `gnomad_dataframe_query` <sub>tool</sub>

- Runs single-statement, read-only SQL `SELECT`s against a table staged by `gnomad_list_gene_variants` or `gnomad_search_clinvar` (`gene_variants` or `clinvar_variants`); writes, DDL, and file/HTTP table functions are rejected
- Pages with `offset` (default 0) and `limit` (default 25; a larger value is clamped to 3,000 with a notice, or rejected with `GNOMAD_CLAMP_LIMITS=false`); returns `rows`, `columns`, `total`, `truncated`, and `next_offset` (follow it until `null`). A page reads at most `limit` rows and ends before a row that would take its row JSON past 4,000,000 characters. Use an `ORDER BY` on a unique key for stable paging, and filter or aggregate in SQL to get past the `CANVAS_DEFAULT_ROW_LIMIT` cap (10,000 by default)
- A first row over 4,000,000 characters of JSON fails with `row_too_large`; select fewer columns or cut long text with `substr`
- `BIGINT` values (staged counts such as `ac` and `an`, and `COUNT(*)`) arrive as JSON strings to keep precision; `CAST(col AS INTEGER)` returns a number
- Listed only while the canvas is on: with `CANVAS_PROVIDER_TYPE=none` it is absent from `tools/list`

---

### `gnomad_dataframe_describe` <sub>tool</sub>

- Lists every table staged on a canvas with its row count and column schema (name and DuckDB type)
- Call it before writing SQL for `gnomad_dataframe_query`
- Lists tables only, not the views a running `gnomad_dataframe_query` call holds
- Listed only while the canvas is on: with `CANVAS_PROVIDER_TYPE=none` it is absent from `tools/list`

---

### `gnomad_dataframe_drop` <sub>tool</sub>

- Drops a named table from a canvas to reclaim memory (`destructiveHint: true`)
- Opt-in via `GNOMAD_DATAFRAME_DROP_ENABLED=true` and the canvas on; absent from `tools/list` when either is off
- An unknown or expired `canvas_id` fails as `canvas_not_found`

---

### `gnomad://variant/{dataset}/{variantId}` <sub>resource</sub>

- Population record for one variant as `application/json`, mirroring `gnomad_get_variant`; `variantId` takes a chrom-pos-ref-alt ID or an rsID. On a `gnomad_r4` or `gnomad_r3` subset segment `faf95` and each callset's `faf95` are null and no notice says why (a resource carries none); read the parent's segment for its `faf95`
- Typed errors: `invalid_variant_id`, `mitochondrial_unsupported`, `variant_not_found`, `variant_not_found_other_build` (with `candidates`), `ambiguous_rsid` (with `candidates`), `graphql_error`, `upstream_build_mismatch`, `upstream_unavailable`, `upstream_timeout`, `upstream_access`, and `invalid_upstream_response`, each with a recovery hint

---

### `gnomad://gene/{dataset}/{gene}/constraint` <sub>resource</sub>

- Gene loss-of-function constraint as `application/json`, mirroring `gnomad_get_gene_constraint` (same `constraint_release` per `dataset`, a subset reading its parent's table, and the same `mitochondrial_constraint`); `gene` takes an HGNC symbol or Ensembl gene ID
- Typed errors: `gene_not_found`, `invalid_constraint_data`, `graphql_error`, `upstream_unavailable`, `upstream_timeout`, `upstream_access`, and `invalid_upstream_response`, each with a recovery hint

---

### `gnomad_variant_triage` <sub>prompt</sub>

- Arguments: `variant` required (chrom-pos-ref-alt or rsID; a malformed one is rejected); `gene` and `dataset` optional. `dataset` is any of the 14 values listed under [Datasets](#datasets), and the server default applies when omitted or blank; a subset reads its parent release's coverage and constraint
- Emits a three-step chain as one user message: population frequency (`gnomad_get_variant`, checking `qc_status` and each callset's `filters` first, then comparing `faf95` rather than raw AF against the disease's frequency threshold) → gene constraint (`gnomad_get_gene_constraint`) → callability check, which first settles the build when step 1 reports `variant_not_found_other_build`, then runs `gnomad_get_coverage` on the exact position

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

gnomAD-specific:

- Single keyless GraphQL source for the entire core surface — ClinVar significance is joined per variant inside gnomAD's own response
- `dataset` and `reference_genome` are distinct, coherence-validated parameters (v4, v3, and their subsets ⇒ GRCh38; v2.1, its subsets, and ExAC ⇒ GRCh37); both are echoed in the output of every gnomAD-data tool so a wrong-build coordinate mismatch is visible. `gnomad_get_variant_cooccurrence` takes neither and echoes `gnomad_r2_1` and `GRCh37`
- Polite client — conservative concurrency cap (`GNOMAD_MAX_CONCURRENCY`, default 2) and exponential backoff against a community-funded, rate-limited API
- In-conversation SQL analytics: `gnomad_list_gene_variants` and `gnomad_search_clinvar` stage results too large to inline on a DuckDB-backed canvas table — `gnomad_dataframe_describe` lists its columns, `gnomad_dataframe_query` runs SQL over every row

Agent-friendly output:

- Per-ancestry allele-frequency vector returned in full, never collapsed to a single global AF
- gnomAD's per-callset QC filters and a `qc_status` on every variant record and list row, with QC-failed rows kept and counted rather than hidden
- `gnomad_get_variant` returns per-item `failed[]` rows instead of failing the whole batch
- Effective `dataset` and `reference_genome` echoed on every gnomAD-data response; null upstream fields stay null
- Every error carries a typed `reason` (e.g. `incoherent_build`, `invalid_target`, `variant_not_found`, `upstream_timeout`, `canvas_disabled`) and a recovery hint

## Getting started

Connect to the hosted instance, no install:

```sh
claude mcp add --transport http gnomad-genetics-mcp-server https://gnomad-genetics.caseyjhand.com/mcp
```

Or run it locally:

```sh
claude mcp add gnomad-genetics-mcp-server -- npx -y @cyanheads/gnomad-genetics-mcp-server
```

For other clients, add this to the MCP config file:

```json
{
  "mcpServers": {
    "gnomad-genetics-mcp-server": {
      "command": "npx",
      "args": ["-y", "@cyanheads/gnomad-genetics-mcp-server"]
    }
  }
}
```

gnomAD is keyless. An optional `NCBI_API_KEY` raises the `gnomad_search_clinvar` rate limit. DuckDB-backed SQL is enabled by default; `CANVAS_PROVIDER_TYPE=none` disables it. The Claude Desktop bundle ships without native bindings and runs with canvas off.

For Docker or a source build, see [Running the server](#running-the-server).

## Configuration

All variables are optional; the server runs keyless with the defaults below.

Node and Bun load the working directory's `.env` before building tool definitions. Exported values take precedence; blank values use the schema defaults. The advertised variant cap, its input validation, the `limit` schemas, and the dataframe-tool registration gates use those same settings. Invalid server configuration fails startup with a banner naming the variable; `DEBUG=true` includes the stack.

| Variable | Description | Default |
|:---------|:------------|:--------|
| `GNOMAD_API_BASE_URL` | gnomAD GraphQL endpoint. Override for a private mirror or testing. | `https://gnomad.broadinstitute.org/api` |
| `GNOMAD_DEFAULT_DATASET` | Dataset used when a tool call omits `dataset` (`gnomad_r4`, `gnomad_r3`, `gnomad_r2_1`, `exac`, or one of the ten subsets listed under [Datasets](#datasets)). | `gnomad_r4` |
| `GNOMAD_REQUEST_TIMEOUT_MS` | Per-attempt gnomAD/NCBI timeout in milliseconds, bounded by the shared 45 s call deadline. | `30000` |
| `GNOMAD_MAX_CONCURRENCY` | Cap on concurrent upstream requests — politeness against a community-funded API. | `2` |
| `GNOMAD_MAX_VARIANT_BATCH` | Maximum variant IDs accepted per `gnomad_get_variant` call. | `25` |
| `CLINVAR_BASE_URL` | NCBI E-utilities base URL for `gnomad_search_clinvar`. | `https://eutils.ncbi.nlm.nih.gov/entrez/eutils` |
| `NCBI_API_KEY` | Optional NCBI key. Raises the E-utilities rate limit from 3 to 10 req/s. | — |
| `CANVAS_PROVIDER_TYPE` | DataCanvas backend for the spill/SQL path behind the list tools. `none` disables it: `gnomad_list_gene_variants` then returns every row of each `offset`/`limit` page inline, `gnomad_search_clinvar` every row of its window, and the dataframe tools are not registered. | `duckdb` |
| `GNOMAD_DATAFRAME_DROP_ENABLED` | Gate for the opt-in `gnomad_dataframe_drop` tool. Off by default; the tool also requires the canvas on. | `false` |
| `GNOMAD_CLAMP_LIMITS` | When true, a `limit` above its tool's cap is clamped to the cap with a notice. `false` advertises the cap as the schema maximum and rejects larger values. | `true` |
| `GNOMAD_NORMALIZE_IDS` | Rewrite identifier spellings with one clear reading before validation: an uppercase rsID to lowercase, a colon-separated variant ID or region (thousands separators allowed in a region) to `chrom-pos-ref-alt` / `chrom-start-stop`, and a lowercase or versioned Ensembl gene or transcript ID to its unversioned uppercase form. Each rewrite is logged and counted (`gnomad.identifiers.normalized`). `false` restores strict rejection. | `true` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

Requires [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).

- **Clone and install:**

  ```sh
  git clone https://github.com/cyanheads/gnomad-genetics-mcp-server.git
  cd gnomad-genetics-mcp-server && bun install
  cp .env.example .env   # all variables are optional
  ```

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t gnomad-genetics-mcp-server .
docker run --rm -e MCP_TRANSPORT_TYPE=http -p 3010:3010 gnomad-genetics-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/gnomad-genetics-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools/resources/prompts and inits services. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`) and shared input schemas. |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). |
| `src/mcp-server/prompts` | Prompt definitions (`*.prompt.ts`). |
| `src/services/gnomad` | gnomAD GraphQL client, query documents, and domain types. |
| `src/services/clinvar` | NCBI E-utilities client for the optional ClinVar tool. |
| `src/services/canvas-accessor.ts` | Module-level accessor for the framework's optional DataCanvas. |

## Development guide

See [`CLAUDE.md`/`AGENTS.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources in the `createApp()` arrays in `src/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Data attribution

gnomAD data is provided by the [Genome Aggregation Database](https://gnomad.broadinstitute.org) (Broad Institute). ClinVar data is provided by [NCBI](https://www.ncbi.nlm.nih.gov/clinvar/).

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
