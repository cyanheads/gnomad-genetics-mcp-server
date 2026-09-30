/**
 * @fileoverview Offline integration tests for which chromosomes and region
 * bounds the region tools and gnomad_get_variant send to gnomAD. Runs the real
 * tool definitions through runToolContract over the real GnomadService, with
 * only global fetch faked, so the region parser, the variant-ID guard, the
 * gene/transcript chromosome check, and the declared recovery hints are all on
 * the tested path.
 * @module tests/integration/chromosome-scope.integration.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GNOMAD_DATASETS } from '@/config/server-config.js';
import { variantResource } from '@/mcp-server/resources/definitions/variant.resource.js';
import { gnomadGetCoverage } from '@/mcp-server/tools/definitions/gnomad-get-coverage.tool.js';
import { gnomadGetVariant } from '@/mcp-server/tools/definitions/gnomad-get-variant.tool.js';
import { gnomadListGeneVariants } from '@/mcp-server/tools/definitions/gnomad-list-gene-variants.tool.js';
import { initGnomadService } from '@/services/gnomad/gnomad-service.js';
import { minimalVariant } from '../helpers/minimal-variant.js';
import { readResourceBody, rpcErrorOf } from '../helpers/worker-resource-read.js';

interface GraphqlRequest {
  query: string;
  variables: Record<string, unknown>;
}

/** Answer every GraphQL document with an empty, well-formed payload for its root. */
function emptyPayload(request: GraphqlRequest, featureChrom: string): unknown {
  const coverage = request.query.includes('coverage(');
  const inner = coverage ? { coverage: { exome: [], genome: [] } } : { variants: [] };
  if (request.query.includes('region(')) return { data: { region: inner } };
  const root = request.query.includes('transcript(') ? 'transcript' : 'gene';
  return { data: { [root]: { chrom: featureChrom, ...inner } } };
}

let requests: GraphqlRequest[];

function fakeGnomad(featureChrom = '1'): void {
  requests = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as GraphqlRequest;
    requests.push(request);
    return new Response(JSON.stringify(emptyPayload(request, featureChrom)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

interface ErrorEnvelope {
  error: {
    code: number;
    message: string;
    data: { reason: string; retryable?: boolean; recovery?: { hint: string } };
  };
}

function errorOf(result: { structuredContent?: unknown }): ErrorEnvelope['error'] {
  return (result.structuredContent as ErrorEnvelope).error;
}

function textOf(result: { content: unknown[] }): string {
  return (result.content as { type: string; text?: string }[])
    .map((block) => block.text ?? '')
    .join('\n');
}

const REGION_TOOLS = [
  ['gnomad_list_gene_variants', gnomadListGeneVariants],
  ['gnomad_get_coverage', gnomadGetCoverage],
] as const;

const NUCLEAR = [...Array.from({ length: 22 }, (_, index) => String(index + 1)), 'X', 'Y'] as const;

beforeEach(() => {
  initGnomadService({} as never, {} as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(REGION_TOOLS)('%s — region forms gnomAD already serves', (_name, tool) => {
  it.each(GNOMAD_DATASETS)('sends each of 1–22, X, and Y unchanged on %s', async (dataset) => {
    fakeGnomad();
    for (const chrom of NUCLEAR) {
      const result = await runToolContract(tool as typeof gnomadGetCoverage, {
        region: `${chrom}-1000-1010`,
        dataset,
      });
      expect(result.isError).toBeFalsy();
    }
    expect(requests.map((request) => request.variables.chrom)).toEqual([...NUCLEAR]);
    expect(requests.every((request) => request.variables.dataset === dataset)).toBe(true);
  });

  it('sends a single-position region with start equal to stop', async () => {
    fakeGnomad();
    const result = await runToolContract(tool as typeof gnomadGetCoverage, {
      region: '1-55051215-55051215',
    });
    expect(result.isError).toBeFalsy();
    expect(requests[0]?.variables).toMatchObject({ chrom: '1', start: 55051215, stop: 55051215 });
  });

  it('sends a span one base under 2,500,000', async () => {
    fakeGnomad();
    const result = await runToolContract(tool as typeof gnomadGetCoverage, {
      region: 'Y-30000001-32500000',
    });
    expect(result.isError).toBeFalsy();
    expect(requests[0]?.variables).toMatchObject({ chrom: 'Y', start: 30000001, stop: 32500000 });
  });

  it('rejects an inverted region with the start-exceeds-stop message and no fetch', async () => {
    fakeGnomad();
    const result = await runToolContract(tool as typeof gnomadGetCoverage, {
      region: '1-200-100',
    });
    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('Region start must not exceed stop: 200 > 100.'),
      data: { reason: 'invalid_region', retryable: false },
    });
    expect(requests).toHaveLength(0);
  });

  it('answers a nuclear gene target from one request', async () => {
    fakeGnomad('1');
    const result = await runToolContract(tool as typeof gnomadGetCoverage, { gene: 'PCSK9' });
    expect(result.isError).toBeFalsy();
    expect(requests).toHaveLength(1);
  });
});

describe.each(REGION_TOOLS)('%s — region forms outside what gnomAD serves', (_name, tool) => {
  const declared = (reason: string) =>
    tool.errors?.find((entry) => entry.reason === reason)?.recovery ?? '';

  it.each(['23-1-2', '0-1-2', '01-1-2', 'XY-1-2', '1-0-10', '1-999999990-1000000000'])(
    'rejects %s as invalid_region before any fetch',
    async (region) => {
      fakeGnomad();
      const result = await runToolContract(tool as typeof gnomadGetCoverage, { region });
      expect(result.isError).toBe(true);
      const error = errorOf(result);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_region', retryable: false },
      });
      expect(error.data.recovery?.hint).toBe(declared('invalid_region'));
      expect(textOf(result)).toContain(declared('invalid_region'));
      expect(requests).toHaveLength(0);
    },
  );

  it('names the rejected chromosome and the rejected bound in the message', async () => {
    fakeGnomad();
    const chrom = await runToolContract(tool as typeof gnomadGetCoverage, { region: '23-1-2' });
    const start = await runToolContract(tool as typeof gnomadGetCoverage, { region: '1-0-10' });
    const stop = await runToolContract(tool as typeof gnomadGetCoverage, {
      region: '1-999999990-1000000000',
    });
    expect(errorOf(chrom).message).toContain('"23"');
    expect(errorOf(start).message).toContain('start');
    expect(errorOf(stop).message).toContain('1,000,000,000');
  });

  it.each(['Y-30000001-32500001', '1-1-2500001'])(
    'rejects %s (span of 2,500,000 or more) as region_too_large before any fetch',
    async (region) => {
      fakeGnomad();
      const result = await runToolContract(tool as typeof gnomadGetCoverage, { region });
      expect(result.isError).toBe(true);
      const error = errorOf(result);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'region_too_large', retryable: false },
      });
      expect(error.data.recovery?.hint).toBe(declared('region_too_large'));
      expect(textOf(result)).toContain(declared('region_too_large'));
      expect(requests).toHaveLength(0);
    },
  );

  it.each([
    ['chr1-1000-1010', '1'],
    ['CHRx-1000-1010', 'X'],
    ['x-1000-1010', 'X'],
    ['chry-1000-1010', 'Y'],
  ])('sends %s to gnomAD as chromosome %s', async (region, canonical) => {
    fakeGnomad();
    const result = await runToolContract(tool as typeof gnomadGetCoverage, { region });
    expect(result.isError).toBeFalsy();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.variables).toMatchObject({ chrom: canonical, start: 1000, stop: 1010 });
  });

  it.each(['M-1-100', 'MT-1-100', 'chrm-1-100', 'chrMT-1-100'])(
    'rejects mitochondrial region %s as mitochondrial_unsupported before any fetch',
    async (region) => {
      fakeGnomad();
      const result = await runToolContract(tool as typeof gnomadGetCoverage, { region });
      expect(result.isError).toBe(true);
      const error = errorOf(result);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'mitochondrial_unsupported', retryable: false },
      });
      expect(error.data.recovery?.hint).toBe(declared('mitochondrial_unsupported'));
      expect(error.data.recovery?.hint).toContain('https://gnomad.broadinstitute.org/');
      expect(textOf(result)).toContain(declared('mitochondrial_unsupported'));
      expect(requests).toHaveLength(0);
    },
  );

  it('rejects a mitochondrial gene (gnomAD chrom "M") after its single request', async () => {
    fakeGnomad('M');
    const result = await runToolContract(tool as typeof gnomadGetCoverage, {
      gene: 'MT-TL1',
      dataset: 'gnomad_r3',
    });
    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('MT-TL1'),
      data: { reason: 'mitochondrial_unsupported', retryable: false },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.query).toMatch(/\bchrom\b/);
  });

  it('rejects a mitochondrial transcript (gnomAD chrom "M") after its single request', async () => {
    fakeGnomad('M');
    const result = await runToolContract(tool as typeof gnomadGetCoverage, {
      transcript_id: 'ENST00000386347',
    });
    expect(result.isError).toBe(true);
    expect(errorOf(result).data.reason).toBe('mitochondrial_unsupported');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.query).toContain('transcript(');
  });

  it('keeps answering a nuclear transcript from one request', async () => {
    fakeGnomad('X');
    const result = await runToolContract(tool as typeof gnomadGetCoverage, {
      transcript_id: 'ENST00000302118',
    });
    expect(result.isError).toBeFalsy();
    expect(requests).toHaveLength(1);
  });
});

describe('gnomad_get_variant — mitochondrial coordinate IDs', () => {
  it('fails M, MT, and chrM IDs per item with no variant fetch, beside a nuclear ID that resolves', async () => {
    requests = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as GraphqlRequest;
      requests.push(request);
      return Response.json({
        data: {
          variant: minimalVariant(String(request.variables.variantId)),
          clinvar_variant: null,
        },
      });
    });

    const result = await runToolContract(gnomadGetVariant, {
      variants: ['M-3243-A-G', 'MT-3243-A-G', 'chrM-3243-A-G', 'mt-3243-a-g', '1-55051215-G-GA'],
      dataset: 'gnomad_r3',
    });

    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as {
      found: { variant_id: string }[];
      failed: { variant: string; error: string }[];
    };
    expect(out.found.map((record) => record.variant_id)).toEqual(['1-55051215-G-GA']);
    expect(out.failed.map((item) => item.variant)).toEqual([
      'M-3243-A-G',
      'MT-3243-A-G',
      'chrM-3243-A-G',
      'mt-3243-a-g',
    ]);
    for (const item of out.failed) {
      expect(item.error).toMatch(/mitochondrial/i);
      expect(item.error).not.toMatch(/malformed|not found/i);
    }
    expect(textOf(result)).toContain('M-3243-A-G');
    expect(textOf(result)).toMatch(/mitochondrial/i);
    expect(requests.map((request) => request.variables.variantId)).toEqual(['1-55051215-G-GA']);
  });

  it('declares mitochondrial_unsupported with a hint pointing at the gnomAD browser', () => {
    const entry = gnomadGetVariant.errors?.find(
      (candidate) => candidate.reason === 'mitochondrial_unsupported',
    );
    expect(entry).toMatchObject({ code: JsonRpcErrorCode.ValidationError, thrownBy: 'service' });
    expect(entry?.recovery).toContain('https://gnomad.broadinstitute.org/');
  });
});

describe('gnomad://variant resource — mitochondrial coordinate IDs (wire)', () => {
  const read = async (uri: string) => rpcErrorOf(await readResourceBody(variantResource, uri));

  it('fills the declared hint onto a resource failure on the wire', async () => {
    fakeGnomad();
    const error = await read('gnomad://variant/gnomad_r4/not-a-variant');
    const declared = variantResource.errors?.find((entry) => entry.reason === 'invalid_variant_id');
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_variant_id' },
    });
    expect(error.data.recovery?.hint).toBe(declared?.recovery);
    expect(requests).toHaveLength(0);
  });

  it.each(['M-3243-A-G', 'MT-3243-A-G', 'chrM-3243-A-G'])(
    'fails %s with mitochondrial_unsupported and the declared hint, with no fetch',
    async (id) => {
      fakeGnomad();
      const error = await read(`gnomad://variant/gnomad_r3/${id}`);

      const declared = variantResource.errors?.find(
        (entry) => entry.reason === 'mitochondrial_unsupported',
      );
      expect(declared?.thrownBy).toBe('service');
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'mitochondrial_unsupported' },
      });
      expect(error.data.recovery?.hint).toBe(declared?.recovery);
      expect(requests).toHaveLength(0);
    },
  );
});
