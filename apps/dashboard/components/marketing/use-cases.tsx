import Link from 'next/link';
import { ArrowUpRight, Bot, LifeBuoy, Wallet } from 'lucide-react';
import { PUBLIC_REFERENCE_URL } from '@/lib/public-urls';

const USE_CASES = [
  {
    id: 'finops-platform',
    audience: 'FinOps & platform',
    title: 'Cap spend before it ships',
    body: 'Set daily, weekly, and monthly budgets before requests leave your gateway. Reconcile the result with savings receipts that show what changed and why.',
    href: '/savings',
    cta: 'Review savings receipts',
    icon: Wallet,
    external: false,
  },
  {
    id: 'reliability',
    audience: 'Reliability',
    title: "Stay up when a provider doesn't",
    body: 'Build fallback chains that keep eligible requests moving when a provider does not. Activity records the exact reason for each fallback, skip, or block.',
    href: '/activity',
    cta: 'Inspect activity',
    icon: LifeBuoy,
    external: false,
  },
  {
    id: 'agent-teams',
    audience: 'Agent teams',
    title: 'Give every harness the same local route',
    body: 'Use the local Connect CLI and MCP catalog with your own gateway, while policies stay visible at the gateway.',
    href: PUBLIC_REFERENCE_URL,
    cta: 'Read the local setup guide',
    icon: Bot,
    external: true,
  },
] as const;

export function UseCases() {
  return (
    <section id="use-cases" aria-labelledby="use-cases-heading" className="scroll-mt-16 border-b border-white/[0.04] py-20 sm:py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="max-w-2xl">
          <p className="text-sm font-medium uppercase tracking-[0.18em] text-emerald-400">Built for operator jobs</p>
          <h2 id="use-cases-heading" className="font-heading mt-3 text-4xl italic tracking-tight text-white sm:text-5xl">
            One gateway for the team that owns the bill.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-zinc-400 sm:text-lg">
            Keep spend, reliability, and developer access in the same explainable route instead of splitting them across tools.
          </p>
        </div>

        <div className="mt-10 grid gap-4 lg:grid-cols-3">
          {USE_CASES.map((useCase) => {
            const Icon = useCase.icon;
            const linkContent = (
              <>
                {useCase.cta}
                <ArrowUpRight className="h-4 w-4 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" aria-hidden="true" />
              </>
            );

            return (
              <article key={useCase.id} className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-6">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-emerald-400/20 bg-emerald-400/10">
                    <Icon className="h-5 w-5 text-emerald-300" aria-hidden="true" />
                  </div>
                  <p className="text-sm font-medium uppercase tracking-[0.14em] text-zinc-400">{useCase.audience}</p>
                </div>
                <h3 className="mt-5 text-xl font-semibold text-white">{useCase.title}</h3>
                <p className="mt-3 text-base leading-relaxed text-zinc-300">{useCase.body}</p>
                {useCase.external ? (
                  <a href={useCase.href} target="_blank" rel="noopener noreferrer" className="group mt-6 inline-flex min-h-11 items-center gap-2 text-sm font-medium text-emerald-300 hover:text-emerald-200">
                    {linkContent}
                  </a>
                ) : (
                  <Link href={useCase.href} className="group mt-6 inline-flex min-h-11 items-center gap-2 text-sm font-medium text-emerald-300 hover:text-emerald-200">
                    {linkContent}
                  </Link>
                )}
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
