/**
 * @fileoverview Live gnomAD replies carrying filtering allele frequency (FAF)
 * fields, and fetch fakes that answer this server's variant and list documents
 * with them, for tests that run the real service at the fetch seam (#64). The
 * list fake executes each FAF and annotations field's `@include` directive as
 * the sent document writes it (#65), answers the gene fields it selects (#82),
 * keeps only the `populations` subfields it selects (#81), and refuses a
 * document missing a declared variable, as gnomAD does.
 * @module tests/helpers/live-faf
 */

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { Dataset } from '@/services/gnomad/types.js';
import { fakeGnomadGraphql, type GraphqlRequest } from './fake-gnomad-graphql.js';
import type { LiveReply } from './live-subsets.js';

type Json = Record<string, unknown>;

const SMALL = JSON.parse(
  readFileSync(new URL('../fixtures/gnomad-faf.live.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

/**
 * Live gene-list replies carrying each record's genetic-ancestry groups (#81),
 * keyed `list-gene:<dataset>:<gene>`, their rows cut to a few of every shape:
 * PCSK9 on each dataset family (gnomad_r4, gnomad_r4_non_ukb, gnomad_r3,
 * gnomad_r3_non_v2, gnomad_r2_1, gnomad_r2_1_non_cancer, exac) and CFTR on
 * gnomad_r4. The gnomad_r4 rows carry joint groups only, the others callset
 * groups only. The fixture's _about names the capture.
 */
export const POPULATION_LISTS = JSON.parse(
  readFileSync(new URL('../fixtures/gnomad-list-populations.live.json', import.meta.url), 'utf8'),
) as Record<string, LiveReply>;

/**
 * Live gene-list replies with every FAF field selected, keyed
 * `list-gene:<dataset>:<gene>`: PCSK9 on gnomad_r4, gnomad_r4_non_ukb, and
 * gnomad_r2_1, INS on gnomad_r3 and gnomad_r2_1. The gnomad_r4 PCSK9 and
 * gnomad_r2_1 INS replies also carry lof and every annotations field (#65).
 * Gzipped (about 4.3 MB as text).
 */
export const FAF_GENE_LISTS = JSON.parse(
  gunzipSync(
    readFileSync(new URL('../fixtures/gnomad-faf-gene-lists.live.json.gz', import.meta.url)),
  ).toString('utf8'),
) as Record<string, LiveReply>;

/** Each alias of the live aliased variant document: the dataset it asked and the variant. */
export const FAF_VARIANT_ALIASES = {
  r4: { dataset: 'gnomad_r4', variantId: '1-55039974-G-T' },
  r4_non_ukb: { dataset: 'gnomad_r4_non_ukb', variantId: '1-55039974-G-T' },
  r3: { dataset: 'gnomad_r3', variantId: '1-55039974-G-T' },
  r3_cab: { dataset: 'gnomad_r3_controls_and_biobanks', variantId: '1-55039974-G-T' },
  r3_non_cancer: { dataset: 'gnomad_r3_non_cancer', variantId: '1-55039974-G-T' },
  r3_non_neuro: { dataset: 'gnomad_r3_non_neuro', variantId: '1-55039974-G-T' },
  r3_non_topmed: { dataset: 'gnomad_r3_non_topmed', variantId: '1-55039974-G-T' },
  r3_non_v2: { dataset: 'gnomad_r3_non_v2', variantId: '1-55039974-G-T' },
  r2: { dataset: 'gnomad_r2_1', variantId: '1-55505647-G-T' },
  r2_controls: { dataset: 'gnomad_r2_1_controls', variantId: '1-55505647-G-T' },
  r2_non_neuro: { dataset: 'gnomad_r2_1_non_neuro', variantId: '1-55505647-G-T' },
  r2_non_cancer: { dataset: 'gnomad_r2_1_non_cancer', variantId: '1-55505647-G-T' },
  r2_non_topmed: { dataset: 'gnomad_r2_1_non_topmed', variantId: '1-55505647-G-T' },
  exac: { dataset: 'exac', variantId: '1-55505647-G-T' },
  r4_ac0: { dataset: 'gnomad_r4', variantId: '1-55039866-G-A' },
} as const satisfies Record<string, { dataset: Dataset; variantId: string }>;

export type FafAlias = keyof typeof FAF_VARIANT_ALIASES;

/** A live record's callset or joint data with the keys its document did not select read as null. */
function unselectedAsNull(record: Json | null): Json | null {
  return record && { hemizygote_count: null, populations: null, ...record };
}

/**
 * The live record under `alias` as a reply to this server's variant document:
 * its counts, filters, and faf95 as captured, and every key the aliased
 * document did not select (populations, hemizygote counts, rsids, flags,
 * consequences, predictors) null.
 */
export function fafVariant(alias: FafAlias): Json {
  const record = structuredClone((SMALL['variant-faf'] as Record<FafAlias, Json>)[alias]);
  return {
    variant_id: record.variant_id,
    reference_genome: record.reference_genome,
    rsids: null,
    flags: null,
    exome: unselectedAsNull(record.exome as Json | null),
    genome: unselectedAsNull(record.genome as Json | null),
    joint: unselectedAsNull(record.joint as Json | null),
    transcript_consequences: null,
    in_silico_predictors: null,
  };
}

/** The one live row of a single-position region list reply, every FAF field it was captured with. */
export function fafRegionRow(dataset: Dataset, region: string): Json {
  const reply = SMALL[`list-region:${dataset}:${region}`] as LiveReply | undefined;
  const [row] =
    (reply?.body as { data: { region: { variants: Json[] } } } | undefined)?.data.region.variants ??
    [];
  if (!row) throw new Error(`No live list row for ${dataset}:${region}`);
  return structuredClone(row);
}

const operationOf = (query: string) => /query\s+(\w+)/.exec(query)?.[1];

/** gnomAD's live pathless error beside a populated `variant` when only the ClinVar join fails. */
const CLINVAR_ERRORS = [{ message: 'Invalid variant ID' }];

/**
 * Answer gnomAD variant documents with the live records of FAF_VARIANT_ALIASES,
 * matched by the request's dataset and variant ID. ClinVar answers no entry,
 * or — with `clinvarFails` — fails as gnomAD's live reply does: an error beside
 * the combined document's populated variant, then again on the ClinVar-only
 * request. Any other origin, document, or record is rejected. Returns the
 * requests sent, in order.
 */
export function fakeFafVariants({ clinvarFails = false } = {}): GraphqlRequest[] {
  return fakeGnomadGraphql((request) => {
    const { variables } = request;
    const operation = operationOf(request.query);
    if (operation === 'GnomadClinvar') {
      return Response.json(
        clinvarFails
          ? { errors: CLINVAR_ERRORS, data: { clinvar_variant: null } }
          : { data: { clinvar_variant: null } },
      );
    }
    const alias = (Object.keys(FAF_VARIANT_ALIASES) as FafAlias[]).find(
      (key) =>
        FAF_VARIANT_ALIASES[key].dataset === variables.dataset &&
        FAF_VARIANT_ALIASES[key].variantId === variables.variantId,
    );
    if (!alias) {
      throw new Error(
        `No live FAF record for ${String(variables.dataset)}:${String(variables.variantId)}`,
      );
    }
    const variant = fafVariant(alias);
    if (operation === 'GnomadVariant') {
      return Response.json(
        clinvarFails
          ? { errors: CLINVAR_ERRORS, data: { variant, clinvar_variant: null } }
          : { data: { variant, clinvar_variant: null } },
      );
    }
    if (operation === 'GnomadVariantOnly') return Response.json({ data: { variant } });
    throw new Error(`Unmocked gnomAD operation ${String(operation)}`);
  });
}

/** The selection set of `field` in a whitespace-flattened document, braces balanced. */
function selectionOf(document: string, field: string): string {
  const start = document.indexOf(`${field} {`);
  if (start < 0) throw new Error(`The list document selects no ${field}`);
  let depth = 0;
  for (let i = document.indexOf('{', start); i < document.length; i++) {
    if (document[i] === '{') depth++;
    else if (document[i] === '}' && --depth === 0) return document.slice(start, i + 1);
  }
  throw new Error(`Unbalanced ${field} selection`);
}

/**
 * Whether `selection` selects `field` under the request's variables, as GraphQL
 * executes `@include`: an object field by its selection set, a scalar one alone.
 */
function selects(
  selection: string,
  field: string,
  variables: Record<string, unknown>,
  kind: 'object' | 'scalar' = 'object',
): boolean {
  const end = kind === 'object' ? '\\s*\\{' : '(?!\\s*\\{)';
  const match = new RegExp(`\\b${field}\\b(?:\\s*@include\\(if:\\s*\\$(\\w+)\\))?${end}`).exec(
    selection,
  );
  if (!match) return false;
  return match[1] == null || variables[match[1]] === true;
}

/** The transcript fields a list row carries: lof always, the rest under `$annotations` (#65). */
const TRANSCRIPT_FIELDS = ['lof', 'hgvsc', 'hgvsp', 'lof_filter', 'lof_flags', 'rsids'] as const;

/** The TRANSCRIPT_FIELDS a list request selects once GraphQL executes its `@include` directives. */
export function selectedTranscriptFields({ query, variables }: GraphqlRequest): string[] {
  const selection = selectionOf(query.replace(/\s+/g, ' '), 'variants(dataset: $dataset)');
  return TRANSCRIPT_FIELDS.filter((field) => selects(selection, field, variables, 'scalar'));
}

/** The gene fields a list row can carry, naming the gene of its transcript_id (#82). */
const ROW_GENE_FIELDS = ['gene_id', 'gene_symbol'] as const;

/** The ROW_GENE_FIELDS a list request selects on each row. */
export function selectedRowGeneFields({ query, variables }: GraphqlRequest): string[] {
  const selection = selectionOf(query.replace(/\s+/g, ' '), 'variants(dataset: $dataset)');
  return ROW_GENE_FIELDS.filter((field) => selects(selection, field, variables, 'scalar'));
}

/**
 * The scalar fields a whitespace-flattened list document selects on its gene or
 * transcript root, ahead of `variants`; empty on a region document.
 */
function rootSelection(document: string): string {
  const root = document.indexOf('{', document.indexOf('{') + 1);
  return document.slice(root + 1, document.indexOf('variants(dataset: $dataset)'));
}

/**
 * Gene identities as gnomAD answers them, captured 2026-11-24 (UTC): each
 * fixture gene's root `gene_id` and `symbol` (the same on both builds), and
 * the gene of the one transcript the fixture region rows sit on.
 */
const GENE_IDS: Record<string, string> = {
  PCSK9: 'ENSG00000169174',
  INS: 'ENSG00000254647',
  CFTR: 'ENSG00000001626',
};
const TRANSCRIPT_GENES: Record<string, { gene_id: string; gene_symbol: string }> = {
  ENST00000302118: { gene_id: 'ENSG00000169174', gene_symbol: 'PCSK9' },
};

/**
 * Answer the gene fields a list request selects, as gnomAD would: a gene
 * root's `gene_id` and `symbol`, and each row's `gene_id` and `gene_symbol`
 * (null on a row without a transcript). The captured replies predate both
 * selections, so a field the document selects is filled from the identities
 * above, and one it does not is dropped.
 */
function answerGeneFields(
  request: GraphqlRequest,
  body: { data: Record<string, Json & { variants: Json[] }> },
): void {
  const document = request.query.replace(/\s+/g, ' ');
  const root = rootSelection(document);
  const rowFields = new Set(selectedRowGeneFields(request));
  for (const feature of Object.values(body.data)) {
    if (/\bgene_id\b/.test(root) || /\bsymbol\b/.test(root)) {
      const symbol = String(request.variables.gene);
      const geneId = GENE_IDS[symbol];
      if (!geneId) throw new Error(`No captured gene identity for ${symbol}`);
      if (/\bgene_id\b/.test(root)) feature.gene_id = geneId;
      if (/\bsymbol\b/.test(root)) feature.symbol = symbol;
    }
    for (const variant of feature.variants) {
      if (rowFields.size === 0) {
        for (const field of ROW_GENE_FIELDS) delete variant[field];
        continue;
      }
      const transcriptId = variant.transcript_id as string | null;
      const gene = transcriptId == null ? null : TRANSCRIPT_GENES[transcriptId];
      if (gene === undefined) throw new Error(`No captured gene for transcript ${transcriptId}`);
      for (const field of ROW_GENE_FIELDS) {
        if (rowFields.has(field)) variant[field] = gene?.[field] ?? null;
        else delete variant[field];
      }
    }
  }
}

/** The FAF fields a list request selects once GraphQL executes its `@include` directives, as `<record>.<field>`. */
export function selectedFafFields({ query, variables }: GraphqlRequest): string[] {
  const document = query.replace(/\s+/g, ' ');
  return (['exome', 'genome', 'joint'] as const).flatMap((record) => {
    const selection = selectionOf(document, record);
    return ['faf95', 'fafmax']
      .filter((faf) => selects(selection, faf, variables))
      .map((faf) => `${record}.${faf}`);
  });
}

/** The records whose `populations` a list request selects once GraphQL executes its `@include` directives (#81). */
export function selectedPopulationRecords({ query, variables }: GraphqlRequest): string[] {
  const document = query.replace(/\s+/g, ' ');
  return (['exome', 'genome', 'joint'] as const).filter((record) =>
    selects(selectionOf(document, record), 'populations', variables),
  );
}

/** The subfields a record's `populations` selection names (`id ac an`); empty when it selects none. */
function populationFields(recordSelection: string): string[] {
  const match = /\bpopulations\b[^{]*\{([^{}]*)\}/.exec(recordSelection);
  return match?.[1]?.trim().split(' ') ?? [];
}

/**
 * The live FAF list reply for a request: the gene reply keyed by its symbol,
 * or the region reply keyed by its bounds. Undefined when none was captured.
 */
function fafListReply({ query, variables }: GraphqlRequest): LiveReply | undefined {
  const operation = operationOf(query);
  const dataset = String(variables.dataset);
  if (operation === 'GnomadGeneVariantsBySymbol') {
    return FAF_GENE_LISTS[`list-gene:${dataset}:${String(variables.gene)}`];
  }
  if (operation === 'GnomadRegionVariants') {
    const region = `${String(variables.chrom)}-${String(variables.start)}-${String(variables.stop)}`;
    return SMALL[`list-region:${dataset}:${region}`] as LiveReply | undefined;
  }
  return undefined;
}

/**
 * Answer gnomAD gene and region list documents with the live FAF replies. Each
 * reply is cut to what the sent document selects: a FAF field, a record's
 * `populations`, or a row's lof or annotations field, gated by an `@include`
 * whose variable is false, or not selected at all, is dropped from every
 * record, as gnomAD would omit it; each `populations` entry keeps only the
 * subfields the document selects; and the gene fields are answered as
 * answerGeneFields does. A document that declares a variable the request does
 * not supply fails as gnomAD fails it. Any other origin, document, or target is
 * rejected. Returns the requests sent, in order.
 */
export function fakeFafLists(): GraphqlRequest[] {
  return fakeLists(fafListReply);
}

/**
 * Answer gnomAD gene list documents from `lists` — the live POPULATION_LISTS
 * replies unless a test passes its own, keyed the same way — cut to what the
 * sent document selects as fakeFafLists cuts its replies, a record's
 * `populations` and its entries' subfields among them (#81). Returns the
 * requests sent, in order.
 */
export function fakePopulationLists(
  lists: Record<string, LiveReply> = POPULATION_LISTS,
): GraphqlRequest[] {
  return fakeLists(({ query, variables }) =>
    operationOf(query) === 'GnomadGeneVariantsBySymbol'
      ? lists[`list-gene:${String(variables.dataset)}:${String(variables.gene)}`]
      : undefined,
  );
}

function fakeLists(lookup: (request: GraphqlRequest) => LiveReply | undefined): GraphqlRequest[] {
  return fakeGnomadGraphql((request) => {
    const reply = lookup(request);
    if (!reply) throw new Error(`Unmocked gnomAD document: ${request.query.slice(0, 80)}`);
    const document = request.query.replace(/\s+/g, ' ');
    for (const [, name, type] of document.matchAll(/\$(\w+):\s*([\w[\]]+!)/g)) {
      if (request.variables[name as string] === undefined) {
        return Response.json({
          errors: [{ message: `Variable "$${name}" of required type "${type}" was not provided.` }],
        });
      }
    }
    const selected = new Set(selectedFafFields(request));
    const transcriptFields = new Set(selectedTranscriptFields(request));
    const populations = new Set(selectedPopulationRecords(request));
    const records = ['exome', 'genome', 'joint'] as const;
    const groupFields = new Map(
      records.map((record) => [record, populationFields(selectionOf(document, record))]),
    );
    const body = structuredClone(reply.body) as {
      data: Record<string, Json & { variants: Json[] }>;
    };
    answerGeneFields(request, body);
    for (const feature of Object.values(body.data)) {
      for (const variant of feature.variants) {
        for (const field of TRANSCRIPT_FIELDS) {
          if (!transcriptFields.has(field)) delete variant[field];
        }
        for (const record of records) {
          const data = variant[record] as Json | null;
          for (const faf of ['faf95', 'fafmax']) {
            if (data && faf in data && !selected.has(`${record}.${faf}`)) delete data[faf];
          }
          if (data && !populations.has(record)) delete data.populations;
          else if (data && Array.isArray(data.populations)) {
            const fields = groupFields.get(record) ?? [];
            data.populations = (data.populations as Json[]).map((entry) =>
              Object.fromEntries(fields.filter((f) => f in entry).map((f) => [f, entry[f]])),
            );
          }
        }
      }
    }
    return Response.json(body, { status: reply.status });
  });
}
