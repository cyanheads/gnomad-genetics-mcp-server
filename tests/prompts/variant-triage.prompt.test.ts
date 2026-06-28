/**
 * @fileoverview Tests for the gnomad_variant_triage prompt — the generated tool
 * chain (frequency → constraint → coverage) is built deterministically from the
 * args, with the coverage step always present and the dataset/gene clauses woven
 * in only when supplied.
 * @module tests/prompts/variant-triage.prompt.test
 */

import { describe, expect, it } from 'vitest';
import { variantTriagePrompt } from '@/mcp-server/prompts/definitions/variant-triage.prompt.js';

/** Flatten the generated messages to a single string for substring assertions. */
function renderText(args: Record<string, unknown>): string {
  const parsed = variantTriagePrompt.args!.parse(args);
  return variantTriagePrompt
    .generate(parsed)
    .map((m) => ('text' in m.content ? m.content.text : ''))
    .join('\n');
}

describe('gnomad_variant_triage prompt', () => {
  it('generates a user message embedding the variant and all three steps', () => {
    const messages = variantTriagePrompt.generate(
      variantTriagePrompt.args!.parse({ variant: '1-55051215-G-GA' }),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: 'user', content: { type: 'text' } });

    const text = renderText({ variant: '1-55051215-G-GA' });
    expect(text).toContain('1-55051215-G-GA');
    expect(text).toContain('gnomad_get_variant');
    expect(text).toContain('gnomad_get_gene_constraint');
    // The coverage step is the signature "do not skip" instruction.
    expect(text).toContain('gnomad_get_coverage');
    expect(text).toContain('do not skip');
  });

  it('inlines a known gene into the constraint step', () => {
    const text = renderText({ variant: 'rs11591147', gene: 'PCSK9' });
    expect(text).toContain('gnomad_get_gene_constraint(gene: "PCSK9"');
    // No <symbol> placeholder leaks when the gene is supplied.
    expect(text).not.toContain('<symbol>');
  });

  it('derives a single-position region for a chrom-pos-ref-alt variant and quotes the dataset', () => {
    const text = renderText({ variant: '1-55051215-G-GA', gene: 'PCSK9', dataset: 'gnomad_r4' });
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

  it('routes an rsID coverage check through the resolved variant_id, with gene as a fallback only', () => {
    const text = renderText({ variant: 'rs11591147', gene: 'PCSK9', dataset: 'gnomad_r4' });
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

  it('falls back to a gene placeholder when gene is omitted', () => {
    const text = renderText({ variant: 'rs11591147' });
    expect(text).toContain('ensembl_lookup_gene');
    expect(text).toContain('<symbol>');
  });

  it('threads an explicit, quoted dataset into every tool call clause', () => {
    const text = renderText({ variant: 'rs11591147', gene: 'PCSK9', dataset: 'gnomad_r2_1' });
    expect(text).toContain('dataset: "gnomad_r2_1"');
    // v2 threshold guidance appears in the constraint step text.
    expect(text).toContain('<0.35 in v2');
  });

  it('omits the dataset clause entirely when dataset is not supplied', () => {
    const text = renderText({ variant: 'rs11591147', gene: 'PCSK9' });
    expect(text).not.toContain('dataset:');
  });
});
