/**
 * @fileoverview Shared call deadlines and cancellation at the real HTTP/retry seams.
 * @module tests/services/upstream-deadline.test
 */
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { gnomadGetGeneConstraint } from '@/mcp-server/tools/definitions/gnomad-get-gene-constraint.tool.js';
import { gnomadGetVariant } from '@/mcp-server/tools/definitions/gnomad-get-variant.tool.js';
import { ClinVarService } from '@/services/clinvar/clinvar-service.js';
import { GnomadService, initGnomadService } from '@/services/gnomad/gnomad-service.js';
import { minimalVariant } from '../helpers/minimal-variant.js';

const pending = (signal: AbortSignal | null | undefined) =>
  new Promise<Response>((_resolve, reject) => {
    signal?.throwIfAborted();
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
const context = () => createMockContext();
const dataset = { dataset: 'gnomad_r4', reference_genome: 'GRCh38' } as const;

describe('upstream call deadlines', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('characterizes a clean primary absence as one request', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"data":{"gene":null}}'));
    const svc = new GnomadService(getServerConfig());
    expect(await svc.getGeneConstraint('PCSK9', dataset, context())).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('bounds primary headers and queued work with one 45 second budget', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((_url, init) => pending(init?.signal));
    const svc = new GnomadService({
      ...getServerConfig(),
      maxConcurrency: 1,
      requestTimeoutMs: 60_000,
    });
    let first: unknown;
    let second: unknown;
    const one = svc.getGeneConstraint('A', dataset, context()).catch((error) => {
      first = error;
    });
    const two = svc.getGeneConstraint('B', dataset, context()).catch((error) => {
      second = error;
    });
    await vi.advanceTimersByTimeAsync(44_999);
    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(first).toMatchObject({ data: { reason: 'upstream_timeout' } });
    expect(second).toMatchObject({ data: { reason: 'upstream_timeout' } });
    expect(fetch).toHaveBeenCalledTimes(1);
    await Promise.all([one, two]);
  });

  it('removes a cancelled semaphore waiter before the held request finishes', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((_url, init) => pending(init?.signal));
    const svc = new GnomadService({
      ...getServerConfig(),
      maxConcurrency: 1,
      requestTimeoutMs: 60_000,
    });
    const held = new AbortController();
    const queued = new AbortController();
    const one = svc
      .getGeneConstraint('A', dataset, createMockContext({ signal: held.signal }))
      .catch((error) => error);
    let outcome: unknown;
    const two = svc
      .getGeneConstraint('B', dataset, createMockContext({ signal: queued.signal }))
      .catch((error) => {
        outcome = error;
      });
    await vi.advanceTimersByTimeAsync(0);
    queued.abort(new Error('cancel queued lookup'));
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toMatchObject({ message: 'cancel queued lookup' });
    expect(fetch).toHaveBeenCalledTimes(1);
    held.abort(new Error('release held request'));
    await Promise.all([one, two]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('shares the NCBI budget across search and later summary batches', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => String(i + 1));
    const paths: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://eutils.ncbi.nlm.nih.gov');
      paths.push(url.pathname);
      if (url.pathname.endsWith('/esearch.fcgi'))
        return new Response(JSON.stringify({ esearchresult: { count: '101', idlist: ids } }));
      if (url.pathname.endsWith('/esummary.fcgi') && paths.length === 2) {
        await new Promise((resolve) => setTimeout(resolve, 30_000));
        const batch = ids.slice(0, 50);
        return new Response(
          JSON.stringify({
            result: { uids: batch, ...Object.fromEntries(batch.map((uid) => [uid, { uid }])) },
          }),
        );
      }
      if (url.pathname.endsWith('/esummary.fcgi')) return pending(init?.signal);
      throw new Error('unmatched request');
    });
    const svc = new ClinVarService({ ...getServerConfig(), requestTimeoutMs: 60_000 });
    let outcome: unknown;
    const call = svc.searchGene('PCSK9', {}, context()).catch((error) => {
      outcome = error;
    });
    await vi.advanceTimersByTimeAsync(44_999);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toMatchObject({ data: { reason: 'upstream_timeout' } });
    expect(paths).toHaveLength(3);
    await call;
  });

  it.each(['headers', 'body'] as const)(
    'renders a shared %s deadline with declared recovery on both tool surfaces',
    async (stage) => {
      initGnomadService({} as never, {} as never);
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        if (stage === 'headers') return pending(init?.signal);
        return new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), {
                once: true,
              });
            },
          }),
        );
      });
      const call = runToolContract(gnomadGetGeneConstraint, { gene: 'PCSK9' });
      await vi.advanceTimersByTimeAsync(45_000);
      const result = await call;
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'upstream_timeout' } },
      });
      expect(JSON.stringify(result.content)).toContain('wait a few seconds');
      expect(JSON.stringify(result)).not.toContain('retry_deadline_exceeded');
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it('retains ordered batch successes and expires unfinished primary items without late fetches', async () => {
    initGnomadService({} as never, {} as never);
    const requested: string[] = [];
    const starts: number[] = [];
    const startedAt = Date.now();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const { variables } = JSON.parse(String(init?.body));
      requested.push(variables.variantId);
      starts.push(Date.now() - startedAt);
      if (variables.variantId === '1-1-A-T')
        return new Response(
          JSON.stringify({ data: { variant: minimalVariant('1-1-A-T'), clinvar_variant: null } }),
        );
      return pending(init?.signal);
    });
    const call = runToolContract(gnomadGetVariant, {
      variants: ['1-1-A-T', '1-2-A-T', '1-3-A-T', '1-4-A-T'],
    });
    await vi.advanceTimersByTimeAsync(45_000);
    const result = await call;
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      found: [{ variant_id: '1-1-A-T' }],
      failed: [
        { variant: '1-2-A-T', reason: 'upstream_timeout' },
        { variant: '1-3-A-T', reason: 'upstream_timeout' },
        { variant: '1-4-A-T', reason: 'upstream_timeout' },
      ],
    });
    expect(JSON.stringify(result.content)).toContain('upstream_timeout');
    expect(JSON.stringify(result.content)).toContain('smaller batches');
    expect(starts.every((start) => start < 45_000)).toBe(true);
    const count = requested.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requested).toHaveLength(count);
  });

  it('cancels queued NCBI requests promptly and leaves later callers usable', async () => {
    const svc = new ClinVarService(getServerConfig());
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"esearchresult":{"idlist":[],"count":"0"}}'));
    await svc.searchGene('A', {}, context());
    const controller = new AbortController();
    const queued = svc
      .searchGene('B', {}, createMockContext({ signal: controller.signal }))
      .catch((error) => error);
    controller.abort(new Error('cancel paced lookup'));
    await expect(queued).resolves.toMatchObject({ message: 'cancel paced lookup' });
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValue(new Response('{"esearchresult":{"idlist":[],"count":"0"}}'));
    const next = svc.searchGene('C', {}, context());
    await vi.advanceTimersByTimeAsync(334);
    expect(await next).toMatchObject({ rows: [], totalFound: 0 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('expires a search waiting behind another NCBI start without fetching its summary', async () => {
    const svc = new ClinVarService({ ...getServerConfig(), requestTimeoutMs: 60_000 });
    const paths: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.searchParams.get('term')?.includes('SLOW')) {
        await new Promise((resolve) => setTimeout(resolve, 44_950));
        return new Response('{"esearchresult":{"count":"1","idlist":["1"]}}');
      }
      if (url.pathname.endsWith('/esearch.fcgi'))
        return new Response('{"esearchresult":{"count":"0","idlist":[]}}');
      throw new Error('expired summary must not start');
    });
    let outcome: unknown;
    const first = svc.searchGene('SLOW', {}, context()).catch((error) => {
      outcome = error;
    });
    await vi.advanceTimersByTimeAsync(44_900);
    await svc.searchGene('OTHER', {}, context());
    await vi.advanceTimersByTimeAsync(99);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toMatchObject({ data: { reason: 'upstream_timeout' } });
    expect(paths).toHaveLength(2);
    await first;
  });

  it.each(['rsid', 'split'] as const)(
    'shares the primary deadline across the %s chain',
    async (path) => {
      const svc = new GnomadService({ ...getServerConfig(), requestTimeoutMs: 60_000 });
      const operations: string[] = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
        const { query } = JSON.parse(String(init?.body));
        const operation = /query (\w+)/.exec(query)?.[1];
        operations.push(operation!);
        if (operations.length === 1) {
          await new Promise((resolve) => setTimeout(resolve, 30_000));
          if (path === 'rsid')
            return new Response('{"errors":[{"message":"Multiple variants found"}]}');
          return new Response(
            JSON.stringify({
              errors: [{ message: 'An unknown error occurred' }],
              data: { variant: minimalVariant('1-1-A-T'), clinvar_variant: null },
            }),
          );
        }
        return pending(init?.signal);
      });
      let outcome: unknown;
      const call = svc
        .getVariant(path === 'rsid' ? 'rs1' : '1-1-A-T', dataset, context())
        .catch((error) => {
          outcome = error;
        });
      await vi.advanceTimersByTimeAsync(44_999);
      expect(outcome).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(outcome).toMatchObject({ data: { reason: 'upstream_timeout' } });
      expect(operations).toEqual(
        path === 'rsid'
          ? ['GnomadVariantByRsid', 'GnomadVariantSearch']
          : ['GnomadVariant', 'GnomadVariantOnly'],
      );
      await call;
    },
  );
});
