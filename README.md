# RouteShift Gateway — reference archive

An **unmaintained, source-only reference** of an OpenAI-compatible LLM gateway: policy routing, provider adapters, cost accounting, tenant-scoped caching, budget reservations, a dashboard, SDK, Connect CLI and read-only catalog MCP server.

This is not the former hosted service, a supported product, or a promise of future provider compatibility. Forks are welcome; upstream does not operate an issue/PR support inbox or promise security fixes. **Do not expose this archive to untrusted traffic or use it for real-money billing without your own security review, dependency upgrades and operational controls.** See [SECURITY.md](SECURITY.md).

First-party source is [Apache-2.0](LICENSE). LiteLLM-derived data and installed dependencies retain their own terms; see [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Provider names identify interoperability, not endorsement or permission to use their services.

## Prefer the small toolkit for policy evaluation

[`toolkits/policy-router`](toolkits/policy-router/README.md) is a separate deterministic library, replay/comparison CLI and local browser workbench with synthetic examples and zero runtime dependencies. It makes no provider calls and needs no account, database or gateway. Its versioned semantics are not a drop-in replacement for the legacy gateway or an authorization engine.

The independently released, archived toolkit is at [smynkr/explainable-policy-router](https://github.com/smynkr/explainable-policy-router).

```sh
cd toolkits/policy-router
npm ci --ignore-scripts
npm run build
npm test
node dist/cli.js demo
```

## What this snapshot contains

| Path | Responsibility |
|---|---|
| `apps/proxy` | Provider dispatch, authentication, routing, budgets, cost settlement and log sinks |
| `apps/dashboard` | Local operator dashboard and historical marketing/demo UI |
| `packages/shared` | Routing contracts, frozen model/pricing data and shared types |
| `packages/sdk` | Typed client for an operator-configured gateway |
| `packages/connect` | Device authorization and local agent configuration CLI |
| `packages/mcp` | Read-only model-catalog MCP server |
| `toolkits/policy-router` | Independent explainable-policy reference toolkit |

The gateway's existing billing, authentication, tenant and routing machinery is retained as reference code. Optional benchmark scores without adequate value-level provenance are omitted, including their display and sorting controls. Private operational documents, customer data, original Git history, hosted deployment configuration, paid/scheduled automation and generated coverage are not part of this archive. It does not publish installed dependencies, container images or built dashboard/font assets.

Catalog prices, model identifiers, limits and compatibility are **frozen historical inputs, not current recommendations**. A freshness warning is expected as the snapshot ages. Manual generator commands remain available to a fork, but there is no upstream refresh service. A successful build or local smoke does not establish that a provider still accepts a listed model or that its historical price is correct. Provider calls use your own credentials and can incur charges.

## Local evaluation with Docker Compose

Prerequisites: Docker with Compose, outbound access for image/package downloads and the dashboard's Google font build fetch. Use a disposable environment, not production credentials or a restored customer database.

1. Copy the template: `cp .env.example .env`.
2. Generate **three different secrets** and place them in `.env`:
   - `ADMIN_SECRET`: `openssl rand -hex 32`
   - `AUTH_SECRET`: `openssl rand -base64 32`
   - `PROVIDER_KEY_SECRET`: `openssl rand -hex 32`
3. Leave provider, Stripe and analytics credentials empty for inspection. The admin API is authenticated even locally; no demo-auth bypass is provided.
4. Start the local stack:

```sh
docker compose up --build -d
curl --fail http://localhost:4000/health
curl --fail http://localhost:4000/v1/models
```

Open `http://localhost:3000`. Postgres, ClickHouse, proxy and dashboard ports bind to **127.0.0.1 only**. The database password in Compose is a local development fixture, not a production secret. Compose refuses to start the apps with missing required app secrets. The proxy applies its database migrations before the dashboard starts; do not point this stack at an existing production database.

Compose fixes the dashboard and proxy listening ports independently and sets the authentication origin from `NEXT_PUBLIC_APP_URL`; use that same origin in your browser. Keep quoted empty values in the template: an unquoted blank assignment followed by an inline comment can become a non-empty value in Compose. Optional provider, payment and analytics integrations must remain genuinely empty unless you deliberately configure them.

Create a local dashboard account to inspect authenticated features. For inference, configure a provider key you control, create a gateway API key and select an actually supported/priced model. No provider call is needed to inspect the catalog or run the toolkit. Stripe-dependent payment features are optional and are not functional until an operator explicitly configures their own account; use test mode when evaluating them. Analytics are off unless explicitly configured with your own property/key.

`docker compose down` stops the local stack and preserves its volumes. Do not use `--volumes` if you need its data. Keep the encryption secret with any retained database containing provider-key ciphertext.

## Source verification and development

Prerequisites: Node.js 22 or 24, pnpm 10.6.0, and Python 3 for the two invariant checks. Google font downloads occur during dashboard builds.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @routeshift/shared build
python3 scripts/check_migration_tenant_ids.py
python3 scripts/check_microcent_scale.py
pnpm typecheck
pnpm test
pnpm build
```

The toolkit is outside the pnpm workspace and has its own commands above. Some inherited integration tests require external fixtures and remain explicitly skipped; unit-test success is not a production certification. See the release's verification record for the exact checks exercised, runtime platform and limitations.

The landing-page animation helpers preserve server-rendered values for the first client render;
animations begin only after hydration. A regression test and a served production-page smoke cover
that boundary, including browsers with reduced motion.

For host-process development, start the local databases with Compose, provide the template environment to each app process, then use `pnpm dev`. Do not assume a root `.env` is loaded by every workspace command: the proxy consumes process environment; Next.js uses its own app environment convention.

No package in this archive is published to npm. Build the included source and run its CLI directly, or pack/install it locally. Documentation under [`packages/sdk`](packages/sdk/README.md), [`packages/connect`](packages/connect/README.md), [`packages/mcp`](packages/mcp/README.md) and [`apps/proxy`](apps/proxy/README.md) describes their contracts. Existing registry packages are separate historical releases, not this archive.

## Integration example

```ts
import { ProxyClient } from '@routeshift/sdk';

const client = new ProxyClient({
  baseUrl: 'http://localhost:4000',
  apiKey: process.env.ROUTESHIFT_API_KEY!,
});

const response = await client.chat({
  model: '<model-supported-by-your-configured-provider>',
  messages: [{ role: 'user', content: 'Hello' }],
});
```

The placeholder is intentionally not a model recommendation. Configure provider access, permitted models and budgets before sending a billable request. The gateway retains exact skip/fallback/error reasons; do not interpret a skipped or unavailable model as a successful provider call.

## Maintenance and custody

This release is provided **as-is**. It contains no service-level agreement, support commitment, security-update promise, measured-savings guarantee or model-quality guarantee. Public source publication does not itself cancel subscriptions, delete retained records, revoke credentials or retire the former hosted infrastructure. Those are separate private operator obligations.
