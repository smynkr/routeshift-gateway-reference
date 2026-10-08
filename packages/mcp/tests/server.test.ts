import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCatalogServer, SERVER_NAME, SERVER_VERSION } from '../src/server.js';

/** The SDK client types callTool results with an `unknown` index signature;
 *  narrow with runtime checks (the shape is a JSON-serializable result). */
function textOfCallResult(result: unknown): string | null {
  if (typeof result !== 'object' || result === null || !('content' in result)) return null;
  const content = result.content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (typeof block === 'object' && block !== null && 'type' in block && 'text' in block) {
      if (block.type === 'text' && typeof block.text === 'string') return block.text;
    }
  }
  return null;
}

function isErrorOfCallResult(result: unknown): boolean {
  if (typeof result !== 'object' || result === null || !('isError' in result)) return false;
  return result.isError === true;
}

async function connectClient() {
  const server = createCatalogServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

describe('MCP protocol surface', () => {
  it('completes the initialize handshake and advertises tools', async () => {
    const client = await connectClient();
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(['list_models', 'get_model', 'rank_models']);
    await client.close();
  });

  it('serves the catalog over a real tools/call round-trip', async () => {
    const client = await connectClient();
    const result = await client.callTool({ name: 'list_models', arguments: {} });
    expect(isErrorOfCallResult(result)).toBe(false);
    const text = textOfCallResult(result);
    if (text === null) throw new Error('no text content in result');
    const list = JSON.parse(text);
    expect(list.object).toBe('list');
    const ids = list.data.map((m: { id: string }) => m.id);
    expect(ids).toContain('gpt-5.5');
    expect(ids).toContain('text-embedding-3-small');
    await client.close();
  });

  it('returns expected tool failures as isError results, not protocol errors', async () => {
    const client = await connectClient();
    const result = await client.callTool({ name: 'get_model', arguments: { model_id: 'nope' } });
    expect(isErrorOfCallResult(result)).toBe(true);
    const text = textOfCallResult(result);
    expect(text).toContain('model_not_found');
    await client.close();
  });

  it('maps schema-level misuse to JSON-RPC InvalidParams over the wire', async () => {
    const client = await connectClient();
    // unknown tool name — the tools/call method exists, the name is invalid
    await expect(client.callTool({ name: 'frobnicate', arguments: {} }))
      .rejects.toThrowError('-32602');
    // unknown argument key
    await expect(client.callTool({ name: 'list_models', arguments: { toString: 1 } }))
      .rejects.toThrowError('-32602');
    await client.close();
  });

  it('ranks models over a real round-trip', async () => {
    const client = await connectClient();
    const result = await client.callTool({ name: 'rank_models', arguments: { criterion: 'price', limit: 3 } });
    expect(isErrorOfCallResult(result)).toBe(false);
    const text = textOfCallResult(result);
    if (text === null) throw new Error('no text content in result');
    const ranked = JSON.parse(text) as Array<{ id: string }>;
    expect(ranked).toHaveLength(3);
    expect(typeof ranked[0].id).toBe('string');
    await client.close();
  });
});

describe('process boundary (the committed launcher path)', () => {
  it('serves clean newline-framed JSON-RPC over real stdio', { timeout: 90_000 }, async () => {
    // Regression pin for the pnpm lifecycle-banner bug: `pnpm run` prints
    // '> @routeshift/mcp…' to stdout, which corrupts MCP framing. The
    // launcher script (scripts/serve-mcp-catalog.sh, what .mcp.json runs)
    // must emit only protocol bytes on stdout.
    // This exercises a real child process; fake timers cannot advance OS process startup.
    const root = new URL('../../..', import.meta.url).pathname;
    const child = spawn('bash', ['scripts/serve-mcp-catalog.sh'], { cwd: root });
    const firstLine = new Promise<string>((resolve, reject) => {
      let buffer = '';
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const newline = buffer.indexOf('\n');
        if (newline !== -1) {
          child.stdout.removeAllListeners('data');
          resolve(buffer.slice(0, newline));
        }
      });
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`launcher exited early with ${code}`)));
    });
    try {
      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stdio-test', version: '0.0.0' } },
      }) + '\n');
      const line = await firstLine;
      const message = JSON.parse(line);
      expect(message.id).toBe(1);
      expect(message.result.serverInfo.name).toBe(SERVER_NAME);
      expect(message.result.serverInfo.version).toBe(SERVER_VERSION);
    } finally {
      child.kill();
    }
  });
});

describe('server identity', () => {
  it('advertises the routeshift-catalog name and package version on the wire', async () => {
    const client = await connectClient();
    const serverInfo = client.getServerVersion();
    if (!serverInfo) throw new Error('no negotiated server info');
    expect(serverInfo.name).toBe(SERVER_NAME);
    expect(serverInfo.version).toBe(SERVER_VERSION);
    await client.close();
  });
});
