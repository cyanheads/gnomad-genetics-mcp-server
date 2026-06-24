# gnomad-genetics-mcp-server — Idea & Design

Human population genetics over [gnomAD](https://gnomad.broadinstitute.org) (the Genome Aggregation Database, Broad Institute) — the reference everyone in human genetics reaches for to answer **"how common is this variant, and how tolerant is this gene to being broken?"** Population allele frequencies broken down by ancestry, gene-level loss-of-function constraint (pLI / LOEUF), per-gene variant catalogs, and sequencing coverage — with ClinVar clinical significance joined in. Keyless GraphQL, openly licensed.

Complements `ensembl` (which annotates *what* a variant does — consequence, VEP) with the two things clinical and rare-disease genetics actually gate on: **population frequency** (is it rare enough to be pathogenic?) and **gene constraint** (is this gene intolerant to loss-of-function?). Together they turn "this variant exists" into "this variant is plausibly causal."

**Audience:** Clinical geneticists, rare-disease researchers, variant-curation analysts, statistical and population geneticists, bioinformaticians doing variant prioritization.

## User Goals

- Get population allele frequency for a variant — overall and per ancestry group
- Assess gene constraint — is this gene loss-of-function intolerant? (pLI / LOEUF)
- List variants in a gene/transcript/region with frequencies and predicted consequences
- Triage a rare-disease candidate: is this variant absent/ultra-rare in gnomAD?
- Check sequencing coverage at a position (is absence real or just uncallable?)
- Pull ClinVar clinical significance alongside frequency for interpretation

## API Surface

One provider, a **GraphQL** endpoint at `gnomad.broadinstitute.org/api`. The handler constructs typed queries — there's no REST surface, so the service layer owns a small set of parameterized query documents per tool. Two axes of versioning matter and must be explicit:

- **Dataset / reference build:** gnomAD v4 (GRCh38, default) vs. v2 (GRCh37). Composes with `ensembl`, which is build-aware — keep builds aligned or the agent gets silent mismatches.
- **Identifiers:** variants as `chrom-pos-ref-alt` (e.g. `1-55051215-G-GA`) or rsID; genes by symbol (`PCSK9`) or Ensembl gene ID (`ENSG00000169174`); regions as `chrom-start-stop`.

| Query | Returns |
|:------|:--------|
| variant(variantId / rsId, dataset) | AC/AN/AF overall + per population (afr, amr, asj, eas, fin, nfe, sas, mid, remaining), homozygote/hemizygote counts, flags, consequence, in-silico scores, ClinVar significance |
| gene(gene_symbol, dataset) → constraint | pLI, LOEUF (+ CI), missense Z, synonymous Z, observed/expected LoF |
| gene/region → variants | variant list with AF + consequence (large — paginate / spill) |
| region → coverage | mean/median depth, fraction of samples over depth thresholds |

## Tool Surface (sketch)

```
gnomad_get_variant          — full population record for one variant (by variantId or
                            rsID, with dataset/build). Allele count, allele number, and
                            allele frequency overall AND per ancestry population;
                            homozygote/hemizygote counts; quality flags; transcript
                            consequence; in-silico predictors; and joined ClinVar
                            clinical significance. The "how common / is it benign" answer
                            in one call. Per-id batch with partial success.

gnomad_get_gene_constraint  — loss-of-function constraint for a gene: pLI, LOEUF (with
                            confidence interval), missense and synonymous Z-scores, and
                            observed/expected ratios. The "is this gene intolerant to
                            being broken" metric that weights a candidate LoF variant.
                            By gene symbol or Ensembl ID.

gnomad_list_gene_variants   — all variants in a gene / transcript / region with allele
                            frequencies and predicted consequences. Filter by consequence
                            class (e.g. LoF only), frequency threshold, and dataset.
                            Large result sets spill to DataCanvas for SQL (rank by AF,
                            count by consequence). "Show me the rare LoF variants in BRCA2."

gnomad_get_coverage         — sequencing coverage across a gene/region: mean/median depth
                            and the fraction of samples above depth thresholds. Disambig-
                            uates a true absent variant from an uncallable position —
                            critical before concluding "not seen in gnomAD."

—— optional second source ——

gnomad_search_clinvar       — gene-level ClinVar detail beyond what gnomAD joins per
                            variant: pathogenic/likely-pathogenic variant lists, review
                            status (star rating), and submission counts, via NCBI
                            E-utilities. Turns the variant-level significance gnomAD
                            surfaces into a gene-panel view for curation.
```

## Design Notes

- **GraphQL means the service layer owns the queries.** Unlike a REST wrapper, there's no endpoint-per-resource — define a parameterized query document per tool, request only the fields the tool returns, and validate the typed response. This is the main source of the "medium-high" complexity rating.
- **Dataset/build is a first-class parameter, not a default to bury.** v4=GRCh38, v2=GRCh37. Default to v4 but expose the choice on every tool and echo the effective dataset in output — a frequency from the wrong build silently misleads. Document the alignment requirement with `ensembl`.
- **Per-ancestry breakdown is the point** — don't collapse to a single global AF. A variant common in one population and absent in another is exactly the signal clinical interpretation needs; return the full population vector with AC/AN/AF each.
- **"Absent" needs coverage to be meaningful.** Pair `get_variant`/`list_gene_variants` reasoning with `get_coverage`: a variant absent from a well-covered region is informative; absent from an uncallable one is not. Surface coverage proactively in rare-disease triage.
- **Per-gene variant lists are analytical and large** → DataCanvas + `gnomad_dataframe_query` (rank by AF, filter by consequence, count by category). Compute distributions over the full set.
- **Be a polite client.** gnomAD's API is free but rate-limited and community-funded; the service layer needs conservative concurrency + backoff, and a hosted instance must not bulk-scrape. Note this in config and licensing — it's the one hosting caveat.
- **Scope decision:** core is gnomAD-only; ClinVar significance rides along *for free* in gnomAD's own variant response, so the dedicated `gnomad_search_clinvar` (NCBI) tool is an optional extension for gene-level curation depth, not a core dependency. Keeps the server keyless and single-source by default.
- **Composes with** `ensembl` (variant consequence/VEP + gene coordinates, shared build), `clinicaltrials` (trials for a gene's disease), `openfda` / `pubmed` (literature + drug context), `uniprot` (the protein the gene encodes).
- README one-liner: "Human population genetics over gnomAD — allele frequencies by ancestry, gene loss-of-function constraint, and variant catalogs for variant interpretation."
