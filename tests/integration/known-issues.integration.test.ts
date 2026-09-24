/**
 * @fileoverview Correct-behavior regressions for tracked defects. Each test
 * retains its public issue link so the implementation contract stays traceable.
 * @module tests/integration/known-issues.integration.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { gnomadGetGeneConstraint } from '@/mcp-server/tools/definitions/gnomad-get-gene-constraint.tool.js';
import { gnomadGetVariant } from '@/mcp-server/tools/definitions/gnomad-get-variant.tool.js';
import { gnomadListGeneVariants } from '@/mcp-server/tools/definitions/gnomad-list-gene-variants.tool.js';
import { gnomadSearchClinvar } from '@/mcp-server/tools/definitions/gnomad-search-clinvar.tool.js';
import { ClinVarService } from '@/services/clinvar/clinvar-service.js';
import { initGnomadService } from '@/services/gnomad/gnomad-service.js';

describe('known correctness defects', () => {
  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/11
  it('rejects whitespace-only ClinVar genes before any upstream call', () => {
    expect(gnomadSearchClinvar.input.safeParse({ gene: '  ' }).success).toBe(false);
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/11
  it('trims whitespace around a valid ClinVar gene before the E-utilities query', async () => {
    let term: string | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(input);
      term = url.searchParams.get('term');
      return new Response(JSON.stringify({ esearchresult: { count: '0', idlist: [] } }));
    });
    const svc = new ClinVarService(getServerConfig());

    await svc.searchGene(' PCSK9 ', {}, createMockContext());

    expect(term).toBe('"PCSK9"[gene]');
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/12
  it('includes the declared recovery hint on incoherent-build validation', async () => {
    initGnomadService({} as never, {} as never);
    const ctx = createMockContext({ errors: gnomadGetGeneConstraint.errors });
    const input = gnomadGetGeneConstraint.input.parse({
      gene: 'PCSK9',
      dataset: 'gnomad_r4',
      reference_genome: 'GRCh37',
    });

    const error = await Promise.resolve(gnomadGetGeneConstraint.handler(input, ctx)).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({
      data: {
        reason: 'incoherent_build',
        recovery: { hint: expect.stringMatching(/omit reference_genome|GRCh38/i) },
      },
    });
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/12
  it('includes the declared recovery hint when no genome target is supplied', async () => {
    initGnomadService({} as never, {} as never);
    const ctx = createMockContext({ errors: gnomadListGeneVariants.errors });
    const input = gnomadListGeneVariants.input.parse({});

    const error = await Promise.resolve(gnomadListGeneVariants.handler(input, ctx)).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({
      data: {
        reason: 'invalid_target',
        recovery: { hint: expect.stringMatching(/exactly one target/i) },
      },
    });
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/13
  it('makes an ambiguous rsID failure actionable with candidates or a concrete resolver', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            errors: [{ message: 'Multiple variants found, query using variant ID to select one.' }],
            data: { variant: null },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              variant_search: [{ variant_id: '1-55039974-G-T' }, { variant_id: '1-55039974-G-A' }],
            },
          }),
        ),
      );
    initGnomadService({} as never, {} as never);
    const result = await gnomadGetVariant.handler(
      gnomadGetVariant.input.parse({ variants: ['rs11591147'] }),
      createMockContext({ errors: gnomadGetVariant.errors }),
    );

    expect(result.failed).toEqual([
      {
        variant: 'rs11591147',
        error: 'rs11591147 maps to multiple variants; retry with a candidate variant ID.',
        candidates: ['1-55039974-G-T', '1-55039974-G-A'],
      },
    ]);
    const text = (gnomadGetVariant.format?.(result) ?? [])
      .map((block) => ('text' in block ? block.text : ''))
      .join('');
    expect(text).toContain('1-55039974-G-T');
    expect(text).toContain('1-55039974-G-A');
  });
});
