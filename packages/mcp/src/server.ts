import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { version as packageVersion } from '../package.json';
import { callTool, TOOLS } from './tools.js';

export const SERVER_NAME = 'routeshift-catalog';
export const SERVER_VERSION = packageVersion;

export function createCatalogServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    // `arguments: null` is malformed input, not an absent field — pass it
    // through so parseArgs rejects it instead of silently accepting `{}`.
    callTool(request.params.name, request.params.arguments === undefined ? {} : request.params.arguments),
  );

  return server;
}

export async function runServer(): Promise<void> {
  const server = createCatalogServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
