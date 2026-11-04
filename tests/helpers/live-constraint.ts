/**
 * @fileoverview Live gnomAD gene constraint roots — BRCA1, SCN2A, MALAT1, PCSK9,
 * and the mitochondrial MT-CO1, MT-TL1, and MT-RNR1 on both builds — and a
 * fetch fake that answers this server's constraint documents with them, for
 * tests that run the real service at the fetch seam.
 * @module tests/helpers/live-constraint
 */

import { readFileSync } from 'node:fs';
import { fakeGnomadGraphql, type GraphqlRequest } from './fake-gnomad-graphql.js';

type Build = 'GRCh38' | 'GRCh37';

/** A constraint document as the service sends it. */
export interface ConstraintRequest extends GraphqlRequest {
  variables: { gene: string; referenceGenome: Build };
}

/** A live `gene` root for the constraint selection. */
export interface LiveGene {
  exac_constraint: Record<string, number> | null;
  gene_id: string;
  gnomad_constraint: Record<string, unknown> | null;
  mitochondrial_constraint: Record<string, unknown> | null;
  symbol: string;
}

/** Live gene roots, captured 2026-11-03, keyed `<referenceGenome>:<symbol>`. */
const LIVE_CONSTRAINT = JSON.parse(
  readFileSync(new URL('../fixtures/gnomad-constraint.live.json', import.meta.url), 'utf8'),
) as Record<string, LiveGene>;

/** The live gene root for a captured symbol on a build. */
export function liveGene(referenceGenome: Build, symbol: string): LiveGene {
  const gene = LIVE_CONSTRAINT[`${referenceGenome}:${symbol}`];
  if (!gene) throw new Error(`No live constraint for ${symbol} on ${referenceGenome}`);
  return gene;
}

const CONSTRAINT_DOCUMENT = /query GnomadGeneConstraintBy(?:Symbol|Id)\(/;

/**
 * Answer gnomAD constraint documents as gnomAD did for the captured genes, by
 * symbol or Ensembl ID; any other gene gets gnomAD's not-found reply. Any other
 * origin or document is rejected, never answered. Returns the requests sent,
 * in order.
 */
export function fakeLiveConstraint(): ConstraintRequest[] {
  return fakeGnomadGraphql<ConstraintRequest>((request) => {
    if (!CONSTRAINT_DOCUMENT.test(request.query)) {
      throw new Error(`Unmocked gnomAD document: ${request.query.slice(0, 80)}`);
    }
    const { gene, referenceGenome } = request.variables;
    const root = Object.entries(LIVE_CONSTRAINT).find(
      ([key, value]) =>
        key.startsWith(`${referenceGenome}:`) && (value.symbol === gene || value.gene_id === gene),
    )?.[1];
    return Response.json(
      root
        ? { data: { gene: root } }
        : { errors: [{ message: 'Gene not found' }], data: { gene: null } },
    );
  });
}
