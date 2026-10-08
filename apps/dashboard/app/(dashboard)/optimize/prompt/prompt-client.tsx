'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Wand2, Copy, Check, Loader2, ArrowLeft } from 'lucide-react';

type Mode = 'compress' | 'clarify' | 'both';

interface OptimizeResponse {
  optimized: string;
  originalTokens: number;
  optimizedTokens: number;
  deltaPercent: number;
  costPerKCallsOriginal: number;
  costPerKCallsOptimized: number;
  modelUsed: string;
}

const MODE_META: Record<Mode, { label: string; help: string }> = {
  compress: { label: 'Compress', help: 'Shorter (target 30-50% reduction). Preserves all rules.' },
  clarify: { label: 'Clarify', help: 'Resolve ambiguity. Restructure for consistency. Length may grow.' },
  both: { label: 'Both', help: 'Shorter and clearer (target 20-30% reduction).' },
};

export function PromptOptimizerClient() {
  const [input, setInput] = useState('');
  const [result, setResult] = useState<OptimizeResponse | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function run(selected: Mode) {
    if (!input.trim()) return;
    setMode(selected);
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/optimize/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: input, mode: selected }),
      });
      const json = (await res.json()) as OptimizeResponse | { error?: string };
      if (!res.ok) {
        throw new Error(('error' in json && json.error) || `Request failed (${res.status})`);
      }
      setResult(json as OptimizeResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Optimizer failed');
    } finally {
      setLoading(false);
    }
  }

  async function copyOutput() {
    if (!result?.optimized) return;
    await navigator.clipboard.writeText(result.optimized);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/optimize"
          className="inline-flex items-center gap-1.5 text-xs text-neutral-400 hover:text-white mb-3 transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to Optimize
        </Link>
        <h2 className="text-3xl font-bold text-white flex items-center gap-3">
          <Wand2 className="h-7 w-7 text-emerald-400" />
          Prompt Optimizer
        </h2>
        <p className="mt-1 text-neutral-400">
          Rewrite a system prompt to cut tokens, sharpen instructions, or both. The estimate
          uses the same pricing source as your /billing dashboard.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="space-y-2">
          <label className="text-xs font-semibold uppercase tracking-wider text-neutral-500">Original prompt</label>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Paste your system prompt here…"
            className="h-96 w-full resize-y rounded-xl border border-white/[0.08] bg-[#0c0c0e] px-4 py-3 font-mono text-[13px] text-neutral-200 placeholder:text-neutral-600 focus:border-emerald-500/40 focus:outline-none focus:ring-1 focus:ring-emerald-500/30"
            spellCheck={false}
          />
          <p className="text-xs text-neutral-500">{input.length.toLocaleString()} characters</p>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-xs font-semibold uppercase tracking-wider text-neutral-500">Optimized</label>
            {result && (
              <button
                onClick={copyOutput}
                className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-xs text-neutral-300 hover:bg-white/[0.06] transition-colors"
              >
                {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            )}
          </div>
          <div className="h-96 w-full overflow-auto rounded-xl border border-white/[0.08] bg-[#0c0c0e] px-4 py-3 font-mono text-[13px]">
            {loading ? (
              <div className="flex h-full items-center justify-center text-neutral-500">
                <Loader2 className="h-5 w-5 animate-spin mr-2" />
                Optimizing…
              </div>
            ) : error ? (
              <div className="text-red-400 whitespace-pre-wrap">{error}</div>
            ) : result ? (
              <div className="text-neutral-200 whitespace-pre-wrap">{result.optimized}</div>
            ) : (
              <div className="text-neutral-600">Pick a mode to start.</div>
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {(Object.keys(MODE_META) as Mode[]).map((m) => {
          const meta = MODE_META[m];
          const isActive = mode === m && (loading || result !== null);
          return (
            <button
              key={m}
              onClick={() => run(m)}
              disabled={loading || !input.trim()}
              className={[
                'rounded-lg border px-4 py-2.5 text-sm font-medium transition-all',
                'disabled:opacity-40 disabled:cursor-not-allowed',
                isActive
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                  : 'border-white/[0.08] bg-white/[0.03] text-neutral-200 hover:bg-white/[0.06]',
              ].join(' ')}
              title={meta.help}
            >
              {meta.label}
            </button>
          );
        })}
      </div>

      {result && !loading && !error && (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-5">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <Metric label="Original tokens" value={result.originalTokens.toLocaleString()} />
            <Metric label="Optimized tokens" value={result.optimizedTokens.toLocaleString()} />
            <Metric
              label="Δ"
              value={`${result.deltaPercent >= 0 ? '−' : '+'}${Math.abs(result.deltaPercent)}%`}
              accent={result.deltaPercent > 0 ? 'positive' : result.deltaPercent < 0 ? 'negative' : undefined}
            />
            <Metric
              label="Est. cost / 1K calls"
              value={`$${result.costPerKCallsOriginal.toFixed(4)} → $${result.costPerKCallsOptimized.toFixed(4)}`}
            />
          </div>
          <p className="mt-4 text-xs text-neutral-500">
            Optimization ran on <span className="text-neutral-400">{result.modelUsed}</span>.
            Cost estimate prices the prompt as input tokens at your dashboard&apos;s pricing source —
            assumes the prompt is sent identically on every call.
          </p>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: 'positive' | 'negative' }) {
  const accentClass =
    accent === 'positive'
      ? 'text-emerald-400'
      : accent === 'negative'
        ? 'text-amber-400'
        : 'text-white';
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">{label}</p>
      <p className={`mt-1 text-xl font-semibold ${accentClass}`}>{value}</p>
    </div>
  );
}
