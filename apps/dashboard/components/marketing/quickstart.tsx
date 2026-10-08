'use client';

import { useRef, useState } from 'react';

import Link from 'next/link';
import { buildModelsList } from '@routeshift/shared';
import { PUBLIC_PROXY_BASE_URL, PUBLIC_PROXY_CHAT_COMPLETIONS_URL } from '@/lib/public-urls';

type QuickstartTab = 'curl' | 'sdk' | 'cli';

const QUICKSTART_TABS: { id: QuickstartTab; label: string }[] = [
  { id: 'curl', label: 'cURL' },
  { id: 'sdk', label: 'TypeScript SDK' },
  { id: 'cli', label: 'Agent CLI' },
];

// Public chat catalog only: never embeddings, never parked ids. Sorted for a
// stable select; the default prefers the documented primary when present.
const QUICKSTART_MODELS: string[] = buildModelsList(null)
  .data.map((model) => model.id)
  .filter((id) => !id.startsWith('text-embedding'))
  .sort((a, b) => a.localeCompare(b));

// model-freshness: allow-compat pinned versioned docs default with catalog-includes guard for quickstart-wire-snippet
const QUICKSTART_DEFAULT_MODEL = QUICKSTART_MODELS.includes('gpt-5.4')
  // model-freshness: allow-compat pinned versioned docs default with catalog-includes guard for quickstart-wire-snippet
  ? 'gpt-5.4'
  : QUICKSTART_MODELS[0];

function providerOf(modelId: string): string | null {
  const entry = buildModelsList(null).data.find((model) => model.id === modelId);
  return entry?.endpoints[0]?.provider ?? null;
}

function quickstartCurlSnippet(model: string): string {
  return `export ROUTESHIFT_API_KEY="sk-proxy-live_..."\n\ncurl ${PUBLIC_PROXY_CHAT_COMPLETIONS_URL} \\\n  -H "Authorization: Bearer $ROUTESHIFT_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "model": "${model}",\n    "messages": [{"role": "user", "content": "Hello"}]\n  }'\n\n# Stream: add "stream": true. Embeddings: POST ${PUBLIC_PROXY_BASE_URL}/v1/embeddings.`;
}

const QUICKSTART_SNIPPETS: Record<'cli', string> = {
  cli: `pnpm --filter @routeshift/connect build
node packages/connect/dist/index.js
# Defaults: dashboard http://localhost:3000, proxy http://localhost:4000

node packages/connect/dist/index.js --status   # show what's configured`,
};

// The pasted chain always pairs the selected model with a fallback from a
// different provider, so the snippet demonstrates cross-provider resilience
// (a same-provider fallback adds no failover value).
function quickstartSdkSnippet(model: string): string {
  // model-freshness: allow-compat pinned versioned cross-provider fallback pair for quickstart-wire-snippet
  const fallback = providerOf(model) === 'anthropic' ? 'gpt-5.4' : 'claude-opus-4-6';
  const chain = model === fallback ? [model] : [model, fallback];
  const chainLiteral = chain.map((id) => `'${id}'`).join(', ');
  return `import { ProxyClient } from '@routeshift/sdk';\n\nconst client = new ProxyClient({\n  baseUrl: '${PUBLIC_PROXY_BASE_URL}',\n  apiKey: process.env.ROUTESHIFT_API_KEY!,\n});\n\nconst res = await client.chat({\n  models: [${chainLiteral}],\n  messages: [{ role: 'user', content: 'Hello' }],\n});`;
}

export function Quickstart() {
  const [tab, setTab] = useState<QuickstartTab>('curl');
  const [model, setModel] = useState<string>(QUICKSTART_DEFAULT_MODEL);
  const [copied, setCopied] = useState(false);
  const snippetRef = useRef<HTMLPreElement>(null);
  const snippet =
    tab === 'curl' ? quickstartCurlSnippet(model) : tab === 'sdk' ? quickstartSdkSnippet(model) : QUICKSTART_SNIPPETS[tab];

  const copySnippet = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API denied (permissions, non-secure context): fall back to
      // selecting the snippet so one keyboard copy finishes the job.
      const node = snippetRef.current;
      if (node) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      setCopied(false);
    }
  };

  return (
    <section aria-labelledby="quickstart-heading" className="border-b border-white/[0.04] py-20 sm:py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-medium uppercase tracking-[0.18em] text-emerald-400">
            Quickstart
          </p>
          <h2 id="quickstart-heading" className="font-heading mt-3 text-4xl italic tracking-tight text-white sm:text-5xl">
            First request in a minute
          </h2>
          <p className="mt-4 text-base leading-relaxed text-zinc-400 sm:text-lg">
            Works with any free-tier key — pick the path that matches your stack.
          </p>
        </div>
        <div className="mx-auto mt-10 max-w-3xl">
          <div role="tablist" aria-label="Integration paths" className="mb-4 flex flex-wrap justify-center gap-2">
            {QUICKSTART_TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                onClick={() => { setTab(item.id); setCopied(false); }}
                className={`inline-flex h-10 items-center rounded-lg px-4 text-sm font-medium transition-colors ${
                  tab === item.id
                    ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                    : 'border border-transparent text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
          {tab === 'curl' && (
            <div className="mx-auto mb-4 flex max-w-3xl flex-wrap items-center justify-center gap-2">
              <label htmlFor="quickstart-model" className="text-xs font-medium text-zinc-400">
                Model
              </label>
              <select
                id="quickstart-model"
                value={model}
                onChange={(event) => { setModel(event.target.value); setCopied(false); }}
                className="rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2 font-mono text-sm text-white outline-none focus:border-emerald-500/50"
              >
                {QUICKSTART_MODELS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="overflow-hidden rounded-xl border border-white/[0.06] bg-[#0c0c0e]">
            <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-3">
              <div className="h-3 w-3 rounded-full bg-white/10" />
              <div className="h-3 w-3 rounded-full bg-white/10" />
              <div className="h-3 w-3 rounded-full bg-white/10" />
              <span className="ml-3 text-xs text-zinc-400">
                {tab === 'curl' ? 'terminal' : tab === 'sdk' ? 'quickstart.ts' : 'agent setup'}
              </span>
              <button
                type="button"
                onClick={copySnippet}
                aria-label="Copy snippet to clipboard"
                className="ml-auto inline-flex h-8 items-center rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 text-xs font-medium text-zinc-300 transition-colors hover:border-white/20 hover:text-white"
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div role="tabpanel" className="overflow-x-auto p-4 sm:p-6">
              <pre
                ref={snippetRef}
                className="whitespace-pre-wrap font-mono text-[13px] leading-relaxed text-zinc-300 sm:text-sm"
              >
                {snippet}
              </pre>
            </div>
          </div>
          <p className="mt-4 text-center text-xs leading-relaxed text-zinc-400">
            Model ids come from the live public catalog. Switching from OpenRouter? See the <Link href="/compare/openrouter" className="underline hover:text-zinc-300">migration guide</Link>.
          </p>
        </div>
      </div>
    </section>
  );
}
