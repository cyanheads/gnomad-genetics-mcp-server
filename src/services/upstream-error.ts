/**
 * @fileoverview Sanitizes framework HTTP errors before they reach the client.
 *
 * `fetchWithTimeout` throws a status-mapped `McpError` on any non-2xx (and on
 * network/abort failures) whose `data` carries raw upstream internals —
 * `statusCode`, `statusText`, `responseBody`, the request `operation`, the
 * internal `requestId`, and an internal request URL inside the message. On a
 * public server those internals would leak to the caller. Service methods route
 * every upstream failure through {@link sanitizeUpstreamError}, which detects the
 * framework error STRUCTURALLY (by `JsonRpcErrorCode` + leak markers in `data`,
 * never by string-matching the message — that format drifts) and re-throws a
 * clean typed domain error: a generic message, leak-free `data`
 * (`reason` + `retryable`), and the original carried as `cause` for
 * server-side logs only (an `Error` `cause` is never serialized onto the wire).
 *
 * @module services/upstream-error
 */

import {
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
  timeout,
} from '@cyanheads/mcp-ts-core/errors';

/**
 * Keys `fetchWithTimeout` puts in `McpError.data` on an upstream failure. Any
 * one of these present marks an error that originated in the framework HTTP
 * layer and therefore carries internals we must not forward to the client.
 */
const LEAK_MARKER_KEYS = ['statusCode', 'responseBody', 'requestId', 'errorSource'] as const;

/**
 * Codes `fetchWithTimeout` raises on an upstream/transport failure. A framework
 * McpError on one of these codes is sanitized; codes the service raises itself
 * (NotFound, ValidationError, …) pass through untouched so their typed
 * not-found / validation contracts still fire at the handler.
 */
const SANITIZED_CODES = new Set<JsonRpcErrorCode>([
  JsonRpcErrorCode.ServiceUnavailable,
  JsonRpcErrorCode.RateLimited,
  JsonRpcErrorCode.Timeout,
  JsonRpcErrorCode.InternalError,
  JsonRpcErrorCode.Unauthorized,
  JsonRpcErrorCode.Forbidden,
  JsonRpcErrorCode.Conflict,
]);

/** True when `data` carries any framework HTTP-layer leak marker. */
function hasLeakMarker(data: Record<string, unknown> | undefined): boolean {
  if (!data) return false;
  return LEAK_MARKER_KEYS.some((k) => k in data);
}

/**
 * Re-throw a clean, leak-free domain error for an upstream/transport failure
 * raised by the framework HTTP layer, or rethrow anything else unchanged.
 *
 * Detection is structural: an `McpError` qualifies for sanitizing when its
 * `code` is a transport/upstream code AND/OR its `data` carries a framework
 * leak marker. The clean error preserves the failure *class* (transient vs
 * timeout) so callers' retry/backoff and typed contracts still work, but its
 * message and `data` reveal nothing about the upstream URL, status, body, or
 * internal request IDs.
 *
 * @param err - The caught error.
 * @param upstream - Human label for the dependency (e.g. `'gnomAD'`, `'NCBI ClinVar'`).
 * @param retryHint - Recovery guidance surfaced to the agent (no internal detail).
 * @throws A sanitized `McpError`, or the original error if it isn't a framework HTTP error.
 */
export function sanitizeUpstreamError(err: unknown, upstream: string, retryHint: string): never {
  if (!(err instanceof McpError) || !(SANITIZED_CODES.has(err.code) || hasLeakMarker(err.data))) {
    throw err;
  }

  // Preserve the failure class so the right client-facing semantics apply; never
  // forward the framework `data` (statusCode/responseBody/requestId/URL).
  if (err.code === JsonRpcErrorCode.Timeout) {
    throw timeout(
      `${upstream} request timed out.`,
      { reason: 'upstream_timeout', retryable: true },
      { cause: err },
    );
  }

  if (err.code === JsonRpcErrorCode.Unauthorized || err.code === JsonRpcErrorCode.Forbidden) {
    // Surfaces as transient to the client but flags the real cause for the operator.
    throw serviceUnavailable(
      `${upstream} rejected the request (access).`,
      { reason: 'upstream_access', retryable: false },
      { cause: err },
    );
  }

  // ServiceUnavailable / RateLimited / InternalError / Conflict / any leak-marked
  // error → a single clean transient class with the supplied recovery hint.
  throw serviceUnavailable(
    `${upstream} is unavailable or rate-limited.`,
    { reason: 'upstream_unavailable', retryable: true, recovery: { hint: retryHint } },
    { cause: err },
  );
}
