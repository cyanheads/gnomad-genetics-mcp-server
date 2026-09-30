/**
 * @fileoverview Tests for sanitizeUpstreamError — the guard that strips raw
 * upstream internals (statusCode/responseBody/requestId/statusText/internal URL)
 * out of the framework HTTP McpError before it can reach the client. Builds the
 * exact leaky error shapes fetchWithTimeout produces and asserts none of those
 * internals survive on the client-facing error's message or data.
 * @module tests/services/upstream-error.test
 */

import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import {
  invalidUpstreamResponse,
  readUpstreamText,
  sanitizeUpstreamError,
  upstreamGraphqlMessages,
  upstreamUnavailable,
} from '@/services/upstream-error.js';

/** The internals that must never reach the client, as literal substrings. */
const LEAKED_VALUES = [
  '503',
  '500',
  'eutils.ncbi.nlm.nih.gov',
  'gnomad.broadinstitute.org',
  'rate limit exceeded for your IP',
  'req-abc-123',
  'Service Unavailable',
];

/** Keys fetchWithTimeout puts on data that are internal-only. */
const LEAKED_KEYS = ['statusCode', 'statusText', 'responseBody', 'requestId', 'errorSource'];

/** The status-mapped McpError fetchWithTimeout throws on a non-2xx response. */
function httpError(code: JsonRpcErrorCode, status: number, upstreamUrl: string): McpError {
  return new McpError(code, `Fetch failed for ${upstreamUrl}. Status: ${status}`, {
    requestId: 'req-abc-123',
    operation: 'gnomad.getVariant',
    statusCode: status,
    statusText: 'Service Unavailable',
    responseBody: 'rate limit exceeded for your IP',
    errorSource: 'FetchHttpError',
  });
}

/** Run the sanitizer and capture the re-thrown error. */
function caught(err: unknown): McpError {
  try {
    sanitizeUpstreamError(err, 'gnomAD');
  } catch (e) {
    return e as McpError;
  }
  throw new Error('sanitizeUpstreamError did not throw');
}

/** Assert no internal value or key survives anywhere a client can read. */
function assertLeakFree(err: McpError): void {
  const serialized = JSON.stringify({ message: err.message, data: err.data ?? {} });
  for (const v of LEAKED_VALUES) expect(serialized).not.toContain(v);
  for (const k of LEAKED_KEYS) expect(err.data ?? {}).not.toHaveProperty(k);
}

describe('sanitizeUpstreamError', () => {
  it('strips all upstream internals from a 503 ServiceUnavailable HTTP error', () => {
    const err = caught(
      httpError(JsonRpcErrorCode.ServiceUnavailable, 503, 'https://gnomad.broadinstitute.org/api'),
    );
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    assertLeakFree(err);
    expect(err.data).toMatchObject({ reason: 'upstream_unavailable', retryable: true });
  });

  it('strips internals from a 429 RateLimited error and keeps it retryable', () => {
    const err = caught(
      httpError(
        JsonRpcErrorCode.RateLimited,
        429,
        'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi',
      ),
    );
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    assertLeakFree(err);
    expect(err.data?.retryable).toBe(true);
  });

  it('strips internals from a 500 InternalError', () => {
    const err = caught(
      httpError(JsonRpcErrorCode.InternalError, 500, 'https://gnomad.broadinstitute.org/api'),
    );
    assertLeakFree(err);
  });

  it('maps a Timeout to a clean retryable timeout', () => {
    const raw = new McpError(JsonRpcErrorCode.Timeout, 'fetch GET … timed out.', {
      requestId: 'req-abc-123',
      operation: 'gnomad.getVariant',
      errorSource: 'FetchTimeout',
    });
    const err = caught(raw);
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    assertLeakFree(err);
    expect(err.data).toMatchObject({ reason: 'upstream_timeout', retryable: true });
  });

  it('maps a network-level ServiceUnavailable (carrying requestId/originalErrorName) clean', () => {
    const raw = new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Network error during fetch', {
      requestId: 'req-abc-123',
      operation: 'clinvar.esearch',
      originalErrorName: 'ECONNREFUSED',
      errorSource: 'FetchNetworkErrorWrapper',
    });
    const err = caught(raw);
    assertLeakFree(err);
    expect(err.data).not.toHaveProperty('originalErrorName');
  });

  it('treats 401/403 as a non-retryable access failure without leaking', () => {
    const err = caught(
      httpError(JsonRpcErrorCode.Forbidden, 403, 'https://gnomad.broadinstitute.org/api'),
    );
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    assertLeakFree(err);
    expect(err.data).toMatchObject({ reason: 'upstream_access', retryable: false });
  });

  it('carries the original leaky error as cause for server-side logs only', () => {
    const raw = httpError(
      JsonRpcErrorCode.ServiceUnavailable,
      503,
      'https://gnomad.broadinstitute.org/api',
    );
    const err = caught(raw);
    // cause is an Error field, never serialized onto the JSON-RPC wire.
    expect(err.cause).toBe(raw);
  });

  it.each([
    ['transient', httpError(JsonRpcErrorCode.ServiceUnavailable, 503, 'https://x.test/api')],
    ['access', httpError(JsonRpcErrorCode.Forbidden, 403, 'https://x.test/api')],
    [
      'timeout',
      new McpError(JsonRpcErrorCode.Timeout, 'timed out', { errorSource: 'FetchTimeout' }),
    ],
  ])('leaves the %s class without a recovery, for the surface’s declaration to fill', (_c, raw) => {
    const err = caught(raw);
    expect(err.data).toHaveProperty('reason');
    expect(err.data).not.toHaveProperty('recovery');
  });

  it('passes a service-raised NotFound straight through (so typed not-found contracts fire)', () => {
    const nf = notFound('Gene not found');
    expect(() => sanitizeUpstreamError(nf, 'gnomAD')).toThrow(nf);
  });

  it('passes a service-raised ValidationError straight through', () => {
    const ve = validationError('Invalid variant ID');
    expect(() => sanitizeUpstreamError(ve, 'gnomAD')).toThrow(ve);
  });

  it('passes a plain non-McpError straight through unchanged', () => {
    const e = new Error('boom');
    expect(() => sanitizeUpstreamError(e, 'gnomAD')).toThrow(e);
  });
});

/** Capture what a throwing helper raised. */
function thrown(run: () => unknown): McpError {
  try {
    run();
  } catch (e) {
    return e as McpError;
  }
  throw new Error('helper did not throw');
}

describe('upstreamUnavailable and invalidUpstreamResponse', () => {
  it('raises upstream_unavailable with the cause kept and no recovery', () => {
    const cause = new Error('gnomAD GraphQL error: Service overloaded');
    const err = thrown(() => upstreamUnavailable(cause, 'gnomAD'));
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.message).toBe('gnomAD is unavailable or rate-limited.');
    expect(err.data).toEqual({ reason: 'upstream_unavailable', retryable: true });
    expect(err.cause).toBe(cause);
  });

  it('raises invalid_upstream_response with the cause kept and no recovery', () => {
    const cause = new SyntaxError('Unexpected end of JSON input');
    const err = thrown(() => invalidUpstreamResponse(cause, 'NCBI ClinVar'));
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.message).toBe('NCBI ClinVar returned an invalid response.');
    expect(err.data).toEqual({ reason: 'invalid_upstream_response', retryable: true });
    expect(err.cause).toBe(cause);
  });
});

/** A 200 response whose body stream fails on the first read with `error`. */
function failingBody(error: unknown): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.error(error);
      },
    }),
    { status: 200 },
  );
}

/** Capture what a body read rejected with. */
async function readFailure(response: Response, upstream: string): Promise<McpError> {
  try {
    await readUpstreamText(response, upstream);
  } catch (e) {
    return e as McpError;
  }
  throw new Error('readUpstreamText did not reject');
}

describe('readUpstreamText', () => {
  it('returns the body text', async () => {
    await expect(readUpstreamText(new Response('{"data":{}}'), 'gnomAD')).resolves.toBe(
      '{"data":{}}',
    );
  });

  it('turns a body deadline into a leak-free upstream_timeout', async () => {
    const deadline = new McpError(JsonRpcErrorCode.Timeout, 'fetch POST … timed out.', {
      errorSource: 'FetchTimeout',
    });
    const err = await readFailure(failingBody(deadline), 'gnomAD');
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.data).toEqual({ reason: 'upstream_timeout', retryable: true });
    expect(err.cause).toBe(deadline);
  });

  it('turns a raw stream reset into upstream_unavailable, keeping the cause', async () => {
    const reset = new TypeError('terminated');
    const err = await readFailure(failingBody(reset), 'NCBI ClinVar');
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.message).toBe('NCBI ClinVar is unavailable or rate-limited.');
    expect(err.data).toEqual({ reason: 'upstream_unavailable', retryable: true });
    expect(err.cause).toBe(reset);
  });
});

/** The McpError fetchWithTimeout throws on a non-2xx, carrying the bounded response body. */
function fetchError(status: number, body: string): McpError {
  return new McpError(
    status >= 500 ? JsonRpcErrorCode.ServiceUnavailable : JsonRpcErrorCode.InvalidParams,
    `Fetch failed for https://gnomad.broadinstitute.org/api. Status: ${status}`,
    {
      status,
      statusText: 'Internal Server Error',
      body,
      statusCode: status,
      responseBody: body,
      errorSource: 'FetchHttpError',
    },
  );
}

describe('upstreamGraphqlMessages', () => {
  const envelope = JSON.stringify({
    errors: [
      { message: 'This region has too many variants to display.' },
      { message: 'Select a smaller region to view variants', path: ['region'] },
    ],
    data: null,
  });

  it('returns every message of a GraphQL error envelope on a 5xx', () => {
    expect(upstreamGraphqlMessages(fetchError(500, envelope))).toEqual([
      'This region has too many variants to display.',
      'Select a smaller region to view variants',
    ]);
    expect(upstreamGraphqlMessages(fetchError(503, envelope))).toHaveLength(2);
  });

  it('ignores the same envelope on a non-5xx status', () => {
    expect(upstreamGraphqlMessages(fetchError(400, envelope))).toBeUndefined();
    expect(upstreamGraphqlMessages(fetchError(429, envelope))).toBeUndefined();
  });

  it.each([
    ['a non-JSON body', '<html>Internal Server Error</html>'],
    ['a body truncated mid-JSON', envelope.slice(0, 40)],
    ['an empty body', ''],
    ['JSON with no errors', '{"data":null}'],
    ['an empty errors list', '{"errors":[],"data":null}'],
    ['an error without a string message', '{"errors":[{"message":42}]}'],
    ['a JSON array', '[]'],
    ['JSON null', 'null'],
  ])('returns undefined for %s', (_label, body) => {
    expect(upstreamGraphqlMessages(fetchError(500, body))).toBeUndefined();
  });

  it('returns undefined for anything that is not a framework HTTP error', () => {
    expect(upstreamGraphqlMessages(new Error(envelope))).toBeUndefined();
    expect(upstreamGraphqlMessages(validationError('Invalid variant ID'))).toBeUndefined();
    expect(
      upstreamGraphqlMessages(
        new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Network error during fetch', {
          errorSource: 'FetchNetworkErrorWrapper',
        }),
      ),
    ).toBeUndefined();
  });
});
