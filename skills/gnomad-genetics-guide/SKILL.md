---
name: gnomad-genetics-guide
description: Use gnomad_* tools to follow ClinVar gene candidates into population evidence, screen gene variant catalogs, or analyze staged results. Covers identifier conversion gates, complete ClinVar pagination, and candidate selection without treating missing frequency as rarity.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.1"
---

## Scope

Use this server for human population frequency and gene constraint evidence, or for ClinVar gene-level curation followed by population lookups. Core lookups and ClinVar search are keyless. It does not translate coordinates between builds: an absent coordinate ID whose string also lifts over from the other build fails as `variant_not_found_other_build` with the lifted IDs in `candidates`, a hint the server never acts on. It does not annotate structural or mitochondrial variants or submit clinical classifications.

For a single candidate, the user-invoked `gnomad_variant_triage` prompt already supplies the frequency, constraint, and callability workflow. The workflows below address candidate discovery and cross-source follow-up.

## Identifiers

- Resolve an Ensembl gene ID to its HGNC symbol before `gnomad_search_clinvar`; other gene tools accept the Ensembl ID directly (versioned or lowercase forms included). An Ensembl lookup can supply the symbol.
- ClinVar search returns its own VariationID and accession for provenance. Neither is a gnomAD variant identifier; the HGVS title is not one either.
- Prefer a returned `grch38_variant_id` for `gnomad_get_variant` on a GRCh38 dataset. When it is null, the row may still supply dbSNP rsIDs; split the semicolon-joined `rsids` into individual identifiers before lookup.
- A canonical SPDI is not a VCF-style gnomAD ID. SPDI positions are zero-based; canonical insertions and deletions can be repeat-expanded and lack the VCF anchor base. Do not construct a gnomAD ID by replacing separators or merely adding one to the position. Obtain a normalized allele on the required build from a reference-aware source instead.

## Gates

- Before following an rsID into population evidence, inspect its batch outcome. For `ambiguous_rsid`, select the concrete allele matching the candidate from `candidates`, or resolve it through dbSNP or Ensembl when candidates are unavailable. Do not choose the first candidate by position.
- Before reading a `variant_not_found_other_build` item as absence or as a wrong-build ID, decide which build the ID was written for. If it was written for the other build, look up a candidate on the same dataset; if not, it is absent, so check coverage at its position. A resolved lift does not prove a mismatch: a valid ID truly absent from the dataset lifts too.
- Before treating an unknown gene or transcript on `gnomad_list_gene_variants` or `gnomad_get_coverage` as an empty gene, read its `gene_not_found` / `transcript_not_found` failure: gnomAD holds no such ID in this build. Pass Ensembl transcript IDs (`ENST…`), not RefSeq (`NM_…`).
- Before calling a ClinVar search complete, follow `next_offset` until it is null. For `pathogenic`, `likely pathogenic`, `uncertain significance`, `vus`, `likely benign`, `benign`, and `conflicting`, `total_found` is the classified match count and windows hold matching records only. For any other significance term it counts search candidates, so a window can retain no rows while later windows still hold matches. Report `unavailable_ids` as gaps. The default `limit` is 10; pass a larger one (up to 1,500) to walk a gene in fewer calls.
- Before combining staged windows or genes, account for table replacement: another list call at offset 0 on the same canvas replaces `gene_variants`, and another ClinVar call replaces `clinvar_variants`. A list page past offset 0 never replaces `gene_variants`. Query or retain the current result before advancing, or use separate canvases. Reusing a canvas does not append rows.
- Before reading a catalog count or row as observed variants, check `qc_status` and `qc_filtered`. A `filtered` row failed gnomAD QC in every callset carrying it, often `AC0` (no high-quality carrier) at AF 0, so it passes any `max_af` and sorts first under `ORDER BY af`. Count, rank, or describe only `pass` rows as observed — pass `pass_only`, or filter on `qc_status` in SQL — and report the filtered rows separately. The two differ on `gnomad_r2_1`: filtering staged rows on `qc_status = 'pass'` keeps each row's counts summed over every carried callset, a QC-failed one included, while `pass_only` reads them from the passing callsets only (as gnomAD's browser table does) and applies `max_af` to that frequency. Use `pass_only` when the counts must match the browser's default view. On `gnomad_get_variant`, read `callsets.*.filters` for the reason; a filtered record is a QC-failed call, neither an observed carrier nor proof of absence.
- Before describing a frequency-filtered catalog as rare variants, separate rows with null AF. They survive the maximum-frequency filter because their frequency is unknown.
- Before treating a `gnomad_list_gene_variants` page as the full candidate set, compare it with `total` and follow `next_offset` until it is null, or aggregate over the staged table. Each page re-fetches the target, so narrow with filters and raise `limit` for a large gene. Without a canvas, exhaustive counts and rankings need every page; a ClinVar window then holds every row of its window, and `next_offset` reaches the rest.

## Core chain

For gene-panel curation: resolve the HGNC symbol → search ClinVar → inspect each retained allele and its review evidence → retrieve its gnomAD population record → apply the single-candidate triage workflow where further interpretation is needed.

Keep clinical classification, population frequency, predicted consequence, and gene constraint as separate evidence axes. A ClinVar classification is not a population observation; an absent ClinVar entry is not a benign classification. A failed optional ClinVar annotation leaves population evidence usable while clinical annotation remains unknown.

## Workflows

### Follow ClinVar candidates into gnomAD

Process one ClinVar window at a time. Inspect or query all retained rows, select alleles with usable identifiers, and fetch their population records. Preserve the ClinVar VariationID alongside the resolved gnomAD variant ID so each conclusion can be traced back to the candidate. Resolve unmapped alleles rather than dropping them silently; state any candidates that could not be followed into gnomAD. Finish the window before advancing when reusing its canvas.

### Screen a gene variant catalog

Use `gnomad_list_gene_variants` to select candidates by consequence and frequency, then `gnomad_get_variant` for the selected IDs' full ancestry vectors and annotations. The catalog's joint AF is a screening value; it does not replace the detailed population record. Keep unknown-frequency rows distinct from measured rare rows, and do not turn a catalog shortlist into an unsupported pathogenicity ranking. A row's `consequence` is the most severe term in the gene and can sit on a minor isoform: where `consequence_transcript` is `other`, read the selected variant's `primary_transcript`, which covers the gene in its `gene_symbol`, before calling it pLoF. A null `primary_transcript` means the variant lies outside the gene's MANE Select and canonical transcripts altogether, not that the consequence there is unknown.

### Analyze staged results

With the canvas off, the dataframe tools are not offered and every result is inline. Otherwise, results too large to return inline are staged as a DataCanvas table, and the response carries a `canvas_id`; the list tool stages only at offset 0. Call `gnomad_dataframe_describe` with it for the staged table and column names before writing SQL, then `gnomad_dataframe_query` with a read-only query. Pass the same `canvas_id` back to stage further results beside the first; the tables expire with the canvas. Different table names can coexist; repeated calls producing the same table name replace that table as described above.

For exhaustive analysis, aggregate over the staged table rather than the preview. When retrieving query rows in pages, use a stable ordering with a unique key and follow the returned continuation. `gnomad_dataframe_query` pages default to 25 rows (a `limit` above 3,000 is clamped), and `BIGINT` values such as `ac`, `an`, and `COUNT(*)` arrive as strings; `CAST(col AS INTEGER)` returns a number. If the query reports a cap or unknown total, narrow or aggregate the query before claiming completeness.
