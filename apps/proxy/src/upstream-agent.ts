import { Agent, setGlobalDispatcher } from 'undici';

// Node's built-in fetch opens a new TCP/TLS connection per request. For a
// proxy that fans out hundreds of requests/sec to the same handful of
// upstreams (api.openai.com, api.anthropic.com, generativelanguage.googleapis.com,
// bedrock-runtime.*.amazonaws.com), the handshake cost dominates p50 —
// roughly 80-150ms per request that doesn't reuse a socket.
//
// Replace the global dispatcher with an undici Agent that pools and
// keep-alives sockets per origin. setGlobalDispatcher applies to the
// global fetch used in proxy-handler.ts and routing/fallback.ts without
// touching the call sites.
const upstreamAgent = new Agent({
  // Hold idle sockets long enough that bursty traffic reuses them, but
  // not so long that we pin connections through a provider rolling
  // restart. 30s lines up with most LLM provider keep-alive windows.
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  // Per-origin pool size. Most upstreams support pipelining, but LLM
  // requests are long-lived streams — pipelining gives no benefit and
  // can stall. Leave at 1.
  pipelining: 1,
  // Cap concurrent in-flight requests per origin to keep us from
  // blowing through provider rate limits at the connection layer.
  connections: 256,
});

export function installUpstreamAgent(): void {
  setGlobalDispatcher(upstreamAgent);
}

export async function destroyUpstreamAgent(): Promise<void> {
  await upstreamAgent.close();
}
