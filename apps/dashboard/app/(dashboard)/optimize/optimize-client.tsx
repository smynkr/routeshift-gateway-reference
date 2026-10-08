'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Sparkles, AlertTriangle, AlertCircle, Info, Copy, Check, X, Wand2, ArrowRight } from 'lucide-react';

const MICROCENTS_TO_USD = 100_000_000;
const formatUsd = (mc: number) => {
  const usd = mc / MICROCENTS_TO_USD;
  if (usd >= 100) return `$${Math.round(usd).toLocaleString()}`;
  if (usd >= 1) return `$${usd.toFixed(0)}`;
  return `$${usd.toFixed(2)}`;
};

interface Finding {
  id: string;
  rule_id: string;
  severity: 'high' | 'medium' | 'low';
  estimated_savings_microcents: number;
  body_md: string;
  fix_md: string;
  first_seen_at: string;
  last_seen_at: string;
}

interface FindingsResponse {
  findings: Finding[];
  total_estimated_savings_microcents: number;
}

const SEVERITY_META = {
  high: { Icon: AlertTriangle, bg: 'bg-red-500/10', text: 'text-red-400', label: 'High' },
  medium: { Icon: AlertCircle, bg: 'bg-amber-500/10', text: 'text-amber-400', label: 'Medium' },
  low: { Icon: Info, bg: 'bg-sky-500/10', text: 'text-sky-400', label: 'Low' },
} as const;

export function OptimizeClient() {
  const [data, setData] = useState<FindingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch('/api/optimize/findings');
      if (!res.ok) throw new Error('Failed to fetch');
      setData(await res.json());
    } catch (err) {
      console.error('Failed to fetch findings:', err);
      setError('Failed to load findings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const dismissFinding = async (id: string) => {
    setData((d) => (d ? { ...d, findings: d.findings.filter((f) => f.id !== id) } : d));
    try {
      await fetch('/api/optimize/findings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status: 'dismissed' }),
      });
    } catch (err) {
      console.error('Dismiss failed:', err);
      void fetchData();
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-3xl font-bold text-white flex items-center gap-3">
          <Sparkles className="h-7 w-7 text-emerald-400" />
          Optimize
        </h2>
        <p className="mt-1 text-neutral-400">
          Ranked, copy-paste-fixable waste patterns from the last 7 days of traffic.
        </p>
      </div>

      <Link
        href="/optimize/prompt"
        className="group flex items-center justify-between rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-5 transition-colors hover:bg-emerald-500/[0.08]"
      >
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 ring-1 ring-emerald-500/20">
            <Wand2 className="h-5 w-5 text-emerald-400" />
          </div>
          <div>
            <p className="text-sm font-semibold text-white">Prompt Optimizer</p>
            <p className="mt-0.5 text-sm text-neutral-400">
              Rewrite a system prompt to cut tokens, sharpen instructions, or both.
            </p>
          </div>
        </div>
        <ArrowRight className="h-4 w-4 text-neutral-400 transition-transform group-hover:translate-x-0.5 group-hover:text-emerald-400" />
      </Link>

      {error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {loading ? (
        <div className="space-y-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-32 animate-pulse rounded-xl border border-white/[0.06] bg-white/[0.03]" />
          ))}
        </div>
      ) : data && data.findings.length > 0 ? (
        <>
          <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-5">
            <p className="text-sm text-neutral-400">Estimated monthly savings if all findings are fixed</p>
            <p className="mt-1 text-3xl font-bold text-emerald-400">
              {formatUsd(data.total_estimated_savings_microcents)}
            </p>
          </div>

          <div className="space-y-4">
            {data.findings.map((f) => (
              <FindingCard key={f.id} finding={f} onDismiss={() => dismissFinding(f.id)} />
            ))}
          </div>
        </>
      ) : (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] py-16 text-center">
          <Sparkles className="mx-auto mb-4 h-10 w-10 text-emerald-500/60" />
          <h3 className="mb-2 text-lg font-semibold text-white">Nothing to optimize</h3>
          <p className="mx-auto max-w-md text-sm text-neutral-500">
            We scanned your last 7 days of traffic and didn't find any waste patterns.
            Check back tomorrow — the engine runs nightly.
          </p>
        </div>
      )}
    </div>
  );
}

function FindingCard({ finding, onDismiss }: { finding: Finding; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  const meta = SEVERITY_META[finding.severity];
  const Icon = meta.Icon;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(finding.fix_md);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error('Copy failed:', err);
    }
  };

  return (
    <article className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-6">
      <header className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className={`mt-0.5 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium ${meta.bg} ${meta.text}`}>
            <Icon className="h-3.5 w-3.5" />
            {meta.label}
          </span>
          <div>
            <p className="font-mono text-xs text-neutral-500">{finding.rule_id}</p>
            <p className="mt-1 text-sm text-neutral-300">
              <RenderInline text={finding.body_md} />
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="text-right">
            <p className="text-xs text-neutral-500">Est. savings</p>
            <p className="text-lg font-semibold text-emerald-400">
              {formatUsd(finding.estimated_savings_microcents)}/mo
            </p>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            title="Dismiss"
            className="rounded-md p-1.5 text-neutral-600 transition-colors hover:bg-white/[0.04] hover:text-neutral-400"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="mt-4 rounded-lg border border-white/[0.04] bg-black/40 p-4">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
            Suggested fix
          </p>
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.06] bg-white/[0.03] px-2 py-1 text-xs text-neutral-400 transition-colors hover:border-white/[0.1] hover:text-neutral-200"
          >
            {copied ? (
              <>
                <Check className="h-3 w-3" /> Copied
              </>
            ) : (
              <>
                <Copy className="h-3 w-3" /> Copy
              </>
            )}
          </button>
        </div>
        <pre className="whitespace-pre-wrap break-words text-xs leading-relaxed text-neutral-300">
          <RenderInline text={finding.fix_md} />
        </pre>
      </div>
    </article>
  );
}

// Inline Markdown renderer for rule output. Handles **bold**, `code`, and
// [link](url) — that's all our rules emit. We control input shape, so this
// is intentionally minimal rather than pulling in a full markdown lib.
function RenderInline({ text }: { text: string }) {
  const tokens = tokenizeInline(text);
  return (
    <>
      {tokens.map((tok, i) => {
        if (tok.kind === 'text') return <span key={i}>{tok.value}</span>;
        if (tok.kind === 'bold') return <strong key={i} className="font-semibold text-white">{tok.value}</strong>;
        if (tok.kind === 'code') return <code key={i} className="rounded bg-white/[0.06] px-1 py-0.5 font-mono text-[11px] text-emerald-300">{tok.value}</code>;
        // Only render an anchor for safe schemes (http/https or a site-relative
        // path). Anything else (javascript:, data:, …) renders as plain text so
        // a stray URL in a finding can't become a clickable XSS payload.
        if (/^(https?:\/\/|\/)/i.test(tok.href)) {
          return <a key={i} href={tok.href} rel="noopener noreferrer" className="text-emerald-400 underline hover:text-emerald-300">{tok.value}</a>;
        }
        return <span key={i}>{tok.value}</span>;
      })}
    </>
  );
}

type InlineToken =
  | { kind: 'text'; value: string }
  | { kind: 'bold'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'link'; value: string; href: string };

function tokenizeInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  const matches = Array.from(text.matchAll(/(\*\*[^*]+\*\*)|(`[^`]+`)|(\[[^\]]+\]\([^)]+\))/g));
  let cursor = 0;
  for (const m of matches) {
    const idx = m.index ?? 0;
    if (idx > cursor) tokens.push({ kind: 'text', value: text.slice(cursor, idx) });
    const tok = m[0];
    if (tok.startsWith('**')) {
      tokens.push({ kind: 'bold', value: tok.slice(2, -2) });
    } else if (tok.startsWith('`')) {
      tokens.push({ kind: 'code', value: tok.slice(1, -1) });
    } else {
      const linkMatch = tok.match(/\[([^\]]+)\]\(([^)]+)\)/);
      if (linkMatch) tokens.push({ kind: 'link', value: linkMatch[1]!, href: linkMatch[2]! });
    }
    cursor = idx + tok.length;
  }
  if (cursor < text.length) tokens.push({ kind: 'text', value: text.slice(cursor) });
  return tokens;
}
