import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { getEffectiveTeamId, isDemoActive } from '@/lib/demo';
import { hasRole, requireTeamMembership } from '@/lib/rbac';

export async function GET(request: NextRequest) {
  try {
    const member = await requireTeamMembership();
    if (!member) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const demoActive = await isDemoActive();
    const teamId = (await getEffectiveTeamId(member.teamId)) as string;
    const pool = getPool();

    // Run independent queries in parallel
    const [subResult, keyResult, ruleResult, teamResult, balResult, topupResult] = await Promise.all([
      pool.query(
        `SELECT id, plan, status, current_period_start, current_period_end, cancel_at_period_end
         FROM subscriptions
         WHERE team_id = $1 AND status != 'canceled'
         LIMIT 1`,
        [teamId],
      ),
      pool.query(
        'SELECT COUNT(*)::int AS count FROM api_keys WHERE team_id = $1 AND revoked_at IS NULL',
        [teamId],
      ),
      pool.query(
        'SELECT COUNT(*)::int AS count FROM routing_rules WHERE team_id = $1 AND enabled = true',
        [teamId],
      ),
      pool.query('SELECT billing_mode FROM teams WHERE id = $1', [teamId]),
      pool.query('SELECT balance_microcents FROM credit_balances WHERE team_id = $1', [teamId]),
      pool.query(
        'SELECT enabled, stripe_payment_method_id FROM auto_topup_settings WHERE team_id = $1',
        [teamId],
      ),
    ]);

    const subscription = subResult.rows[0] ?? null;
    const keys = keyResult.rows[0].count;
    const rules = ruleResult.rows[0].count;
    const teamRows = teamResult.rows;
    const balRows = balResult.rows;
    const topupRows = topupResult.rows;
    const billingMode = teamRows[0]?.billing_mode ?? 'subscription';

    // Calculate current period savings
    let periodSavingsCents = 0;
    let unknownCostRequests = 0;
    if (billingMode === 'credits') {
      const now = new Date();
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const { rows: unknownRows } = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE actual_cost_known = false)::int AS unknown_cost_requests
         FROM request_logs
         WHERE team_id = $1
           AND billing_mode = 'credits'
           AND timestamp >= $2
           AND timestamp <= $3`,
        [teamId, monthStart, now],
      );
      unknownCostRequests = Number(unknownRows[0]?.unknown_cost_requests ?? 0);
    } else if (subscription?.current_period_start && subscription?.current_period_end) {
      // LAY-345: floor at 0 to match the Stripe meter — negative savings
      // (fallback to a more expensive model, alias to a model with no
      // pricing entry) are never billed, so the dashboard shouldn't
      // surface them either. Otherwise the customer-facing number drifts
      // away from what they're charged.
      const { rows: savingsRows } = await pool.query(
        `SELECT COALESCE(SUM(GREATEST(savings_microcents, 0)) FILTER (WHERE actual_cost_known = true), 0)::bigint AS total_savings,
                COUNT(*) FILTER (WHERE actual_cost_known = false)::int AS unknown_cost_requests
         FROM request_logs
         WHERE team_id = $1
           AND billing_mode = 'subscription'
           AND timestamp >= $2
           AND timestamp <= $3`,
        [teamId, subscription.current_period_start, subscription.current_period_end],
      );
      // Convert microcents to cents (1 cent = 1_000_000 microcents)
      periodSavingsCents = Math.round(Number(savingsRows[0].total_savings) / 1_000_000);
      unknownCostRequests = Number(savingsRows[0]?.unknown_cost_requests ?? 0);
    }

    return NextResponse.json({
      subscription,
      usage: { keys, rules },
      period_savings_cents: periodSavingsCents,
      unknown_cost_requests: unknownCostRequests,
      actual_costs_qualified: unknownCostRequests === 0,
      billing_mode: billingMode,
      credit_balance_microcents: Number(balRows[0]?.balance_microcents ?? 0),
      auto_topup_enabled: Boolean(topupRows[0]?.enabled && topupRows[0]?.stripe_payment_method_id),
      demo_active: demoActive,
      can_manage_billing: !demoActive && hasRole(member.role, 'admin'),
    });
  } catch (err) {
    const isSidebarSnapshot = request.nextUrl.searchParams.get('source') === 'sidebar';
    if (isSidebarSnapshot) {
      return NextResponse.json({ error: 'billing_status_unavailable' }, { status: 503 });
    }
    console.error('Billing status fetch failed:', err);
    return NextResponse.json({ error: 'Failed to fetch billing status' }, { status: 500 });
  }
}
