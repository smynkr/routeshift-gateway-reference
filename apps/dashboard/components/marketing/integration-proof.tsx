import { Braces, Cable, Terminal } from 'lucide-react';
import { PUBLIC_PROXY_BASE_URL } from '@/lib/public-urls';

const PUBLIC_SDK_BASE_URL = `${PUBLIC_PROXY_BASE_URL}/v1`;
const CONNECT_TARGETS = ['opencode', 'Continue/Cline', 'aider'] as const;

export function IntegrationProof() {
  return (
    <section aria-labelledby="integration-proof-heading" className="border-b border-white/[0.04] py-20 sm:py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="grid gap-10 lg:grid-cols-[0.85fr_1.15fr] lg:items-start">
          <div className="min-w-0">
            <p className="text-sm font-medium uppercase tracking-[0.18em] text-emerald-400">Integration proof</p>
            <h2 id="integration-proof-heading" className="font-heading mt-3 text-4xl italic tracking-tight text-white sm:text-5xl">
              Change the base URL. Keep the client.
            </h2>
            <p className="mt-5 max-w-xl text-base leading-relaxed text-zinc-400 sm:text-lg">
              Route an existing OpenAI-compatible SDK through RouteShift, then add policy without rewriting request or response code.
            </p>
            <div className="mt-7 overflow-hidden rounded-xl border border-white/[0.08] bg-[#0c0c0e]">
              <div className="border-b border-white/[0.06] px-4 py-3 text-xs text-zinc-400">client configuration</div>
              <pre className="overflow-x-auto p-4 text-sm leading-relaxed text-zinc-300"><code>{`const client = new OpenAI({
  baseURL: '${PUBLIC_SDK_BASE_URL}',
  apiKey: process.env.ROUTESHIFT_API_KEY,
});`}</code></pre>
            </div>
          </div>
          <div className="grid min-w-0 gap-4 sm:grid-cols-2">
            <article className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5 sm:col-span-2">
              <div className="flex items-center gap-3">
                <Cable className="h-5 w-5 text-emerald-300" aria-hidden="true" />
                <h3 className="text-base font-semibold text-white">Connect targets available today</h3>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-zinc-400">
                The Connect CLI auto-configures these OpenAI-compatible targets:
              </p>
              <ul className="mt-4 flex flex-wrap gap-2" aria-label="Supported Connect targets">
                {CONNECT_TARGETS.map((target) => (
                  <li key={target} className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1.5 text-sm text-emerald-200">
                    {target}
                  </li>
                ))}
              </ul>
            </article>
            <article className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5">
              <Terminal className="h-5 w-5 text-emerald-300" aria-hidden="true" />
              <h3 className="mt-4 text-base font-semibold text-white">MCP catalog</h3>
              <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                Give agents a read-only catalog for model availability, pricing, and rankings before they choose a route.
              </p>
            </article>
            <article className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5">
              <Braces className="h-5 w-5 text-emerald-300" aria-hidden="true" />
              <h3 className="mt-4 text-base font-semibold text-white">Typed SDK</h3>
              <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                Keep typed request helpers for chat, streaming, and embeddings while RouteShift records the decision.
              </p>
            </article>
          </div>
        </div>
      </div>
    </section>
  );
}
