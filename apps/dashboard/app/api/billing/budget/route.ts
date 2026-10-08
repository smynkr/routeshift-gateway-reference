// RSH-138: per-team daily/weekly/monthly budget settings + live status.
//
// GET — three UTC windows with cap, committed spend, status, reset time,
//       unknown-cost count, and qualification. Never cached.
// PUT — partial upsert of daily/weekly/monthly caps plus alert_at_pct and
//       hard_cap_action. Omitted fields are preserved; an explicit null clears
//       exactly that cap. Cap values are validated exactly (microcents) before
//       any SQL.

import { NextResponse } from 'next/server';
import { requireRole, requireTeamMembership } from '@/lib/rbac';
import { getPool } from '@/lib/db';
import { DEMO_WRITE_BLOCKED_MESSAGE, getEffectiveTeamId, isDemoActive } from '@/lib/demo';
import { readJsonObject } from '@/lib/request-json';
import { parseBudgetCapFields } from '@/lib/budget-input';
import { loadBudgetReport } from '@/lib/budget-report';

export async function GET() {
  try {
    const member = await requireTeamMembership();
    if (!member) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const teamId = (await getEffectiveTeamId(member.teamId)) as string;
    const [report, { rows: configRows }] = await Promise.all([
      loadBudgetReport(teamId),
      getPool().query<{ alert_at_pct: number | null; hard_cap_action: string | null }>(
        'SELECT alert_at_pct, hard_cap_action FROM team_budgets WHERE team_id = $1',
        [teamId],
      ),
    ]);
    const config = configRows[0] ?? null;
    const response = NextResponse.json({
      ...report,
      alert_at_pct: config?.alert_at_pct ?? 80,
      hard_cap_action: config?.hard_cap_action ?? 'alert',
    });
    response.headers.set('Cache-Control', 'no-store');
    return response;
  } catch (err) {
    console.error('budget GET error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    if (await isDemoActive()) {
      return NextResponse.json({ error: DEMO_WRITE_BLOCKED_MESSAGE }, { status: 403 });
    }
    const member = await requireRole('admin');
    if (!member) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const teamId = member.teamId;

    const body = await readJsonObject(request);
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const caps = parseBudgetCapFields(body);

    const alertAtPct = body.alert_at_pct;
    if (
      alertAtPct != null
      && (typeof alertAtPct !== 'number' || !Number.isFinite(alertAtPct) || alertAtPct < 0 || alertAtPct > 100)
    ) {
      return NextResponse.json({ error: 'alert_at_pct must be 0–100' }, { status: 400 });
    }
    const hardCapAction = body.hard_cap_action;
    if (hardCapAction != null && !['alert', 'throttle', 'block'].includes(String(hardCapAction))) {
      return NextResponse.json({ error: 'hard_cap_action must be alert|throttle|block' }, { status: 400 });
    }

    const pool = getPool();
    const capColumns = ['daily_usd_cap', 'weekly_usd_cap', 'monthly_usd_cap'] as const;
    const params: unknown[] = [teamId];
    const setExprs: string[] = [];
    for (const column of capColumns) {
      // $n+1 = supplied flag, $n+2 = value (microcents or null to clear)
      // The columns store USD decimals (numeric(20,8)); validation happens in
      // exact microcents, persistence is the USD spelling.
      const microcents = (caps as Record<string, { microcents: number | null } | undefined>)[column]?.microcents;
      params.push(column in body, microcents != null ? microcents / 100_000_000 : null);
      setExprs.push(`${column} = CASE WHEN $${params.length - 1} THEN $${params.length} ELSE team_budgets.${column} END`);
    }
    params.push(alertAtPct ?? null, hardCapAction ?? null);
    // $3/$5/$7 are the cap VALUES (the INSERT branch); $2/$4/$6 are the
    // supplied flags consumed by the ON CONFLICT branch.
    await pool.query(
      `
      INSERT INTO team_budgets (team_id, daily_usd_cap, weekly_usd_cap, monthly_usd_cap, alert_at_pct, hard_cap_action, updated_at)
      VALUES ($1, $3, $5, $7, COALESCE($8, 80), COALESCE($9, 'alert'), NOW())
      ON CONFLICT (team_id) DO UPDATE SET
        ${setExprs.join(',\n        ')},
        alert_at_pct = COALESCE($8, team_budgets.alert_at_pct),
        hard_cap_action = COALESCE($9, team_budgets.hard_cap_action),
        updated_at = NOW()
      `,
      params,
    );

    const report = await loadBudgetReport(teamId);
    const response = NextResponse.json(report);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  } catch (err) {
    console.error('budget PUT error:', err);
    if (err instanceof Error && err.message.includes('must be a non-negative number')) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
