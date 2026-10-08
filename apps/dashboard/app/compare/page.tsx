import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { MarketingFooter } from '@/components/marketing/marketing-footer';
import { MarketingNav } from '@/components/marketing/marketing-nav';

export const metadata: Metadata = {
  title: 'Compare',
  description: 'How RouteShift compares to OpenRouter, Vercel AI Gateway, Helicone, and Portkey.',
};

type ComparisonCard = {
  name: string;
  positioning: string;
  slug: string;
  differentiators: string[];
};

const COMPARISONS: ComparisonCard[] = [
  {
    name: 'OpenRouter',
    positioning: 'Broad model access',
    slug: 'openrouter',
    differentiators: [
      'Measured-savings pricing: 0% BYOK spend markup plus 3% of measured savings.',
      'Exact skip and fallback reasons are preserved verbatim for each route.',
    ],
  },
  {
    name: 'Vercel AI Gateway',
    positioning: 'One API key, no markup',
    slug: 'vercel-ai-gateway',
    differentiators: [
      'Measured-savings pricing: the BYOK share applies only when routing reduces cost.',
      'Ordered fallback chains across providers with exact per-attempt outcomes logged.',
    ],
  },
  {
    name: 'Helicone',
    positioning: 'Observability-first',
    slug: 'helicone',
    differentiators: [
      'Ordered fallback chains across providers with exact per-attempt outcomes logged.',
      'Matched rules, resolved routes, and exact skip or fallback reasons stay visible.',
    ],
  },
  {
    name: 'Portkey',
    positioning: 'Production stack + governance',
    slug: 'portkey',
    differentiators: [
      'Measured-savings pricing: 0% BYOK spend markup plus 3% of measured savings.',
      'Exact skip, fallback, and error reasons are preserved verbatim in Activity.',
    ],
  },
];

export default function ComparePage() {
  return (
    <div className="dark min-h-screen bg-[#09090b] text-white">
      <MarketingNav />

      <main className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
        <header className="max-w-3xl">
          <p className="text-sm font-medium uppercase tracking-[0.18em] text-emerald-400">Comparisons</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">RouteShift vs other gateways</h1>
          <p className="mt-4 text-base leading-relaxed text-zinc-400">
            Policy routing, budgets, and savings evidence — compared against the gateway you already know. Honest ties where both do the job.
          </p>
        </header>

        <section aria-labelledby="comparison-options" className="mt-12">
          <h2 id="comparison-options" className="sr-only">
            Compare RouteShift with other gateways
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {COMPARISONS.map((comparison) => (
              <article
                key={comparison.slug}
                className="group flex h-full flex-col rounded-xl border border-white/[0.06] bg-white/[0.02] p-6 transition-colors hover:border-white/[0.12] hover:bg-white/[0.04] sm:p-7"
              >
                <div>
                  <h2 className="text-xl font-semibold text-white">{comparison.name}</h2>
                  <p className="mt-1 text-sm text-zinc-400">{comparison.positioning}</p>
                </div>
                <ul className="mt-6 flex-1 space-y-3 text-sm leading-relaxed text-zinc-300">
                  {comparison.differentiators.map((differentiator) => (
                    <li key={differentiator} className="flex items-start gap-2.5">
                      <span aria-hidden="true" className="mt-0.5 text-emerald-400">
                        •
                      </span>
                      <span>{differentiator}</span>
                    </li>
                  ))}
                </ul>
                <Link
                  href={`/compare/${comparison.slug}`}
                  className="group/link mt-7 inline-flex items-center gap-2 text-sm font-medium text-emerald-400 transition-colors hover:text-emerald-300"
                >
                  Read the comparison
                  <ArrowRight className="h-4 w-4 transition-transform group-hover/link:translate-x-0.5" aria-hidden="true" />
                </Link>
              </article>
            ))}
          </div>
        </section>

        <section className="mt-16 border-t border-white/[0.06] pt-10 sm:mt-20 sm:pt-12">
          <div className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
            <p className="max-w-2xl text-sm leading-relaxed text-zinc-400">
              Comparisons are maintained from public pricing/docs pages linked on each page; ties called where both do the job.
            </p>
            <Link
              href="/register"
              className="group inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-emerald-500 px-6 text-sm font-semibold text-zinc-950 shadow-lg shadow-emerald-500/20 transition-all hover:bg-emerald-400 hover:shadow-emerald-500/30"
            >
              Create a free account
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
            </Link>
          </div>
        </section>
      </main>

      <MarketingFooter />
    </div>
  );
}
