#!/bin/sh
# Run from the repository root. The MCP stdout stream must contain only JSON-RPC.
# `pnpm run` emits lifecycle banners; use `pnpm exec` for the server process.
# The shared package exposes dist/*, so build it before serving a fresh checkout.
set -e
pnpm --filter @routeshift/shared build >/dev/null
exec pnpm --filter @routeshift/mcp exec tsx src/index.ts
