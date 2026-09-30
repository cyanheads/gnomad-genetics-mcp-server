/**
 * @fileoverview Offline integration tests for how the region tools surface
 * gnomAD's own failure messages. Runs the real tool definitions through
 * runToolContract over the real GnomadService with only global fetch faked, so
 * the retry loop, fetchWithTimeout, the region-message allowlist, the sanitizer,
 * and the declared recovery hints are all on the tested path. Covers the
 * caller-correctable HTTP 500s no pre-check can predict (a region holding more
 * variants than gnomAD lists) and the transient messages that must keep retrying.
 * @module tests/integration/upstream-errors.integration.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gnomadGetCoverage } from '@/mcp-server/tools/definitions/gnomad-get-coverage.tool.js';
import { gnomadListGeneVariants } from '@/mcp-server/tools/definitions/gnomad-list-gene-variants.tool.js';
import { initGnomadService } from '@/services/gnomad/gnomad-service.js';

interface GraphqlRequest {
  query: string;
  variables: Record<string, unknown>;
}

interface ErrorEnvelope {
  error: {
    code: number;
    message: string;
    data: { reason: string; retryable?: boolean; recovery?: { hint: string } };
  };
}

type ToolResult = Awaited<ReturnType<typeof runToolContract>>;
type RegionTool = typeof gnomadListGeneVariants | typeof gnomadGetCoverage;

let requests: GraphqlRequest[];

/** Answer every GraphQL request with the given replies in order, the last one repeating. */
function fakeGnomad(...replies: { status: number; body: unknown }[]): void {
  requests = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as GraphqlRequest);
    const { status, body } = replies[Math.min(requests.length, replies.length) - 1] as {
      status: number;
      body: unknown;
    };
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
}

function graphqlErrors(...messages: string[]) {
  return { errors: messages.map((message) => ({ message })), data: null };
}

/** Run a tool call while advancing fake timers past every retry backoff. */
async function call(tool: RegionTool, input: Record<string, unknown>) {
  const outcome = runToolContract(tool, input as never);
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(60_000);
  return outcome;
}

function errorOf(result: ToolResult): ErrorEnvelope['error'] {
  return (result.structuredContent as ErrorEnvelope).error;
}

function textOf(result: ToolResult): string {
  return (result.content as { type: string; text?: string }[])
    .map((block) => block.text ?? '')
    .join('\n');
}

function declared(tool: RegionTool, reason: string): string {
  return tool.errors?.find((entry) => entry.reason === reason)?.recovery ?? '';
}

const TOO_MANY_VARIANTS =
  'This region has too many variants to display. Select a smaller region to view variants.';
/** The sanitized transient message once the retry loop gives up. */
const RETRIED_OUT = 'gnomAD is unavailable or rate-limited. (failed after 4 attempts)';

beforeEach(() => {
  vi.useFakeTimers();
  initGnomadService({} as never, {} as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('gnomad_list_gene_variants — a region gnomAD refuses for its variant count', () => {
  it('fails once as region_too_large with gnomAD’s text and the declared hint, on both surfaces', async () => {
    fakeGnomad({ status: 500, body: graphqlErrors(TOO_MANY_VARIANTS) });
    const tool = gnomadListGeneVariants;

    const result = await call(tool, { region: '1-1000000-3400000', dataset: 'gnomad_r4' });

    expect(result.isError).toBe(true);
    expect(errorOf(result)).toEqual({
      code: JsonRpcErrorCode.ValidationError,
      message: TOO_MANY_VARIANTS,
      data: {
        reason: 'region_too_large',
        retryable: false,
        recovery: { hint: declared(tool, 'region_too_large') },
      },
    });
    const text = textOf(result);
    expect(text).toContain(TOO_MANY_VARIANTS);
    expect(text).toContain(declared(tool, 'region_too_large'));
    expect(text).toContain('reason region_too_large · not retryable');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.variables).toMatchObject({ chrom: '1', start: 1000000, stop: 3400000 });
  });

  it('keeps a successful region answer unchanged', async () => {
    fakeGnomad({ status: 200, body: { data: { region: { variants: [] } } } });
    const result = await call(gnomadListGeneVariants, { region: '1-55039447-55064852' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ total: 0, preview: [] });
    expect(requests).toHaveLength(1);
  });
});

describe.each([
  ['gnomad_list_gene_variants', gnomadListGeneVariants, 'Select a smaller region to view variants'],
  ['gnomad_get_coverage', gnomadGetCoverage, 'Coverage is not available for a region this large'],
] as [string, RegionTool, string][])(
  '%s — gnomAD region messages on HTTP 500',
  (_name, tool, tooLarge) => {
    it.each([
      [tooLarge, 'region_too_large'],
      ["Invalid chromosome: '23'", 'invalid_region'],
      ['Region stop must be greater than region start', 'invalid_region'],
    ])('maps "%s" to %s after one fetch, with the declared hint', async (message, reason) => {
      fakeGnomad({ status: 500, body: graphqlErrors(message) });

      const result = await call(tool, { region: '2-1000-2000' });

      expect(result.isError).toBe(true);
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message,
        data: { reason, retryable: false, recovery: { hint: declared(tool, reason) } },
      });
      expect(textOf(result)).toContain(message);
      expect(textOf(result)).toContain(declared(tool, reason));
      expect(requests).toHaveLength(1);
    });

    it('keeps retrying an unlisted 500 message and ends as upstream_unavailable', async () => {
      fakeGnomad({ status: 500, body: graphqlErrors('An unknown error occurred') });

      const result = await call(tool, { region: '2-1000-2000' });

      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: RETRIED_OUT,
        data: { reason: 'upstream_unavailable', retryable: true },
      });
      expect(textOf(result)).not.toContain('An unknown error occurred');
      expect(requests).toHaveLength(4);
    });
  },
);

describe('gnomad_list_gene_variants — transient messages on an HTTP 200 envelope', () => {
  const overloaded = {
    status: 200,
    body: { errors: [{ message: 'Service overloaded', path: ['gene'] }], data: { gene: null } },
  };

  it('retries "Service overloaded" and ends as upstream_unavailable with the retry hint', async () => {
    fakeGnomad(overloaded);

    const result = await call(gnomadListGeneVariants, { gene: 'PCSK9' });

    const error = errorOf(result);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: RETRIED_OUT,
      data: { reason: 'upstream_unavailable', retryable: true },
    });
    expect(error.data.recovery?.hint).toMatch(/wait a few seconds and retry/);
    expect(textOf(result)).toContain(error.data.recovery?.hint ?? '');
    expect(textOf(result)).toContain('reason upstream_unavailable · retryable');
    expect(requests).toHaveLength(4);
  });

  it('answers once the overload clears on a later attempt', async () => {
    fakeGnomad(overloaded, overloaded, {
      status: 200,
      body: { data: { gene: { chrom: '1', variants: [] } } },
    });

    const result = await call(gnomadListGeneVariants, { gene: 'PCSK9' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ total: 0 });
    expect(requests).toHaveLength(3);
  });
});
