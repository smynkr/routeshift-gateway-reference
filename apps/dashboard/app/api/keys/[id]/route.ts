import { NextResponse } from 'next/server';
import { PROXY_URL, adminHeaders, assertAdminSecret } from '@/lib/proxy';
import { requireRole } from '@/lib/rbac';
import { DEMO_WRITE_BLOCKED_MESSAGE, isDemoActive } from '@/lib/demo';

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
    // Encode id + build the query with URLSearchParams so a crafted id can't
    // inject its own team_id ahead of the trusted one (query-param pollution).
    // LAY-331: actor user id flows through the URL since DELETE has no body.
    const query = new URLSearchParams({ team_id: teamId });
    if (typeof user.userId === 'string') query.set('actor_user_id', user.userId);
    const res = await fetch(
      `${PROXY_URL}/admin/keys/${encodeURIComponent(id)}?${query.toString()}`,
      { method: 'DELETE', headers: adminHeaders() },
    );
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (err) {
    console.error('Failed to delete key via proxy:', err);
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
    // LAY-331: actor flows through the body on PATCH (unlike DELETE's query)
    // so UI edits record WHO changed the key in the audit trail. NEVER trust
    // a client-supplied actor_user_id — strip it, then inject the
    // session-derived user (a forged actor on policy edits would corrupt the
    // audit trail). Primitives/null bodies are forwarded verbatim so the
    // proxy's own validation produces the deterministic 400 (mutating a
    // primitive would TypeError into a 502 here).
    if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
      delete body.actor_user_id;
      if (typeof user.userId === 'string') body.actor_user_id = user.userId;
    }
    const res = await fetch(`${PROXY_URL}/admin/keys/${encodeURIComponent(id)}?team_id=${encodeURIComponent(teamId)}`, {
      method: 'PATCH',
      headers: adminHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (err) {
    console.error('Failed to update key via proxy:', err);
    return NextResponse.json({ error: { message: 'Proxy unavailable' } }, { status: 502 });
  }
}
