import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

export function LandingCta() {
  return (
    <section aria-labelledby="landing-cta-heading" className="relative overflow-hidden py-20 sm:py-24">
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-emerald-500/[0.08] via-transparent to-teal-500/[0.05]" />
      <div className="relative mx-auto max-w-3xl px-4 text-center sm:px-6">
        <p className="text-sm font-medium uppercase tracking-[0.18em] text-emerald-400">Start with proof</p>
        <h2 id="landing-cta-heading" className="font-heading mt-3 text-4xl italic tracking-tight text-white sm:text-5xl">
          Make the next routing decision explainable.
        </h2>
        <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-zinc-400 sm:text-lg">
          Create a scoped key, point your client at RouteShift, and inspect the first policy outcome before you send more traffic.
        </p>
        <Link href="/register" className="mt-8 inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-emerald-500 px-7 text-sm font-semibold text-zinc-950 transition-colors hover:bg-emerald-400">
          Create free account
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      </div>
    </section>
  );
}
