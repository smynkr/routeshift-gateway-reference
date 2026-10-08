import Link from 'next/link';
import { ArrowUpRight, FileCheck2, History, ShieldCheck } from 'lucide-react';
import { PUBLIC_PROXY_BASE_URL, PUBLIC_REFERENCE_URL } from '@/lib/public-urls';

const EVIDENCE_ITEMS = [
  {
    title: 'Exact route reasons',
    description: 'Inspect the matched rule, resolved route, fallback, and explanation for a request.',
    icon: FileCheck2,
  },
  {
    title: 'Example data labelled',
    description: 'Landing previews identify illustrative workspace values instead of presenting them as telemetry.',
    icon: ShieldCheck,
  },
  {
    title: 'Public product updates',
    description: 'Follow the curated changelog and public documentation as the product changes.',
    icon: History,
  },
] as const;

export function TrustEvidence() {
  return (
    <section aria-labelledby="trust-evidence-heading" className="border-b border-white/[0.04] py-16 sm:py-20">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-xl">
            <p className="text-sm font-medium uppercase tracking-[0.18em] text-emerald-400">Trust through evidence</p>
            <h2 id="trust-evidence-heading" className="font-heading mt-3 text-3xl italic tracking-tight text-white sm:text-4xl">
              Claims you can check.
            </h2>
          </div>
          <nav aria-label="Public evidence links" className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
            <Link href="/privacy" className="min-h-11 inline-flex items-center text-zinc-300 hover:text-white">
              Read the privacy policy
            </Link>
            <Link href="/changelog" className="min-h-11 inline-flex items-center text-zinc-300 hover:text-white">
              Read the product changelog
            </Link>
            <a href={PUBLIC_REFERENCE_URL} target="_blank" rel="noopener noreferrer" className="min-h-11 inline-flex items-center gap-1 text-zinc-300 hover:text-white">
              Read the local setup guide
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
            <a href={`${PUBLIC_PROXY_BASE_URL}/health`} target="_blank" rel="noopener noreferrer" className="min-h-11 inline-flex items-center gap-1 text-zinc-300 hover:text-white">
              Check API health
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          </nav>
        </div>
        <div className="mt-9 grid gap-3 md:grid-cols-3">
          {EVIDENCE_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <article key={item.title} className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-5">
                <Icon className="h-5 w-5 text-emerald-300" aria-hidden="true" />
                <h3 className="mt-4 text-base font-semibold text-white">{item.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-zinc-400">{item.description}</p>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
