// LAY-331: GET /api/keys/:id/audit — proxy thin-wrapper around the
// /admin/keys/:id/audit endpoint. Used by the /keys drawer.

import { NextResponse } from 'next/server';
import { PROXY_URL, adminHeaders, assertAdminSecret } from '@/lib/proxy';
import { requireTeamMembership } from '@/lib/rbac';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const member = await requireTeamMembership();
    if (!member) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    assertAdminSecret();
    const { id } = await params;

    const url = new URL(request.url);
    const limit = url.searchParams.get('limit') ?? '50';
    // Encode id + build the query with URLSearchParams so a crafted id can't
    // break out of the path segment and inject its own team_id ahead of the
    // trusted one (cross-tenant query-param pollution; the proxy reads the FIRST
    // team_id). Mirrors the sibling [id] and [id]/rotate routes.
    const query = new URLSearchParams({ team_id: member.teamId, limit });
    const res = await fetch(
      `${PROXY_URL}/admin/keys/${encodeURIComponent(id)}/audit?${query.toString()}`,
      { headers: adminHeaders(), cache: 'no-store' },
    );
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (err) {
    console.error('Failed to fetch key audit events from proxy:', err);
    return NextResponse.json({ error: { message: 'Proxy unavailable' } }, { status: 502 });
  }
}
