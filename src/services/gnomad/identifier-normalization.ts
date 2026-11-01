/**
 * @fileoverview Identifier spellings with one clear reading, rewritten to the
 * form gnomAD accepts before validation: an uppercase rsID, a colon-separated
 * variant ID or region (thousands separators allowed in a region), and an
 * Ensembl gene or transcript ID in lowercase or with a version suffix. Gated by
 * GNOMAD_NORMALIZE_IDS (default on); with it off every input is left as sent.
 * Each applied rewrite writes one log line and increments a counter keyed by
 * its kind.
 * @module services/gnomad/identifier-normalization
 */

import { createCounter, logger, requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';

/** Which identifier a rewrite applies to — the counter's only attribute. */
export type IdentifierKind = 'rsid' | 'gene' | 'transcript' | 'variant' | 'region';

/**
 * An Ensembl gene ID, versioned or not; group 1 is the stable ID. A version
 * suffix is stripped only from a bare stable ID, so a PAR_Y form (ENSG….PAR_Y,
 * ENSG…_PAR_Y, ENSG….14_PAR_Y) never resolves to the X record.
 */
export const ENSEMBL_GENE_ID = /^(ENSG\d+)(?:\.\d+)?$/i;
const ENSEMBL_TRANSCRIPT_ID = /^(ENST\d+)(?:\.\d+)?$/i;
/** chrom:start-stop, the browser and samtools spelling of a region. */
const COLON_REGION = /^(?:chr)?([0-9A-Z]+):([\d,]+)-([\d,]+)$/i;
/** A coordinate written plain or grouped in thousands (55,039,447) — never any other comma use. */
const COORDINATE = /^(?:\d+|\d{1,3}(?:,\d{3})+)$/;

const REWRITES: Record<IdentifierKind, (value: string) => string> = {
  /** gnomAD rejects any rsID not written in lowercase. Callers pass rsID-shaped values only. */
  rsid: (value) => value.toLowerCase(),
  /** chrom:pos:ref:alt → chrom-pos-ref-alt; a value mixing both separators keeps its reading open. */
  variant: (value) =>
    !value.includes('-') && value.split(':', 5).length === 4 ? value.replaceAll(':', '-') : value,
  gene: (value) => ENSEMBL_GENE_ID.exec(value)?.[1]?.toUpperCase() ?? value,
  transcript: (value) => ENSEMBL_TRANSCRIPT_ID.exec(value)?.[1]?.toUpperCase() ?? value,
  region: (value) => {
    const [, chrom, start = '', stop = ''] = COLON_REGION.exec(value) ?? [];
    if (!chrom || !COORDINATE.test(start) || !COORDINATE.test(stop)) return value;
    return `${chrom.toUpperCase()}-${start.replaceAll(',', '')}-${stop.replaceAll(',', '')}`;
  },
};

/** Created on first use: a module-load call would bind the no-op meter OpenTelemetry starts with. */
let rewrites: ReturnType<typeof createCounter> | undefined;

/**
 * The spelling of `value` this server validates and sends upstream: the
 * one-reading rewrite for `kind` when GNOMAD_NORMALIZE_IDS is on and `accepts`
 * takes the rewritten value, else `value` unchanged. Reads the server config on
 * every call, never at import. An applied rewrite logs once and increments
 * `gnomad.identifiers.normalized` with its `kind`; an input already canonical
 * does neither.
 */
export function normalizeIdentifier(
  kind: IdentifierKind,
  value: string,
  accepts: (rewritten: string) => boolean = () => true,
): string {
  if (!getServerConfig().normalizeIds) return value;
  const rewritten = REWRITES[kind](value);
  if (rewritten === value || !accepts(rewritten)) return value;
  logger.info(
    `Normalized a ${kind} identifier before validation.`,
    requestContextService.createRequestContext({
      operation: 'normalizeIdentifier',
      additionalContext: { kind, from: value, to: rewritten },
    }),
  );
  rewrites ??= createCounter(
    'gnomad.identifiers.normalized',
    'Identifier spellings rewritten to their canonical form before validation',
    '{rewrites}',
  );
  rewrites.add(1, { kind });
  return rewritten;
}
