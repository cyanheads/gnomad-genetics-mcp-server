/**
 * @fileoverview The User-Agent header every upstream request sends, so gnomAD's
 * and NCBI's operators can tell this server's traffic apart and reach its source.
 * @module services/upstream-user-agent
 */
import { config } from '@cyanheads/mcp-ts-core/config';

/** `gnomad-genetics-mcp-server/<version> (+<repository URL>)`, with the version the server reports. */
export function upstreamUserAgent(): string {
  return `gnomad-genetics-mcp-server/${config.mcpServerVersion} (+https://github.com/cyanheads/gnomad-genetics-mcp-server)`;
}
