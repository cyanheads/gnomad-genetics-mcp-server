# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-06-30

gnomad_get_variant batch lookups now dispatch concurrently under the existing GNOMAD_MAX_CONCURRENCY cap instead of a serial loop; per-item partial success and stable input-order found[]/failed[] are unchanged, with no schema change.

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-06-30 · 🛡️ Security

Two fixes plus a security-bearing framework bump: gnomad_get_coverage bounds region coverage to the requested span (no more padded-window leakage); gnomad_search_clinvar names the cause for Ensembl gene IDs instead of a bare empty result; and adopting @cyanheads/mcp-ts-core ^0.10.10 re-resolves the transitive js-yaml, clearing GHSA-h67p-54hq-rp68.

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-06-28

Three fixes: an inverted region (start > stop) is rejected immediately as a validation error instead of exhausting the retry budget; GNOMAD_MAX_VARIANT_BATCH now drives the gnomad_get_variant batch cap (was hard-coded 25); and gnomad_variant_triage confirms the exact variant position for callability instead of gene-level coverage.

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-06-27

Three correctness fixes: the gnomad_search_clinvar clinical_significance filter is enforced post-fetch and composes with min_review_stars, gnomad_list_gene_variants reports joint AN/AF for dual-callset rows, and the gnomad_get_gene_constraint LOEUF interval renders oe_lof_upper as its upper bound.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-06-25

Scopes the npm package to @cyanheads/gnomad-genetics-mcp-server and finalizes publish metadata. First release carrying the full gnomAD surface — allele frequencies by ancestry, gene loss-of-function constraint, gene variant lists, sequencing coverage, and gene-level ClinVar, with a DataCanvas SQL path.

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-06-24

Initial release — gnomAD population genetics over MCP: variant allele frequencies by ancestry, gene loss-of-function constraint, gene variant lists, sequencing coverage, and gene-level ClinVar, with a DataCanvas SQL path.
