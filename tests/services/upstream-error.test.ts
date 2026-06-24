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
import { sanitizeUpstreamError } from '@/services/upstream-error.js';

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
    sanitizeUpstreamError(err, 'gnomAD', 'wait and retry');
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

  it('surfaces a recovery hint for the transient class', () => {
    const err = caught(
      httpError(JsonRpcErrorCode.ServiceUnavailable, 503, 'https://gnomad.broadinstitute.org/api'),
    );
    expect((err.data?.recovery as { hint?: string } | undefined)?.hint).toBe('wait and retry');
  });

  it('passes a service-raised NotFound straight through (so typed not-found contracts fire)', () => {
    const nf = notFound('Gene not found');
    expect(() => sanitizeUpstreamError(nf, 'gnomAD', 'hint')).toThrow(nf);
  });

  it('passes a service-raised ValidationError straight through', () => {
    const ve = validationError('Invalid variant ID');
    expect(() => sanitizeUpstreamError(ve, 'gnomAD', 'hint')).toThrow(ve);
  });

  it('passes a plain non-McpError straight through unchanged', () => {
    const e = new Error('boom');
    expect(() => sanitizeUpstreamError(e, 'gnomAD', 'hint')).toThrow(e);
  });
});
