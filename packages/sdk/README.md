# @routeshift/sdk

Typed client for the RouteShift gateway — OpenAI-compatible chat, streaming, embeddings,
model catalog, and generation metadata. Dependency-free runtime. This private workspace
package is not published to npm; build it from the repository root:

```bash
pnpm --filter @routeshift/sdk build
```

Use it from code in this workspace. `baseUrl` is required and should point at your own gateway (local endpoint shown):

```ts
import { ProxyClient } from '@routeshift/sdk';

const client = new ProxyClient({
  baseUrl: 'http://localhost:4000',
  apiKey: process.env.ROUTESHIFT_API_KEY!,
  defaultModel: 'gpt-5.4', // optional default when a request omits model/preset
});

// Non-streaming chat (OpenAI shape in, normalized OpenAI shape out)
const res = await client.chat({
  model: 'gpt-5.4',
  messages: [{ role: 'user', content: 'What shipped in the latest Node LTS?' }],
});
console.log(res.choices[0].message.content);
// RouteShift request id for cost/savings lookup (non-enumerable):
// res._routeshift_request_id

// Streaming chat — async iterator of OpenAI SSE chunks
const stream = client.chatStream({
  model: 'gpt-5.4',
  messages: [{ role: 'user', content: 'Stream this.' }],
});
const meta = await stream.metadata; // headers-derived: request id, warnings
for await (const event of stream) {
  process.stdout.write(event.choices?.[0]?.delta?.content ?? '');
}

// Fallbacks + provider preferences (OpenRouter-compatible `provider`)
const resilient = await client.chat({
  models: ['gpt-5.4', 'claude-opus-4-6-20250219'],
  provider: { sort: 'price', allow_fallbacks: true },
  messages: [{ role: 'user', content: 'Hi' }],
});

// Web-search plugin (`:online` suffix works too: model: 'gpt-5.4:online')
const grounded = await client.chat({
  model: 'gpt-5.4',
  plugins: [{ id: 'web', max_results: 5 }],
  messages: [{ role: 'user', content: 'Latest AI news?' }],
});
console.log(grounded.warnings ?? []); // non-fatal plugin outcomes

// Embeddings
const emb = await client.embeddings.create({
  model: 'text-embedding-3-small',
  input: ['hello world'],
});

// Catalog + generation metadata
const catalog = await client.models.list();
const detail = await client.models.get('gpt-5.4');
const generation = await client.generation.get(res._routeshift_request_id!);
```

## API

| Namespace | Method | Description |
|---|---|---|
| `chat(request)` | `Promise<ChatCompletionResponse>` | Non-streaming completion. `preset` may supply the model server-side. |
| `chatStream(request)` | `ChatCompletionStream` | Async-iterable SSE stream with `.metadata` promise (request id, plugin warnings). |
| `models.list()` | `Promise<ModelList>` | Public catalog — same visibility as unauthenticated `GET /v1/models`. |
| `models.get(id)` | `Promise<Model>` | One entry by canonical id or provider `api_model_id`. |
| `generation.get(id)` | `Promise<Generation>` | Cost/savings metadata. Pass the RouteShift request id (`_routeshift_request_id`), not the upstream completion id. |
| `embeddings.create(params)` | `Promise<EmbeddingResponse>` | `encoding_format` / `dimensions` / `user` forwarded when the provider supports them. |

## Errors

- `ProxyAPIError` — `status` + raw `body` for non-2xx responses.
- `ProxyRateLimitError extends ProxyAPIError` — 429 with optional `retryAfter`.

Budget/throttle surfaces arrive as real HTTP statuses: `402` (cap exceeded), `429` (rate/TPM/throttle), `503` (fail-closed budget service) — each with an exact machine-readable `code`, preserved verbatim for logs and UI.

## Notes

- `SDK_PROVIDER_NAMES` mirrors `PROVIDERS` in `@routeshift/shared`. The SDK stays dependency-free for publishing; `provider-name.test.ts` fails if the two diverge — keep them in sync.
- Preset-bound keys resolve their model server-side; the SDK omits its default model when a usable preset is present so the default never becomes an accidental override.
- Plugin-bearing requests are never served from the response cache (per-request augmentation, surcharge charged once per real upstream call).
