import { runServer } from './server.js';

// MCP stdio servers must keep stdout protocol-only; diagnostics go to stderr.
runServer().catch((error) => {
  console.error(`routeshift-mcp: fatal: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
