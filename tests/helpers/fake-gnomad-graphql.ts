/**
 * @fileoverview The fetch seam the fake gnomAD helpers share: a global fetch
 * spy that records each GraphQL request the service sends to the gnomAD
 * origin and answers it, and refuses any other origin.
 * @module tests/helpers/fake-gnomad-graphql
 */

import { vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';

/** A GraphQL document and its variables as the service sends them. */
export interface GraphqlRequest {
  query: string;
  variables: Record<string, unknown>;
}

const GNOMAD_ORIGIN = new URL(getServerConfig().gnomadApiBaseUrl).origin;

/**
 * Spy on global fetch: record each request to the gnomAD origin, then answer it
 * with `respond`. A request to any other origin throws, never reaching the
 * network. Returns the requests sent, in order.
 */
export function fakeGnomadGraphql<R extends GraphqlRequest = GraphqlRequest>(
  respond: (request: R) => Response | Promise<Response>,
): R[] {
  const requests: R[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).origin !== GNOMAD_ORIGIN) throw new Error(`Unmocked fetch to ${url}`);
    const request = JSON.parse(String(init?.body)) as R;
    requests.push(request);
    return respond(request);
  });
  return requests;
}
