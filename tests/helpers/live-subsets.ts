/**
 * @fileoverview Live gnomAD replies on subset datasets and their parents, and a
 * fetch fake that answers coverage documents with them, for tests that run the
 * real service at the fetch seam on gnomAD's subsets.
 * @module tests/helpers/live-subsets
 */

import { readFileSync } from 'node:fs';
import { LIVE_COVERAGE } from './fake-gnomad-coverage.js';
import { fakeGnomadGraphql, type GraphqlRequest } from './fake-gnomad-graphql.js';

/** One live gnomAD reply: its HTTP status and body. */
export interface LiveReply {
  body: unknown;
  status: number;
}

/**
 * Live gnomAD replies to this server's own documents, captured 2026-11-03,
 * keyed `<document>:<dataset>:<target>`.
 */
export const SUBSET_REPLIES = JSON.parse(
  readFileSync(new URL('../fixtures/gnomad-subsets.live.json', import.meta.url), 'utf8'),
) as Record<string, LiveReply>;

function liveReply(key: string): LiveReply {
  const reply = SUBSET_REPLIES[key];
  if (!reply) throw new Error(`No live reply under ${key}`);
  return reply;
}

const ok = (body: unknown): LiveReply => ({ status: 200, body });

/**
 * gnomAD's coverage replies, keyed `<target kind>:<dataset>`. Every subset
 * fails: a gene or transcript with HTTP 200 and an error beside a null root, a
 * region with HTTP 500. The gnomad_r4_non_ukb gene reply is that dataset's
 * alias in one aliased live document over every subset (2026-11-03).
 */
const COVERAGE_REPLIES: Record<string, LiveReply> = {
  'region:gnomad_r4': ok(LIVE_COVERAGE['region:1-55039974-55039974']),
  'region:gnomad_r3': liveReply('coverage-region:gnomad_r3:1-55039974-55039974'),
  'region:gnomad_r4_non_ukb': liveReply('coverage-region:gnomad_r4_non_ukb:1-55039974-55039974'),
  'region:gnomad_r3_non_topmed': liveReply(
    'coverage-region:gnomad_r3_non_topmed:1-55039974-55039974',
  ),
  'transcript:gnomad_r4': ok(LIVE_COVERAGE['transcript:ENST00000302118']),
  'transcript:gnomad_r4_non_ukb': liveReply(
    'coverage-transcript:gnomad_r4_non_ukb:ENST00000302118',
  ),
  'gene:gnomad_r4': ok(LIVE_COVERAGE['gene:PCSK9']),
  'gene:gnomad_r3_non_cancer': liveReply('coverage-gene:gnomad_r3_non_cancer:PCSK9'),
  'gene:gnomad_r4_non_ukb': ok({
    errors: [{ message: 'An unknown error occurred' }],
    data: { gene: null },
  }),
};

const COVERAGE_KIND = /query Gnomad(Region|Transcript|Gene)Coverage/;

/**
 * Answer gnomAD coverage documents as gnomAD did for the region
 * 1-55039974-55039974, transcript ENST00000302118, and gene PCSK9 on the
 * datasets above. Any other origin, document, or dataset is rejected, never
 * answered. Returns the requests sent, in order.
 */
export function fakeSubsetCoverage(): GraphqlRequest[] {
  return fakeGnomadGraphql((request) => {
    const kind = COVERAGE_KIND.exec(request.query)?.[1]?.toLowerCase();
    const reply = kind && COVERAGE_REPLIES[`${kind}:${String(request.variables.dataset)}`];
    if (!reply) throw new Error(`Unmocked gnomAD document: ${request.query.slice(0, 80)}`);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    });
  });
}
