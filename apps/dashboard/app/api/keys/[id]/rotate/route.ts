import { NextResponse } from 'next/server';
import { PROXY_URL, adminHeaders, assertAdminSecret } from '@/lib/proxy';
import { requireRole } from '@/lib/rbac';
import { DEMO_WRITE_BLOCKED_MESSAGE, isDemoActive } from '@/lib/demo';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
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
    const body = await request.json().catch(() => ({}));
    // Encode the path id and build the query with URLSearchParams so a crafted
    // id (e.g. containing `?team_id=other&`) can't inject its own team_id ahead
    // of the trusted one and bypass the proxy's team scoping.
    const query = new URLSearchParams({ team_id: teamId });
    if (typeof user.userId === 'string') query.set('actor_user_id', user.userId);
    const res = await fetch(
      `${PROXY_URL}/admin/keys/${encodeURIComponent(id)}/rotate?${query.toString()}`,
      {
        method: 'POST',
        headers: adminHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      },
    );
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (err) {
    console.error('Failed to rotate key via proxy:', err);
    return NextResponse.json({ error: { message: 'Proxy unavailable' } }, { status: 502 });
  }
}
