# @routeshift/mcp

Read-only [Model Context Protocol](https://modelcontextprotocol.io) server exposing the model catalog bundled with the RouteShift source. It reads the local `@routeshift/shared` catalog; no hosted RouteShift API or remote catalog is contacted.

## What it exposes

Three tools, all derived from the same local catalog implementation used by the gateway's `GET /v1/models` response (same visibility: `public: false` models excluded, unpriced
models omitted, embeddings included):

- `list_models` — the catalog: id, provider, context window, intelligence tier,
  per-endpoint pricing (USD per token) and data policy.
- `get_model` — one entry by canonical id or provider `api_model_id`.
- `rank_models` — deterministic ordering of the public chat-model catalog by real catalog
  fields (`intelligence` / `price` / `context`). **Not** a live quality or benchmark score —
  RouteShift publishes no such score today; the tool description says so.

No customer traffic, no money-path, no write operations. The server never touches Postgres,
ClickHouse, or any request data.

## Run

```sh
pnpm --filter @routeshift/mcp build   # shared must be built first (pnpm --filter @routeshift/shared build)
pnpm --filter @routeshift/mcp start
```

For Claude Code, the committed `.mcp.json` registration is canonical:

```json
{
  "mcpServers": {
    "routeshift-catalog": {
      "command": "bash",
      "args": ["scripts/serve-mcp-catalog.sh"]
    }
  }
}
```

`scripts/serve-mcp-catalog.sh` builds `@routeshift/shared` (its exports resolve
to `dist/`, gitignored on a fresh checkout) and then runs the server via
`pnpm --filter @routeshift/mcp exec tsx src/index.ts`. Do NOT use a plain
`pnpm run dev` for this: pnpm prints its lifecycle banner to stdout, which
corrupts MCP's newline-framed JSON-RPC (pinned by the process-boundary test).
`start` (`node dist/index.js`) serves the built bundle instead; build first.

## Test

```sh
pnpm --filter @routeshift/mcp test
pnpm --filter @routeshift/mcp typecheck
```
