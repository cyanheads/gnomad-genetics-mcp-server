# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-06-27

Three correctness fixes: the gnomad_search_clinvar clinical_significance filter is enforced post-fetch and composes with min_review_stars, gnomad_list_gene_variants reports joint AN/AF for dual-callset rows, and the gnomad_get_gene_constraint LOEUF interval renders oe_lof_upper as its upper bound.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-06-25

Scopes the npm package to @cyanheads/gnomad-genetics-mcp-server and finalizes publish metadata. First release carrying the full gnomAD surface — allele frequencies by ancestry, gene loss-of-function constraint, gene variant lists, sequencing coverage, and gene-level ClinVar, with a DataCanvas SQL path.

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-06-24

Initial release — gnomAD population genetics over MCP: variant allele frequencies by ancestry, gene loss-of-function constraint, gene variant lists, sequencing coverage, and gene-level ClinVar, with a DataCanvas SQL path.
