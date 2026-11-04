/**
 * @fileoverview Live gnomAD variant_cooccurrence replies on gnomad_r2_1,
 * captured 2026-11-03 and keyed by the variants argument as sent, plus a fake
 * global fetch that serves them — for tests of gnomad_get_variant_cooccurrence
 * at the fetch seam, where the retry loop, response validation, labelling, and
 * refusal mapping all run for real.
 * @module tests/helpers/live-cooccurrence
 */

import { readFileSync } from 'node:fs';
import { vi } from 'vitest';

const FIXTURE = JSON.parse(
  readFileSync(new URL('../fixtures/gnomad-cooccurrence.live.json', import.meta.url), 'utf8'),
) as { replies: Record<string, unknown> };

/** gnomAD's live HTTP 200 body for a co-occurrence request sending `variants` in this order. */
export function liveCooccurrence(...variants: string[]): unknown {
  const body = FIXTURE.replies[variants.join(' ')];
  if (body === undefined)
    throw new Error(`No live co-occurrence capture for ${variants.join(' ')}`);
  return body;
}

/** One co-occurrence request as the fake sees it. */
export interface CooccurrenceRequest {
  query: string;
  variables: { dataset: string; variants: string[] };
}

/**
 * Fake gnomAD: answer each request with `respond` — by default the live capture
 * for the variants it sends — and record it. Returns the fetch spy and the
 * recorded requests.
 */
export function fakeCooccurrenceFetch(
  respond: (
    request: CooccurrenceRequest,
    init: RequestInit | undefined,
  ) => Promise<Response> | Response = (request) =>
    Response.json(liveCooccurrence(...request.variables.variants)),
) {
  const requests: CooccurrenceRequest[] = [];
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as CooccurrenceRequest;
    requests.push(request);
    return respond(request, init);
  });
  return { fetch, requests };
}
