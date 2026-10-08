import { VolumeChart } from '@/components/charts/volume-chart';
import { KpiCard } from '@/components/stats/kpi-card';
import { OverviewQuickStart } from '@/components/overview/overview-quick-start';
import { OverviewChecklist } from '@/components/overview/overview-checklist';
import { CostQualificationNotice } from '@/components/cost-qualification-notice';
import { getPool } from '@/lib/db';
import { getEffectiveTeamId, isDemoActive } from '@/lib/demo';
import { hasRole, requireTeamMembership } from '@/lib/rbac';
import { categoryColor, categoryLabel } from '@/lib/activity-categories';
import { Activity, Key, GitBranch, Zap, Sparkles, Target, Wallet } from 'lucide-react';
import Link from 'next/link';

export const metadata = { title: 'Overview' };
export const dynamic = 'force-dynamic';

const MICROCENTS_TO_USD = 100_000_000;

function gradeColor(grade: string | undefined): string {
  if (grade === 'A') return 'text-emerald-400';
  if (grade === 'B') return 'text-emerald-400';
  if (grade === 'C') return 'text-amber-400';
  if (grade === 'D' || grade === 'F') return 'text-red-400';
  return 'text-neutral-500';
}

async function getOverviewData() {
  try {
    const member = await requireTeamMembership();
    if (!member) return { data: null, error: null };
    const demo = await isDemoActive();
    const teamId = await getEffectiveTeamId(member.teamId);
    if (!teamId) return { data: null, error: 'No team context is available for this session.' };

    const pool = getPool();

    // Summary metrics for the last 7 days
    const summaryResult = await pool.query(
      `SELECT
         COUNT(*)::int AS total_requests,
         -- Routing cost/savings stay separate from the customer-facing bill.
         COALESCE(SUM(actual_cost_microcents), 0)::bigint AS total_routing_cost_microcents,
         COALESCE(SUM(actual_cost_microcents + COALESCE(plugin_cost_microcents, 0)), 0)::bigint AS total_billed_spend_microcents,
         COALESCE(SUM(original_cost_microcents), 0)::bigint AS total_original_microcents,
         COALESCE(SUM(GREATEST(savings_microcents, 0)) FILTER (WHERE actual_cost_known = true), 0)::bigint AS total_savings_microcents,
         COUNT(*) FILTER (WHERE actual_cost_known = false)::int AS unknown_cost_requests,
         COALESCE(AVG(total_latency_ms), 0)::int AS avg_latency_ms,
         CASE WHEN COUNT(*) > 0
           THEN ROUND(COUNT(*) FILTER (WHERE status_code >= 400)::numeric / COUNT(*)::numeric, 4)
           ELSE 0
         END AS error_rate,
         COUNT(*) FILTER (WHERE COALESCE(cache_hit, false) = true)::int AS cache_hits
       FROM request_logs
       WHERE team_id = $1
         AND timestamp >= NOW() - INTERVAL '7 days'`,
      [teamId],
    );

    const summary = summaryResult.rows[0];
    const totalRoutingCostUsd = Number(summary.total_routing_cost_microcents) / MICROCENTS_TO_USD;
    const totalBilledSpendUsd = Number(summary.total_billed_spend_microcents) / MICROCENTS_TO_USD;
    const totalSavingsUsd = Number(summary.total_savings_microcents) / MICROCENTS_TO_USD;
    // Use original spend (what you would have paid) as the savings denominator
    // so this headline % matches the Savings page exactly. The old
    // actual + clampedSavings base diverges whenever a row has negative raw
    // savings (routing that cost more than baseline).
    const totalOriginal = Number(summary.total_original_microcents) / MICROCENTS_TO_USD;
    const savingsPercent = totalOriginal > 0
      ? Math.round((totalSavingsUsd / totalOriginal) * 100)
      : 0;

    // Hourly timeseries for the last 7 days
    const timeseriesResult = await pool.query(
      `SELECT
         date_trunc('hour', timestamp) AS hour,
         COUNT(*)::int AS requests,
         COALESCE(AVG(total_latency_ms), 0)::int AS avg_latency_ms
       FROM request_logs
       WHERE team_id = $1
         AND timestamp >= NOW() - INTERVAL '7 days'
       GROUP BY date_trunc('hour', timestamp)
       ORDER BY hour`,
      [teamId],
    );

    const timeseries = timeseriesResult.rows.map((row) => ({
      hour: row.hour.toISOString(),
      requests: row.requests,
      avg_latency_ms: row.avg_latency_ms,
    }));

    // Query setup state directly from DB so first-run guidance reflects the
    // live workspace without adding a client-side fetch.
    const [keysResult, rulesResult, teamResult, providerKeysResult, balanceResult, trafficResult] = await Promise.all([
      pool.query(
        'SELECT COUNT(*)::int AS count FROM api_keys WHERE team_id = $1 AND revoked_at IS NULL',
        [teamId],
      ),
      pool.query(
        'SELECT COUNT(*)::int AS count FROM routing_rules WHERE team_id = $1 AND enabled = true',
        [teamId],
      ),
      pool.query('SELECT billing_mode FROM teams WHERE id = $1', [teamId]),
      pool.query(
        'SELECT COUNT(*)::int AS count FROM provider_keys WHERE team_id = $1 AND enabled = true',
        [teamId],
      ),
      pool.query('SELECT balance_microcents FROM credit_balances WHERE team_id = $1', [teamId]),
      pool.query(
        'SELECT EXISTS(SELECT 1 FROM request_logs WHERE team_id = $1) AS has_traffic',
        [teamId],
      ),
    ]);
    const keysRow = keysResult.rows[0];
    const rulesRow = rulesResult.rows[0];
    const activeKeys = keysRow.count;
    const activeRules = rulesRow.count;
    const billingMode = teamResult.rows[0]?.billing_mode === 'credits' ? 'credits' : 'subscription';
    const hasModelAccess = billingMode === 'credits'
      ? Number(balanceResult.rows[0]?.balance_microcents ?? 0) > 0
      : Number(providerKeysResult.rows[0]?.count ?? 0) > 0;

    // Top activity category (by request count) over the last 7 days. Returns
    // null if every row in the window predates migration 015.
    const { rows: topCategoryRows } = await pool.query(
      `SELECT activity_category AS category, COUNT(*)::int AS requests
       FROM request_logs
       WHERE team_id = $1
         AND timestamp >= NOW() - INTERVAL '7 days'
         AND activity_category IS NOT NULL
       GROUP BY activity_category
       ORDER BY requests DESC
       LIMIT 1`,
      [teamId],
    );
    const topCategory = topCategoryRows[0] ?? null;

    // One-shot rate over closed sessions (LAY-314). Sessions stay out of
    // session_metrics until idle ≥30 min, so this lags live activity by
    // design — it's a quality signal, not a real-time meter.
    const { rows: [oneShotRow] } = await pool.query(
      `SELECT
         COUNT(*)::int AS sessions,
         COALESCE(SUM(edit_turns), 0)::int AS edit_turns,
         COALESCE(SUM(retry_turns), 0)::int AS retry_turns
       FROM session_metrics
       WHERE team_id = $1
         AND last_request_at >= NOW() - INTERVAL '7 days'`,
      [teamId],
    );
    const oneShotEditTurns = Number(oneShotRow?.edit_turns ?? 0);
    const oneShotRetryTurns = Number(oneShotRow?.retry_turns ?? 0);
    const oneShotRate = oneShotEditTurns > 0
      ? (oneShotEditTurns - oneShotRetryTurns) / oneShotEditTurns
      : null;

    // Optimize health grade (LAY-315). Weighted finding count: high=3,
    // medium=1, low=0.5. >=8 → F, >=5 → D, >=3 → C, >=1 → B, else A.
    const { rows: findingsRows } = await pool.query(
      `SELECT severity, COUNT(*)::int AS count, COALESCE(SUM(estimated_savings_microcents), 0)::bigint AS savings
       FROM optimize_findings
       WHERE team_id = $1 AND status = 'open'
       GROUP BY severity`,
      [teamId],
    );
    const counts: Record<string, number> = { high: 0, medium: 0, low: 0 };
    let openSavings = BigInt(0);
    for (const row of findingsRows) {
      counts[row.severity as string] = row.count;
      openSavings += BigInt(row.savings);
    }
    const weighted = counts.high * 3 + counts.medium * 1 + counts.low * 0.5;
    const healthGrade = weighted >= 8 ? 'F' : weighted >= 5 ? 'D' : weighted >= 3 ? 'C' : weighted >= 1 ? 'B' : 'A';
    const totalFindings = counts.high + counts.medium + counts.low;

    // Budget tile (LAY-317). Pull cap + month-to-date spend; project EOM
    // linearly from days elapsed in the calendar month.
    const { rows: budgetRows } = await pool.query(
      `SELECT monthly_usd_cap, alert_at_pct, hard_cap_action
       FROM team_budgets WHERE team_id = $1`,
      [teamId],
    );
    let budget: {
      monthly_usd_cap: number;
      spend_to_date_usd: number;
      projected_eom_usd: number;
      pct_used: number;
      alert_at_pct: number;
      action: 'alert' | 'throttle' | 'block';
      unknown_cost_requests: number;
      actual_costs_qualified: boolean;
    } | null = null;
    if (budgetRows[0]?.monthly_usd_cap != null) {
      const cap = Number(budgetRows[0].monthly_usd_cap);
      const { rows: spendRows } = await pool.query(
        `SELECT COALESCE(SUM(actual_cost_microcents + COALESCE(plugin_cost_microcents, 0)), 0)::bigint AS spend,
                COUNT(*) FILTER (WHERE actual_cost_known = false)::int AS unknown_cost_requests
         FROM request_logs
         WHERE team_id = $1 AND timestamp >= date_trunc('month', NOW())`,
        [teamId],
      );
      const spendMicrocents = Number(spendRows[0]?.spend ?? 0);
      const spendUsd = spendMicrocents / MICROCENTS_TO_USD;
      const now = new Date();
      const daysInMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getUTCDate();
      const dayOfMonth = now.getUTCDate();
      const daysElapsed = Math.max(1, dayOfMonth - 1 + now.getUTCHours() / 24);
      const projectedEom = (spendUsd / daysElapsed) * daysInMonth;
      budget = {
        monthly_usd_cap: cap,
        spend_to_date_usd: spendUsd,
        projected_eom_usd: projectedEom,
        pct_used: cap > 0 ? Math.min(100, (spendUsd / cap) * 100) : 0,
        alert_at_pct: budgetRows[0].alert_at_pct as number,
        action: budgetRows[0].hard_cap_action as 'alert' | 'throttle' | 'block',
        unknown_cost_requests: Number(spendRows[0]?.unknown_cost_requests ?? 0),
        actual_costs_qualified: Number(spendRows[0]?.unknown_cost_requests ?? 0) === 0,
      };
    }

    return {
      data: {
        summary: {
        total_requests: summary.total_requests,
        total_cost_usd: Math.round(totalBilledSpendUsd * 100) / 100,
        total_billed_spend_usd: Math.round(totalBilledSpendUsd * 100) / 100,
        total_routing_cost_usd: Math.round(totalRoutingCostUsd * 100) / 100,
        total_savings_usd: Math.round(totalSavingsUsd * 100) / 100,
        total_routing_savings_usd: Math.round(totalSavingsUsd * 100) / 100,
        unknown_cost_requests: Number(summary.unknown_cost_requests ?? 0),
        actual_costs_qualified: Number(summary.unknown_cost_requests ?? 0) === 0,
        savings_percent: savingsPercent,
        avg_latency_ms: summary.avg_latency_ms,
        error_rate: Number(summary.error_rate),
        cache_hits: summary.cache_hits,
        active_keys: activeKeys,
        active_rules: activeRules,
        top_category: topCategory ? { category: topCategory.category as string, requests: topCategory.requests as number } : null,
        one_shot: {
          rate: oneShotRate,
          edit_turns: oneShotEditTurns,
          sessions: Number(oneShotRow?.sessions ?? 0),
        },
        health: {
          grade: healthGrade,
          findings: totalFindings,
          potential_savings_usd: Math.round(Number(openSavings) / MICROCENTS_TO_USD),
        },
        budget,
        },
        timeseries,
        setup: {
          workspace_id: teamId,
          billing_mode: billingMode as 'subscription' | 'credits',
          has_api_key: activeKeys > 0,
          has_model_access: hasModelAccess,
          has_traffic: Boolean(trafficResult.rows[0]?.has_traffic),
          can_manage: !demo && hasRole(member.role, 'admin'),
          demo,
        },
      },
      error: null,
    };
  } catch {
    return {
      data: null,
      error: 'Unable to load overview metrics. Check the dashboard database connection and try again.',
    };
  }
}

export default async function OverviewPage() {
  const result = await getOverviewData();
  const data = result.data;
  const loadError = result.error;
  const s = data?.summary;

  const isEmpty = !loadError && (!data || s?.total_requests === 0);

  // LAY-317: surface a banner once month-to-date spend crosses the
  // alert_at_pct threshold. Hidden when no cap is set.
  const budget = s?.budget ?? null;
  const showBudgetBanner =
    budget != null && budget.pct_used >= budget.alert_at_pct;

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-3xl font-bold text-white">Overview</h2>
        <p className="mt-1 text-neutral-400">Your LLM proxy at a glance.</p>
      </div>

      {showBudgetBanner && budget && (
        <div
          className={`rounded-xl border px-4 py-3 text-sm ${
            budget.pct_used >= 100
              ? 'border-red-500/30 bg-red-500/10 text-red-300'
              : 'border-amber-500/30 bg-amber-500/10 text-amber-300'
          }`}
        >
          <p className="font-medium">
            {budget.pct_used >= 100
              ? `Monthly budget exceeded — $${budget.spend_to_date_usd.toFixed(0)} of $${budget.monthly_usd_cap.toFixed(0)} (${Math.round(budget.pct_used)}%).`
              : `Approaching budget cap — $${budget.spend_to_date_usd.toFixed(0)} of $${budget.monthly_usd_cap.toFixed(0)} (${Math.round(budget.pct_used)}%).`}
            {' '}
            <Link href="/billing" className="underline hover:opacity-80">
              Adjust in Billing
            </Link>
          </p>
        </div>
      )}

      {loadError ? (
        <div className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-5 py-4 text-sm text-red-300">
          <p className="font-medium">Overview metrics could not be loaded.</p>
          <p className="mt-1 text-red-300/80">{loadError}</p>
        </div>
      ) : isEmpty ? (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] py-16 text-center">
          <div className="flex justify-center mb-4">
            <Activity className="h-10 w-10 text-neutral-600" />
          </div>
          <h3 className="text-lg font-semibold text-white mb-2">No requests yet</h3>
          <p className="text-sm text-neutral-500 max-w-md mx-auto mb-6">
            Point your application at RouteShift to start tracking costs and savings.
          </p>
          <OverviewChecklist
            hasApiKey={data?.setup.has_api_key ?? false}
            hasModelAccess={data?.setup.has_model_access ?? false}
            hasTraffic={data?.setup.has_traffic ?? ((s?.total_requests ?? 0) > 0)}
            canManage={data?.setup.can_manage ?? false}
          />
          <OverviewQuickStart
            autoOpen={Boolean(data && !data.setup.demo && !data.setup.has_traffic)}
            billingMode={data?.setup.billing_mode ?? 'subscription'}
            hasApiKey={data?.setup.has_api_key ?? false}
            hasModelAccess={data?.setup.has_model_access ?? false}
            canManage={data?.setup.can_manage ?? false}
            workspaceId={data?.setup.workspace_id ?? 'unavailable'}
          />
        </div>
      ) : (
        <>
          {s && <CostQualificationNotice unknownCostRequests={s.unknown_cost_requests} />}
          {/* KPI Cards */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            <Link href="/activity" className="block">
              <KpiCard
                title="Total Requests"
                value={s ? s.total_requests.toLocaleString() : '---'}
                subtitle="Last 7 days"
              />
            </Link>
            <KpiCard
              title="Total Billed Spend"
              value={s ? `$${s.total_billed_spend_usd.toFixed(2)}` : '---'}
              subtitle="Last 7 days"
            />
            <Link href="/savings" className="block">
              <KpiCard
                title="Routing Savings"
                value={s ? `$${s.total_routing_savings_usd.toFixed(2)}` : '---'}
                subtitle={s ? `${s.savings_percent}% routing reduction` : undefined}
              />
            </Link>
            <Link href="/analytics" className="block">
              <KpiCard
                title="Avg Latency"
                value={s ? `${s.avg_latency_ms}ms` : '---'}
                subtitle="Across all providers"
              />
            </Link>
            <Link href="/activity" className="block">
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-5 transition-all duration-300 hover:border-white/[0.1]">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-neutral-500">Cache Hits</p>
                  <Zap className="h-4 w-4 text-neutral-600" />
                </div>
                <div className="mt-2 text-2xl font-bold text-white">{s?.cache_hits ?? 0}</div>
                <p className="mt-1 text-xs text-neutral-500">
                  {s && s.total_requests > 0
                    ? `${Math.round((s.cache_hits / s.total_requests) * 100)}% hit rate`
                    : 'Last 7 days'}
                </p>
              </div>
            </Link>
            <Link href="/billing" className="block">
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-5 transition-all duration-300 hover:border-white/[0.1]">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-neutral-500">Budget</p>
                  <Wallet className="h-4 w-4 text-neutral-600" />
                </div>
                {budget ? (
                  <>
                    <div className={`mt-2 text-2xl font-bold ${
                      budget.pct_used >= 95 ? 'text-red-400'
                        : budget.pct_used >= 70 ? 'text-amber-400'
                        : 'text-emerald-400'
                    }`}>
                      {Math.round(budget.pct_used)}%
                    </div>
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
                      <div
                        className={`h-full transition-all duration-500 ${
                          budget.pct_used >= 95 ? 'bg-red-500'
                            : budget.pct_used >= 70 ? 'bg-amber-500'
                            : 'bg-emerald-500'
                        }`}
                        style={{ width: `${Math.min(100, budget.pct_used)}%` }}
                      />
                    </div>
                    <p className="mt-2 text-xs text-neutral-500">
                      ${budget.spend_to_date_usd.toFixed(0)} of ${budget.monthly_usd_cap.toFixed(0)} · projected ${budget.projected_eom_usd.toFixed(0)}
                    </p>
                    {budget.actual_costs_qualified === false && (
                      <p className="mt-1 text-xs text-amber-200">
                        Observed lower bound; {budget.unknown_cost_requests} request{budget.unknown_cost_requests === 1 ? '' : 's'} have unknown historical cost.
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    <div className="mt-2 text-2xl font-bold text-neutral-500">—</div>
                    <p className="mt-1 text-xs text-neutral-500">No cap set</p>
                  </>
                )}
              </div>
            </Link>
            <Link href="/optimize" className="block">
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-5 transition-all duration-300 hover:border-white/[0.1]">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-neutral-500">Health</p>
                  <Sparkles className="h-4 w-4 text-neutral-600" />
                </div>
                <div className={`mt-2 text-2xl font-bold ${gradeColor(s?.health?.grade)}`}>
                  {s?.health?.grade ?? '—'}
                </div>
                <p className="mt-1 text-xs text-neutral-500">
                  {s?.health
                    ? s.health.findings === 0
                      ? 'No findings'
                      : `${s.health.findings} finding${s.health.findings === 1 ? '' : 's'} · $${s.health.potential_savings_usd.toLocaleString()}/mo potential`
                    : 'Optimize scan'}
                </p>
              </div>
            </Link>
            <Link href="/keys" className="block">
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-5 transition-all duration-300 hover:border-white/[0.1]">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-neutral-500">Active Keys</p>
                  <Key className="h-4 w-4 text-neutral-600" />
                </div>
                <div className="mt-2 text-2xl font-bold text-white">{s?.active_keys ?? 0}</div>
              </div>
            </Link>
            <Link href="/routing" className="block">
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-5 transition-all duration-300 hover:border-white/[0.1]">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-neutral-500">Active Rules</p>
                  <GitBranch className="h-4 w-4 text-neutral-600" />
                </div>
                <div className="mt-2 text-2xl font-bold text-white">{s?.active_rules ?? 0}</div>
              </div>
            </Link>
            <Link href="/usage" className="block">
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-5 transition-all duration-300 hover:border-white/[0.1]">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-neutral-500">Top Activity</p>
                  <Sparkles className="h-4 w-4 text-neutral-600" />
                </div>
                {s?.top_category ? (
                  <>
                    <div className="mt-2 flex items-center gap-2 text-2xl font-bold text-white">
                      <span className={`inline-block h-2 w-2 rounded-full ${categoryColor(s.top_category.category)}`} />
                      {categoryLabel(s.top_category.category)}
                    </div>
                    <p className="mt-1 text-xs text-neutral-500">
                      {s.top_category.requests.toLocaleString()} requests · last 7 days
                    </p>
                  </>
                ) : (
                  <>
                    <div className="mt-2 text-2xl font-bold text-neutral-500">—</div>
                    <p className="mt-1 text-xs text-neutral-500">No categorized traffic yet</p>
                  </>
                )}
              </div>
            </Link>
            <Link href="/analytics" className="block">
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-5 transition-all duration-300 hover:border-white/[0.1]">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-neutral-500">One-shot Rate</p>
                  <Target className="h-4 w-4 text-neutral-600" />
                </div>
                {s?.one_shot.rate != null ? (
                  <>
                    <div className="mt-2 text-2xl font-bold text-white">
                      {Math.round(s.one_shot.rate * 100)}%
                    </div>
                    <p className="mt-1 text-xs text-neutral-500">
                      {s.one_shot.edit_turns.toLocaleString()} edit turns · {s.one_shot.sessions} sessions
                    </p>
                  </>
                ) : (
                  <>
                    <div className="mt-2 text-2xl font-bold text-neutral-500">—</div>
                    <p className="mt-1 text-xs text-neutral-500">No closed sessions yet</p>
                  </>
                )}
              </div>
            </Link>
          </div>

          {/* Request Volume Chart */}
          <div>
            <h3 className="mb-4 text-lg font-semibold text-white">Request Volume</h3>
            <VolumeChart data={data?.timeseries ?? []} />
          </div>
        </>
      )}
    </div>
  );
}
