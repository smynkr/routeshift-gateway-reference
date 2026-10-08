import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { RouteDecisionTrace } from '@/components/marketing/route-decision-trace';

export function LandingHero() {
  return (
    <section className="landing-grain relative overflow-hidden border-b border-white/[0.04]">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-[-320px] h-[480px] w-[820px] -translate-x-1/2 rounded-full bg-emerald-500/[0.07] blur-[120px]" />
        <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.025)_1px,transparent_1px)] bg-[size:72px_72px] [mask-image:radial-gradient(ellipse_70%_60%_at_50%_0%,black,transparent)]" />
      </div>
      <div className="relative z-10 mx-auto grid max-w-6xl gap-12 px-4 pb-20 pt-32 sm:px-6 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
        <div>
          <p className="text-sm font-medium uppercase tracking-[0.18em] text-emerald-400">
            Explainable policy routing
          </p>
          <h1 className="font-heading mt-5 text-5xl italic leading-[1.02] text-white sm:text-6xl lg:text-7xl">
            Control where AI requests run
            <span className="block text-emerald-400">and prove what the decision saved.</span>
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-zinc-300">
            Apply routing, budget, quality, and data-policy controls through one OpenAI-compatible endpoint—then inspect the exact rule, route, and cost outcome.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link
              href="/register"
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-emerald-500 px-6 text-sm font-semibold text-zinc-950 transition-colors hover:bg-emerald-400"
            >
              Create free account
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
            <a
              href="#route-decision-trace"
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-6 text-sm font-medium text-zinc-200 transition-colors hover:border-white/20 hover:bg-white/[0.06]"
            >
              Explore the decision
            </a>
          </div>
        </div>
        <div id="route-decision-trace" className="scroll-mt-24">
          <RouteDecisionTrace />
        </div>
      </div>
    </section>
  );
}
