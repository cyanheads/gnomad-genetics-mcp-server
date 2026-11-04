/**
 * @fileoverview Tests for the gnomad_variant_triage prompt — the generated tool
 * chain (frequency → constraint → coverage) is built deterministically from the
 * args, with the coverage step always present and the dataset/gene clauses woven
 * in only when supplied.
 * @module tests/prompts/variant-triage.prompt.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GNOMAD_DATASETS, resetServerConfig } from '@/config/server-config.js';
import { variantTriagePrompt } from '@/mcp-server/prompts/definitions/variant-triage.prompt.js';
import { VARIANT_OR_RSID_REGEX } from '@/mcp-server/tools/shared-schemas.js';

/** Flatten the generated messages to a single string for substring assertions. */
async function renderText(args: Record<string, unknown>): Promise<string> {
  const parsed = variantTriagePrompt.args!.parse(args);
  return (await variantTriagePrompt.generate(parsed))
    .map((m) => ('text' in m.content ? m.content.text : ''))
    .join('\n');
}

describe('gnomad_variant_triage prompt', () => {
  it('generates a user message embedding the variant and all three steps', async () => {
    const messages = await variantTriagePrompt.generate(
      variantTriagePrompt.args!.parse({ variant: '1-55051215-G-GA' }),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: 'user', content: { type: 'text' } });

    const text = await renderText({ variant: '1-55051215-G-GA' });
    expect(text).toContain('1-55051215-G-GA');
    expect(text).toContain('gnomad_get_variant');
    expect(text).toContain('gnomad_get_gene_constraint');
    // The coverage step is the signature "do not skip" instruction.
    expect(text).toContain('gnomad_get_coverage');
    expect(text).toContain('do not skip');
  });

  it('inlines a known gene into the constraint step', async () => {
    const text = await renderText({ variant: 'rs11591147', gene: 'PCSK9' });
    expect(text).toContain('gnomad_get_gene_constraint(gene: "PCSK9"');
    // No <symbol> placeholder leaks when the gene is supplied.
    expect(text).not.toContain('<symbol>');
  });

  it('derives a single-position region for a chrom-pos-ref-alt variant and quotes the dataset', async () => {
    const text = await renderText({
      variant: '1-55051215-G-GA',
      gene: 'PCSK9',
      dataset: 'gnomad_r4',
    });
    // Every tool-call clause quotes the dataset value so it is copyable verbatim.
    expect(text).toContain(
      'gnomad_get_variant(variants: ["1-55051215-G-GA"], dataset: "gnomad_r4")',
    );
    expect(text).toContain('gnomad_get_gene_constraint(gene: "PCSK9", dataset: "gnomad_r4")');
    // Coverage confirms the exact position via a single-position region — not the gene.
    expect(text).toContain(
      'gnomad_get_coverage(region: "1-55051215-55051215", dataset: "gnomad_r4")',
    );
    expect(text).not.toContain('gnomad_get_coverage(gene:');
  });

  it('canonicalizes a chr-prefixed lowercase coordinate throughout the generated workflow', async () => {
    const text = await renderText({ variant: 'chr1-55051215-g-ga' });

    expect(text).toContain('**1-55051215-G-GA**');
    expect(text).toContain('variants: ["1-55051215-G-GA"]');
    expect(text).toContain('region: "1-55051215-55051215"');
    expect(text).not.toContain('chr1-55051215-g-ga');
  });

  it.each(['23-100-A-T', '1-0-A-T', '1-100-N-T'])(
    'rejects an invalid coordinate before prompt generation: %s',
    (variant) => {
      expect(variantTriagePrompt.args!.safeParse({ variant }).success).toBe(false);
    },
  );

  it('names only the served chromosomes when it rejects a coordinate', () => {
    const parsed = variantTriagePrompt.args!.safeParse({ variant: '23-100-A-T' });
    const message = parsed.error?.issues[0]?.message ?? '';
    expect(message).toContain('1–22, X, or Y');
    expect(message).not.toMatch(/\bM\b/);
  });

  it.each(['M-3243-A-G', 'MT-3243-A-G', 'chrM-3243-A-G'])(
    'passes mitochondrial %s through so gnomad_get_variant can refuse it with its typed reason',
    (variant) => {
      expect(variantTriagePrompt.args!.safeParse({ variant }).success).toBe(true);
    },
  );

  it('routes an rsID coverage check through the resolved variant_id, with gene as a fallback only', async () => {
    const text = await renderText({ variant: 'rs11591147', gene: 'PCSK9', dataset: 'gnomad_r4' });
    // Coordinates are unknown for an rsID, so coverage derives the region from the
    // variant_id step 1 resolves.
    expect(text).toContain('variant_id');
    expect(text).toContain(
      'gnomad_get_coverage(region: "<chrom>-<pos>-<pos>", dataset: "gnomad_r4")',
    );
    // Gene-level coverage is offered only as a weaker, non-confirming fallback.
    expect(text).toContain('weaker fallback');
    expect(text).toContain('gnomad_get_coverage(gene: "PCSK9", dataset: "gnomad_r4")');
  });

  it('falls back to a gene placeholder when gene is omitted', async () => {
    const text = await renderText({ variant: 'rs11591147' });
    expect(text).toContain('ensembl_lookup_gene');
    expect(text).toContain('<symbol>');
  });

  it('threads an explicit, quoted dataset into every tool call clause', async () => {
    const text = await renderText({ variant: 'rs11591147', gene: 'PCSK9', dataset: 'gnomad_r2_1' });
    expect(text).toContain('dataset: "gnomad_r2_1"');
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/26
  it.each([
    ['a known gene', { gene: 'PCSK9' }],
    ['an unknown gene', {}],
  ])(
    'states LOEUF guidance per constraint release in the constraint step for %s',
    async (_label, gene) => {
      const text = await renderText({ variant: 'rs11591147', ...gene });
      const constraintStep = text.split('\n').find((line) => line.startsWith('2. ')) ?? '';

      expect(constraintStep).toContain('LOEUF < 0.45 for gnomAD v4.1.2 constraint');
      expect(constraintStep).toContain('< 0.35 for gnomAD v2.1.1');
      expect(constraintStep).toMatch(/ExAC[^.]*pLI alone/);
      expect(constraintStep).toContain('constraint_release');
      expect(text).not.toMatch(/beta|0\.6\b|in v4/i);
    },
  );

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/26
  it('asks the synthesis to cite the constraint release instead of a beta caveat', async () => {
    const text = await renderText({ variant: '1-55051215-G-GA', gene: 'PCSK9' });
    const synthesis = text.split('\n').find((line) => line.startsWith('Synthesize:')) ?? '';

    expect(synthesis).toContain('constraint_release');
    expect(synthesis).not.toMatch(/beta/i);
  });

  it('omits the dataset clause entirely when dataset is not supplied', async () => {
    const text = await renderText({ variant: 'rs11591147', gene: 'PCSK9' });
    expect(text).not.toContain('dataset:');
  });

  it.each(['banana', 'GNOMAD_R4', 'gnomad_r5', ' gnomad_r4'])(
    'rejects an unsupported dataset %j before prompt generation',
    (dataset) => {
      expect(variantTriagePrompt.args!.safeParse({ variant: 'rs11591147', dataset }).success).toBe(
        false,
      );
    },
  );

  it.each(GNOMAD_DATASETS)(
    'quotes a supported dataset %s in every emitted call',
    async (dataset) => {
      const text = await renderText({ variant: '1-55051215-G-GA', gene: 'PCSK9', dataset });
      const calls = text.match(/`gnomad_[a-z_]+\([^`]*\)`/g) ?? [];
      expect(calls).toHaveLength(3);
      for (const call of calls) expect(call).toContain(`dataset: "${dataset}"`);
    },
  );

  it('treats an empty-string dataset as omitted (form-client payload)', async () => {
    const text = await renderText({ variant: '1-55051215-G-GA', gene: 'PCSK9', dataset: '' });
    expect(text).not.toContain('dataset:');
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/68
  it('lists every supported dataset, subsets included, in both dataset descriptions', () => {
    const field = variantTriagePrompt.args!.shape.dataset;
    const descriptions = [field.description ?? '', field.unwrap().options[1].description ?? ''];
    for (const description of descriptions) {
      for (const dataset of GNOMAD_DATASETS) {
        expect(description).toMatch(new RegExp(`(?<!\\w)${dataset}(?!\\w)`));
      }
    }
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/68
  it('ties each LOEUF threshold to a parent release and its subsets', async () => {
    const text = await renderText({ variant: 'rs11591147', dataset: 'gnomad_r2_1_non_cancer' });
    const constraintStep = text.split('\n').find((line) => line.startsWith('2. ')) ?? '';

    expect(constraintStep).toMatch(/< 0\.45 for gnomAD v4\.1\.2[^;]*gnomad_r3, and their subsets/);
    expect(constraintStep).toMatch(/< 0\.35 for gnomAD v2\.1\.1 \(gnomad_r2_1 and its subsets\)/);
  });

  it('advertises only variant as a required argument', () => {
    const schema = z.toJSONSchema(variantTriagePrompt.args!) as { required?: string[] };
    expect(schema.required).toEqual(['variant']);
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/62
  it('keeps variant required in the input JSON Schema prompts/list derives its arguments from', () => {
    const schema = variantTriagePrompt.args!['~standard'].jsonSchema.input({
      target: 'draft-2020-12',
    }) as { required?: string[]; properties: Record<string, { pattern?: string }> };
    expect(schema.required).toEqual(['variant']);
    expect(schema.properties.variant?.pattern).toBe(VARIANT_OR_RSID_REGEX.source);
  });

  it.each(['   ', '', '\t'])('treats a blank gene %j as omitted', async (gene) => {
    const text = await renderText({ variant: 'rs11591147', gene });
    expect(text).toContain('gnomad_get_gene_constraint(gene: <symbol>');
    expect(text).not.toMatch(/gene: "\s*"/);
    expect(text).toContain('gene- or transcript-level coverage is a weaker fallback');
  });

  it('trims a padded gene before quoting it', async () => {
    const text = await renderText({ variant: 'rs11591147', gene: ' PCSK9 ' });
    expect(text).toContain('gnomad_get_gene_constraint(gene: "PCSK9")');
  });

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/54
  it.each(['1-55039866-G-A', 'rs11591147'])(
    'has step 1 check qc_status and each callset’s filters before reading the frequency (%s)',
    async (variant) => {
      const text = await renderText({ variant });
      const frequencyStep = text.split('\n').find((line) => line.startsWith('1. ')) ?? '';

      expect(frequencyStep).toContain('`qc_status`');
      expect(frequencyStep).toContain('`callsets.exome.filters`');
      expect(frequencyStep).toContain('`callsets.genome.filters`');
      expect(frequencyStep.indexOf('qc_status')).toBeLessThan(frequencyStep.indexOf('AC/AN/AF'));
      const synthesis = text.split('\n').find((line) => line.startsWith('Synthesize:')) ?? '';
      expect(synthesis).toContain('filtered qc_status');
    },
  );

  // https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/58
  it.each(['1-55039974-G-T', 'rs11591147'])(
    'has the callability step settle the build on variant_not_found_other_build before checking coverage (%s)',
    async (variant) => {
      const text = await renderText({ variant, dataset: 'gnomad_r2_1' });
      const coverageStep = text.split('\n').find((line) => line.startsWith('3. ')) ?? '';

      expect(coverageStep).toContain('`variant_not_found_other_build`');
      expect(coverageStep).toContain('`candidates`');
      expect(coverageStep.indexOf('variant_not_found_other_build')).toBeLessThan(
        coverageStep.indexOf('gnomad_get_coverage('),
      );
    },
  );
});

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/62
describe('gnomad_variant_triage identifier normalization (#62)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetServerConfig();
  });

  it('emits a chr-prefixed colon ID as chrom-pos-ref-alt in every step', async () => {
    const text = await renderText({ variant: 'chr1:55039974:G:T' });

    expect(text).toContain('Triage variant **1-55039974-G-T**');
    expect(text).toContain('gnomad_get_variant(variants: ["1-55039974-G-T"])');
    expect(text).toContain('gnomad_get_coverage(region: "1-55039974-55039974")');
    expect(text).not.toContain('chr1:55039974:G:T');
  });

  it('emits an uppercase rsID lowercased in every step', async () => {
    const text = await renderText({ variant: 'RS505151' });

    expect(text).toContain('Triage variant **rs505151**');
    expect(text).toContain('gnomad_get_variant(variants: ["rs505151"])');
    expect(text).not.toContain('RS505151');
  });

  it('rejects a colon ID and keeps an uppercase rsID as written with GNOMAD_NORMALIZE_IDS=false', async () => {
    vi.stubEnv('GNOMAD_NORMALIZE_IDS', 'false');
    resetServerConfig();

    expect(variantTriagePrompt.args!.safeParse({ variant: 'chr1:55039974:G:T' }).success).toBe(
      false,
    );
    const text = await renderText({ variant: 'RS505151' });
    expect(text).toContain('gnomad_get_variant(variants: ["RS505151"])');
  });
});

// https://github.com/cyanheads/gnomad-genetics-mcp-server/issues/64
describe('gnomad_variant_triage prompt — the filtering allele frequency (#64)', () => {
  it('names faf95, not raw AF, as the value step 1 compares against a disease threshold', async () => {
    const text = await renderText({ variant: '1-55039974-G-T' });

    const step1 = text.slice(text.indexOf('1. **Population frequency.**'), text.indexOf('\n2. '));
    expect(step1).toContain(
      "Compare `faf95` (gnomAD's filtering allele frequency, the lower 95% confidence bound of the highest non-bottlenecked group AF), not raw AF, against the disease's frequency threshold (e.g. ACMG/AMP BA1 or BS1)",
    );
    expect(step1).toContain('a null `faf95` gives nothing to compare, not a pass');
  });
});
