import type { Metadata } from 'next';
import Link from 'next/link';
import { MarketingFooter } from '@/components/marketing/marketing-footer';
import { MarketingNav } from '@/components/marketing/marketing-nav';
import { PRODUCT_RELEASES } from '@/lib/product-changelog';

export const metadata: Metadata = {
  title: 'Changelog',
  description: 'Customer-facing product releases and operator improvements.',
};

const dateFormatter = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });

export default function ChangelogPage() {
  return (
    <div className="min-h-screen bg-[#09090b] text-white">
      <MarketingNav />
      <main className="mx-auto max-w-4xl px-4 py-16 sm:px-6 sm:py-24">
        <div className="mb-12">
          <p className="text-sm font-medium uppercase tracking-[0.18em] text-emerald-400">Product updates</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">Changelog</h1>
          <p className="mt-4 max-w-2xl text-base leading-relaxed text-zinc-400">
            Customer-facing product releases and operator improvements.
          </p>
        </div>

        <div className="space-y-4">
          {PRODUCT_RELEASES.map((release) => (
            <article
              key={release.slug}
              id={release.slug}
              className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-5 sm:p-6"
              aria-labelledby={`${release.slug}-title`}
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <time dateTime={release.date} className="text-sm font-medium text-emerald-400">
                    {dateFormatter.format(new Date(`${release.date}T00:00:00Z`))}
                  </time>
                  <h2 id={`${release.slug}-title`} className="mt-2 text-lg font-semibold text-white">
                    {release.title}
                  </h2>
                </div>
                {'cta' in release && release.cta ? (
                  release.cta.href.startsWith('/') ? (
                    <Link
                      href={release.cta.href}
                      className="shrink-0 text-sm font-medium text-emerald-400 transition-colors hover:text-emerald-300"
                    >
                      {release.cta.label}
                    </Link>
                  ) : (
                    <a
                      href={release.cta.href}
                      className="shrink-0 text-sm font-medium text-emerald-400 transition-colors hover:text-emerald-300"
                    >
                      {release.cta.label}
                    </a>
                  )
                ) : null}
              </div>

              <p className="mt-4 text-sm leading-relaxed text-zinc-300">{release.summary}</p>
              <h3 className="sr-only">Highlights</h3>
              <ul className="mt-4 space-y-2 text-sm text-zinc-400">
                {release.highlights.map((highlight) => (
                  <li key={highlight} className="flex gap-2">
                    <span aria-hidden="true" className="text-emerald-400">•</span>
                    <span>{highlight}</span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </main>
      <MarketingFooter />
    </div>
  );
}
