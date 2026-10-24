/**
 * @fileoverview Fixed upstream call budget shared by chained requests and batch items.
 * @module services/upstream-deadline
 */
import { timeout } from '@cyanheads/mcp-ts-core/errors';

/** Total milliseconds for an upstream-backed call, including queueing and retries. */
export const UPSTREAM_CALL_BUDGET_MS = 45_000;

/** Milliseconds left before an absolute epoch deadline; caller cancellation takes precedence. */
export function remainingBudget(deadline: number, signal: AbortSignal, upstream: string): number {
  signal.throwIfAborted();
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw timeout(`${upstream} request timed out.`, {
      reason: 'upstream_timeout',
      retryable: true,
    });
  }
  return remaining;
}
