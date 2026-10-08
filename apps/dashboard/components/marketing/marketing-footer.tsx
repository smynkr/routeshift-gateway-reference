import Link from 'next/link';
import { PUBLIC_PROXY_BASE_URL, PUBLIC_REFERENCE_URL } from '@/lib/public-urls';

// Shared marketing footer for public pages (models, privacy, terms).
// Matches the landing page Footer's palette (border-white/[0.06], zinc-500 links,
// emerald brand-mark tile) with link columns per the public-site structure.

type FooterLink = {
  label: string;
  href: string;
  external?: boolean;
};

const FOOTER_COLUMNS: { heading: string; links: FooterLink[] }[] = [
  {
    heading: 'Product',
    links: [
      { label: 'Models', href: '/models' },
      { label: 'Rankings', href: '/rankings' },
      { label: 'Compare all', href: '/compare' },
      { label: 'vs OpenRouter', href: '/compare/openrouter' },
      { label: 'vs Vercel AI Gateway', href: '/compare/vercel-ai-gateway' },
      { label: 'vs Helicone', href: '/compare/helicone' },
      { label: 'vs Portkey', href: '/compare/portkey' },
      { label: 'Changelog', href: '/changelog' },
      { label: 'Pricing', href: '/#pricing' },
    ],
  },
  {
    heading: 'Legal',
    links: [
      { label: 'Privacy', href: '/privacy' },
      { label: 'Terms', href: '/terms' },
      { label: 'Security', href: '/security' },
    ],
  },
  {
    heading: 'Resources',
    links: [
      { label: 'Docs', href: PUBLIC_REFERENCE_URL, external: true },
      { label: 'Login', href: '/login' },
      { label: 'Register', href: '/register' },
    ],
  },
];

export function MarketingFooter() {
  return (
    <footer className="border-t border-white/[0.06] bg-[#09090b]">
      <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-14">
        <div className="grid gap-10 sm:grid-cols-[1.4fr_repeat(3,1fr)]">
          <div className="flex flex-col items-start gap-3">
            <Link href="/" className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-md border border-emerald-500/20 bg-emerald-500/10">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/brand/routeshift-mark.svg" alt="RouteShift logo" className="h-4 w-4" />
              </div>
              <span className="text-base font-semibold tracking-tight text-white">
                RouteShift
              </span>
            </Link>
            <p className="max-w-xs text-xs leading-5 text-zinc-400">
              The LLM routing gateway that pays for itself. Built for developers who care about their AI
              spend.
            </p>
          </div>
          {FOOTER_COLUMNS.map((column) => (
            <div key={column.heading} className="flex flex-col gap-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                {column.heading}
              </p>
              <ul className="flex flex-col gap-2.5">
                {column.links.map((link) => (
                  <li key={link.href}>
                    {link.external ? (
                      <a
                        href={link.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-zinc-400 transition-colors hover:text-zinc-200"
                      >
                        {link.label}
                      </a>
                    ) : (
                      <Link
                        href={link.href}
                        className="text-sm text-zinc-400 transition-colors hover:text-zinc-200"
                      >
                        {link.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-10 border-t border-white/[0.04] pt-6 text-center sm:text-left">
          <p className="text-[11px] text-zinc-400">
            &copy; {new Date().getFullYear()} RouteShift ·{' '}
            <a
              href={`${PUBLIC_PROXY_BASE_URL}/health`}
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-zinc-200"
            >
              API health
            </a>
            </p>
        </div>
      </div>
    </footer>
  );
}
