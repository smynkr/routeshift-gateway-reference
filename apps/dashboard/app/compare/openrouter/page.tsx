'use client';

import Link from 'next/link';
import { Fragment } from 'react';
import { motion } from 'motion/react';
import { MarketingNav } from '@/components/marketing/marketing-nav';
import { MarketingFooter } from '@/components/marketing/marketing-footer';
import { requireCurrentModel } from '@/lib/current-models';
import {
  ArrowRight,
  Zap,
  Check,
  Minus,
} from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { PUBLIC_PROXY_BASE_URL } from '@/lib/public-urls';

// Migration snippet models come from the generated role fixture so the
// example tracks the current catalog instead of pinning versioned ids.
const MIGRATION_PRIMARY = requireCurrentModel('default');
const MIGRATION_FALLBACK = requireCurrentModel('economy');

const comparisonRows = [
  {
    category: 'Pricing',
    items: [
      {
        feature: 'Pricing model',
        routeshift: '0% BYOK spend markup + 3% of measured savings',
        openrouter: 'BYOK allowance, then 5%; 5.5% credit-purchase fee',
        winner: 'tie',
      },
      {
        feature: 'Free tier',
        routeshift: 'Free BYOK: unlimited keys/rules and 0% savings share',
        openrouter: 'Free models plus an included monthly BYOK allowance',
        winner: 'tie',
      },
      {
        feature: 'Fee when not optimizing',
        routeshift: 'BYOK: $0 share at $0 savings; credits still add 3%',
        openrouter: 'BYOK allowance then 5%; managed credits carry a purchase fee',
        winner: 'tie',
      },
      {
        feature: 'Incentive alignment',
        routeshift: 'BYOK share tracks savings; credits markup tracks usage',
        openrouter: 'BYOK fee tracks equivalent cost; managed fee applies at purchase',
        winner: 'tie',
      },
    ],
  },
  {
    category: 'Routing & Optimization',
    items: [
      {
        feature: 'Smart routing engine',
        routeshift: 'Rules with conditions and priorities, plus auto-routing strategies (cheapest/fastest/balanced), versioned presets with history, and response quality gates',
        openrouter: 'Auto Exacto adaptive quality routing, presets with version history, performance-index filtering',
        winner: 'tie',
      },
      {
        feature: 'Fallback chains',
        routeshift: 'Automatic sequential failover',
        openrouter: 'Provider fallback available',
        winner: 'tie',
      },
      {
        feature: 'Response caching',
        routeshift: 'Narrower eligibility (temperature=0 only; no streaming or tools) — bills the cache hit at full cost',
        openrouter: 'Broader eligibility incl. streaming, tools, and multimodal — $0 billed on a cache hit',
        winner: 'openrouter',
      },
      {
        feature: 'Circuit breaker',
        routeshift: 'Per-provider/model failure tracking',
        openrouter: 'Internal reliability measures',
        winner: 'tie',
      },
      {
        feature: 'Cost-aware routing',
        routeshift: 'Automatic cost-optimized model selection',
        openrouter: 'Provider routing with model selection',
        winner: 'tie',
      },
    ],
  },
  {
    category: 'Models & Providers',
    items: [
      {
        feature: 'Total models',
        routeshift: 'Curated public model registry',
        openrouter: '400+ models',
        winner: 'openrouter',
      },
      {
        feature: 'Providers',
        routeshift: 'Focused set of registered providers',
        openrouter: '70+ providers',
        winner: 'openrouter',
      },
      {
        feature: 'Model curation',
        routeshift: 'Optimized for cost-quality tradeoffs',
        openrouter: 'Broad aggregator catalog',
        winner: 'routeshift',
      },
    ],
  },
  {
    category: 'Analytics & Visibility',
    items: [
      {
        feature: 'Cost analytics',
        routeshift: 'Per-model, per-provider, daily trends + LLM classifier that tags sampled, PII-stripped requests across custom dimensions',
        openrouter: 'Analytics API for usage/adoption trends + Classifiers for custom spend-tagging dimensions',
        winner: 'routeshift',
      },
      {
        feature: 'Savings tracking',
        routeshift: 'Original vs actual cost on every request',
        openrouter: 'Not applicable',
        winner: 'routeshift',
      },
      {
        feature: 'Live activity feed',
        routeshift: 'Real-time filterable request log',
        openrouter: 'Activity log available',
        winner: 'tie',
      },
      {
        feature: 'Cache hit analytics',
        routeshift: 'Hit rate, cache savings breakdown',
        openrouter: 'Header-level signal only (X-OpenRouter-Cache); no dedicated hit-rate dashboard',
        winner: 'routeshift',
      },
      {
        feature: 'Error analysis',
        routeshift: 'By provider, status code, error type',
        openrouter: 'Basic error visibility',
        winner: 'routeshift',
      },
    ],
  },
  {
    category: 'API Compatibility',
    items: [
      {
        feature: 'OpenAI-compatible model catalog',
        routeshift: 'Yes — GET /v1/models and GET /v1/models/:id',
        openrouter: 'Yes',
        winner: 'tie',
      },
      {
        feature: 'Generation cost lookup',
        routeshift: 'Yes — GET /api/v1/generation?id=',
        openrouter: 'Yes',
        winner: 'tie',
      },
      {
        feature: 'Embeddings endpoint',
        routeshift: 'Yes — OpenAI-compatible POST /v1/embeddings',
        openrouter: 'Yes',
        winner: 'tie',
      },
    ],
  },
  {
    category: 'Team & Security',
    items: [
      {
        feature: 'Team invitations',
        routeshift: 'Email invite with shareable link',
        openrouter: 'Organization support',
        winner: 'tie',
      },
      {
        feature: 'Role-based access',
        routeshift: 'Owner, admin, member roles',
        openrouter: 'Basic access control',
        winner: 'routeshift',
      },
      {
        feature: 'API key management',
        routeshift: 'Create, revoke, environment scoping',
        openrouter: 'API key management',
        winner: 'tie',
      },
      {
        feature: 'Rate limiting',
        routeshift: 'Per-team sliding window',
        openrouter: 'Rate limiting available',
        winner: 'tie',
      },
      {
        feature: 'Guardrails (prompt-injection / DLP)',
        routeshift: 'Pre-dispatch scanning with a built-in PII + prompt-injection pattern catalog; per-team toggles, custom regex, and block/warn overrides (default off)',
        openrouter: 'Prompt-injection detection + built-in PII/DLP scanning, scoped per key/member/workspace',
        winner: 'openrouter',
      },
    ],
  },
];

function WinnerIcon({ winner }: { winner: string }) {
  if (winner === 'routeshift') return <Check className="h-4 w-4 text-emerald-400" />;
  if (winner === 'openrouter') return <Check className="h-4 w-4 text-zinc-400" />;
  return <Minus className="h-3.5 w-3.5 text-zinc-400" />;
}

function PricingBreakdown({
  title,
  subtitle,
  items,
  total,
  totalLabel,
  totalColor,
  accent,
}: {
  title: string;
  subtitle: string;
  items: { label: string; value: string; color?: string }[];
  total: string;
  totalLabel: string;
  totalColor: string;
  accent: 'emerald' | 'neutral';
}) {
  return (
    <div
      className={`rounded-xl border p-6 sm:p-8 ${
        accent === 'emerald'
          ? 'border-emerald-500/20 bg-emerald-500/[0.04]'
          : 'border-white/[0.06] bg-white/[0.02]'
      }`}
    >
      <h3 className="text-xl font-bold text-white">{title}</h3>
      <p className={`mt-1 text-sm ${accent === 'emerald' ? 'text-emerald-400/70' : 'text-zinc-400'}`}>
        {subtitle}
      </p>
      <div className="mt-6 space-y-3">
        {items.map((item) => (
          <div key={item.label} className="flex items-center justify-between text-sm">
            <span className="text-zinc-400">{item.label}</span>
            <span className={`font-mono ${item.color ?? 'text-zinc-300'}`}>{item.value}</span>
          </div>
        ))}
        <div className="border-t border-white/[0.06] pt-3 flex items-center justify-between text-sm font-semibold">
          <span className="text-zinc-300">{totalLabel}</span>
          <span className={`font-mono text-lg ${totalColor}`}>{total}</span>
        </div>
      </div>
    </div>
  );
}

export default function OpenRouterComparePage() {
  return (
    <div className="dark min-h-screen bg-[#09090b] text-white">
      <MarketingNav />

      <main>
        {/* Hero */}
        <section className="relative overflow-hidden py-20 md:py-28">
          <div className="pointer-events-none absolute inset-0">
            <div className="absolute left-1/2 top-0 h-[600px] w-[900px] -translate-x-1/2 -translate-y-1/3 rounded-full bg-emerald-500/[0.06] blur-[150px]" />
          </div>

          <div className="relative mx-auto max-w-4xl px-6 text-center">
            <motion.p
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4 }}
              className="mb-4 text-sm font-medium uppercase tracking-wider text-emerald-400"
            >
              Comparison
            </motion.p>
            <motion.h1
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.1 }}
              className="text-4xl font-bold tracking-tight text-white sm:text-5xl lg:text-6xl"
            >
              RouteShift vs OpenRouter
            </motion.h1>
            <motion.p
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.2 }}
              className="mx-auto mt-6 max-w-2xl text-lg text-zinc-400"
            >
              Both platforms can route and optimize your LLM traffic. The
              difference is how we charge — and what that means for our
              incentives to actually save you money.
            </motion.p>
          </div>
        </section>

        {/* Pricing face-off */}
        <section className="py-16 md:py-24">
          <div className="mx-auto max-w-5xl px-6">
            <motion.h2
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5 }}
              className="mb-4 text-center text-2xl font-bold text-white sm:text-3xl"
            >
              The pricing difference
            </motion.h2>
            <motion.p
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: 0.1 }}
              className="mx-auto mb-12 max-w-xl text-center text-zinc-400"
            >
              The products support both provider-funded and managed-credit paths.
              The fair comparison is which event each fee applies to.
            </motion.p>

            <div className="grid gap-6 md:grid-cols-2">
              <motion.div
                initial={{ opacity: 0, x: -20 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5 }}
              >
                <PricingBreakdown
                  title="OpenRouter"
                  subtitle="Separate BYOK and managed-credit fees — verify current terms below"
                  items={[
                    { label: 'BYOK within included allowance', value: '$0 fee' },
                    { label: 'BYOK above included allowance', value: '5% of equivalent cost' },
                    { label: 'Managed credits', value: '5.5% purchase fee' },
                  ]}
                  total="Usage-dependent"
                  totalLabel="Fee basis"
                  totalColor="text-zinc-300"
                  accent="neutral"
                />
              </motion.div>

              <motion.div
                initial={{ opacity: 0, x: 20 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: 0.1 }}
              >
                <PricingBreakdown
                  title="RouteShift"
                  subtitle="0% BYOK provider-spend markup"
                  items={[
                    { label: 'BYOK provider-spend markup', value: '0%' },
                    { label: 'Active-plan savings share', value: '3% of measured savings' },
                    { label: 'Active-plan managed credits', value: 'Provider cost + 3%' },
                  ]}
                  total="Mode-dependent"
                  totalLabel="Fee basis"
                  totalColor="text-emerald-400"
                  accent="emerald"
                />
              </motion.div>
            </div>

            {/* The real differentiator */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: 0.2 }}
              className="mt-10 rounded-xl border border-white/[0.06] bg-white/[0.02] p-6 sm:p-8"
            >
              <h3 className="text-lg font-semibold text-white mb-4">The real difference: incentive alignment</h3>
              <div className="grid gap-6 md:grid-cols-2">
                <div className="space-y-3">
                  <h4 className="text-sm font-medium text-zinc-300">OpenRouter&apos;s fees depend on funding mode</h4>
                  <p className="text-sm text-zinc-400">
                    OpenRouter passes through managed inference pricing and charges
                    when credits are purchased. BYOK has an included allowance, then
                    a fee based on equivalent model and provider cost.
                  </p>
                </div>
                <div className="space-y-3">
                  <h4 className="text-sm font-medium text-emerald-400">RouteShift&apos;s fee tracks your savings</h4>
                  <p className="text-sm text-zinc-400">
                    In BYOK mode, our savings share only applies when we actually reduce your costs.
                    If routing doesn&apos;t save you anything, you pay zero — no platform
                    fee, no savings share. The BYOK savings-share fee grows only
                    when measured savings grow.
                  </p>
                </div>
              </div>
              <div className="mt-6 rounded-lg bg-white/[0.02] p-4">
                <p className="text-xs text-zinc-400">
                  <span className="font-medium text-zinc-300">No optimization scenario:</span>{' '}
                  In RouteShift BYOK mode, zero measured optimization means a $0
                  savings share and provider spend still has 0% markup. Managed
                  credits are a separate mode and include the plan&apos;s credits markup.
                </p>
              </div>
            </motion.div>

            <p className="mt-4 text-center text-xs text-zinc-400">
              OpenRouter comparison terms can change over time. Verify current details in its{' '}
              <a
                href="https://openrouter.ai/docs/guides/overview/auth/byok"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-zinc-400"
              >
                BYOK documentation
              </a>{' '}
              and{' '}
              <a
                href="https://openrouter.ai/docs/faq"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-zinc-400"
              >
                pricing FAQ
              </a>.
            </p>

            <motion.p
              initial={{ opacity: 0 }}
              whileInView={{ opacity: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: 0.3 }}
              className="mt-8 text-center text-sm text-zinc-400"
            >
              OpenRouter excels at model breadth. RouteShift excels at cost
              optimization. Both are solid choices — it depends on what
              matters most to your team.
            </motion.p>
          </div>
        </section>

        {/* Feature comparison table */}
        <section className="py-16 md:py-24">
          <div className="mx-auto max-w-5xl px-6">
            <motion.h2
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5 }}
              className="mb-12 text-center text-2xl font-bold text-white sm:text-3xl"
            >
              Feature-by-feature comparison
            </motion.h2>

            <Table className="min-w-[600px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="sticky top-0 w-[40%] bg-[#09090b] p-4 text-zinc-400">Feature</TableHead>
                  <TableHead className="sticky top-0 w-[30%] bg-[#09090b] p-4 text-emerald-400">
                    <span className="flex items-center gap-2">
                      <Zap className="h-3.5 w-3.5" />
                      RouteShift
                    </span>
                  </TableHead>
                  <TableHead className="sticky top-0 w-[30%] bg-[#09090b] p-4 text-zinc-400">OpenRouter</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {comparisonRows.map((category) => (
                  <Fragment key={category.category}>
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={3} className="bg-white/[0.02] px-4 py-2.5">
                        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                          {category.category}
                        </span>
                      </TableCell>
                    </TableRow>
                    {category.items.map((item) => (
                      <TableRow key={item.feature}>
                        <TableCell className="whitespace-normal p-4 font-medium text-zinc-300">{item.feature}</TableCell>
                        <TableCell className="whitespace-normal p-4">
                          <div className="flex items-start gap-2 text-sm">
                            <WinnerIcon winner={item.winner === 'routeshift' ? 'routeshift' : item.winner === 'tie' ? 'tie' : 'none'} />
                            <span className={item.winner === 'routeshift' ? 'text-emerald-300' : 'text-zinc-300'}>
                              {item.routeshift}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="whitespace-normal p-4">
                          <div className="flex items-start gap-2 text-sm">
                            <WinnerIcon winner={item.winner === 'openrouter' ? 'openrouter' : item.winner === 'tie' ? 'tie' : 'none'} />
                            <span className={item.winner === 'openrouter' ? 'text-zinc-200' : 'text-zinc-400'}>
                              {item.openrouter}
                            </span>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </Fragment>
                ))}
              </TableBody>
            </Table>

          </div>
        </section>

        {/* When to use which */}
        <section className="py-16 md:py-24">
          <div className="mx-auto max-w-5xl px-6">
            <motion.h2
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5 }}
              className="mb-12 text-center text-2xl font-bold text-white sm:text-3xl"
            >
              When to use which
            </motion.h2>

            <div className="grid gap-6 md:grid-cols-2">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5 }}
                className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-6 sm:p-8"
              >
                <h3 className="text-lg font-semibold text-white mb-1">Use OpenRouter when&hellip;</h3>
                <p className="text-sm text-zinc-400 mb-5">You need breadth of model access</p>
                <ul className="space-y-3">
                  {[
                    'You need access to 400+ models across 70+ providers',
                    'You\'re experimenting with niche or fine-tuned models',
                    'You want a single API for every model available',
                    'Model diversity matters more than cost optimization',
                  ].map((item) => (
                    <li key={item} className="flex items-start gap-2.5 text-sm text-zinc-400">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" />
                      {item}
                    </li>
                  ))}
                </ul>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: 0.1 }}
                className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-6 sm:p-8"
              >
                <h3 className="text-lg font-semibold text-white mb-1">Use RouteShift when&hellip;</h3>
                <p className="text-sm text-emerald-400/70 mb-5">You want to cut costs without sacrificing quality</p>
                <ul className="space-y-3">
                  {[
                    'You\'re spending $1K+/mo on LLM APIs and want to reduce it',
                    'You want automatic cost-optimized routing between providers',
                    'You want per-identity cost attribution and savings reporting per person or team',
                    'You want deep analytics showing exactly where money goes',
                    'You prefer BYOK fees based on measured savings rather than provider spend',
                    'You need team management with role-based access control',
                  ].map((item) => (
                    <li key={item} className="flex items-start gap-2.5 text-sm text-zinc-300">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                      {item}
                    </li>
                  ))}
                </ul>
              </motion.div>
            </div>
          </div>
        </section>
        {/* Switching from OpenRouter */}
        <section className="py-16 md:py-24">
          <div className="mx-auto max-w-5xl px-6">
            <motion.h2
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5 }}
              className="mb-4 text-center text-2xl font-bold text-white sm:text-3xl"
            >
              Switching from OpenRouter takes minutes
            </motion.h2>
            <motion.p
              initial={{ opacity: 0 }}
              whileInView={{ opacity: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: 0.1 }}
              className="mx-auto mb-10 max-w-2xl text-center text-sm leading-relaxed text-zinc-400"
            >
              Both APIs speak the OpenAI chat-completions shape, so the migration is a base-URL swap plus a key exchange. Provider preferences carry over — RouteShift honors the same per-request provider routing preferences.
            </motion.p>
            <div className="overflow-hidden rounded-xl border border-white/[0.06]">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] border-collapse text-left text-sm">
                  <thead className="bg-white/[0.03] text-xs uppercase text-zinc-400">
                    <tr>
                      <th className="px-4 py-3 font-medium">OpenRouter</th>
                      <th className="px-4 py-3 font-medium">RouteShift</th>
                    </tr>
                  </thead>
                  <tbody className="text-zinc-300">
                    <tr className="border-t border-white/[0.06]">
                      <td className="px-4 py-3 font-mono text-[13px]">https://openrouter.ai/api/v1</td>
                      <td className="px-4 py-3 font-mono text-[13px] text-emerald-300">{PUBLIC_PROXY_BASE_URL}</td>
                    </tr>
                    <tr className="border-t border-white/[0.06]">
                      <td className="px-4 py-3 font-mono text-[13px]">sk-or-… API key</td>
                      <td className="px-4 py-3 font-mono text-[13px] text-emerald-300">sk-proxy-… API key from /keys</td>
                    </tr>
                    <tr className="border-t border-white/[0.06]">
                      <td className="px-4 py-3 font-mono text-[13px]">provider: {'{ sort: … }'}</td>
                      <td className="px-4 py-3 font-mono text-[13px] text-emerald-300">provider: {'{ sort: … }'} — same shape</td>
                    </tr>
                    <tr className="border-t border-white/[0.06]">
                      <td className="px-4 py-3 font-mono text-[13px]">model: &apos;vendor/slug&apos;</td>
                      <td className="px-4 py-3 font-mono text-[13px] text-emerald-300">model or models: […] — check /models for ids</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
            <div className="mt-6 overflow-hidden rounded-xl border border-white/[0.06] bg-[#0c0c0e]">
              <div className="border-b border-white/[0.06] px-4 py-3 text-xs text-zinc-400">migration.ts — the whole diff</div>
              <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-relaxed sm:p-6">
                <code>
                  <span className="text-zinc-400">{'// 1. Swap the base URL, keep the OpenAI client'}</span>{'\n'}
                  <span className="text-purple-400">const</span> <span className="text-zinc-300">client</span> <span className="text-zinc-400">=</span> <span className="text-purple-400">new</span> <span className="text-blue-400">OpenAI</span><span className="text-zinc-400">({'{'}</span>{'\n'}
                  {'  '}baseURL: <span className="text-emerald-400">&apos;{PUBLIC_PROXY_BASE_URL}&apos;</span><span className="text-zinc-400">,</span>{'\n'}
                  {'  '}apiKey: process.env.<span className="text-zinc-300">ROUTESHIFT_API_KEY</span><span className="text-zinc-400">,</span>{'\n'}
                  <span className="text-zinc-400">{'});'}</span>{'\n\n'}
                  <span className="text-zinc-400">{'// 2. Add an ordered fallback chain (optional, recommended)'}</span>{'\n'}
                  <span className="text-purple-400">await</span> <span className="text-zinc-300">client</span><span className="text-zinc-400">.</span><span className="text-zinc-300">chat</span><span className="text-zinc-400">.</span><span className="text-yellow-300">completions</span><span className="text-zinc-400">.</span><span className="text-yellow-300">create</span><span className="text-zinc-400">({'{'}</span>{'\n'}
                  {'  '}models: [<span className="text-emerald-400">&apos;{MIGRATION_PRIMARY.canonical_name}&apos;</span>, <span className="text-emerald-400">&apos;{MIGRATION_FALLBACK.canonical_name}&apos;</span>]{'\n'}
                  {'}'})<span className="text-zinc-400">;</span>
                </code>
              </pre>
            </div>
            <p className="mt-4 text-center text-xs leading-relaxed text-zinc-400">
              Model ids differ between catalogs — confirm yours on the <Link href="/models" className="underline hover:text-zinc-300">RouteShift models page</Link> before switching production traffic.
            </p>
          </div>
        </section>


        {/* CTA */}
        <section className="relative overflow-hidden py-20 md:py-28">
          <div className="pointer-events-none absolute inset-0">
            <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/[0.06] via-transparent to-teal-500/[0.04]" />
          </div>

          <div className="relative mx-auto max-w-3xl px-6 text-center">
            <motion.h2
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5 }}
              className="text-3xl font-bold text-white sm:text-4xl"
            >
              Ready to start saving?
            </motion.h2>
            <motion.p
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: 0.1 }}
              className="mx-auto mt-4 max-w-lg text-zinc-400"
            >
              Start with the free tier. Set up in two minutes. See your first
              savings report within the hour.
            </motion.p>
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: 0.2 }}
              className="mt-8 flex flex-col items-center gap-4 sm:flex-row sm:justify-center"
            >
              <Link
                href="/register"
                className="group inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-emerald-500 px-8 text-sm font-semibold text-zinc-950 shadow-lg shadow-emerald-500/25 transition-all hover:bg-emerald-400 hover:shadow-emerald-500/40"
              >
                Get Started Free
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
              <Link
                href="/#pricing"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-8 text-sm font-medium text-zinc-300 transition-all hover:border-white/20 hover:bg-white/[0.06]"
              >
                View Pricing
              </Link>
            </motion.div>
          </div>
        </section>
      </main>

      <MarketingFooter />
    </div>
  );
}
