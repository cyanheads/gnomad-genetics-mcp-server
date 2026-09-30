/**
 * @fileoverview Read a resource through the worker handler's resources/read —
 * the path on which the framework fills a declared recovery hint onto a
 * failure — and pull the JSON-RPC error or the resource record out of the
 * response body, whether it arrives as plain JSON or as an SSE frame.
 * @module tests/helpers/worker-resource-read
 */

import type { AnyResourceDefinition } from '@cyanheads/mcp-ts-core';
import { createWorkerHandler } from '@cyanheads/mcp-ts-core/worker';

const PROTOCOL_REVISION = '2026-07-28';

const executionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as Parameters<ReturnType<typeof createWorkerHandler>['fetch']>[2];

/** A JSON-RPC error as the worker handler puts it on the wire. */
export interface RpcError {
  code: number;
  data: {
    reason: string;
    recovery?: { hint: string };
    retryable?: boolean;
    [key: string]: unknown;
  };
  message: string;
}

/** The response body of a resources/read for `uri` from a worker serving only `resource`. */
export async function readResourceBody(
  resource: AnyResourceDefinition,
  uri: string,
): Promise<string> {
  const handler = createWorkerHandler({
    name: 'gnomad-genetics-mcp-server',
    title: 'gnomad-genetics-mcp-server',
    resources: [resource],
  });
  const request = new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL_REVISION,
      'Mcp-Method': 'resources/read',
      'Mcp-Name': uri,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'resources/read',
      params: {
        uri,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': PROTOCOL_REVISION,
          'io.modelcontextprotocol/clientInfo': { name: 'resource-read-test', version: '1.0.0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
  return (await handler.fetch(request, {}, executionContext)).text();
}

/** The JSON-RPC message in `body`: the SSE `data:` frame naming `key`, or the body itself. */
function rpcMessage(body: string, key: 'error' | 'result'): unknown {
  const frame = body
    .split('\n')
    .find((line) => line.startsWith('data:') && line.includes(`"${key}"`));
  return JSON.parse(frame ? frame.slice(5).trim() : body);
}

/** The JSON-RPC error a failed read answered with. */
export function rpcErrorOf(body: string): RpcError {
  const { error } = rpcMessage(body, 'error') as { error?: RpcError };
  if (!error) throw new Error(`No error in response: ${body}`);
  return error;
}

/** The JSON record a successful read returned in its first contents[] entry. */
export function resourceRecordOf(body: string): Record<string, unknown> {
  const { result } = rpcMessage(body, 'result') as { result?: { contents: { text: string }[] } };
  const text = result?.contents[0]?.text;
  if (text == null) throw new Error(`No resource contents in response: ${body}`);
  return JSON.parse(text) as Record<string, unknown>;
}
