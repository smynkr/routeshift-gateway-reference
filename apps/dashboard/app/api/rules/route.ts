import { NextResponse } from 'next/server';
import { PROXY_URL, adminHeaders, assertAdminSecret } from '@/lib/proxy';
import { requireRole, requireTeamMembership } from '@/lib/rbac';
import { isDemoActive } from '@/lib/demo';
import { DEMO_TEAM_ID } from '@/lib/demo-constants';
import { getPool } from '@/lib/db';

export async function GET() {
  try {
    if (await isDemoActive()) {
      // Demo mode: read seeded routing_rules directly, mirroring the proxy's
      // GET /admin/rules array shape (team-specific + global '*', priority asc).
      const { rows } = await getPool().query(
        `SELECT id, team_id, name, description, priority, enabled, condition, action,
                created_at, updated_at
           FROM routing_rules
          WHERE (team_id = $1 OR team_id = '*')
          ORDER BY priority ASC`,
        [DEMO_TEAM_ID],
      );
      return NextResponse.json(rows, { status: 200 });
    }

    // Re-validate team membership against team_members rather than trusting the
    // (30-day) JWT's teamId — a removed member must not keep reading team rules.
    const member = await requireTeamMembership();
    if (!member) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    assertAdminSecret();
    const teamId = member.teamId;
    const res = await fetch(`${PROXY_URL}/admin/rules?team_id=${encodeURIComponent(teamId)}`, { headers: adminHeaders() });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    console.error('Failed to fetch rules from proxy:', err);
    return NextResponse.json({ error: { message: 'Proxy unavailable' } }, { status: 502 });
  }
}

export async function POST(request: Request) {
  try {
    if (await isDemoActive()) {
      // Demo mode: rule creation is inert — never call the proxy.
      return NextResponse.json(
        { error: { message: 'Rule creation is disabled in demo mode.' } },
        { status: 403 },
      );
    }
    const user = await requireRole('admin');
    if (!user) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    assertAdminSecret();
    const body = await request.json();
    // Inject the session's team_id so rules are attributed to the correct team
    body.team_id = user.teamId;
    const res = await fetch(`${PROXY_URL}/admin/rules`, {
      method: 'POST',
      headers: adminHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    console.error('Failed to create rule via proxy:', err);
    return NextResponse.json({ error: { message: 'Proxy unavailable' } }, { status: 502 });
  }
}
