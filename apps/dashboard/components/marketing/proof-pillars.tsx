import { BarChart3, GitBranch, ShieldCheck } from 'lucide-react';

export const PROOF_PILLARS = [
  {
    id: 'decide',
    title: 'Decide',
    outcome: 'Match each workload to the right model and provider.',
    mechanism: 'Rules, capability signals, quality history, and fallbacks produce one replayable decision.',
    bullets: ['Policy routing', 'Quality-aware deranking', 'Fallback chains', 'Presets and Rule templates'],
    icon: GitBranch,
  },
  {
    id: 'protect',
    title: 'Protect',
    outcome: 'Keep spend and provider exposure inside explicit limits.',
    mechanism: 'Budgets alert or enforce according to configured actions; allowlists, guardrails, and data-policy requirements run as pre-dispatch checks when configured and available.',
    bullets: ['Daily, weekly, and monthly budgets', 'Provider and model controls', 'Prompt guardrails', 'Residency and ZDR policy'],
    icon: ShieldCheck,
  },
  {
    id: 'prove',
    title: 'Prove',
    outcome: 'Trace every route and reconcile the result.',
    mechanism: 'Activity, analytics, receipts, and exact reason codes connect aggregate changes to individual requests.',
    bullets: ['Exact route and fallback reasons', 'Savings receipts', 'Cost anomaly signals', 'Cache and token evidence'],
    icon: BarChart3,
  },
] as const;

export function ProofPillars() {
  return (
    <section id="product" aria-labelledby="proof-pillars-heading" className="border-b border-white/[0.04] py-20 sm:py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="max-w-2xl">
          <p className="text-sm font-medium uppercase tracking-[0.18em] text-emerald-400">Policy you can audit</p>
          <h2 id="proof-pillars-heading" className="font-heading mt-3 text-4xl italic tracking-tight text-white sm:text-5xl">
            Decide, protect, and prove every request.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-zinc-400 sm:text-lg">
            RouteShift keeps the policy decision visible from the first request through the savings receipt.
          </p>
        </div>
        <div className="mt-10 grid gap-4 lg:grid-cols-3">
          {PROOF_PILLARS.map((pillar) => {
            const Icon = pillar.icon;
            return (
              <article key={pillar.id} className="rounded-2xl border border-white/[0.08] bg-[#0c0c0e] p-6">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-emerald-400/20 bg-emerald-400/10">
                  <Icon className="h-5 w-5 text-emerald-300" aria-hidden="true" />
                </div>
                <h3 className="mt-5 text-xl font-semibold text-white">{pillar.title}</h3>
                <p className="mt-3 text-base font-medium leading-relaxed text-zinc-200">{pillar.outcome}</p>
                <p className="mt-3 text-sm leading-relaxed text-zinc-400">{pillar.mechanism}</p>
                <ul className="mt-5 space-y-2 border-t border-white/[0.07] pt-5">
                  {pillar.bullets.map((bullet) => (
                    <li key={bullet} className="flex items-start gap-2 text-sm text-zinc-300">
                      <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" aria-hidden="true" />
                      {bullet}
                    </li>
                  ))}
                </ul>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
