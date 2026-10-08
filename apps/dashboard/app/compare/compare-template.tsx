'use client';

import Link from 'next/link';
import { Fragment } from 'react';
import { motion } from 'motion/react';
import { MarketingNav } from '@/components/marketing/marketing-nav';
import { MarketingFooter } from '@/components/marketing/marketing-footer';
import {
  ArrowRight,
  Zap,
  Check,
  Minus,
} from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { PUBLIC_PROXY_BASE_URL } from '@/lib/public-urls';

export type CompareWinner = 'routeshift' | 'competitor' | 'tie';

export interface CompareRowItem {
  feature: string;
  routeshift: string;
  competitor: string;
  winner: CompareWinner;
}

export interface CompareCategory {
  category: string;
  items: CompareRowItem[];
}

export interface CompareVerifyLink {
  label: string;
  href: string;
}

export interface CompareTemplateProps {
  competitorName: string;
  /** Short slug used for the migration key label, e.g. "vercel-ai-gateway". */
  pagePath: string;
  heroSubtitle: string;
  competitorPricing: {
    subtitle: string;
    items: { label: string; value: string }[];
  };
  differentiator: {
    competitorTitle: string;
    competitorBody: string;
    routeshiftTitle: string;
    routeshiftBody: string;
    footnote: string;
  };
  verifyPrefix: string;
  verifyLinks: CompareVerifyLink[];
  closingLine: string;
  rows: CompareCategory[];
  useCompetitorWhen: {
    subtitle: string;
    bullets: string[];
  };
  migration: {
    baseUrl: string;
    keyLabel: string;
    modelLabel: string;
    note: string;
  };
  switchingHeading: string;
  switchingIntro: string;
}

const ROUTESHIFT_USE_BULLETS = [
  "You're spending $1K+/mo on LLM APIs and want to reduce it",
  'You want automatic cost-optimized routing between providers',
  'You want per-identity cost attribution and savings reporting per person or team',
  'You want deep analytics showing exactly where money goes',
  'You prefer BYOK fees based on measured savings rather than provider spend',
  'You need team management with role-based access control',
];

function WinnerIcon({ winner }: { winner: string }) {
  if (winner === 'routeshift') {
    return <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-label="RouteShift advantage" />;
  }
  if (winner === 'competitor') {
    return <Check className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" aria-label="Competitor advantage" />;
  }
  if (winner === 'tie') {
    return <Minus className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" aria-label="Comparable" />;
  }
  return null;
}

function PricingBreakdown({
  title,
  subtitle,
  items,
  total,
  totalLabel,
  totalColor,
  accent,
}: {
  title: string;
  subtitle: string;
  items: { label: string; value: string }[];
  total: string;
  totalLabel: string;
  totalColor: string;
  accent: 'emerald' | 'neutral';
}) {
  return (
    <div
      className={
        accent === 'emerald'
          ? 'h-full rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-6 sm:p-8'
          : 'h-full rounded-xl border border-white/[0.06] bg-white/[0.02] p-6 sm:p-8'
      }
    >
      <h3 className="text-lg font-semibold text-white">{title}</h3>
      <p className="mt-1 text-sm text-zinc-400">{subtitle}</p>
      <ul className="mt-6 space-y-3">
        {items.map((item) => (
          <li key={item.label} className="flex items-start justify-between gap-4 text-sm">
            <span className="text-zinc-400">{item.label}</span>
            <span className="text-right font-medium text-zinc-200">{item.value}</span>
          </li>
        ))}
      </ul>
      <div className="mt-6 border-t border-white/[0.06] pt-4">
        <p className="text-xs uppercase tracking-wider text-zinc-500">{totalLabel}</p>
        <p className={`mt-1 text-xl font-bold ${totalColor}`}>{total}</p>
      </div>
    </div>
  );
}

export function CompareTemplate({
  competitorName,
  pagePath,
  heroSubtitle,
  competitorPricing,
  differentiator,
  verifyPrefix,
  verifyLinks,
  closingLine,
  rows,
  useCompetitorWhen,
  migration,
  switchingHeading,
  switchingIntro,
}: CompareTemplateProps) {
  return (
    <div className="dark min-h-screen bg-[#09090b] text-white">
      <MarketingNav />

      <main>
        {/* Hero */}
        <section className="relative overflow-hidden py-20 md:py-28">
          <div className="pointer-events-none absolute inset-0">
            <div className="absolute left-1/2 top-0 h-[600px] w-[900px] -translate-x-1/2 -translate-y-1/3 rounded-full bg-emerald-500/[0.06] blur-[150px]" />
          </div>

          <div className="relative mx-auto max-w-4xl px-6 text-center">
            <motion.p
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4 }}
              className="mb-4 text-sm font-medium uppercase tracking-wider text-emerald-400"
            >
              Comparison
            </motion.p>
            <motion.h1
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.1 }}
              className="text-4xl font-bold tracking-tight text-white sm:text-5xl lg:text-6xl"
            >
              RouteShift vs {competitorName}
            </motion.h1>
            <motion.p
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.2 }}
              className="mx-auto mt-6 max-w-2xl text-lg text-zinc-400"
            >
              {heroSubtitle}
            </motion.p>
          </div>
        </section>

        {/* Pricing face-off */}
        <section className="py-16 md:py-24">
          <div className="mx-auto max-w-5xl px-6">
            <motion.h2
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5 }}
              className="mb-4 text-center text-2xl font-bold text-white sm:text-3xl"
            >
              The pricing difference
            </motion.h2>
            <motion.p
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: 0.1 }}
              className="mx-auto mb-12 max-w-xl text-center text-zinc-400"
            >
              The products support both provider-funded and managed-credit paths.
              The fair comparison is which event each fee applies to.
            </motion.p>

            <div className="grid gap-6 md:grid-cols-2">
              <motion.div
                initial={{ opacity: 0, x: -20 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5 }}
              >
                <PricingBreakdown
                  title={competitorName}
                  subtitle={competitorPricing.subtitle}
                  items={competitorPricing.items}
                  total="Usage-dependent"
                  totalLabel="Fee basis"
                  totalColor="text-zinc-300"
                  accent="neutral"
                />
              </motion.div>

              <motion.div
                initial={{ opacity: 0, x: 20 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: 0.1 }}
              >
                <PricingBreakdown
                  title="RouteShift"
                  subtitle="0% BYOK provider-spend markup"
                  items={[
                    { label: 'BYOK provider-spend markup', value: '0%' },
                    { label: 'Active-plan savings share', value: '3% of measured savings' },
                    { label: 'Active-plan managed credits', value: 'Provider cost + 3%' },
                  ]}
                  total="Mode-dependent"
                  totalLabel="Fee basis"
                  totalColor="text-emerald-400"
                  accent="emerald"
                />
              </motion.div>
            </div>

            {/* The real differentiator */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: 0.2 }}
              className="mt-10 rounded-xl border border-white/[0.06] bg-white/[0.02] p-6 sm:p-8"
            >
              <h3 className="text-lg font-semibold text-white mb-4">The real difference: incentive alignment</h3>
              <div className="grid gap-6 md:grid-cols-2">
                <div className="space-y-3">
                  <h4 className="text-sm font-medium text-zinc-300">{differentiator.competitorTitle}</h4>
                  <p className="text-sm text-zinc-400">
                    {differentiator.competitorBody}
                  </p>
                </div>
                <div className="space-y-3">
                  <h4 className="text-sm font-medium text-emerald-400">{differentiator.routeshiftTitle}</h4>
                  <p className="text-sm text-zinc-400">
                    {differentiator.routeshiftBody}
                  </p>
                </div>
              </div>
              <div className="mt-6 rounded-lg bg-white/[0.02] p-4">
                <p className="text-xs text-zinc-400">
                  <span className="font-medium text-zinc-300">No optimization scenario:</span>{' '}
                  {differentiator.footnote}
                </p>
              </div>
            </motion.div>

            <p className="mt-4 text-center text-xs text-zinc-400">
              {verifyPrefix}{' '}
              {verifyLinks.map((link, index) => (
                <Fragment key={link.href}>
                  {index > 0 && ' and '}
                  <a
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:text-zinc-400"
                  >
                    {link.label}
                  </a>
                </Fragment>
              ))}.
            </p>

            <motion.p
              initial={{ opacity: 0 }}
              whileInView={{ opacity: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: 0.3 }}
              className="mt-8 text-center text-sm text-zinc-400"
            >
              {closingLine}
            </motion.p>
          </div>
        </section>

        {/* Feature comparison table */}
        <section className="py-16 md:py-24">
          <div className="mx-auto max-w-5xl px-6">
            <motion.h2
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5 }}
              className="mb-12 text-center text-2xl font-bold text-white sm:text-3xl"
            >
              Feature-by-feature comparison
            </motion.h2>

            <Table className="min-w-[600px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="sticky top-0 w-[40%] bg-[#09090b] p-4 text-zinc-400">Feature</TableHead>
                  <TableHead className="sticky top-0 w-[30%] bg-[#09090b] p-4 text-emerald-400">
                    <span className="flex items-center gap-2">
                      <Zap className="h-3.5 w-3.5" />
                      RouteShift
                    </span>
                  </TableHead>
                  <TableHead className="sticky top-0 w-[30%] bg-[#09090b] p-4 text-zinc-400">{competitorName}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((category) => (
                  <Fragment key={category.category}>
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={3} className="bg-white/[0.02] px-4 py-2.5">
                        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                          {category.category}
                        </span>
                      </TableCell>
                    </TableRow>
                    {category.items.map((item) => (
                      <TableRow key={item.feature}>
                        <TableCell className="whitespace-normal p-4 font-medium text-zinc-300">{item.feature}</TableCell>
                        <TableCell className="whitespace-normal p-4">
                          <div className="flex items-start gap-2 text-sm">
                            <WinnerIcon winner={item.winner === 'routeshift' ? 'routeshift' : item.winner === 'tie' ? 'tie' : 'none'} />
                            <span className={item.winner === 'routeshift' ? 'text-emerald-300' : 'text-zinc-300'}>
                              {item.routeshift}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="whitespace-normal p-4">
                          <div className="flex items-start gap-2 text-sm">
                            <WinnerIcon winner={item.winner === 'competitor' ? 'competitor' : item.winner === 'tie' ? 'tie' : 'none'} />
                            <span className={item.winner === 'competitor' ? 'text-zinc-200' : 'text-zinc-400'}>
                              {item.competitor}
                            </span>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </Fragment>
                ))}
              </TableBody>
            </Table>

          </div>
        </section>

        {/* When to use which */}
        <section className="py-16 md:py-24">
          <div className="mx-auto max-w-5xl px-6">
            <motion.h2
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5 }}
              className="mb-12 text-center text-2xl font-bold text-white sm:text-3xl"
            >
              When to use which
            </motion.h2>

            <div className="grid gap-6 md:grid-cols-2">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5 }}
                className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-6 sm:p-8"
              >
                <h3 className="text-lg font-semibold text-white mb-1">Use {competitorName} when&hellip;</h3>
                <p className="text-sm text-zinc-400 mb-5">{useCompetitorWhen.subtitle}</p>
                <ul className="space-y-3">
                  {useCompetitorWhen.bullets.map((item) => (
                    <li key={item} className="flex items-start gap-2.5 text-sm text-zinc-400">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" />
                      {item}
                    </li>
                  ))}
                </ul>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: 0.1 }}
                className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-6 sm:p-8"
              >
                <h3 className="text-lg font-semibold text-white mb-1">Use RouteShift when&hellip;</h3>
                <p className="text-sm text-emerald-400/70 mb-5">You want to cut costs without sacrificing quality</p>
                <ul className="space-y-3">
                  {ROUTESHIFT_USE_BULLETS.map((item) => (
                    <li key={item} className="flex items-start gap-2.5 text-sm text-zinc-300">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                      {item}
                    </li>
                  ))}
                </ul>
              </motion.div>
            </div>
          </div>
        </section>

        {/* Switching */}
        <section className="py-16 md:py-24">
          <div className="mx-auto max-w-5xl px-6">
            <motion.h2
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5 }}
              className="mb-4 text-center text-2xl font-bold text-white sm:text-3xl"
            >
              {switchingHeading}
            </motion.h2>
            <motion.p
              initial={{ opacity: 0 }}
              whileInView={{ opacity: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: 0.1 }}
              className="mx-auto mb-10 max-w-2xl text-center text-sm leading-relaxed text-zinc-400"
            >
              {switchingIntro}
            </motion.p>
            <div className="overflow-hidden rounded-xl border border-white/[0.06]">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] border-collapse text-left text-sm">
                  <thead className="bg-white/[0.03] text-xs uppercase text-zinc-400">
                    <tr>
                      <th className="px-4 py-3 font-medium">{competitorName}</th>
                      <th className="px-4 py-3 font-medium">RouteShift</th>
                    </tr>
                  </thead>
                  <tbody className="text-zinc-300">
                    <tr className="border-t border-white/[0.06]">
                      <td className="px-4 py-3 font-mono text-[13px]">{migration.baseUrl}</td>
                      <td className="px-4 py-3 font-mono text-[13px] text-emerald-300">{PUBLIC_PROXY_BASE_URL}</td>
                    </tr>
                    <tr className="border-t border-white/[0.06]">
                      <td className="px-4 py-3 font-mono text-[13px]">{migration.keyLabel}</td>
                      <td className="px-4 py-3 font-mono text-[13px] text-emerald-300">sk-proxy-… API key from /keys</td>
                    </tr>
                    <tr className="border-t border-white/[0.06]">
                      <td className="px-4 py-3 font-mono text-[13px]">{migration.modelLabel}</td>
                      <td className="px-4 py-3 font-mono text-[13px] text-emerald-300">model or models: […] — check /models for ids</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
            <p className="mt-4 text-center text-xs leading-relaxed text-zinc-400">
              {migration.note}{' '}
              <Link href="/models" className="underline hover:text-zinc-300">RouteShift models page</Link> before switching production traffic.
            </p>
            <p className="mt-2 text-center text-xs leading-relaxed text-zinc-500">
              Full comparison path: routeshift.io{pagePath}
            </p>
          </div>
        </section>

        {/* CTA */}
        <section className="relative overflow-hidden py-20 md:py-28">
          <div className="pointer-events-none absolute inset-0">
            <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/[0.06] via-transparent to-teal-500/[0.04]" />
          </div>

          <div className="relative mx-auto max-w-3xl px-6 text-center">
            <motion.h2
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5 }}
              className="text-3xl font-bold text-white sm:text-4xl"
            >
              Ready to start saving?
            </motion.h2>
            <motion.p
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: 0.1 }}
              className="mx-auto mt-4 max-w-lg text-zinc-400"
            >
              Start with the free tier. Set up in two minutes. See your first
              savings report within the hour.
            </motion.p>
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: 0.2 }}
              className="mt-8 flex flex-col items-center gap-4 sm:flex-row sm:justify-center"
            >
              <Link
                href="/register"
                className="group inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-emerald-500 px-8 text-sm font-semibold text-zinc-950 shadow-lg shadow-emerald-500/25 transition-all hover:bg-emerald-400 hover:shadow-emerald-500/40"
              >
                Get Started Free
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
              <Link
                href="/#pricing"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-8 text-sm font-medium text-zinc-300 transition-all hover:border-white/20 hover:bg-white/[0.06]"
              >
                View Pricing
              </Link>
            </motion.div>
          </div>
        </section>
      </main>

      <MarketingFooter />
    </div>
  );
}
