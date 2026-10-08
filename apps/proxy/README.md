# @routeshift/proxy

Self-hosted OpenAI-compatible LLM proxy: routes requests across Anthropic, OpenAI, Google,
and local models by cost, latency, and capability, with caching, fallbacks, observability,
and billing. Start it locally or deploy it on infrastructure you control. See the
[root README](../../README.md) for the monorepo layout.

## Run locally

```bash
pnpm dev    # tsx watch src/index.ts
```

Listens on `PORT` (default 4000). Runtime env lives in `apps/proxy/.env`.

## Environment variables

Required in production; startup exits if any are missing (`src/config.ts`):

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (keys, billing, audit). |
| `ADMIN_SECRET` | Admin API auth. |
| `PROVIDER_KEY_SECRET` | Encryption key for stored provider credentials. |
| `CORS_ORIGIN` | Comma-separated origin allowlist; wildcard rejected in production. |

Core optional:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | Listen port. |
| `CLICKHOUSE_URL` | unset | Analytics/log sink. |
| `MAX_REQUEST_BODY_BYTES` | `14680064` | HTTP body cap (14 MiB). Sized to wrap the 10 MiB decoded-file plugin limit so the body gate does not fire before the file-parser can return its own limit warning. |
| `POSTHOG_API_KEY` | unset | PostHog project key; telemetry remains disabled unless `POSTHOG_HOST` is also explicitly set. |
| `POSTHOG_HOST` | unset | Explicit PostHog ingestion URL; both settings are required to enable telemetry. |

Provider keys: at least one of `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, a valid Cloudflare pair (`CLOUDFLARE_ACCOUNT_ID` plus `CLOUDFLARE_WORKERS_AI_TOKEN`), or `NEURALWATT_API_KEY` must be set for platform routing. Cloudflare account IDs must be lowercase 32-character hex. Team/BYOK Cloudflare keys also require `metadata.account_id`; explicit legacy GLM-5.2 routes use `NEURALWATT_API_KEY`.

### Plugin and search

| Variable | Default | Purpose |
|---|---|---|
| `SEARCH_BACKEND` | `exa` | Web-search backend for the `web` plugin. |
| `EXA_API_KEY` | unset | Exa API key. Without it the `web` plugin degrades with a `plugin_backend_not_configured` warning (or 502s when marked `required`). |
| `WEB_SEARCH_SURCHARGE_MICROCENTS` | `500000` | Per-search surcharge ($0.005). |
| `PLUGIN_FETCH_TIMEOUT_MS` | `5000` | Shared fetch timeout: web-search requests and file-parser URL fetches. |
| `PLUGIN_MAX_FILE_BYTES` | `10485760` | Max decoded bytes per file (10 MiB). |
| `PLUGIN_MAX_FILE_PAGES` | `100` | Max PDF pages per file. |
| `PLUGIN_MAX_EXTRACTED_TEXT_CHARS` | `1000000` | Max extracted text per file. |
| `PLUGIN_MAX_TOTAL_FILE_BYTES` | `10485760` | Max combined file bytes per request. |
| `PLUGIN_MAX_TOTAL_EXTRACTED_TEXT_CHARS` | `1000000` | Max combined extracted text per request. |
| `PLUGIN_MAX_FILES` | `10` | Max files per request. |

## Plugins

Plugins augment a request before it reaches the upstream model: `web` injects Exa search results, `file-parser` extracts text from PDFs and other files so non-multimodal models can read them. Wire shapes are `PluginSpec` and `PluginWarning` in [`packages/sdk/src/types.ts`](../../packages/sdk/src/types.ts); spec parsing lives in [`src/plugins/specs.ts`](src/plugins/specs.ts).

### Activation

There are three ways to turn a plugin on for a request.

1. Top-level `plugins` array. Each entry is a `PluginSpec`: `id` (`web` or `file-parser`), plus optional `required`, `max_results`, and `search_prompt`.

```bash
curl http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer $ROUTESHIFT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4",
    "messages": [{"role": "user", "content": "What shipped in the latest Node LTS?"}],
    "plugins": [{"id": "web", "max_results": 5}]
  }'
```

2. `:online` model suffix, equivalent to adding `{"id": "web"}` with default options. The suffix is stripped before the upstream call.

```bash
curl http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer $ROUTESHIFT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4:online",
    "messages": [{"role": "user", "content": "Latest AI news?"}]
  }'
```

3. Implicit file-parser. Any message (or `system` / `system_prompt`) content part of type `file` or `input_file` activates `file-parser` with no explicit entry needed.

```bash
curl http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer $ROUTESHIFT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4",
    "messages": [{"role": "user", "content": [
      {"type": "text", "text": "Summarize this PDF."},
      {"type": "file", "file_data": "data:application/pdf;base64,JVBERi0..."}
    ]}]
  }'
```

### Failure contract

- An optional plugin that fails degrades: the request continues upstream and the response carries `X-RouteShift-Plugin-Warning` (comma-joined warning codes) and `X-RouteShift-Plugin-Skip-Reason` headers. Non-streaming bodies also gain a `warnings[]` array.
- A plugin marked `required: true` that fails aborts the request with 502 and `code: plugin_required_failed`.
- A malformed `plugins` array or an unknown plugin id is rejected with 400 `invalid_plugin` before any upstream call.
- Plugin-bearing requests are never served from or written to the response cache. Plugin results are per-request augmentation, and the search surcharge must be charged exactly once per real upstream call.

### Billing

Each web search meters `WEB_SEARCH_SURCHARGE_MICROCENTS` into `request_logs.plugin_cost_microcents` and writes a `plugin_runs` audit row (migration `047-track-d-plugin-billing.sql`). The file-parser is free.

The dashboard surfaces plugin outcomes, warnings, and surcharge spend on the `/plugins` page. Client-side request and warning types ship in `@routeshift/sdk`.
