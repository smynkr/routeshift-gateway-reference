import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

export default function NotFound() {
  return (
    <div className="dark relative flex min-h-screen flex-col overflow-hidden bg-[#09090b] text-white">
      {/* Subtle emerald glow, matching the landing/auth backgrounds */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute left-1/2 top-1/3 h-[500px] w-[800px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-emerald-500/[0.06] blur-[150px]" />
      </div>

      <div className="relative z-10 flex justify-center px-4 pt-10 sm:pt-12">
        <Link href="/" className="flex items-center gap-2 transition-opacity hover:opacity-80">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-emerald-500/20 bg-emerald-500/10">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/routeshift-mark.svg" alt="RouteShift logo" className="h-5 w-5" />
          </div>
          <span className="text-lg font-semibold tracking-tight text-white">RouteShift</span>
        </Link>
      </div>

      <div className="relative z-10 flex flex-1 flex-col items-center justify-center px-4 py-20 text-center">
        <p className="font-heading text-7xl italic leading-none text-white sm:text-8xl">404</p>
        <h1 className="mt-6 text-2xl font-semibold tracking-tight text-white sm:text-3xl">
          Page not found
        </h1>
        <p className="mt-3 max-w-md text-sm leading-6 text-zinc-400">
          The page you&apos;re looking for doesn&apos;t exist or has been moved. Let&apos;s get you
          back to routing.
        </p>
        <div className="mt-8 flex flex-col items-center gap-4 sm:flex-row">
          <Link
            href="/"
            className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-emerald-500 px-8 text-sm font-semibold text-zinc-950 shadow-lg shadow-emerald-500/25 transition-all duration-300 hover:bg-emerald-400 hover:shadow-emerald-500/40"
          >
            Back to home
            <ArrowRight className="h-4 w-4" />
          </Link>
          <div className="flex items-center gap-6">
            <Link
              href="/models"
              className="text-sm text-zinc-400 transition-colors hover:text-white"
            >
              Browse models
            </Link>
            <Link
              href="/overview"
              className="text-sm text-zinc-400 transition-colors hover:text-white"
            >
              Open the dashboard
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
