<div align="center">
  <h1>@cyanheads/gnomad-genetics-mcp-server</h1>
  <p><b>Look up variant allele frequencies by ancestry, gene loss-of-function constraint, gene variant lists, and sequencing coverage over gnomAD — with ClinVar significance joined in — via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools (+1 opt-in) • 2 Resources • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.2-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/gnomad-genetics-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/gnomad-genetics-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/gnomad-genetics-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0%2B-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

Population genetics over gnomAD (Broad Institute), with ClinVar clinical significance joined in from NCBI. Look up per-ancestry allele frequencies, gene loss-of-function constraint, gene variant catalogs, and sequencing coverage, then query large result sets with SQL from any MCP client. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

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

### Prompts

| Prompt | Description |
|:---|:---|
| `gnomad_variant_triage` | Guided rare-disease variant-triage workflow: population frequency → gene constraint → callability check, in order. |

## Capability reference

### `gnomad_get_variant` <sub>tool</sub>

- Batch up to 25 IDs per call (default; raise via `GNOMAD_MAX_VARIANT_BATCH`), each a `chrom-pos-ref-alt` variantId (e.g. `1-55051215-G-GA`) or an rsID (e.g. `rs11591147`)
- Per-item partial success — a malformed or absent ID lands in `failed[]` without failing the others
- Per-ancestry frequency vector is returned in full, never collapsed to a single global AF
- Reports which callset(s) (`exome` / `genome`) carry the variant, quality flags, transcript consequence, in-silico predictor scores, and the ClinVar significance gnomAD joins per variant
- An empty `found[]` for a well-formed ID means the variant is not in the chosen dataset — pair with `gnomad_get_coverage` to confirm the position is callable before concluding true absence

---

### `gnomad_get_gene_constraint` <sub>tool</sub>

- Accepts an HGNC symbol (`PCSK9`) or an Ensembl gene ID (`ENSG00000169174`)
- Returns pLI (>0.9 intolerant), LOEUF / `oe_lof_upper` (<0.6 intolerant in v4, <0.35 in v2) with its lower bound, observed/expected ratios for LoF / missense / synonymous, and the three Z-scores
- Many genes have null constraint (sparse upstream) — null fields are reported as such, never fabricated
- `constraint_flags` surfaces v4 beta caveats flagged by the gnomAD team

---

### `gnomad_list_gene_variants` <sub>tool</sub>

- Supply exactly one of `gene`, `transcript_id`, or `region` (`chrom-start-stop`, 1-based inclusive)
- Optional filters: one `consequence_class` (`lof` / `missense` / `synonymous` / `other`) and/or a maximum allele frequency
- A result too large to inline (the preview holds about 14,000 characters of rows, keeping a response near 24 KB) is staged on a DataCanvas table named `gene_variants`, returned as `canvas_id` and `table_name` beside the preview — inspect it with `gnomad_dataframe_describe`, then query it with `gnomad_dataframe_query` to rank by AF, count by consequence, or group across every row. The response notice names the table and both tools
- A result that fits inline stages no table and uses no canvas (`canvas_id` is empty) unless you pass a `canvas_id`
- Passing a `canvas_id` always writes the result to `gene_variants` on that canvas, REPLACING the previous table (it never appends), even when the result fits inline; a result with no variants removes the table
- When the canvas is disabled (`CANVAS_PROVIDER_TYPE` != `duckdb`) the tool returns the same capped inline preview (as many rows as fit about 14,000 characters) and the SQL path is unavailable
- A blank `gene` or `transcript_id` counts as omitted

---

### `gnomad_get_coverage` <sub>tool</sub>

- Supply exactly one of `gene`, `transcript_id`, or `region`; a blank `gene` or `transcript_id` counts as omitted
- Returns mean and median read depth plus the mean fraction of samples covered at each threshold (1× through 100×), summarized per callset track
- `coverage_source` narrows to one track (`exome` / `genome`); omit to return every available track
- A variant missing from a well-covered region is informative; one missing from a poorly-covered region is not

---

### `gnomad_search_clinvar` <sub>tool</sub>

- Returns a gene's classified ClinVar variants — clinical significance, review status with a 0–4 star rating, associated conditions, molecular consequences, and submission counts
- Each row carries gnomAD-compatible identifiers: `canonical_spdi`, `rsids`, and `grch38_variant_id` (`chrom-pos-ref-alt`, set for SNVs, MNVs, and delins), which `gnomad_get_variant` resolves in the GRCh38 datasets
- Optional filters: `clinical_significance` (e.g. `pathogenic`; blank means no filter) and a minimum star rating (`min_review_stars`, 0–4)
- Returns one window of up to 500 ClinVar records per call: `total_found` is ClinVar's candidate count for the gene and filter terms (taken before the significance and star filters narrow each window), `truncated` and `next_offset` say whether more remain, and `offset` / `limit` (1–500) page through them. `limit` counts records before the filters, so a window can return fewer rows
- VariationIDs ClinVar returns no summary for are listed in `unavailable_ids` rather than returned as blank rows
- Accepts an HGNC symbol only — ClinVar's gene index doesn't resolve Ensembl gene IDs, unlike the other gnomAD tools. An Ensembl gene ID returns guidance to resolve its symbol and searches nothing, leaving any `canvas_id` you pass untouched
- A window too large to inline (the preview holds about 11,000 characters of rows, keeping a response near 24 KB) is staged on the `clinvar_variants` canvas table — inspect it with `gnomad_dataframe_describe`, then query it with `gnomad_dataframe_query`. A window that fits inline stages no table unless you pass a `canvas_id`; passing one always writes the window to `clinvar_variants`, REPLACING the previous table, and a window with no rows removes it. With the canvas disabled, the preview is the same capped preview (as many rows as fit about 11,000 characters)
- Keyless, but honors `NCBI_API_KEY` for a higher rate limit (10 vs 3 req/s)

---

### `gnomad_dataframe_query` <sub>tool</sub>

- Runs single-statement, read-only SQL `SELECT`s against a canvas table staged by `gnomad_list_gene_variants` or `gnomad_search_clinvar` — writes, DDL, and file/HTTP table functions are rejected by the canvas gate
- Reference tables by the name the staging tool returned (`gene_variants` or `clinvar_variants`)
- Output columns are dynamic per the SQL projection; `truncated: true` marks a result clipped at the canvas row cap
- Requires `CANVAS_PROVIDER_TYPE=duckdb` — otherwise fails with a `canvas_disabled` error

---

### `gnomad_dataframe_describe` <sub>tool</sub>

- Lists every table staged on a canvas with its row count and column schema (name and DuckDB type)
- Call it before writing SQL for `gnomad_dataframe_query`
- Requires `CANVAS_PROVIDER_TYPE=duckdb` — otherwise fails with a `canvas_disabled` error

---

### `gnomad_dataframe_drop` <sub>tool</sub>

- Drops a named table from a canvas to reclaim memory — a deliberate mutation (`readOnlyHint: false`, `destructiveHint: true`) on an otherwise read-only surface
- Opt-in via `GNOMAD_DATAFRAME_DROP_ENABLED=true`; absent from `tools/list` when off, since per-table TTL already reclaims memory automatically
- Requires `CANVAS_PROVIDER_TYPE=duckdb` — otherwise fails with a `canvas_disabled` error

---

### `gnomad://variant/{dataset}/{variantId}` <sub>resource</sub>

- Population record for one variant as `application/json` — mirrors `gnomad_get_variant`; the `dataset` segment keeps the URI self-describing
- `variantId` accepts a chrom-pos-ref-alt ID or an rsID, same grammar as the tool
- Typed errors: `invalid_variant_id` (outside the coordinate/rsID grammar) and `variant_not_found`

---

### `gnomad://gene/{dataset}/{gene}/constraint` <sub>resource</sub>

- Gene loss-of-function constraint as `application/json` — mirrors `gnomad_get_gene_constraint`
- `gene` accepts an HGNC symbol or Ensembl gene ID
- Typed error `gene_not_found` when no gene matches in the requested build

---

### `gnomad_variant_triage` <sub>prompt</sub>

- Arguments: `variant` required (chrom-pos-ref-alt or rsID); `gene` and `dataset` optional. `dataset` is one of `gnomad_r4`, `gnomad_r3`, `gnomad_r2_1`, `exac` — any other value is rejected; omitted or blank, the emitted calls carry no `dataset` and use the server default. A blank `gene` counts as omitted
- Emits a three-step chain as one user message: population frequency (`gnomad_get_variant`) → gene constraint (`gnomad_get_gene_constraint`) → callability check (`gnomad_get_coverage` on the exact position, not gene-level)
- Rejects a malformed `variant` with a validation error before generating the chain

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

gnomAD-specific:

- Single keyless GraphQL source for the entire core surface — ClinVar significance is joined per variant inside gnomAD's own response
- `dataset` and `reference_genome` are distinct, coherence-validated parameters (v4/v3 ⇒ GRCh38, v2.1/ExAC ⇒ GRCh37); both are echoed in every tool's output so a wrong-build coordinate mismatch is visible
- Polite client — conservative concurrency cap (`GNOMAD_MAX_CONCURRENCY`, default 2) and exponential backoff against a community-funded, rate-limited API
- In-conversation SQL analytics: `gnomad_list_gene_variants` and `gnomad_search_clinvar` stage results too large to inline on a DuckDB-backed canvas table — `gnomad_dataframe_describe` lists its columns, `gnomad_dataframe_query` runs SQL over every row

Agent-friendly output:

- Per-ancestry allele-frequency vector returned in full, never collapsed to a single global AF — the cross-ancestry contrast is the signal clinical interpretation needs
- Graceful partial failure — `gnomad_get_variant` returns per-item `failed[]` rows with actionable messages instead of failing the whole batch
- Provenance on every response — effective `dataset` and `reference_genome` echoed back; null upstream fields preserved as null, never fabricated
- Recovery hints on errors (`incoherent_build`, `invalid_target`, `gene_not_found`, `canvas_disabled`) so callers know the next move

## Getting started

### Public Hosted Instance

A public instance is available at `https://gnomad-genetics.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "gnomad-genetics-mcp-server": {
      "type": "streamable-http",
      "url": "https://gnomad-genetics.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file. gnomAD is a free, keyless API — no credentials required.

```json
{
  "mcpServers": {
    "gnomad-genetics-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/gnomad-genetics-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "gnomad-genetics-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/gnomad-genetics-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "gnomad-genetics-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "ghcr.io/cyanheads/gnomad-genetics-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

To enable the SQL analytics path, also set `CANVAS_PROVIDER_TYPE=duckdb` — `@duckdb/node-api` ships as a dependency, so nothing extra to install.

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key — gnomAD's GraphQL endpoint is keyless. An optional `NCBI_API_KEY` raises the `gnomad_search_clinvar` rate limit.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/gnomad-genetics-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd gnomad-genetics-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# all vars are optional — the server runs keyless out of the box
```

## Configuration

All variables are optional; the server runs keyless with the defaults below.

| Variable | Description | Default |
|:---------|:------------|:--------|
| `GNOMAD_API_BASE_URL` | gnomAD GraphQL endpoint. Override for a private mirror or testing. | `https://gnomad.broadinstitute.org/api` |
| `GNOMAD_DEFAULT_DATASET` | Dataset used when a tool call omits `dataset` (`gnomad_r4` / `gnomad_r3` / `gnomad_r2_1` / `exac`). | `gnomad_r4` |
| `GNOMAD_REQUEST_TIMEOUT_MS` | Per-request timeout against the GraphQL endpoint, in milliseconds. | `30000` |
| `GNOMAD_MAX_CONCURRENCY` | Cap on concurrent upstream requests — politeness against a community-funded API. | `2` |
| `GNOMAD_MAX_VARIANT_BATCH` | Maximum variant IDs accepted per `gnomad_get_variant` call. | `25` |
| `CLINVAR_BASE_URL` | NCBI E-utilities base URL for `gnomad_search_clinvar`. | `https://eutils.ncbi.nlm.nih.gov/entrez/eutils` |
| `NCBI_API_KEY` | Optional NCBI key. Raises the E-utilities rate limit from 3 to 10 req/s. | — |
| `CANVAS_PROVIDER_TYPE` | Set to `duckdb` to enable the spill/SQL path behind the list tools. When `none`, they return a capped inline preview. | `none` |
| `GNOMAD_DATAFRAME_DROP_ENABLED` | Gate for the opt-in `gnomad_dataframe_drop` tool. Off by default. | `false` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for the HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

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
