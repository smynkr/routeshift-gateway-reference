# @routeshift/shared

Pure, replayable routing primitives shared by the proxy, dashboard, SDK tooling, and tests. Private workspace package (`"private": true`) — not published to npm.

## Rule

Routing decisions live here as **pure functions** (no I/O, no `Date.now()`): the same inputs always produce the same decision, so choices are unit-testable and replayable. Curation-time concerns (source freshness, citation, staleness gates) live in `capability-sources.ts` / `jurisdiction-evidence.ts`, never inside the decision path.

## What's inside

| Module | Responsibility |
|---|---|
| `routing.ts` | Rule evaluation (`evaluateRules`), strategy scoring (cheapest / fastest / balanced), fallback chains, exact skip/fallback reasons. |
| `models.ts` + `cost-tables.ts` + `litellm-pricing.generated.ts` | Model registry (canonical names, context windows, `auto_route` / `public` flags) and the shared price table. Regenerate pricing via `pnpm --filter @routeshift/shared sync-pricing`. |
| `catalog.ts` | The single catalog projection (`buildModelsList` / `buildModelDetail` / `selectModels`) behind HTTP `GET /v1/models` and the MCP `list_models` / `get_model` / `rank_models` tools. |
| `provider-preferences.ts` | OpenRouter-compatible per-request provider routing preferences (order/allow/deny/sort). |
| `model-suffixes.ts` | `:online` / `:floor` / `:nitro` request suffixes. |
| `quality-derank.ts` | Rolling quality derank factor ([0.3, 1.0]) applied as a price-equivalent divisor for opted-in traffic. |
| `capability-sources.ts` | Capability-index provenance (source + `source_as_of`); pure validators, 60-day freshness bound. |
| `budgets.ts` + `budget-report.ts` | Budget-window shapes and the shared `buildBudgetReport` serializer used by proxy admission and the dashboard. |
| `jurisdiction-evidence.ts` | Data-residency evidence lifecycle (human-stamped, 1-year policy expiry, fail-closed). |
| `response-verifier.ts` | Cascade quality-gate verdicts. |
| `shadow-routing.ts` (subpath export) | Shadow-experiment evaluation without side effects. |
| `provider-key-envelope.ts` (subpath export) | Provider-credential envelope classification (fail-closed reads). |
| `token-usage.ts`, `pricing-modifiers.ts`, `prompt-cache.ts`, `provider-endpoints.ts`, `embedding-models.ts`, `model-sources.ts` | Token accounting, price modifiers, cache policy, endpoint fanout, embedding registry, registry provenance. |

## Model lifecycle scripts

```bash
pnpm --filter @routeshift/shared detect-models    # report drift vs provider catalogs
pnpm --filter @routeshift/shared propose-parked   # propose park-safe entries (auto_route: false, public: false)
pnpm --filter @routeshift/shared promote-model    # promote a parked model through onboarding
pnpm --filter @routeshift/shared sync-pricing     # regenerate the LiteLLM price table
```

Prefix-passthrough-covered ids (`gpt-*` / `o3-*` / `o4-*` / `claude-*` / `gemini-*`) must never be parked as exact matches — the proxy dispatches them by prefix, so a parked entry would revoke working traffic.

## Build first

Consumers resolve `dist/` (gitignored): build before dashboard-only checks.

```bash
pnpm --filter @routeshift/shared build
pnpm --filter @routeshift/shared test
```
