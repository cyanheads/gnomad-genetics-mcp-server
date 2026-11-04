/**
 * @fileoverview Server-specific configuration for gnomad-genetics-mcp-server.
 * Lazy-parsed Zod schema, separate from framework config, mapped to env vars
 * via parseEnvConfig so validation errors name the variable, not the schema path.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { normalizeEnv, parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

/**
 * Dataset identifiers accepted wherever `dataset` is taken: gnomAD's whole
 * DatasetId enum, in its order — four releases, each followed by its subsets.
 * Each one's parent release and build live in the gnomAD service's lineage table.
 */
export const GNOMAD_DATASETS = [
  'gnomad_r4',
  'gnomad_r4_non_ukb',
  'gnomad_r3',
  'gnomad_r3_controls_and_biobanks',
  'gnomad_r3_non_cancer',
  'gnomad_r3_non_neuro',
  'gnomad_r3_non_topmed',
  'gnomad_r3_non_v2',
  'gnomad_r2_1',
  'gnomad_r2_1_controls',
  'gnomad_r2_1_non_neuro',
  'gnomad_r2_1_non_cancer',
  'gnomad_r2_1_non_topmed',
  'exac',
] as const;

const ServerConfigSchema = z.object({
  gnomadApiBaseUrl: z
    .string()
    .url()
    .default('https://gnomad.broadinstitute.org/api')
    .describe('gnomAD GraphQL endpoint. Override for a private mirror or testing.'),
  defaultDataset: z
    .enum(GNOMAD_DATASETS)
    .default('gnomad_r4')
    .describe('Dataset used when a tool call omits the dataset parameter.'),
  requestTimeoutMs: z.coerce
    .number()
    .int()
    .positive()
    .default(30_000)
    .describe('Per-request timeout against the GraphQL endpoint, in milliseconds.'),
  maxConcurrency: z.coerce
    .number()
    .int()
    .positive()
    .default(2)
    .describe('Cap on concurrent upstream requests — politeness against a community-funded API.'),
  maxVariantBatch: z.coerce
    .number()
    .int()
    .positive()
    .default(25)
    .describe('Maximum variant IDs accepted per gnomad_get_variant call.'),
  clinvarBaseUrl: z
    .string()
    .url()
    .default('https://eutils.ncbi.nlm.nih.gov/entrez/eutils')
    .describe('NCBI E-utilities base URL for the optional gnomad_search_clinvar tool.'),
  ncbiApiKey: z
    .string()
    .optional()
    .describe('Optional NCBI API key. Raises the E-utilities rate limit from 3 to 10 req/s.'),
  dataframeDropEnabled: z
    .stringbool()
    .default(false)
    .describe('Gate for the opt-in gnomad_dataframe_drop tool. Off by default.'),
  clampLimits: z
    .stringbool()
    .default(true)
    .describe(
      'When true, an over-cap limit is clamped to the cap with a notice; false rejects it at the schema.',
    ),
  normalizeIds: z
    .stringbool()
    .default(true)
    .describe(
      'When true, identifier spellings with one clear reading (case, chr prefix, colons, versioned Ensembl IDs) are normalized before validation.',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/** Definition-only cap read; full configuration remains uncached and strictly validated in setup. */
export function getVariantBatchCap(): number {
  const schema = ServerConfigSchema.shape.maxVariantBatch;
  const result = schema.safeParse(
    normalizeEnv({ value: process.env.GNOMAD_MAX_VARIANT_BATCH }).value,
  );
  return result.success ? result.data : schema.parse(undefined);
}

/** Definition-only registration gate; invalid settings still fail full startup validation. */
export function isDataframeDropEnabled(): boolean {
  const schema = ServerConfigSchema.shape.dataframeDropEnabled;
  const result = schema.safeParse(
    normalizeEnv({ value: process.env.GNOMAD_DATAFRAME_DROP_ENABLED }).value,
  );
  return result.success ? result.data : schema.parse(undefined);
}

/** Definition-only read of GNOMAD_CLAMP_LIMITS; it decides whether `limit` schemas carry a `maximum`. */
export function isClampLimitsEnabled(): boolean {
  const schema = ServerConfigSchema.shape.clampLimits;
  const result = schema.safeParse(normalizeEnv({ value: process.env.GNOMAD_CLAMP_LIMITS }).value);
  return result.success ? result.data : schema.parse(undefined);
}

/**
 * Definition-only canvas gate. The entrypoint defaults CANVAS_PROVIDER_TYPE to duckdb after its
 * imports evaluate, so an unset value reads as enabled here; only an explicit `none` disables it.
 */
export function isCanvasEnabled(): boolean {
  return normalizeEnv({ value: process.env.CANVAS_PROVIDER_TYPE }).value !== 'none';
}

/** Lazy-parse and cache the server configuration. Safe under Workers env injection. */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    gnomadApiBaseUrl: 'GNOMAD_API_BASE_URL',
    defaultDataset: 'GNOMAD_DEFAULT_DATASET',
    requestTimeoutMs: 'GNOMAD_REQUEST_TIMEOUT_MS',
    maxConcurrency: 'GNOMAD_MAX_CONCURRENCY',
    maxVariantBatch: 'GNOMAD_MAX_VARIANT_BATCH',
    clinvarBaseUrl: 'CLINVAR_BASE_URL',
    ncbiApiKey: 'NCBI_API_KEY',
    dataframeDropEnabled: 'GNOMAD_DATAFRAME_DROP_ENABLED',
    clampLimits: 'GNOMAD_CLAMP_LIMITS',
    normalizeIds: 'GNOMAD_NORMALIZE_IDS',
  });
  return _config;
}

/** Reset cached config — test-only. */
export function resetServerConfig(): void {
  _config = undefined;
}
