import { NextResponse } from 'next/server';
import { PROXY_URL, adminHeaders, assertAdminSecret } from '@/lib/proxy';
import { requireRole, requireTeamMembership } from '@/lib/rbac';
import { DEMO_WRITE_BLOCKED_MESSAGE, isDemoActive } from '@/lib/demo';
import { readJsonObject } from '@/lib/request-json';

export async function GET() {
  try {
    // Re-validate team membership against team_members rather than trusting the
    // (30-day) JWT's teamId — a removed member must not keep reading team keys.
    const member = await requireTeamMembership();
    if (!member) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    assertAdminSecret();
    const teamId = member.teamId;
    const res = await fetch(`${PROXY_URL}/admin/keys?team_id=${encodeURIComponent(teamId)}`, { headers: adminHeaders() });
    const response = NextResponse.json(await res.json(), { status: res.status });
    response.headers.set('Cache-Control', 'no-store');
    return response;
  } catch (err) {
    console.error('Failed to fetch keys from proxy:', err);
    return NextResponse.json({ error: { message: 'Proxy unavailable' } }, { status: 502 });
  }
}

export async function POST(request: Request) {
  try {
    if (await isDemoActive()) {
      return NextResponse.json({ error: { message: DEMO_WRITE_BLOCKED_MESSAGE } }, { status: 403 });
    }
    const user = await requireRole('admin');
    if (!user) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    assertAdminSecret();
    const body = await readJsonObject(request);
    if (!body) {
      return NextResponse.json({ error: { message: 'Invalid JSON body' } }, { status: 400 });
    }
    // Inject the session's team_id so keys are attributed to the correct team
    body.team_id = user.teamId;
    // LAY-331: actor user id for the audit trail. Never trust a
    // client-supplied actor_user_id — strip it, then inject the session
    // user (mirrors the PATCH route's contract).
    delete body.actor_user_id;
    if (typeof user.userId === 'string') body.actor_user_id = user.userId;
    const res = await fetch(`${PROXY_URL}/admin/keys`, {
      method: 'POST',
      headers: adminHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (err) {
    console.error('Failed to create key via proxy:', err);
    return NextResponse.json({ error: { message: 'Proxy unavailable' } }, { status: 502 });
  }
}
