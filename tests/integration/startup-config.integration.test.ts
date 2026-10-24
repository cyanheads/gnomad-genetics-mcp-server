/**
 * @fileoverview Built entrypoint configuration behavior on real Node and Bun.
 * @module tests/integration/startup-config.integration.test
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const entry = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

interface Tool {
  inputSchema: { properties: { variants?: { maxItems?: number; description?: string } } };
  name: string;
}
interface Startup {
  code: number | null;
  stderr: string;
  tools?: Tool[];
}

function run(
  runtime: string,
  transport: string,
  settings: Record<string, string>,
  list = false,
  dotenv = 'GNOMAD_MAX_VARIANT_BATCH=2\nGNOMAD_DATAFRAME_DROP_ENABLED=true\nCANVAS_PROVIDER_TYPE=none\n',
): Promise<Startup> {
  const home = mkdtempSync(join(tmpdir(), 'gnomad-startup-'));
  homes.push(home);
  writeFileSync(join(home, '.env'), dotenv);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production',
    MCP_TRANSPORT_TYPE: transport,
    MCP_HTTP_HOST: '127.0.0.1',
    MCP_LOG_LEVEL: 'error',
    CANVAS_PROVIDER_TYPE: 'none',
    OTEL_ENABLED: 'false',
    DEBUG: 'false',
    LOGS_DIR: home,
  };
  for (const key of Object.keys(env))
    if (key.startsWith('GNOMAD_') || key === 'DEBUG') delete env[key];
  Object.assign(env, settings);
  return new Promise((resolve, reject) => {
    const child = spawn(runtime, [entry], { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    let buffer = '';
    let tools: Tool[] | undefined;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 4_000);
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('{')) {
          const message = JSON.parse(line);
          if (message.id === 1 && message.result) {
            child.stdin.write(
              `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
            );
            child.stdin.write(
              `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`,
            );
          }
          if (message.id === 2 && message.result) {
            tools = message.result.tools;
            child.kill('SIGTERM');
          }
        }
        newline = buffer.indexOf('\n');
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`Startup timed out under ${runtime}/${transport}: ${stderr}`));
      else resolve({ code, stderr, ...(tools && { tools }) });
    });
    if (list)
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'startup-config-test', version: '1' } } })}\n`,
      );
  });
}

describe.each(['node', 'bun'])('%s configuration startup', (runtime) => {
  it('characterizes exported cap/drop settings', async () => {
    const result = await run(
      runtime,
      'stdio',
      { GNOMAD_MAX_VARIANT_BATCH: '3', GNOMAD_DATAFRAME_DROP_ENABLED: 'true' },
      true,
    );
    expect(
      result.tools?.find((tool) => tool.name === 'gnomad_get_variant')?.inputSchema.properties
        .variants?.maxItems,
    ).toBe(3);
    expect(result.tools?.some((tool) => tool.name === 'gnomad_dataframe_drop')).toBe(true);
  });

  it.each(['stdio', 'http'])(
    'renders invalid %s settings through the clean startup boundary',
    async (transport) => {
      for (const [name, value] of [
        ['GNOMAD_MAX_CONCURRENCY', 'abc'],
        ['GNOMAD_MAX_VARIANT_BATCH', '-1'],
        ['GNOMAD_DATAFRAME_DROP_ENABLED', 'invalid'],
      ]) {
        const result = await run(runtime, transport, { [name!]: value! });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain(name);
        expect(result.stderr).toContain('Configuration error — server failed to start');
        expect(result.stderr).not.toMatch(/\n\s+at /);
      }
    },
  );

  it('loads file-only settings before definition evaluation', async () => {
    const result = await run(runtime, 'stdio', {}, true);
    const variants = result.tools?.find((tool) => tool.name === 'gnomad_get_variant')?.inputSchema
      .properties.variants;
    expect(variants?.maxItems).toBe(2);
    expect(variants?.description).toContain('2');
    expect(result.tools?.some((tool) => tool.name === 'gnomad_dataframe_drop')).toBe(true);
  });

  it('keeps exported false/blank settings ahead of the dotenv file', async () => {
    const result = await run(
      runtime,
      'stdio',
      { GNOMAD_MAX_VARIANT_BATCH: '', GNOMAD_DATAFRAME_DROP_ENABLED: 'false' },
      true,
    );
    expect(
      result.tools?.find((tool) => tool.name === 'gnomad_get_variant')?.inputSchema.properties
        .variants?.maxItems,
    ).toBe(25);
    expect(result.tools?.some((tool) => tool.name === 'gnomad_dataframe_drop')).toBe(false);
  });

  it('shows a configuration stack only when DEBUG requests it', async () => {
    const result = await run(runtime, 'stdio', { GNOMAD_MAX_CONCURRENCY: 'abc', DEBUG: 'true' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('GNOMAD_MAX_CONCURRENCY');
    expect(result.stderr).toMatch(/\n\s+at /);
  });
});
