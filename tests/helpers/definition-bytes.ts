/**
 * @fileoverview Server-authored text of a tool definition: what the definition itself
 * contributes to tools/list. That is the tool description, every `description` string
 * in its input, output, and enrichment JSON Schemas, and every `errors[].when`. Read
 * from the definition rather than from tools/list, so the framework's error envelope
 * and schema scaffolding are left out and the figures hold across framework releases.
 * @module tests/helpers/definition-bytes
 */

import { type AnyToolDefinition, z } from '@cyanheads/mcp-ts-core';

const utf8 = new TextEncoder();

/** Every `description` string anywhere in a JSON Schema, one entry per emitted copy. */
function schemaDescriptions(node: unknown, into: string[]): string[] {
  if (Array.isArray(node)) {
    for (const item of node) schemaDescriptions(item, into);
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'description' && typeof value === 'string') into.push(value);
      else schemaDescriptions(value, into);
    }
  }
  return into;
}

/**
 * Every server-authored string of one tool definition, in tools/list order: the
 * description, then input, output, and enrichment schema descriptions (a reused
 * sub-schema once per path it is emitted at), then each `errors[].when`. Definitions
 * that read env at module load, such as the canvas gate, must be imported under the
 * environment being measured.
 */
export function serverAuthoredStrings(definition: AnyToolDefinition): string[] {
  const { description, input, output, enrichment, errors } = definition;
  const strings = [description];
  schemaDescriptions(z.toJSONSchema(input, { io: 'input' }), strings);
  schemaDescriptions(z.toJSONSchema(output), strings);
  if (enrichment) schemaDescriptions(z.toJSONSchema(z.object(enrichment)), strings);
  for (const entry of errors ?? []) strings.push(entry.when);
  return strings;
}

/** Server-authored UTF-8 bytes of one tool definition: the sum over serverAuthoredStrings. */
export function serverAuthoredBytes(definition: AnyToolDefinition): number {
  return serverAuthoredStrings(definition).reduce(
    (sum, text) => sum + utf8.encode(text).byteLength,
    0,
  );
}
