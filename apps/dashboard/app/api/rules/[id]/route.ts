import { NextResponse } from 'next/server';
import { PROXY_URL, adminHeaders, assertAdminSecret } from '@/lib/proxy';
import { requireRole } from '@/lib/rbac';
import { DEMO_TEAM_ID } from '@/lib/demo-constants';
import { DEMO_WRITE_BLOCKED_MESSAGE, isDemoActive } from '@/lib/demo';
import { getPool } from '@/lib/db';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (await isDemoActive()) {
      // Demo mode: read the seeded routing_rules row directly (mirrors the
      // proxy GET /admin/rules array shape).
      const { rows } = await getPool().query(
        `SELECT id, team_id, name, description, priority, enabled, condition, action,
                created_at, updated_at
           FROM routing_rules
          WHERE id = $1 AND (team_id = $2 OR team_id = '*')`,
        [id, DEMO_TEAM_ID],
      );
      if (rows.length === 0) {
        return NextResponse.json({ error: { message: 'Rule not found' } }, { status: 404 });
      }
      return NextResponse.json(rows[0], { status: 200 });
    }

    const user = await requireRole('admin');
    if (!user) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    assertAdminSecret();
    // The proxy exposes no GET-by-id; list the team's rules and pick the id.
    const teamId = user.teamId;
    const res = await fetch(`${PROXY_URL}/admin/rules?team_id=${encodeURIComponent(teamId)}`, { headers: adminHeaders() });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return NextResponse.json(data, { status: res.status });
    }
    const rules = await res.json();
    const rule = Array.isArray(rules) ? rules.find((r: any) => r.id === id) : undefined;
    // Defensive: only the team's own rows (or global '*', shown read-only)
    // may be read — never a cross-team row even if the proxy misbehaved.
    if (!rule || (rule.team_id !== teamId && rule.team_id !== '*')) {
      return NextResponse.json({ error: { message: 'Rule not found' } }, { status: 404 });
    }
    return NextResponse.json(rule, { status: 200 });
  } catch (err) {
    console.error('Failed to fetch rule from proxy:', err);
    return NextResponse.json({ error: { message: 'Proxy unavailable' } }, { status: 502 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (await isDemoActive()) {
      return NextResponse.json({ error: { message: DEMO_WRITE_BLOCKED_MESSAGE } }, { status: 403 });
    }
    const user = await requireRole('admin');
    if (!user) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    assertAdminSecret();
    const { id } = await params;
    const teamId = user.teamId;
    const body = await request.json();
    const res = await fetch(`${PROXY_URL}/admin/rules/${encodeURIComponent(id)}?team_id=${encodeURIComponent(teamId)}`, {
      method: 'PATCH',
      headers: adminHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    console.error('Failed to update rule via proxy:', err);
    return NextResponse.json({ error: { message: 'Proxy unavailable' } }, { status: 502 });
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (await isDemoActive()) {
      return NextResponse.json({ error: { message: DEMO_WRITE_BLOCKED_MESSAGE } }, { status: 403 });
    }
    const user = await requireRole('admin');
    if (!user) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    assertAdminSecret();
    const { id } = await params;
    const teamId = user.teamId;
    const res = await fetch(`${PROXY_URL}/admin/rules/${encodeURIComponent(id)}?team_id=${encodeURIComponent(teamId)}`, { method: 'DELETE', headers: adminHeaders() });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    console.error('Failed to delete rule via proxy:', err);
    return NextResponse.json({ error: { message: 'Proxy unavailable' } }, { status: 502 });
  }
}
