import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  // The MCP SDK and @routeshift/shared are runtime deps; leave them external
  // (tsup externalizes `dependencies` by default — listed for clarity).
  external: ['@modelcontextprotocol/sdk', '@routeshift/shared'],
  banner: {
    js: '#!/usr/bin/env node',
  },
});
