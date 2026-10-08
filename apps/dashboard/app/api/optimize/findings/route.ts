// LAY-315: optimize findings API.
// GET /api/optimize/findings — list open findings for the team, ranked by
//   severity then estimated savings.
// PATCH /api/optimize/findings/{id} on the same path — body { status:
//   'dismissed' } lets a user hide a finding they've intentionally chosen
//   to ignore. (We support PATCH on the collection with id in the body
//   to keep it as one route file; the engine never re-opens dismissed
//   findings via UPSERT logic.)

import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { DEMO_WRITE_BLOCKED_MESSAGE, getEffectiveTeamId, isDemoActive } from '@/lib/demo';
import { requireRole, requireTeamMembership } from '@/lib/rbac';

const SEVERITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

export async function GET() {
  try {
    const member = await requireTeamMembership();
    if (!member) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const teamId = await getEffectiveTeamId(member.teamId);
    if (!teamId) return NextResponse.json({ error: 'No team context' }, { status: 403 });

    const pool = getPool();
    const { rows } = await pool.query(
      `
      SELECT id, rule_id, severity, estimated_savings_microcents,
             body_md, fix_md, status, first_seen_at, last_seen_at
      FROM optimize_findings
      WHERE team_id = $1 AND status = 'open'
      ORDER BY last_seen_at DESC
      `,
      [teamId],
    );

    const findings = rows
      .map((row) => ({
        id: row.id as string,
        rule_id: row.rule_id as string,
        severity: row.severity as 'high' | 'medium' | 'low',
        estimated_savings_microcents: Number(row.estimated_savings_microcents),
        body_md: row.body_md as string,
        fix_md: row.fix_md as string,
        first_seen_at: row.first_seen_at as Date,
        last_seen_at: row.last_seen_at as Date,
      }))
      .sort((a, b) => {
        const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
        if (sev !== 0) return sev;
        return b.estimated_savings_microcents - a.estimated_savings_microcents;
      });

    const totalSavings = findings.reduce(
      (s, f) => s + f.estimated_savings_microcents,
      0,
    );

    return NextResponse.json({ findings, total_estimated_savings_microcents: totalSavings });
  } catch (err) {
    console.error('optimize findings GET error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    if (await isDemoActive()) {
      return NextResponse.json({ error: DEMO_WRITE_BLOCKED_MESSAGE }, { status: 403 });
    }
    // Dismissing a finding is a team-wide, irreversible mutation (the engine
    // never re-opens a dismissed finding, and there is no un-dismiss path), so
    // gate it on admin like every other team-state write (keys, rules, billing,
    // rate limits). GET stays open to any member — reads are unrestricted.
    const member = await requireRole('admin');
    if (!member) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const teamId = member.teamId;
    if (!teamId) return NextResponse.json({ error: 'No team context' }, { status: 403 });

    const body = (await request.json()) as { id?: string; status?: string };
    if (!body.id || body.status !== 'dismissed') {
      return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
    }

    const pool = getPool();
    const result = await pool.query(
      `
      UPDATE optimize_findings
      SET status = 'dismissed', resolved_at = NOW()
      WHERE id = $1 AND team_id = $2
      RETURNING id
      `,
      [body.id, teamId],
    );

    if (result.rowCount === 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('optimize findings PATCH error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
