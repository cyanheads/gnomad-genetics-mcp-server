/**
 * @fileoverview End-to-end leak test through the REAL service paths. Stubs the
 * global fetch to return upstream failures (503, then a 500 with a body, then a
 * network throw) so fetchWithTimeout produces its genuine status-mapped McpError,
 * then drives GnomadService and ClinVarService and asserts the error that
 * escapes to the caller carries none of the upstream internals
 * (statusCode/responseBody/requestId/statusText/internal URL). This is the
 * regression guard for the pre-public error-leak fix.
 * @module tests/services/upstream-leak.e2e.test
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { ClinVarService } from '@/services/clinvar/clinvar-service.js';
import { GnomadService } from '@/services/gnomad/gnomad-service.js';

/** Internal values/keys that must never reach the caller-facing error. */
const LEAKED_VALUES = [
  'gnomad.broadinstitute.org',
  'eutils.ncbi.nlm.nih.gov',
  'esearch.fcgi',
  'INTERNAL_UPSTREAM_BODY',
  '503',
  '500',
  'Service Unavailable',
];
const LEAKED_KEYS = ['statusCode', 'statusText', 'responseBody', 'requestId', 'errorSource'];

function assertLeakFree(err: McpError): void {
  const serialized = JSON.stringify({ message: err.message, data: err.data ?? {} });
  for (const v of LEAKED_VALUES) expect(serialized, `leaked "${v}"`).not.toContain(v);
  for (const k of LEAKED_KEYS) expect(err.data ?? {}, `leaked key ${k}`).not.toHaveProperty(k);
}

/** A non-2xx Response — drives fetchWithTimeout's status-mapped throw path. */
function errorResponse(status: number): Response {
  return new Response('INTERNAL_UPSTREAM_BODY: rate limit details', {
    status,
    statusText: 'Service Unavailable',
  });
}

/**
 * Run the operation while advancing fake timers so withRetry's exponential
 * backoff sleeps resolve instantly. Returns the final escaped error.
 *
 * The result handler is attached to the promise BEFORE advancing timers, so the
 * rejection is always handled — advancing fake timers settles the retry loop's
 * backoff sleeps, which would otherwise leave the rejection momentarily
 * unobserved.
 */
async function runExhausting(op: () => Promise<unknown>): Promise<McpError> {
  const settled = op().then(
    () => {
      throw new Error('operation did not throw');
    },
    (e: unknown) => e as McpError,
  );
  // Advance through every backoff window the retry loop schedules.
  for (let i = 0; i < 10; i++) {
    await vi.advanceTimersByTimeAsync(60_000);
  }
  return settled;
}

describe('upstream leak guard (e2e through real services)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('GnomadService.getGeneConstraint does not leak upstream internals on a 503', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorResponse(503));
    const svc = new GnomadService(getServerConfig());
    const ctx = createMockContext();
    const dsCtx = svc.resolveDatasetContext('gnomad_r4');

    const err = await runExhausting(() => svc.getGeneConstraint('PCSK9', dsCtx, ctx));
    expect(err).toBeInstanceOf(McpError);
    assertLeakFree(err);
  });

  it('GnomadService.getVariant does not leak on a 500 with an error body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorResponse(500));
    const svc = new GnomadService(getServerConfig());
    const ctx = createMockContext();
    const dsCtx = svc.resolveDatasetContext('gnomad_r4');

    const err = await runExhausting(() => svc.getVariant('1-55051215-G-GA', dsCtx, ctx));
    assertLeakFree(err);
  });

  it('ClinVarService.searchGene does not leak the eutils URL/status/body on a 503', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorResponse(503));
    const svc = new ClinVarService(getServerConfig());
    const ctx = createMockContext();

    const err = await runExhausting(() => svc.searchGene('BRCA1', {}, ctx));
    assertLeakFree(err);
  });

  it('does not leak when fetch throws a raw network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('fetch failed: connect ECONNREFUSED 1.2.3.4:443'),
    );
    const svc = new GnomadService(getServerConfig());
    const ctx = createMockContext();
    const dsCtx = svc.resolveDatasetContext('gnomad_r4');

    const err = await runExhausting(() => svc.getGeneConstraint('PCSK9', dsCtx, ctx));
    // A raw network error becomes a clean serviceUnavailable; the IP/host detail
    // the framework wrapper carries in data must not survive.
    assertLeakFree(err);
    expect(JSON.stringify(err.data ?? {})).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(err.data ?? {})).not.toContain('1.2.3.4');
  });
});
