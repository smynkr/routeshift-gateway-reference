import Link from 'next/link';
import { ArrowRight, Menu } from 'lucide-react';
import { PUBLIC_REFERENCE_URL } from '@/lib/public-urls';

// Shared public navigation for the marketing surface. Keep this list identical
// across desktop and the native mobile disclosure so every public destination
// remains reachable without client state.

const NAV_LINKS = [
  { href: '/#product', label: 'Product', external: false },
  { href: '/models', label: 'Models', external: false },
  { href: '/rankings', label: 'Rankings', external: false },
  { href: '/#pricing', label: 'Pricing', external: false },
  { href: '/changelog', label: 'Changelog', external: false },
  { href: PUBLIC_REFERENCE_URL, label: 'Docs', external: true },
] as const;

export function MarketingNav() {
  return (
    <header className="sticky top-0 z-50 border-b border-white/[0.06] bg-[#09090b]/90 backdrop-blur-xl">
      <nav
        aria-label="Main"
        className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6"
      >
        <div className="flex min-w-0 items-center gap-8">
          <Link href="/" className="flex min-w-0 items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-emerald-500/20 bg-emerald-500/10">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brand/routeshift-mark.svg" alt="RouteShift logo" className="h-5 w-5" />
            </div>
            <span className="truncate text-lg font-semibold tracking-tight text-white">
              RouteShift
            </span>
          </Link>
          <div className="hidden items-center gap-6 md:flex">
            {NAV_LINKS.map((link) =>
              link.external ? (
                <a
                  key={link.href}
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-zinc-400 transition-colors hover:text-white"
                >
                  {link.label}
                </a>
              ) : (
                <Link
                  key={link.href}
                  href={link.href}
                  className="text-sm text-zinc-400 transition-colors hover:text-white"
                >
                  {link.label}
                </Link>
              ),
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/login"
            className="hidden min-h-11 items-center text-sm text-zinc-400 transition-colors hover:text-white sm:inline-flex"
          >
            Login
          </Link>
          <Link
            href="/register"
            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-white px-4 text-sm font-medium text-zinc-900 transition-all hover:bg-zinc-200"
          >
            <span className="sm:hidden">Sign up</span>
            <span className="hidden sm:inline">Create free account</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
          <details className="relative md:hidden">
            <summary
              aria-label="Open menu"
              className="flex min-h-11 min-w-11 cursor-pointer list-none items-center justify-center rounded-lg border border-white/[0.08] text-zinc-300 marker:hidden"
            >
              <span className="sr-only">Open menu</span>
              <Menu className="h-5 w-5" aria-hidden="true" />
            </summary>
            <div className="absolute right-0 top-14 z-50 w-[calc(100vw-2rem)] max-w-64 rounded-xl border border-white/[0.08] bg-[#0c0c0e] p-3 shadow-2xl">
              <div className="grid gap-1">
                {NAV_LINKS.map((link) =>
                  link.external ? (
                    <a
                      key={`mobile-${link.href}`}
                      href={link.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex min-h-11 items-center rounded-lg px-3 py-2.5 text-sm text-zinc-300 hover:bg-white/[0.05] hover:text-white"
                    >
                      {link.label}
                    </a>
                  ) : (
                    <Link
                      key={`mobile-${link.href}`}
                      href={link.href}
                      className="flex min-h-11 items-center rounded-lg px-3 py-2.5 text-sm text-zinc-300 hover:bg-white/[0.05] hover:text-white"
                    >
                      {link.label}
                    </Link>
                  ),
                )}
                <Link href="/login" className="flex min-h-11 items-center rounded-lg px-3 py-2.5 text-sm text-zinc-300 hover:bg-white/[0.05] hover:text-white">
                  Login
                </Link>
                <Link href="/register" className="flex min-h-11 items-center rounded-lg bg-white px-3 py-2.5 text-sm font-medium text-zinc-900 hover:bg-zinc-200">
                  Create free account
                </Link>
              </div>
            </div>
          </details>
        </div>
      </nav>
    </header>
  );
}
