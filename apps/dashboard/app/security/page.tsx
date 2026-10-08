import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, KeyRound, Users, Gauge, Globe, FileSearch, ReceiptText } from 'lucide-react';
import { MarketingNav } from '@/components/marketing/marketing-nav';
import { MarketingFooter } from '@/components/marketing/marketing-footer';

export const metadata: Metadata = {
  title: 'Security & Trust',
  description:
    'How RouteShift protects your traffic: hash-only API keys, team-scoped tenancy and cache, rate and budget enforcement that fails closed, and exact error reasons.',
};

const SECTIONS = [
  {
    Icon: FileSearch,
    heading: 'Your prompts stay yours',
    body: 'RouteShift proxies requests in real time — prompts and completions are not stored. Operational records are sanitized by design: quality verdicts carry provider, model, outcome, and reason code only, never prompt or response text. Cache accounting persists token counts and policy versions, never the cached content’s source text in logs or exports.',
  },
  {
    Icon: KeyRound,
    heading: 'Keys that minimize blast radius',
    body: 'Only a SHA-256 hash of an API key is ever stored; the plaintext is shown once at creation and never persisted. Rotation uses a grace window (default 24h, capped at 168h) so you can roll credentials with zero downtime and no indefinitely-valid dual key. Device-flow keys are scoped to inference and read capabilities, and admin automation uses scoped read-only tokens — never the global admin secret in browser-facing code.',
  },
  {
    Icon: Users,
    heading: 'Tenancy enforced at every layer',
    body: 'Every billing, key, and rule record carries a team id, and wildcard or missing tenants are rejected — a key or rule can never silently land in a global bucket. Response-cache keys hash the team id into the lookup, so one team can never receive a cache hit built from another team’s request. Demo mode swaps in a fixed sample team so sample data can never leak live tenant data.',
  },
  {
    Icon: Gauge,
    heading: 'Limits that fail closed, not open',
    body: 'Per-team rate limits run on a sliding 60-second window; per-key and team token budgets reserve an estimate before any paid upstream call and reconcile to actual usage after. Daily, weekly, and monthly spend caps admit traffic transactionally — unknown pricing or a ledger failure rejects the request (503) instead of admitting unbilled traffic. Caps report exact codes: 402 with reset_at when a cap is hit, 429 with retry_after for rate and throttle limits.',
  },
  {
    Icon: Globe,
    heading: 'A hardened network path',
    body: 'All traffic is encrypted in transit via TLS, with Cloudflare in front of both the API and dashboard surfaces. Dashboard production traffic traverses a private tunnel so generated hosting hostnames cannot be used to bypass the edge, and client-IP extraction for unauthenticated routes is gated on an edge-shared secret so forged headers cannot evade per-IP limits.',
  },
  {
    Icon: ReceiptText,
    heading: 'Nothing vague in your logs',
    body: 'Exact skip, fallback, and error reasons are preserved verbatim from proxy to log to UI — no collapsing into generic buckets. Savings receipts show measured routed cost against your baseline, and budget surfaces label lower-bound figures as lower bounds when historical cost is unknown. What you see is what the ledger recorded.',
  },
] as const;

export default function SecurityPage() {
  return (
    <div className="dark min-h-screen bg-[#09090b] text-white">
      <MarketingNav />
      <main className="bg-[#050706]">
        <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-16 lg:px-8">
          <header className="max-w-2xl border-b border-white/[0.08] pb-8">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-emerald-300">
              Security &amp; trust
            </p>
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              Built like it sits in front of your money
            </h1>
            <p className="mt-3 text-sm leading-6 text-zinc-400">
              RouteShift is a shared multi-tenant proxy in front of paid provider credentials and a
              per-team credit ledger. These are the controls that keep one team’s traffic, keys,
              and spend away from another’s — and keep any single client from exhausting shared
              capacity.
            </p>
          </header>

          <div className="mt-10 grid gap-6 md:grid-cols-2">
            {SECTIONS.map(({ Icon, heading, body }) => (
              <section
                key={heading}
                className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-6 sm:p-8"
              >
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg border border-emerald-500/20 bg-emerald-500/10">
                  <Icon className="h-5 w-5 text-emerald-400" aria-hidden="true" />
                </div>
                <h2 className="text-lg font-semibold text-white">{heading}</h2>
                <p className="mt-2 text-sm leading-6 text-zinc-400">{body}</p>
              </section>
            ))}
          </div>

          <div className="mt-10 flex flex-col gap-3 border-t border-white/[0.08] pt-6 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-zinc-400">
              Questions about data handling? See the{' '}
              <Link href="/privacy" className="underline hover:text-zinc-300">
                privacy policy
              </Link>
              .
            </p>
            <Link
              href="/register"
              className="inline-flex items-center gap-2 text-sm font-medium text-emerald-300 hover:text-emerald-200"
            >
              Start routing
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </main>
      <MarketingFooter />
    </div>
  );
}
