/**
 * @fileoverview The `limit` count input of the paged tools and the clamp behind
 * it. GNOMAD_CLAMP_LIMITS, read once when the tool definitions evaluate, picks
 * the mode. On (the default), the schema advertises a default and a minimum but
 * no maximum, and a value above the cap is lowered to the cap with a notice, an
 * info log line, and a `gnomad.input.limit_clamped` count. Off, the schema
 * advertises the cap as its maximum and rejects anything above it.
 * @module mcp-server/tools/count-limit
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { ATTR_MCP_TOOL_NAME, createCounter } from '@cyanheads/mcp-ts-core/utils';
import { isClampLimitsEnabled } from '@/config/server-config.js';

/** One tool's `limit`: what a call without one gets, and the most a call is served. */
export interface CountLimit {
  cap: number;
  default: number;
  tool: 'gnomad_dataframe_query' | 'gnomad_list_gene_variants' | 'gnomad_search_clinvar';
}

const WHOLE_NUMBER = 'Send limit as a whole number, such as 25.';

/**
 * The `limit` field for `spec`: `lead` describes what the limit counts, and the
 * description closes with the default and how the cap applies in this mode.
 * Clamping on, `multipleOf(1)` stands in for `.int()`, which would advertise
 * 2^53 − 1 as a maximum; the refinement catches what `multipleOf` tolerates as
 * float noise (20.000000000000004), runs only on an otherwise valid value so a
 * fraction reports one issue, and adds nothing to the advertised schema.
 */
export function limitSchema(spec: CountLimit, lead: string) {
  const cap = spec.cap.toLocaleString('en-US');
  if (!isClampLimitsEnabled()) {
    return z
      .number()
      .int(WHOLE_NUMBER)
      .min(1)
      .max(spec.cap)
      .default(spec.default)
      .describe(`${lead} Default ${spec.default}; at most ${cap}.`);
  }
  return z
    .number()
    .multipleOf(1, WHOLE_NUMBER)
    .min(1)
    .refine(Number.isInteger, { message: WHOLE_NUMBER, when: ({ issues }) => issues.length === 0 })
    .default(spec.default)
    .describe(
      `${lead} Default ${spec.default}; a value above ${cap} is clamped to ${cap}, with a notice.`,
    );
}

/** Created on first clamp: a counter made at import binds the no-op meter OpenTelemetry starts with. */
let clamped: ReturnType<typeof createCounter> | undefined;

/**
 * `requested` lowered to `spec.cap`. A clamp writes one info log line, adds one
 * to `gnomad.input.limit_clamped` for the tool, and returns the notice naming
 * the requested and applied values; a request within the cap does none of that.
 */
export function clampLimit(
  ctx: Context,
  spec: CountLimit,
  requested: number,
): { applied: number; notice?: string } {
  if (requested <= spec.cap) return { applied: requested };
  ctx.log.info('Clamped limit to its cap', {
    tool: spec.tool,
    requested,
    applied: spec.cap,
  });
  clamped ??= createCounter(
    'gnomad.input.limit_clamped',
    'Requests whose limit was lowered to the cap',
    '{requests}',
  );
  clamped.add(1, { [ATTR_MCP_TOOL_NAME]: spec.tool });
  return {
    applied: spec.cap,
    notice: `Requested limit ${requested} was clamped to the cap of ${spec.cap}.`,
  };
}
