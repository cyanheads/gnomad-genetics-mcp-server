---
name: gnomad-genetics-guide
description: Use gnomad_* tools to follow ClinVar gene candidates into population evidence, screen gene variant catalogs, or analyze staged results. Covers identifier conversion gates, complete ClinVar pagination, and candidate selection without treating missing frequency as rarity.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use this server for human population frequency and gene constraint evidence, or for ClinVar gene-level curation followed by population lookups. Core lookups and ClinVar search are keyless. It does not perform coordinate liftover, annotate structural or mitochondrial variants, or submit clinical classifications.

For a single candidate, the user-invoked `gnomad_variant_triage` prompt already supplies the frequency, constraint, and callability workflow. The workflows below address candidate discovery and cross-source follow-up.

## Identifiers

- Resolve an Ensembl gene ID to its HGNC symbol before `gnomad_search_clinvar`; other gene tools accept the Ensembl ID directly. An Ensembl lookup can supply the symbol.
- ClinVar search returns its own VariationID and accession for provenance. Neither is a gnomAD variant identifier; the HGVS title is not one either.
- Prefer a returned `grch38_variant_id` for `gnomad_get_variant` on a GRCh38 dataset. When it is null, the row may still supply dbSNP rsIDs; split the semicolon-joined `rsids` into individual identifiers before lookup.
- A canonical SPDI is not a VCF-style gnomAD ID. SPDI positions are zero-based; canonical insertions and deletions can be repeat-expanded and lack the VCF anchor base. Do not construct a gnomAD ID by replacing separators or merely adding one to the position. Obtain a normalized allele on the required build from a reference-aware source instead.

## Gates

- Before following an rsID into population evidence, inspect its batch outcome. For `ambiguous_rsid`, select the concrete allele matching the candidate from `candidates`, or resolve it through dbSNP or Ensembl when candidates are unavailable. Do not choose the first candidate by position.
- Before calling a ClinVar search complete, follow `next_offset` until it is null. A window can have no retained rows after filtering while later candidate windows remain. `total_found` counts search candidates, not the final classified set; report `unavailable_ids` as gaps.
- Before combining staged windows or genes, account for table replacement: another list call on the same canvas replaces `gene_variants`, and another ClinVar call replaces `clinvar_variants`. Query or retain the current result before advancing, or use separate canvases. Reusing a canvas does not append rows.
- Before describing a frequency-filtered catalog as rare variants, separate rows with null AF. They survive the maximum-frequency filter because their frequency is unknown.
- Before treating an inline preview as the full candidate set, compare it with the reported total and inspect notices. If the canvas is unavailable and rows were omitted, the preview cannot support an exhaustive count or ranking.

## Core chain

For gene-panel curation: resolve the HGNC symbol → search ClinVar → inspect each retained allele and its review evidence → retrieve its gnomAD population record → apply the single-candidate triage workflow where further interpretation is needed.

Keep clinical classification, population frequency, predicted consequence, and gene constraint as separate evidence axes. A ClinVar classification is not a population observation; an absent ClinVar entry is not a benign classification. A failed optional ClinVar annotation leaves population evidence usable while clinical annotation remains unknown.

## Workflows

### Follow ClinVar candidates into gnomAD

Process one ClinVar window at a time. Inspect or query all retained rows, select alleles with usable identifiers, and fetch their population records. Preserve the ClinVar VariationID alongside the resolved gnomAD variant ID so each conclusion can be traced back to the candidate. Resolve unmapped alleles rather than dropping them silently; state any candidates that could not be followed into gnomAD. Finish the window before advancing when reusing its canvas.

### Screen a gene variant catalog

Use `gnomad_list_gene_variants` to select candidates by consequence and frequency, then `gnomad_get_variant` for the selected IDs' full ancestry vectors and annotations. The catalog's joint AF is a screening value; it does not replace the detailed population record. Keep unknown-frequency rows distinct from measured rare rows, and do not turn a catalog shortlist into an unsupported pathogenicity ranking.

### Analyze staged results

Results too large to return inline are staged as a DataCanvas table, and the response carries a `canvas_id`. Call `gnomad_dataframe_describe` with it for the staged table and column names before writing SQL, then `gnomad_dataframe_query` with a read-only query. Pass the same `canvas_id` back to stage further results beside the first; the tables expire with the canvas. Different table names can coexist; repeated calls producing the same table name replace that table as described above.

For exhaustive analysis, aggregate over the staged table rather than the preview. When retrieving query rows in pages, use a stable ordering with a unique key and follow the returned continuation. If the query reports a cap or unknown total, narrow or aggregate the query before claiming completeness.
