/**
 * @fileoverview Offline error-contract conformance for every gnomAD and ClinVar
 * surface. Each failure class the services can raise is driven through a faked
 * global fetch, so fetchWithTimeout, its body deadline, the retry loop, the
 * sanitizer, and response validation all run for real. Per surface, the
 * reasons observed on the wire equal the reasons its errors[] declares, each
 * wire code matches its declaration, and each wire recovery hint is the
 * declared recovery. Tools run through runToolContract, resources through the
 * worker handler's resources/read, and gnomad_get_variant through its failed[]
 * items.
 * @module tests/integration/error-contracts.integration.test
 */

import type { AnyResourceDefinition } from '@cyanheads/mcp-ts-core';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { geneConstraintResource } from '@/mcp-server/resources/definitions/gene-constraint.resource.js';
import { variantResource } from '@/mcp-server/resources/definitions/variant.resource.js';
import { gnomadGetCoverage } from '@/mcp-server/tools/definitions/gnomad-get-coverage.tool.js';
import { gnomadGetGeneConstraint } from '@/mcp-server/tools/definitions/gnomad-get-gene-constraint.tool.js';
import { gnomadGetVariant } from '@/mcp-server/tools/definitions/gnomad-get-variant.tool.js';
import { gnomadListGeneVariants } from '@/mcp-server/tools/definitions/gnomad-list-gene-variants.tool.js';
import { gnomadSearchClinvar } from '@/mcp-server/tools/definitions/gnomad-search-clinvar.tool.js';
import { initClinVarService } from '@/services/clinvar/clinvar-service.js';
import { initGnomadService } from '@/services/gnomad/gnomad-service.js';
import { minimalVariant } from '../helpers/minimal-variant.js';
import { readResourceBody, rpcErrorOf } from '../helpers/worker-resource-read.js';

/** One outbound request as the fake sees it. */
interface UpstreamRequest {
  query: string;
  url: string;
  variables: Record<string, unknown>;
}

/**
 * What the fake upstream does with a request: answer with a status and a body,
 * never send headers (the request deadline fires), send headers and then stall
 * the body (the body deadline fires), or send headers and then reset the body
 * stream.
 */
type Reply =
  | { status: number; body: unknown }
  | { status: number; text: string }
  | 'no-headers'
  | 'stalled-body'
  | 'reset-body';

type Route = (request: UpstreamRequest) => Reply;

let requests: UpstreamRequest[];

function reply(outcome: Reply, signal: AbortSignal | null | undefined): Promise<Response> {
  if (outcome === 'no-headers') {
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }
  if (outcome === 'stalled-body' || outcome === 'reset-body') {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (outcome === 'reset-body') {
          controller.error(new TypeError('terminated'));
          return;
        }
        signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
    });
    return Promise.resolve(
      new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
    );
  }
  const text = 'text' in outcome ? outcome.text : JSON.stringify(outcome.body);
  return Promise.resolve(
    new Response(text, {
      status: outcome.status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

/** Route every outbound fetch — gnomAD GraphQL POSTs and NCBI GETs alike — through `route`. */
function fakeUpstream(route: Route): void {
  requests = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const graphql = init?.body
      ? (JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> })
      : { query: '', variables: {} };
    const request = { url, ...graphql };
    requests.push(request);
    return reply(route(request), init?.signal);
  });
}

/** Resolve a pending call while advancing fake timers past every deadline and backoff. */
async function settle<T>(pending: Promise<T>): Promise<T> {
  for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(60_000);
  return pending;
}

/** What one failed call put on the wire. */
interface Observed {
  code?: number;
  data?: Record<string, unknown>;
  hint?: unknown;
  reason?: unknown;
  text?: string;
}

interface ContractEntry {
  code: number;
  reason: string;
  recovery: string;
  thrownBy?: string;
}

interface Surface<I> {
  /** False where the reason travels in a failed[] item rather than an error envelope. */
  carriesCode?: (input: I) => boolean;
  errors: readonly ContractEntry[] | undefined;
  invoke: (input: I) => Promise<Observed>;
  name: string;
}

interface Scenario<I> {
  input: I;
  label: string;
  reason: string;
  route: Route;
}

// --- Tool and resource invocation -------------------------------------------

interface ToolError {
  error: {
    code: number;
    data?: { reason?: unknown; recovery?: { hint?: unknown }; [key: string]: unknown };
  };
}

async function callTool(definition: unknown, input: Record<string, unknown>): Promise<Observed> {
  const result = await settle(runToolContract(definition as never, input as never));
  expect(result.isError, 'expected an error result').toBe(true);
  const { error } = result.structuredContent as unknown as ToolError;
  const text = (result.content as { text?: string }[]).map((block) => block.text ?? '').join('\n');
  return {
    code: error.code,
    reason: error.data?.reason,
    hint: error.data?.recovery?.hint,
    text,
  };
}

interface VariantInput {
  dataset?: string;
  reference_genome?: string;
  variants: string[];
}

/** gnomad_get_variant: a per-ID failure lands in failed[]; a batch-level one is an envelope. */
async function callGetVariant(input: VariantInput): Promise<Observed> {
  const result = await settle(runToolContract(gnomadGetVariant, input as never));
  if (result.isError) {
    const { error } = result.structuredContent as unknown as ToolError;
    return { code: error.code, reason: error.data?.reason, hint: error.data?.recovery?.hint };
  }
  const { failed, found } = result.structuredContent as {
    failed: { reason: unknown; recovery: unknown }[];
    found: unknown[];
  };
  expect(found).toEqual([]);
  expect(failed).toHaveLength(1);
  const text = (result.content as { text?: string }[]).map((block) => block.text ?? '').join('\n');
  return { reason: failed[0]?.reason, hint: failed[0]?.recovery, text };
}

/** A resource read through the worker handler, so the framework's declared-recovery fill applies. */
async function readResource(definition: AnyResourceDefinition, uri: string): Promise<Observed> {
  const error = rpcErrorOf(await settle(readResourceBody(definition, uri)));
  return {
    code: error.code,
    reason: error.data.reason,
    hint: error.data.recovery?.hint,
    data: error.data,
  };
}

// --- Upstream payloads ------------------------------------------------------

function graphqlErrors(message: string, data: unknown = null) {
  return { status: 200, body: { errors: [{ message }], data } };
}

/** Constraint metrics inside every domain; tests override one field out of range. */
const CONSTRAINT_METRICS = {
  pli: 0.5,
  oe_lof: 0.3,
  oe_lof_lower: 0.2,
  oe_lof_upper: 0.4,
  oe_mis: 0.9,
  oe_syn: 1,
  lof_z: 3,
  mis_z: 1,
  syn_z: 0,
  obs_lof: 5,
  exp_lof: 20,
  obs_mis: 100,
  exp_mis: 120,
  obs_syn: 50,
  exp_syn: 50,
  flags: [],
};

/** A PCSK9 constraint answer whose pLI is outside [0, 1]. */
const OUT_OF_DOMAIN_CONSTRAINT: Reply = {
  status: 200,
  body: {
    data: {
      gene: {
        gene_id: 'ENSG00000169174',
        symbol: 'PCSK9',
        gnomad_constraint: { ...CONSTRAINT_METRICS, pli: 2 },
        exac_constraint: null,
      },
    },
  },
};

const always =
  (outcome: Reply): Route =>
  () =>
    outcome;

/**
 * Transport and validation failures every gnomAD operation shares — the
 * sanitizer's classes, both deadlines, a mid-body reset, and each shape of
 * response validation failure.
 */
const GNOMAD_TRANSPORT: [label: string, reason: string, outcome: Reply][] = [
  [
    'HTTP 503 through every retry',
    'upstream_unavailable',
    { status: 503, text: 'Service Unavailable' },
  ],
  [
    'HTTP 429 through every retry',
    'upstream_unavailable',
    { status: 429, text: 'Too Many Requests' },
  ],
  [
    'a load-shedding GraphQL message on HTTP 200',
    'upstream_unavailable',
    graphqlErrors('Service overloaded'),
  ],
  ['a body stream reset mid-read', 'upstream_unavailable', 'reset-body'],
  ['no response headers before the request deadline', 'upstream_timeout', 'no-headers'],
  ['a body stalled past the request deadline', 'upstream_timeout', 'stalled-body'],
  ['HTTP 504 through every retry', 'upstream_timeout', { status: 504, text: 'Gateway Timeout' }],
  ['HTTP 403', 'upstream_access', { status: 403, text: 'Forbidden' }],
  ['HTTP 401', 'upstream_access', { status: 401, text: 'Unauthorized' }],
  [
    'an HTML page on HTTP 200',
    'invalid_upstream_response',
    { status: 200, text: '<!DOCTYPE html><html><body>maintenance</body></html>' },
  ],
  ['JSON cut off mid-body', 'invalid_upstream_response', { status: 200, text: '{"data":{"gene"' }],
  [
    'a payload off the response schema',
    'invalid_upstream_response',
    { status: 200, body: { data: 42 } },
  ],
];

function transportScenarios<I>(input: I): Scenario<I>[] {
  return GNOMAD_TRANSPORT.map(([label, reason, outcome]) => ({
    label,
    reason,
    input,
    route: always(outcome),
  }));
}

// --- Surfaces ----------------------------------------------------------------

type ToolInput = Record<string, unknown>;

const getVariant: Surface<VariantInput> = {
  name: 'gnomad_get_variant',
  errors: gnomadGetVariant.errors,
  invoke: callGetVariant,
  carriesCode: (input) => input.reference_genome !== undefined,
};

const getVariantScenarios: Scenario<VariantInput>[] = [
  {
    label: 'a reference_genome that contradicts the dataset',
    reason: 'incoherent_build',
    input: { variants: ['1-55051215-G-GA'], dataset: 'gnomad_r4', reference_genome: 'GRCh37' },
    route: always({ status: 200, body: { data: null } }),
  },
  {
    label: 'an ID outside the grammar',
    reason: 'invalid_variant_id',
    input: { variants: ['not-a-variant'] },
    route: always({ status: 200, body: { data: null } }),
  },
  {
    label: 'a well-formed ID gnomAD does not hold',
    reason: 'variant_not_found',
    input: { variants: ['1-55051215-G-GA'] },
    route: always(graphqlErrors('Variant not found', { variant: null, clinvar_variant: null })),
  },
  {
    label: 'a mitochondrial coordinate ID',
    reason: 'mitochondrial_unsupported',
    input: { variants: ['M-3243-A-G'] },
    route: always({ status: 200, body: { data: null } }),
  },
  {
    label: 'an rsID gnomAD maps to several variants',
    reason: 'ambiguous_rsid',
    input: { variants: ['rs11591147'] },
    route: (request) =>
      request.query.includes('variant_search(')
        ? {
            status: 200,
            body: { data: { variant_search: [{ variant_id: '1-55039974-G-T' }] } },
          }
        : graphqlErrors('Multiple variants found for rsid rs11591147', { variant: null }),
  },
  {
    label: 'a GraphQL error gnomAD raises for the ID',
    reason: 'graphql_error',
    input: { variants: ['1-55051215-G-GA'] },
    route: always(graphqlErrors('Unknown error while resolving variant')),
  },
  {
    label: 'a variant answered on the other build',
    reason: 'upstream_build_mismatch',
    input: { variants: ['1-55051215-G-GA'] },
    route: always({
      status: 200,
      body: {
        data: { variant: minimalVariant('1-55051215-G-GA', 'GRCh37'), clinvar_variant: null },
      },
    }),
  },
  ...transportScenarios<VariantInput>({ variants: ['1-55051215-G-GA'] }),
];

const variantUri = (id: string) => `gnomad://variant/gnomad_r4/${id}`;

const variantResourceSurface: Surface<string> = {
  name: 'gnomad://variant/{dataset}/{variantId}',
  errors: variantResource.errors,
  invoke: (uri) => readResource(variantResource, uri),
};

const variantResourceScenarios: Scenario<string>[] = [
  {
    label: 'an ID outside the grammar',
    reason: 'invalid_variant_id',
    input: variantUri('not-a-variant'),
    route: always({ status: 200, body: { data: null } }),
  },
  {
    label: 'a well-formed ID gnomAD does not hold',
    reason: 'variant_not_found',
    input: variantUri('1-55051215-G-GA'),
    route: always(graphqlErrors('Variant not found', { variant: null, clinvar_variant: null })),
  },
  {
    label: 'a mitochondrial coordinate ID',
    reason: 'mitochondrial_unsupported',
    input: variantUri('MT-3243-A-G'),
    route: always({ status: 200, body: { data: null } }),
  },
  {
    label: 'an rsID gnomAD maps to several variants',
    reason: 'ambiguous_rsid',
    input: variantUri('rs11591147'),
    route: (request) =>
      request.query.includes('variant_search(')
        ? {
            status: 200,
            body: { data: { variant_search: [{ variant_id: '1-55039974-G-T' }] } },
          }
        : graphqlErrors('Multiple variants found for rsid rs11591147', { variant: null }),
  },
  {
    label: 'a GraphQL error gnomAD raises for the ID',
    reason: 'graphql_error',
    input: variantUri('1-55051215-G-GA'),
    route: always(graphqlErrors('Unknown error while resolving variant')),
  },
  {
    label: 'a variant answered on the other build',
    reason: 'upstream_build_mismatch',
    input: variantUri('1-55051215-G-GA'),
    route: always({
      status: 200,
      body: {
        data: { variant: minimalVariant('1-55051215-G-GA', 'GRCh37'), clinvar_variant: null },
      },
    }),
  },
  ...transportScenarios(variantUri('1-55051215-G-GA')),
];

const constraintDomainScenarios = <I>(input: I): Scenario<I>[] => [
  {
    label: 'a gene gnomAD does not hold',
    reason: 'gene_not_found',
    input,
    route: always(graphqlErrors('Gene not found', { gene: null })),
  },
  {
    label: 'constraint metrics outside their domains',
    reason: 'invalid_constraint_data',
    input,
    route: always(OUT_OF_DOMAIN_CONSTRAINT),
  },
  {
    label: 'a GraphQL error gnomAD raises for the gene',
    reason: 'graphql_error',
    input,
    route: always(graphqlErrors('Unknown error while resolving gene')),
  },
  ...transportScenarios(input),
];

const constraintTool: Surface<ToolInput> = {
  name: 'gnomad_get_gene_constraint',
  errors: gnomadGetGeneConstraint.errors,
  invoke: (input) => callTool(gnomadGetGeneConstraint, input),
};

const constraintToolScenarios: Scenario<ToolInput>[] = [
  {
    label: 'a reference_genome that contradicts the dataset',
    reason: 'incoherent_build',
    input: { gene: 'PCSK9', dataset: 'gnomad_r4', reference_genome: 'GRCh37' },
    route: always({ status: 200, body: { data: null } }),
  },
  ...constraintDomainScenarios<ToolInput>({ gene: 'PCSK9' }),
];

const constraintResourceSurface: Surface<string> = {
  name: 'gnomad://gene/{dataset}/{gene}/constraint',
  errors: geneConstraintResource.errors,
  invoke: (uri) => readResource(geneConstraintResource, uri),
};

const constraintResourceScenarios = constraintDomainScenarios(
  'gnomad://gene/gnomad_r4/PCSK9/constraint',
);

/** Scenarios both region tools share; `payload` shapes a feature answer for the tool's query. */
function regionToolScenarios(featurePayload: (chrom: string) => unknown): Scenario<ToolInput>[] {
  return [
    {
      label: 'no target',
      reason: 'invalid_target',
      input: {},
      route: always({ status: 200, body: { data: null } }),
    },
    {
      label: 'a reference_genome that contradicts the dataset',
      reason: 'incoherent_build',
      input: { gene: 'PCSK9', dataset: 'gnomad_r4', reference_genome: 'GRCh37' },
      route: always({ status: 200, body: { data: null } }),
    },
    {
      label: 'a region whose start exceeds its stop',
      reason: 'invalid_region',
      input: { region: '1-200-100' },
      route: always({ status: 200, body: { data: null } }),
    },
    {
      label: 'gnomAD refusing the chromosome on HTTP 500',
      reason: 'invalid_region',
      input: { region: '2-1000-2000' },
      route: always({
        status: 500,
        body: { errors: [{ message: "Invalid chromosome: '2'" }], data: null },
      }),
    },
    {
      label: 'a region spanning 2,500,000 bp',
      reason: 'region_too_large',
      input: { region: '1-1-2500001' },
      route: always({ status: 200, body: { data: null } }),
    },
    {
      label: 'a mitochondrial region',
      reason: 'mitochondrial_unsupported',
      input: { region: 'MT-100-200' },
      route: always({ status: 200, body: { data: null } }),
    },
    {
      label: 'a gene gnomAD places on the mitochondrial chromosome',
      reason: 'mitochondrial_unsupported',
      input: { gene: 'MT-ND1' },
      route: always({ status: 200, body: { data: { gene: featurePayload('MT') } } }),
    },
    {
      label: 'a GraphQL error gnomAD raises for the target',
      reason: 'graphql_error',
      input: { gene: 'PCSK9' },
      route: always(graphqlErrors('Unknown error while resolving gene')),
    },
    ...transportScenarios<ToolInput>({ gene: 'PCSK9' }),
    ...transportScenarios<ToolInput>({ region: '1-55039447-55064852' }).map((scenario) => ({
      ...scenario,
      label: `${scenario.label} (region target)`,
    })),
  ];
}

const listTool: Surface<ToolInput> = {
  name: 'gnomad_list_gene_variants',
  errors: gnomadListGeneVariants.errors,
  invoke: (input) => callTool(gnomadListGeneVariants, input),
};

const listToolScenarios = [
  ...regionToolScenarios((chrom) => ({ chrom, variants: [] })),
  {
    label: 'gnomAD refusing a region for its variant count on HTTP 500',
    reason: 'region_too_large',
    input: { region: '1-1000000-3400000' },
    route: always({
      status: 500,
      body: {
        errors: [{ message: 'This region has too many variants to display.' }],
        data: null,
      },
    }),
  },
];

const coverageTool: Surface<ToolInput> = {
  name: 'gnomad_get_coverage',
  errors: gnomadGetCoverage.errors,
  invoke: (input) => callTool(gnomadGetCoverage, input),
};

const coverageToolScenarios = [
  ...regionToolScenarios((chrom) => ({ chrom, coverage: { exome: [], genome: [] } })),
  {
    label: 'gnomAD refusing a region too large for coverage on HTTP 500',
    reason: 'region_too_large',
    input: { region: '1-1000000-3400000' },
    route: always({
      status: 500,
      body: {
        errors: [{ message: 'Coverage is not available for a region this large' }],
        data: null,
      },
    }),
  },
];

const clinvarTool: Surface<ToolInput> = {
  name: 'gnomad_search_clinvar',
  errors: gnomadSearchClinvar.errors,
  invoke: (input) => callTool(gnomadSearchClinvar, input),
};

const ESEARCH_OK = {
  status: 200,
  body: { esearchresult: { count: '1', idlist: ['2878'] } },
};

/** An NCBI outcome on the first leg (ESearch) or the second (ESummary, after ESearch answers). */
function onNcbiLeg(leg: 'esearch' | 'esummary', outcome: Reply): Route {
  return (request) =>
    leg === 'esummary' && request.url.includes('/esearch.fcgi') ? ESEARCH_OK : outcome;
}

const NCBI_TRANSPORT: [label: string, reason: string, outcome: Reply][] = [
  ['HTTP 503 through every retry', 'upstream_unavailable', { status: 503, text: 'down' }],
  ['HTTP 429 through every retry', 'upstream_unavailable', { status: 429, text: 'slow down' }],
  ['a body stream reset mid-read', 'upstream_unavailable', 'reset-body'],
  ['no response headers before the request deadline', 'upstream_timeout', 'no-headers'],
  ['a body stalled past the request deadline', 'upstream_timeout', 'stalled-body'],
  ['HTTP 403', 'upstream_access', { status: 403, text: 'Forbidden' }],
  [
    'an HTML page on HTTP 200',
    'invalid_upstream_response',
    { status: 200, text: '<!DOCTYPE html><html><body>maintenance</body></html>' },
  ],
  [
    'JSON cut off mid-body',
    'invalid_upstream_response',
    { status: 200, text: '{"esearchresult":' },
  ],
  [
    'a payload off the response schema',
    'invalid_upstream_response',
    { status: 200, body: { esearchresult: { count: 'many' }, result: 42 } },
  ],
];

const clinvarToolScenarios: Scenario<ToolInput>[] = (['esearch', 'esummary'] as const).flatMap(
  (leg) =>
    NCBI_TRANSPORT.map(([label, reason, outcome]) => ({
      label: `${label} on ${leg}`,
      reason,
      input: { gene: 'PCSK9' },
      route: onNcbiLeg(leg, outcome),
    })),
);

// --- Assertions --------------------------------------------------------------

function contractSuite<I>(surface: Surface<I>, scenarios: Scenario<I>[]): void {
  const contract = surface.errors ?? [];
  const declaredEntry = (reason: string): ContractEntry => {
    const entry = contract.find((candidate) => candidate.reason === reason);
    if (!entry) throw new Error(`${surface.name} declares no ${reason}`);
    return entry;
  };

  describe(`${surface.name} error contract`, () => {
    it('declares exactly the reasons its handler and services raise', () => {
      const raised = [...new Set(scenarios.map((scenario) => scenario.reason))].sort();
      const declared = contract.map((entry) => entry.reason).sort();
      expect(declared).toEqual(raised);
    });

    it('marks every reason raised below the handler as thrown by the service', () => {
      const handlerOwned = new Set([
        'invalid_variant_id',
        'variant_not_found',
        'gene_not_found',
        'invalid_target',
      ]);
      for (const entry of contract) {
        if (handlerOwned.has(entry.reason)) continue;
        expect(entry.thrownBy, `${entry.reason} thrownBy`).toBe('service');
      }
    });

    it.each(scenarios.map((scenario) => [scenario.label, scenario.reason, scenario] as const))(
      '%s → %s, with the declared code and recovery on the wire',
      async (_label, reason, scenario) => {
        fakeUpstream(scenario.route);
        const observed = await surface.invoke(scenario.input);
        const entry = declaredEntry(reason);

        expect(observed.reason).toBe(reason);
        expect(observed.hint).toBe(entry.recovery);
        if (surface.carriesCode?.(scenario.input) ?? true) {
          expect(observed.code).toBe(entry.code);
        }
        if (observed.text !== undefined) expect(observed.text).toContain(entry.recovery);
      },
    );
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  initGnomadService({} as never, {} as never);
  initClinVarService({} as never, {} as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

contractSuite(getVariant, getVariantScenarios);
contractSuite(variantResourceSurface, variantResourceScenarios);
contractSuite(constraintTool, constraintToolScenarios);
contractSuite(constraintResourceSurface, constraintResourceScenarios);
contractSuite(listTool, listToolScenarios);
contractSuite(coverageTool, coverageToolScenarios);
contractSuite(clinvarTool, clinvarToolScenarios);

describe('gnomad://variant — ambiguous rsID on the wire', () => {
  it('carries the candidates its declared hint tells the reader to use', async () => {
    const scenario = variantResourceScenarios.find((s) => s.reason === 'ambiguous_rsid');
    if (!scenario) throw new Error('no ambiguous_rsid scenario');
    fakeUpstream(scenario.route);

    const observed = await readResource(variantResource, scenario.input);

    expect(observed.reason).toBe('ambiguous_rsid');
    expect(observed.data?.candidates).toEqual(['1-55039974-G-T']);
    expect(observed.hint).toContain('candidates');
  });
});

describe('upstream request counts behind the contract', () => {
  it.each([
    ['HTTP 503', always({ status: 503, text: 'Service Unavailable' }), 4],
    ['a body stream reset', always('reset-body'), 4],
    ['a stalled body', always('stalled-body'), 4],
    ['HTTP 403', always({ status: 403, text: 'Forbidden' }), 1],
    ['out-of-domain constraint metrics', always(OUT_OF_DOMAIN_CONSTRAINT), 1],
  ] as const)('%s → %i gnomAD request(s)', async (_label, route, count) => {
    fakeUpstream(route);
    await callTool(gnomadGetGeneConstraint, { gene: 'PCSK9' });
    expect(requests).toHaveLength(count);
  });

  it('retries each ESummary batch on its own after ESearch answers', async () => {
    fakeUpstream(onNcbiLeg('esummary', 'reset-body'));
    await callTool(gnomadSearchClinvar, { gene: 'PCSK9' });
    expect(requests.map((request) => new URL(request.url).pathname.split('/').pop())).toEqual([
      'esearch.fcgi',
      'esummary.fcgi',
      'esummary.fcgi',
      'esummary.fcgi',
      'esummary.fcgi',
    ]);
  });
});
