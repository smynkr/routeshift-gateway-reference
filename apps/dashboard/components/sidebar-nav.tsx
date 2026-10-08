'use client';

import { useId, useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import {
  LayoutDashboard,
  TrendingDown,
  BarChart3,
  Gauge,
  GitBranch,
  Key,
  CreditCard,
  Settings,
  ScrollText,
  PieChart,
  Wallet,
  Brain,
  Sparkles,
  Target,
  Layers,
  FlaskConical,
  Puzzle,
} from 'lucide-react';
import { DemoToggle } from '@/components/demo-toggle';

export const DASHBOARD_NAV_GROUPS = [
  { label: null, items: [{ href: '/overview', label: 'Overview', Icon: LayoutDashboard }] },
  { label: 'Observe', items: [
    { href: '/activity', label: 'Activity', Icon: ScrollText },
    { href: '/analytics', label: 'Analytics', Icon: PieChart },
    { href: '/savings', label: 'Savings', Icon: TrendingDown },
    { href: '/usage', label: 'Usage', Icon: BarChart3 },
    { href: '/tokens', label: 'Token Tracker', Icon: Gauge },
    { href: '/yield', label: 'Yield', Icon: Target },
    { href: '/optimize', label: 'Optimize', Icon: Sparkles },
  ] },
  { label: 'Route', items: [
    { href: '/routing', label: 'Routing Rules', Icon: GitBranch },
    { href: '/presets', label: 'Presets', Icon: Layers },
    { href: '/shadow-experiments', label: 'Shadow Experiments', Icon: FlaskConical },
    { href: '/models', label: 'Models', Icon: Brain },
  ] },
  { label: 'Control', items: [
    { href: '/keys', label: 'API Keys', Icon: Key },
    { href: '/billing', label: 'Billing & Budgets', Icon: CreditCard },
    { href: '/plugins', label: 'Plugins', Icon: Puzzle },
  ] },
  { label: 'Workspace', items: [{ href: '/settings', label: 'Settings', Icon: Settings }] },
] as const;

export function SidebarNav() {
  const navInstanceId = useId();
  const pathname = usePathname();
  const [creditBalance, setCreditBalance] = useState<number | null>(null);
  const [billingMode, setBillingMode] = useState<string>('subscription');
  const [billingError, setBillingError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadBillingState() {
      try {
        const res = await fetch('/api/billing/status?source=sidebar', { cache: 'no-store' });
        if (!res.ok) {
          if (!cancelled) {
            setBillingError('billing_status_unavailable');
            setCreditBalance(null);
          }
          return;
        }
        const data = await res.json();
        if (data?.error) {
          if (!cancelled) {
            setBillingError(String(data.error));
            setCreditBalance(null);
          }
          return;
        }
        if (!cancelled) {
          setBillingMode(data.billing_mode ?? 'subscription');
          setCreditBalance(data.credit_balance_microcents ?? null);
          setBillingError(null);
        }
      } catch {
        if (!cancelled) {
          setBillingError('billing_status_unavailable');
          setCreditBalance(null);
        }
      }
    }

    loadBillingState();
    const interval = window.setInterval(loadBillingState, 30_000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const renderNavItem = (item: (typeof DASHBOARD_NAV_GROUPS)[number]['items'][number]) => {
    const { href, label, Icon } = item;
    const active = pathname === href || pathname.startsWith(href + '/');
    return (
      <Link
        key={href}
        href={href}
        aria-current={active ? 'page' : undefined}
        className={`group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-all duration-200 ${
          active
            ? 'bg-emerald-500/[0.08] font-medium text-white'
            : 'text-neutral-500 hover:bg-white/[0.04] hover:text-neutral-300'
        }`}
      >
        {/* Active indicator bar */}
        {active && (
          <div className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-emerald-500" />
        )}
        <Icon
          className={`h-[18px] w-[18px] shrink-0 transition-colors duration-200 ${
            active
              ? 'text-emerald-400'
              : 'text-neutral-600 group-hover:text-neutral-400'
          }`}
        />
        {label}
      </Link>
    );
  };

  return (
    <>
      <nav aria-label="Dashboard" className="flex flex-col gap-1">
        {DASHBOARD_NAV_GROUPS.map(({ label, items }) => {
          if (label === null) return items.map(renderNavItem);

          const headingId = `${navInstanceId}-dashboard-nav-${label.toLowerCase()}`;
          return (
            <div key={label} role="group" aria-labelledby={headingId} className="mt-4">
              <div
                id={headingId}
                className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-neutral-400"
              >
                {label}
              </div>
              <div className="flex flex-col gap-1">{items.map(renderNavItem)}</div>
            </div>
          );
        })}
      </nav>
      {billingMode === 'credits' && creditBalance !== null && (
        <Link href="/billing" className="mt-4 block rounded-lg border border-white/[0.06] bg-white/[0.03] p-3 transition-colors hover:border-white/[0.1]">
          <div className="flex items-center justify-between">
            <span className="text-xs text-neutral-500">Credits</span>
            <Wallet className="h-3.5 w-3.5 text-neutral-600" />
          </div>
          <div className={`mt-1 text-lg font-bold ${
            creditBalance > 500000000 ? 'text-emerald-400' :
            creditBalance > 100000000 ? 'text-amber-400' :
            'text-red-400'
          }`}>
            ${(creditBalance / 100_000_000).toFixed(2)}
          </div>
        </Link>
      )}
      {billingError && (
        <Link
          href="/billing"
          className="mt-4 block rounded-lg border border-amber-500/20 bg-amber-500/[0.06] p-3 text-xs text-amber-300 transition-colors hover:border-amber-500/30"
        >
          Billing status unavailable
        </Link>
      )}
      <DemoToggle />
    </>
  );
}
