<div align="center">
  <h1>@cyanheads/gnomad-genetics-mcp-server</h1>
  <p><b>Ancestry allele frequencies, LoF constraint, variant lists, and coverage from gnomAD, joined with ClinVar clinical significance via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools (+1 opt-in) • 2 Resources • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.4.2-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/gnomad-genetics-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/gnomad-genetics-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/gnomad-genetics-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4%2B-blueviolet.svg?style=flat-square)](https://bun.sh/)

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
| `gnomad_get_variant` | Full population record for one or more variants — AC/AN/AF overall and per genetic-ancestry group, homozygote/hemizygote counts, quality flags, transcript consequence, in-silico predictors, and joined ClinVar significance. |
| `gnomad_get_gene_constraint` | Gene loss-of-function constraint — pLI, LOEUF (`oe_lof_upper`) with confidence interval, observed/expected ratios, and Z-scores. By HGNC symbol or Ensembl gene ID. |
| `gnomad_list_gene_variants` | Every variant in a gene, transcript, or region with allele frequencies and predicted consequences, filterable by consequence class and max allele frequency. |
| `gnomad_get_coverage` | Sequencing coverage across a gene, transcript, or region — mean/median depth and the fraction of samples over depth thresholds, per callset track. |
| `gnomad_search_clinvar` | Gene-level ClinVar detail via NCBI E-utilities — classified variants, review status, conditions, submission counts, and gnomAD-compatible variant IDs, paged by offset. |
| `gnomad_dataframe_query` | Run a read-only SQL `SELECT` across canvas tables staged by the list tools. |
| `gnomad_dataframe_describe` | List the tables staged on a canvas and their columns before writing SQL. |
| `gnomad_dataframe_drop` | Drop a named table from a canvas to reclaim memory. Opt-in via `GNOMAD_DATAFRAME_DROP_ENABLED=true` — off by default. |

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

## Capability reference

### `gnomad_get_variant` <sub>tool</sub>

- Up to 25 IDs per call (raise via `GNOMAD_MAX_VARIANT_BATCH`), each a `chrom-pos-ref-alt` variantId on chromosome `1`–`22`, `X`, or `Y` with an optional `chr` prefix (e.g. `1-55051215-G-GA`) or an rsID (e.g. `rs11591147`)
- A bad or absent ID lands in `failed[]` as `{ variant, error, reason, recovery }` without failing the rest; mitochondrial IDs (`M`, `MT`, `chrM`) fail as `mitochondrial_unsupported`, and an ambiguous rsID adds `candidates`
- Returns the full per-ancestry frequency vector, the callset(s) carrying the variant, quality flags, consequence, predictor scores, and ClinVar significance. A validated population record survives ClinVar-only failure or expiry with `clinvar: null` and `clinvar_unavailable: true`
- Inspect each `failed[].reason`: only `variant_not_found` reports absence from the chosen dataset; timeouts and other failures leave presence unknown. Check `gnomad_get_coverage` before interpreting an absent variant

---

### `gnomad_get_gene_constraint` <sub>tool</sub>

- Accepts an HGNC symbol (`PCSK9`) or an Ensembl gene ID (`ENSG00000169174`)
- Returns pLI (>0.9 intolerant), LOEUF / `oe_lof_upper` with its lower bound, observed/expected ratios for LoF / missense / synonymous, the three Z-scores, and `constraint_flags` (e.g. `no_exp_lof`, `syn_outlier`)
- `constraint_release` names the release the metrics come from. Many genes have null constraint, reported as null:

  | `dataset` | Source | `constraint_release` | LoF-intolerance guidance |
  |:--|:--|:--|:--|
  | `gnomad_r4` | GRCh38 gnomAD constraint | `gnomAD v4.1.2` | LOEUF < 0.45 |
  | `gnomad_r3` | GRCh38 gnomAD constraint (gnomAD publishes no v3 constraint) | `gnomAD v4.1.2` | LOEUF < 0.45 |
  | `gnomad_r2_1` | GRCh37 gnomAD constraint | `gnomAD v2.1.1` | LOEUF < 0.35 |
  | `exac` | GRCh37 ExAC constraint | `ExAC r0.3` | pLI only |

- On `exac` the ratios and LOEUF are null and `constraint_flags` is empty

---

### `gnomad_list_gene_variants` <sub>tool</sub>

- Supply exactly one of `gene`, `transcript_id`, or `region` (`chrom-start-stop`, 1-based inclusive, chromosome `1`–`22`, `X`, or `Y` with an optional `chr` prefix); a blank `gene` or `transcript_id` counts as omitted
- A region must span less than 2,500,000 bp and hold at most ~30,000 variants, otherwise it fails as `invalid_region` or `region_too_large`; mitochondrial targets fail as `mitochondrial_unsupported`
- Optional filters: one `consequence_class` (`lof` / `missense` / `synonymous` / `other`) and/or a maximum allele frequency
- A result too large to inline is staged on the `gene_variants` canvas table, returned as `canvas_id` and `table_name` beside a preview; inspect it with `gnomad_dataframe_describe` and query it with `gnomad_dataframe_query`. Passing a `canvas_id` always writes `gene_variants` there, replacing the previous table. With the canvas disabled (`CANVAS_PROVIDER_TYPE=none`), only the capped preview is returned

---

### `gnomad_get_coverage` <sub>tool</sub>

- Supply exactly one of `gene`, `transcript_id`, or `region` (same `chrom-start-stop` form and 2,500,000 bp limit as `gnomad_list_gene_variants`); a blank `gene` or `transcript_id` counts as omitted. Bad regions fail as `invalid_region` or `region_too_large`, and mitochondrial targets as `mitochondrial_unsupported`
- Returns mean and median read depth plus the mean fraction of samples covered at each threshold (1× through 100×), summarized per callset track, with `bucket_size`, `bucket_count`, observed `positions`, total `target_positions`, and unobserved `missing_positions` for each. Missing bases leave callability unknown; statistics describe only returned buckets, with no invented zero depths
- `coverage_source` narrows to one track (`exome` / `genome`); omit to return every available track
- Notices disclose partial targets and missing supported tracks. An explicitly requested unsupported track is identified separately (v3 has genome only; ExAC has exome only)

---

### `gnomad_search_clinvar` <sub>tool</sub>

- Takes an HGNC symbol only (an Ensembl gene ID returns guidance and searches nothing). Optional filters: `clinical_significance` (e.g. `pathogenic`) and `min_review_stars` (0–4)
- Returns clinical significance, review status with a 0–4 star rating, conditions, molecular consequences, submission counts, and gnomAD-compatible identifiers (`canonical_spdi`, `rsids`, `grch38_variant_id`). IDs ClinVar has no summary for are listed in `unavailable_ids`
- Pages up to 500 records per call with `offset` / `limit` (1–500); `total_found`, `truncated`, and `next_offset` say whether more remain. `limit` counts records before the filters, so a window can return fewer rows
- A window too large to inline is staged on the `clinvar_variants` canvas table (query it with `gnomad_dataframe_describe` and `gnomad_dataframe_query`); passing a `canvas_id` always writes it there, replacing the previous table. `NCBI_API_KEY` raises the rate limit from 3 to 10 req/s

---

### `gnomad_dataframe_query` <sub>tool</sub>

- Runs single-statement, read-only SQL `SELECT`s against a table staged by `gnomad_list_gene_variants` or `gnomad_search_clinvar` (`gene_variants` or `clinvar_variants`); writes, DDL, and file/HTTP table functions are rejected
- Pages with `offset` (default 0) and `limit` (default 100, max 500); returns `rows`, `columns`, `total`, `truncated`, and `next_offset` (follow it until `null`). Use an `ORDER BY` on a unique key for stable paging, and filter or aggregate in SQL to get past the `CANVAS_DEFAULT_ROW_LIMIT` cap (10,000 by default)
- A row over the 10,000-character page budget fails with `row_too_large`; with `CANVAS_PROVIDER_TYPE=none` it fails with `canvas_disabled`

---

### `gnomad_dataframe_describe` <sub>tool</sub>

- Lists every table staged on a canvas with its row count and column schema (name and DuckDB type)
- Call it before writing SQL for `gnomad_dataframe_query`
- Fails with a `canvas_disabled` error when the canvas is turned off (`CANVAS_PROVIDER_TYPE=none`)

---

### `gnomad_dataframe_drop` <sub>tool</sub>

- Drops a named table from a canvas to reclaim memory (`destructiveHint: true`)
- Opt-in via `GNOMAD_DATAFRAME_DROP_ENABLED=true`; absent from `tools/list` when off
- An unknown or expired `canvas_id` fails as `canvas_not_found`; with `CANVAS_PROVIDER_TYPE=none` it fails with `canvas_disabled`

---

### `gnomad://variant/{dataset}/{variantId}` <sub>resource</sub>

- Population record for one variant as `application/json`, mirroring `gnomad_get_variant`; `variantId` takes a chrom-pos-ref-alt ID or an rsID
- Typed errors: `invalid_variant_id`, `mitochondrial_unsupported`, `variant_not_found`, `ambiguous_rsid` (with `candidates`), `graphql_error`, `upstream_build_mismatch`, `upstream_unavailable`, `upstream_timeout`, `upstream_access`, and `invalid_upstream_response`, each with a recovery hint

---

### `gnomad://gene/{dataset}/{gene}/constraint` <sub>resource</sub>

- Gene loss-of-function constraint as `application/json`, mirroring `gnomad_get_gene_constraint` (same `constraint_release` per `dataset`); `gene` takes an HGNC symbol or Ensembl gene ID
- Typed errors: `gene_not_found`, `invalid_constraint_data`, `graphql_error`, `upstream_unavailable`, `upstream_timeout`, `upstream_access`, and `invalid_upstream_response`, each with a recovery hint

---

### `gnomad_variant_triage` <sub>prompt</sub>

- Arguments: `variant` required (chrom-pos-ref-alt or rsID; a malformed one is rejected); `gene` and `dataset` optional. `dataset` is one of `gnomad_r4`, `gnomad_r3`, `gnomad_r2_1`, `exac`, and the server default applies when omitted
- Emits a three-step chain as one user message: population frequency (`gnomad_get_variant`) → gene constraint (`gnomad_get_gene_constraint`) → callability check (`gnomad_get_coverage` on the exact position)

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

gnomAD-specific:

- Single keyless GraphQL source for the entire core surface — ClinVar significance is joined per variant inside gnomAD's own response
- `dataset` and `reference_genome` are distinct, coherence-validated parameters (v4/v3 ⇒ GRCh38, v2.1/ExAC ⇒ GRCh37); both are echoed in every tool's output so a wrong-build coordinate mismatch is visible
- Polite client — conservative concurrency cap (`GNOMAD_MAX_CONCURRENCY`, default 2) and exponential backoff against a community-funded, rate-limited API
- In-conversation SQL analytics: `gnomad_list_gene_variants` and `gnomad_search_clinvar` stage results too large to inline on a DuckDB-backed canvas table — `gnomad_dataframe_describe` lists its columns, `gnomad_dataframe_query` runs SQL over every row

Agent-friendly output:

- Per-ancestry allele-frequency vector returned in full, never collapsed to a single global AF
- `gnomad_get_variant` returns per-item `failed[]` rows instead of failing the whole batch
- Effective `dataset` and `reference_genome` echoed on every response; null upstream fields stay null
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

Node and Bun load the working directory's `.env` before building tool definitions. Exported values take precedence; blank values use the schema defaults. The advertised variant cap, its input validation, and the drop-tool registration gate use those same settings. Invalid server configuration fails startup with a banner naming the variable; `DEBUG=true` includes the stack.

| Variable | Description | Default |
|:---------|:------------|:--------|
| `GNOMAD_API_BASE_URL` | gnomAD GraphQL endpoint. Override for a private mirror or testing. | `https://gnomad.broadinstitute.org/api` |
| `GNOMAD_DEFAULT_DATASET` | Dataset used when a tool call omits `dataset` (`gnomad_r4` / `gnomad_r3` / `gnomad_r2_1` / `exac`). | `gnomad_r4` |
| `GNOMAD_REQUEST_TIMEOUT_MS` | Per-attempt gnomAD/NCBI timeout in milliseconds, bounded by the shared 45 s call deadline. | `30000` |
| `GNOMAD_MAX_CONCURRENCY` | Cap on concurrent upstream requests — politeness against a community-funded API. | `2` |
| `GNOMAD_MAX_VARIANT_BATCH` | Maximum variant IDs accepted per `gnomad_get_variant` call. | `25` |
| `CLINVAR_BASE_URL` | NCBI E-utilities base URL for `gnomad_search_clinvar`. | `https://eutils.ncbi.nlm.nih.gov/entrez/eutils` |
| `NCBI_API_KEY` | Optional NCBI key. Raises the E-utilities rate limit from 3 to 10 req/s. | — |
| `CANVAS_PROVIDER_TYPE` | DataCanvas backend for the spill/SQL path behind the list tools. `none` disables it, and the list tools then return a capped inline preview. | `duckdb` |
| `GNOMAD_DATAFRAME_DROP_ENABLED` | Gate for the opt-in `gnomad_dataframe_drop` tool. Off by default. | `false` |

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
