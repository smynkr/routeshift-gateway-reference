'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Check, ChevronRight, Wallet } from 'lucide-react';
import { AddCreditsDialog } from '@/components/credits/add-credits-dialog';
import { TransactionHistory } from '@/components/credits/transaction-history';
import { AutoTopUpSettings } from '@/components/credits/auto-topup-settings';
import { PromoCodeRedeem } from '@/components/billing/promo-code-redeem';
import { MonthlyBudgetSettings } from '@/components/billing/monthly-budget-settings';
import { SpendBreakdown } from '@/components/billing/spend-breakdown';
import { SpendAnomalySettings } from '@/components/billing/spend-anomaly-settings';
import { CostQualificationNotice } from '@/components/cost-qualification-notice';
import { KpiGridSkeleton, Skeleton } from '@/components/ui/skeleton';

const MICROCENTS_TO_USD = 100_000_000;

interface Subscription {
  id: string;
  plan: string;
  status: string;
  current_period_start: string;
  current_period_end: string;
  cancel_at_period_end: boolean;
}

interface BillingStatus {
  subscription: Subscription | null;
  usage: { keys: number; rules: number };
  period_savings_cents: number;
  billing_mode?: 'subscription' | 'credits';
  credit_balance_microcents?: number;
  auto_topup_enabled?: boolean;
  demo_active?: boolean;
  can_manage_billing?: boolean;
  unknown_cost_requests?: number;
  actual_costs_qualified?: boolean;
}

// LAY-344 Option A: single-tier model. RouteShift charges 3% of
// measured savings — no monthly platform fee, ever. The Subscribe
// button enrolls the team in the metered Stripe subscription
// (STRIPE_PRO_PRICE_ID); savings-reporter then bills the meter for
// 3% of period savings. Pre-subscription users (`free`) keep the
// same feature set; they don't owe savings-share and cannot enter the paid-plan-only credits mode.
const PRO_TIER = {
  plan: 'pro',
  name: 'RouteShift',
  price: '$0/mo',
  savingsShare: '3% of measured savings',
  features: [
    'Unlimited API keys',
    'Unlimited routing rules',
    'Fallback chains + response caching',
    'Team management + RBAC',
    'SSO',
    'Audit log export',
    'Regional providers (Z.ai, Qwen, MiniMax, Moonshot, Xiaomi)',
    'Priority support',
  ],
};

function formatBalanceUsd(microcents: number): string {
  const usd = microcents / MICROCENTS_TO_USD;
  return usd.toFixed(2);
}

function balanceColorClass(microcents: number): string {
  const usd = microcents / MICROCENTS_TO_USD;
  if (usd >= 10) return 'text-emerald-400';
  if (usd >= 2) return 'text-amber-400';
  return 'text-red-400';
}

function balanceBorderClass(microcents: number): string {
  const usd = microcents / MICROCENTS_TO_USD;
  if (usd >= 10) return 'border-emerald-500/20 bg-emerald-500/[0.04]';
  if (usd >= 2) return 'border-amber-500/20 bg-amber-500/[0.04]';
  return 'border-red-500/20 bg-red-500/[0.04]';
}

function extractErrorMessage(data: unknown, fallback: string): string {
  if (typeof data === 'string' && data.trim()) {
    return data;
  }
  if (data && typeof data === 'object') {
    const value = (data as { error?: unknown }).error;
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
    if (value && typeof value === 'object') {
      const message = (value as { message?: unknown }).message;
      if (typeof message === 'string' && message.trim()) {
        return message;
      }
    }
  }
  return fallback;
}

export default function BillingPage() {
  return (
    <Suspense fallback={<BillingSkeleton />}>
      <BillingContent />
    </Suspense>
  );
}

function BillingSkeleton() {
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-3xl font-bold text-white">Billing</h2>
        <p className="mt-1 text-neutral-400">Manage your subscription and view invoices.</p>
      </div>
      <KpiGridSkeleton count={3} />
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-6">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="mt-3 h-4 w-full" />
        <Skeleton className="mt-2 h-4 w-3/4" />
      </div>
    </div>
  );
}

function BillingContent() {
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const success = searchParams.get('success') === 'true';
  const canceled = searchParams.get('canceled') === 'true';
  const creditsSuccess = searchParams.get('credits_success') === 'true';
  const creditsCanceled = searchParams.get('credits_canceled') === 'true';

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setLoading(true);

    fetch('/api/billing/status')
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) {
          throw new Error(extractErrorMessage(data, 'Failed to load billing information.'));
        }
        return data as BillingStatus;
      })
      .then((data) => {
        if (!cancelled) {
          setStatus(data);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setStatus(null);
          setError(err instanceof Error ? err.message : 'Failed to load billing information.');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  async function handleCheckout(plan: string) {
    setActionLoading(plan);
    setError(null);
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan }),
      });
      const data = await res.json();
      if (!res.ok || !data.url) {
        setError(extractErrorMessage(data, 'Failed to start checkout.'));
        return;
      }
      if (data.url) {
        window.location.href = data.url;
      }
    } catch {
      setError('Failed to start checkout.');
    } finally {
      setActionLoading(null);
    }
  }

  async function handlePortal() {
    setActionLoading('portal');
    setError(null);
    try {
      const res = await fetch('/api/billing/portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (!res.ok || !data.url) {
        setError(extractErrorMessage(data, 'Failed to open the billing portal.'));
        return;
      }
      window.location.href = data.url;
    } catch {
      setError('Failed to open the billing portal.');
    } finally {
      setActionLoading(null);
    }
  }

  if (loading) {
    return <BillingSkeleton />;
  }

  const subscription = status?.subscription ?? null;
  const periodSavingsCents = status?.period_savings_cents ?? 0;
  const billingMode = status?.billing_mode;
  const creditBalance = status?.credit_balance_microcents ?? 0;
  const showCredits = billingMode === 'credits';
  const demoActive = Boolean(status?.demo_active);
  const canManageBilling = Boolean(status?.can_manage_billing);

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-3xl font-bold text-white">Billing</h2>
        <p className="mt-1 text-neutral-400">Manage your subscription and view invoices.</p>
      </div>

      {success && (
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] px-4 py-3 text-sm text-emerald-400">
          Subscription activated! Welcome to {subscription?.plan ? subscription.plan.charAt(0).toUpperCase() + subscription.plan.slice(1) : 'your new plan'}.
        </div>
      )}

      {creditsSuccess && (
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] px-4 py-3 text-sm text-emerald-400">
          Credits purchased successfully! Your balance has been updated.
        </div>
      )}

      {canceled && (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] px-4 py-3 text-sm text-neutral-400">
          Checkout was canceled.
        </div>
      )}

      {creditsCanceled && (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] px-4 py-3 text-sm text-neutral-400">
          Credit purchase was canceled.
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {demoActive && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-4 py-3 text-sm text-amber-300">
          Demo mode is read-only for billing. Turn off sample data to manage payments, credits, promo codes, or budget settings.
        </div>
      )}

      <CostQualificationNotice unknownCostRequests={status?.unknown_cost_requests ?? 0} />

      {/* Credits Section */}
      {showCredits && (
        <>
          {/* Credit Balance Card */}
          <div className={`rounded-xl border p-6 ${balanceBorderClass(creditBalance)}`}>
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <Wallet className="h-5 w-5 text-neutral-500" />
                  <p className="text-sm font-medium text-neutral-500">Credit Balance</p>
                </div>
                <div className={`mt-3 text-4xl font-bold ${balanceColorClass(creditBalance)}`}>
                  ${formatBalanceUsd(creditBalance)}
                </div>
                {status?.auto_topup_enabled && (
                  <p className="mt-2 text-sm text-neutral-500">
                    <span className="inline-flex items-center rounded-md bg-blue-500/10 px-2 py-0.5 text-xs font-medium text-blue-400">
                      Auto top-up enabled
                    </span>
                  </p>
                )}
              </div>
              {demoActive ? (
                <p className="text-sm text-neutral-500">Credit purchases are disabled in demo mode.</p>
              ) : (
                <AddCreditsDialog onSuccess={() => setRefreshKey((k) => k + 1)} />
              )}
            </div>
          </div>

          {/* Auto Top-Up Settings */}
          {!demoActive ? (
            <AutoTopUpSettings />
          ) : (
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] px-6 py-5 text-sm text-neutral-500">
              Auto top-up settings are read-only while sample data is active.
            </div>
          )}

          {/* Transaction History */}
          <div>
            <h3 className="mb-4 text-lg font-semibold text-white">Transaction History</h3>
            <TransactionHistory />
          </div>
        </>
      )}

      <MonthlyBudgetSettings
        canEdit={canManageBilling && !demoActive}
        readOnlyReason={
          demoActive
            ? 'Demo mode — budget settings are read-only.'
            : 'Only admins can manage budget settings.'
        }
      />
      <SpendAnomalySettings
        canEdit={canManageBilling && !demoActive}
        readOnlyReason={
          demoActive
            ? 'Demo mode — spend anomaly alerts are read-only.'
            : 'Only admins can manage spend alert settings.'
        }
      />

      {!demoActive && <PromoCodeRedeem />}

      {subscription ? (
        <>
          {subscription.cancel_at_period_end && (
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-4 py-3 text-sm text-amber-400 flex items-center justify-between">
              <span>
                Your plan will be downgraded to Free on{' '}
                {new Date(subscription.current_period_end).toLocaleDateString()}.
              </span>
              <button
                onClick={handlePortal}
                disabled={demoActive || actionLoading === 'portal'}
                className="ml-4 shrink-0 rounded-lg bg-amber-500 px-3 py-1.5 text-sm font-medium text-white transition-all hover:bg-amber-400 disabled:opacity-50"
              >
                {actionLoading === 'portal' ? 'Redirecting...' : 'Keep Subscription'}
              </button>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {/* Current Plan */}
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-6">
              <p className="text-sm font-medium text-neutral-500">Current Plan</p>
              <div className="mt-3 flex items-center gap-3">
                <span className="text-2xl font-bold text-white">
                  {subscription.plan.charAt(0).toUpperCase() + subscription.plan.slice(1)}
                </span>
                <span
                  className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${
                    subscription.status === 'active'
                      ? 'bg-emerald-500/10 text-emerald-400'
                      : 'bg-neutral-500/10 text-neutral-400'
                  }`}
                >
                  {subscription.status}
                </span>
              </div>
              <p className="mt-2 text-sm text-neutral-500">
                Next billing date: {new Date(subscription.current_period_end).toLocaleDateString()}
              </p>
              <button
                onClick={handlePortal}
                disabled={demoActive || actionLoading === 'portal'}
                className="mt-4 rounded-lg border border-white/[0.06] bg-white/[0.03] px-4 py-2 text-sm font-medium text-neutral-400 transition-all hover:bg-white/[0.06] hover:text-white disabled:opacity-50"
              >
                {actionLoading === 'portal' ? 'Redirecting...' : 'Manage Subscription'}
              </button>
            </div>

            {/* Period Savings */}
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-6">
              <p className="text-sm font-medium text-neutral-500">Current Period BYOK Savings</p>
              <div className="mt-3 text-2xl font-bold text-emerald-400">
                ${(periodSavingsCents / 100).toFixed(2)}
              </div>
              <p className="mt-2 text-sm text-neutral-500">
                {status?.actual_costs_qualified === false
                  ? 'Observed lower bound; requests with unknown historical cost are excluded from savings-share.'
                  : 'Savings share uses subscription/BYOK requests only'}
              </p>
            </div>
          </div>
        </>
      ) : (
        <>
          {/* Spend Breakdown (LAY-333): per-key + per-tag attribution */}
          <SpendBreakdown />

          {/* LAY-344 Option A: single-tier plan card. No monthly fee;
              clicking Subscribe enrolls in the 3% savings-share meter. */}
          <div>
            <h3 className="mb-4 text-lg font-semibold text-white">Subscribe</h3>
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/[0.04] p-6 shadow-lg shadow-emerald-500/[0.08]">
              <div className="flex flex-col gap-6 md:flex-row md:items-start md:justify-between">
                <div className="flex-1">
                  <h4 className="text-lg font-semibold text-white">{PRO_TIER.name}</h4>
                  <div className="mt-2 flex items-baseline gap-2">
                    <span className="text-3xl font-bold text-white">$0</span>
                    <span className="text-sm text-neutral-400">/mo platform fee</span>
                  </div>
                  <p className="mt-2 text-sm text-emerald-400/90">{PRO_TIER.savingsShare}</p>
                  <p className="mt-1 text-xs text-neutral-500">
                    No charges until our routing actually saves you money. Cancel anytime.
                  </p>
                  <ul className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {PRO_TIER.features.map((f) => (
                      <li key={f} className="flex items-start gap-2 text-sm text-neutral-300">
                        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
                        {f}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="md:w-48 md:shrink-0">
                  <button
                    onClick={() => handleCheckout(PRO_TIER.plan)}
                    disabled={demoActive || actionLoading !== null}
                    className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-500 px-4 text-sm font-medium text-white shadow-md shadow-emerald-500/20 transition-all duration-300 hover:bg-emerald-400 disabled:opacity-50"
                  >
                    {actionLoading === PRO_TIER.plan ? 'Redirecting...' : 'Subscribe'}
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                  <p className="mt-3 text-xs text-neutral-500">
                    Historical billing UI. This archive does not provide hosted plans or a sales service.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
