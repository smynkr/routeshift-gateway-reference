// LAY-348: GET/PATCH /api/team/rate-limits — proxy thin-wrapper for the
// workspace TPM cap. Settings → Team rate limits drives this.

import { NextResponse } from 'next/server';
import { hasRole, requireTeamMembership } from '@/lib/rbac';
import { PROXY_URL, adminHeaders, assertAdminSecret } from '@/lib/proxy';
import { isDemoActive } from '@/lib/demo';
import { DEMO_TEAM_ID } from '@/lib/demo-constants';
import { getPool } from '@/lib/db';

async function getTeamContext() {
  const member = await requireTeamMembership();
  if (!member) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) } as const;
  }
  return { teamId: member.teamId, role: member.role } as const;
}

export async function GET() {
  try {
    if (await isDemoActive()) {
      // Demo mode: return the seeded demo team's tpm_limit directly, mirroring
      // the proxy's { tpm_limit: number | null } shape. Fall back to a sane
      // static demo value if the column is unset.
      const { rows } = await getPool().query<{ tpm_limit: number | null }>(
        `SELECT tpm_limit FROM teams WHERE id = $1`,
        [DEMO_TEAM_ID],
      );
      const tpm_limit = rows[0]?.tpm_limit ?? 2_000_000;
      return NextResponse.json({ tpm_limit }, { status: 200 });
    }

    const ctx = await getTeamContext();
    if ('error' in ctx) return ctx.error;
    assertAdminSecret();
    const res = await fetch(
      `${PROXY_URL}/admin/team/rate-limits?team_id=${encodeURIComponent(ctx.teamId)}`,
      { headers: adminHeaders(), cache: 'no-store' },
    );
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (err) {
    console.error('Failed to fetch team rate limits from proxy:', err);
    return NextResponse.json({ error: { message: 'Proxy unavailable' } }, { status: 502 });
  }
}

export async function PATCH(request: Request) {
  try {
    if (await isDemoActive()) {
      // Demo mode: rate-limit changes are inert — never call the proxy.
      return NextResponse.json(
        { error: { message: 'Rate limits are read-only in demo mode.' } },
        { status: 403 },
      );
    }
    const ctx = await getTeamContext();
    if ('error' in ctx) return ctx.error;
    if (!hasRole(ctx.role, 'admin')) {
      return NextResponse.json({ error: 'Admin role required' }, { status: 403 });
    }
    assertAdminSecret();
    const body = await request.json().catch(() => null);
    const res = await fetch(
      `${PROXY_URL}/admin/team/rate-limits?team_id=${encodeURIComponent(ctx.teamId)}`,
      {
        method: 'PATCH',
        headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (err) {
    console.error('Failed to update team rate limits via proxy:', err);
    return NextResponse.json({ error: { message: 'Proxy unavailable' } }, { status: 502 });
  }
}
