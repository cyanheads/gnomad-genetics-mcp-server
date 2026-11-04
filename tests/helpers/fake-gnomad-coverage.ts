/**
 * @fileoverview Live gnomAD coverage responses and a fetch fake that serves
 * them, for tests that run the real coverage request, retry, and
 * response-validation path.
 * @module tests/helpers/fake-gnomad-coverage
 */

import { readFileSync } from 'node:fs';
import { fakeGnomadGraphql, type GraphqlRequest } from './fake-gnomad-graphql.js';

/**
 * Live gnomAD coverage responses (gnomad_r4) keyed `<target kind>:<target>`.
 * Each record is a verbatim gnomAD bucket; runs no test reads are trimmed out.
 */
export const LIVE_COVERAGE = JSON.parse(
  readFileSync(new URL('../fixtures/gnomad-coverage.live.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

/**
 * Answer every gnomAD coverage request with `envelope` at the fetch seam. Any
 * other origin or GraphQL document is rejected, never answered. Returns the
 * requests sent, in order.
 */
export function fakeCoverage(envelope: unknown): GraphqlRequest[] {
  return fakeGnomadGraphql((request) => {
    if (!/query Gnomad\w*Coverage/.test(request.query)) {
      throw new Error(`Unmocked gnomAD document: ${request.query.slice(0, 80)}`);
    }
    return new Response(JSON.stringify(envelope), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}
