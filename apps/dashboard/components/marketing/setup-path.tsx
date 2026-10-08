import Link from 'next/link';
import { ArrowUpRight, KeyRound, Route, SlidersHorizontal } from 'lucide-react';
import { PUBLIC_REFERENCE_URL } from '@/lib/public-urls';

const SETUP_STEPS = [
  {
    number: '01',
    title: 'Create a scoped API key',
    actionLabel: 'Create an account',
    description: 'Start with a key whose permissions and allowed models match the workload you want to route.',
    href: '/register',
    icon: KeyRound,
    external: false,
  },
  {
    number: '02',
    title: 'Point your OpenAI-compatible client at the local gateway',
    actionLabel: 'Read the local setup guide',
    description: 'Use your configured local proxy endpoint and keep your existing OpenAI-compatible request flow.',
    href: PUBLIC_REFERENCE_URL,
    icon: Route,
    external: true,
  },
  {
    number: '03',
    title: 'Add policy and inspect the first decision',
    actionLabel: 'Open routing rules',
    description: 'Create a routing rule, send a request, and read the exact rule, route, and fallback explanation.',
    href: '/routing/new',
    icon: SlidersHorizontal,
    external: false,
  },
] as const;

export function SetupPath() {
  return (
    <section aria-labelledby="setup-path-heading" className="border-b border-white/[0.04] py-20 sm:py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="max-w-2xl">
          <p className="text-sm font-medium uppercase tracking-[0.18em] text-emerald-400">Setup path</p>
          <h2 id="setup-path-heading" className="font-heading mt-3 text-4xl italic tracking-tight text-white sm:text-5xl">
            Route your first request in three steps
          </h2>
          <p className="mt-4 text-base leading-relaxed text-zinc-400 sm:text-lg">
            The path from a new key to an explainable route stays usable with plain links and a normal OpenAI-compatible client.
          </p>
        </div>
        <ol className="mt-10 grid gap-4 lg:grid-cols-3">
          {SETUP_STEPS.map((step) => {
            const Icon = step.icon;
            const linkClassName = 'group mt-6 inline-flex min-h-11 items-center gap-2 text-sm font-medium text-emerald-300 hover:text-emerald-200';
            const content = (
              <>
                {step.actionLabel}
                <ArrowUpRight className="h-4 w-4 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" aria-hidden="true" />
              </>
            );
            return (
              <li key={step.number} className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-6">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs text-emerald-400/70">{step.number}</span>
                  <Icon className="h-5 w-5 text-zinc-500" aria-hidden="true" />
                </div>
                <h3 className="mt-5 text-lg font-semibold text-white">{step.title}</h3>
                <p className="mt-2 text-base leading-relaxed text-zinc-300">{step.description}</p>
                {step.external ? (
                  <a href={step.href} target="_blank" rel="noopener noreferrer" className={linkClassName}>
                    {content}
                  </a>
                ) : (
                  <Link href={step.href} className={linkClassName}>
                    {content}
                  </Link>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
