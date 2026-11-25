/**
 * @fileoverview Every upstream request names this server in its User-Agent:
 * the gnomAD GraphQL POST and both NCBI E-utilities reads (esearch, esummary).
 * @module tests/services/upstream-user-agent.test
 */

import { readFileSync } from 'node:fs';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { ClinVarService } from '@/services/clinvar/clinvar-service.js';
import { GnomadService } from '@/services/gnomad/gnomad-service.js';

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
const EXPECTED = `gnomad-genetics-mcp-server/${version} (+https://github.com/cyanheads/gnomad-genetics-mcp-server)`;
const dataset = { dataset: 'gnomad_r4', parent: 'gnomad_r4', reference_genome: 'GRCh38' } as const;

/** The User-Agent a fetch call sent, read the way the platform reads `init.headers`. */
function sentUserAgent(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get('user-agent');
}

afterEach(() => vi.restoreAllMocks());

describe('upstream User-Agent', () => {
  it('names the server and its version on the gnomAD request', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"data":{"gene":null}}'));
    await new GnomadService(getServerConfig()).getGeneConstraint(
      'PCSK9',
      dataset,
      createMockContext(),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sentUserAgent(fetch.mock.calls[0]?.[1])).toBe(EXPECTED);
  });

  it('names the server and its version on both ClinVar reads', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/esearch.fcgi')) {
        return new Response(JSON.stringify({ esearchresult: { count: '1', idlist: ['1'] } }));
      }
      return new Response(
        JSON.stringify({
          result: {
            uids: ['1'],
            '1': {
              uid: '1',
              accession: 'VCV001',
              title: 'NM_000371.4(TTR):c.1A>G',
              germline_classification: {
                description: 'Pathogenic',
                review_status: 'reviewed by expert panel',
              },
            },
          },
        }),
      );
    });
    const service = new ClinVarService({ ...getServerConfig(), ncbiApiKey: 'test-key' });
    const { rows } = await service.searchGene('TTR', {}, createMockContext());
    expect(rows).toHaveLength(1);
    const paths = fetch.mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(paths).toEqual(['/entrez/eutils/esearch.fcgi', '/entrez/eutils/esummary.fcgi']);
    for (const [, init] of fetch.mock.calls) expect(sentUserAgent(init)).toBe(EXPECTED);
  });
});
