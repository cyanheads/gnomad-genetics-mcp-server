/**
 * @fileoverview Server-specific configuration for gnomad-genetics-mcp-server.
 * Lazy-parsed Zod schema, separate from framework config, mapped to env vars
 * via parseEnvConfig so validation errors name the variable, not the schema path.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

/** Dataset identifiers accepted on every tool — a subset of the gnomAD DatasetId enum. */
export const GNOMAD_DATASETS = ['gnomad_r4', 'gnomad_r3', 'gnomad_r2_1', 'exac'] as const;

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
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

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
  });
  return _config;
}

/** Reset cached config — test-only. */
export function resetServerConfig(): void {
  _config = undefined;
}
