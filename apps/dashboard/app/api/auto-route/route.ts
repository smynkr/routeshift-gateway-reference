import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { requireRole, requireTeamMembership } from '@/lib/rbac';
import { DEMO_WRITE_BLOCKED_MESSAGE, getEffectiveTeamId, isDemoActive } from '@/lib/demo';
import { PROXY_URL, adminHeaders } from '@/lib/proxy';
import { readJsonObject } from '@/lib/request-json';

export async function GET() {
  try {
    const member = await requireTeamMembership();
    if (!member) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const teamId = (await getEffectiveTeamId(member.teamId)) as string;
    const pool = getPool();

    const { rows } = await pool.query(
      `SELECT enabled, strategy, max_fallbacks, quality_derank FROM team_auto_route_settings WHERE team_id = $1`,
      [teamId],
    );

    if (rows.length === 0) {
      return NextResponse.json({ enabled: false, strategy: 'balanced', max_fallbacks: 2, quality_derank: false });
    }

    return NextResponse.json(rows[0]);
  } catch (err) {
    console.error('Auto-route fetch failed:', err);
    return NextResponse.json({ error: 'Failed to fetch settings' }, { status: 500 });
  }
}

async function invalidateProxyAutoRouteCache(teamId: string): Promise<void> {
  const res = await fetch(`${PROXY_URL}/admin/auto-route/invalidate`, {
    method: 'POST',
    headers: adminHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ team_id: teamId }),
  });
  if (!res.ok) {
    throw new Error(`proxy auto-route invalidation failed: ${res.status}`);
  }
}

export async function POST(request: Request) {
  try {
    if (await isDemoActive()) {
      return NextResponse.json({ error: DEMO_WRITE_BLOCKED_MESSAGE }, { status: 403 });
    }
    const user = await requireRole('admin');
    if (!user) {
      return NextResponse.json({ error: 'Admin role required' }, { status: 403 });
    }

    const teamId = user.teamId;
    const body = await readJsonObject(request);
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const enabled = Boolean(body.enabled);
    const strategy = body.strategy === undefined ? 'balanced' : body.strategy;
    if (strategy !== 'cheapest' && strategy !== 'fastest' && strategy !== 'balanced') {
      return NextResponse.json(
        { error: 'strategy must be cheapest, fastest, or balanced' },
        { status: 400 },
      );
    }
    const maxFallbacks = body.max_fallbacks === undefined ? 2 : body.max_fallbacks;
    if (
      typeof maxFallbacks !== 'number'
      || !Number.isInteger(maxFallbacks)
      || maxFallbacks < 0
      || maxFallbacks > 5
    ) {
      return NextResponse.json(
        { error: 'max_fallbacks must be an integer between 0 and 5' },
        { status: 400 },
      );
    }

    const pool = getPool();
    // RSH-136: quality_derank is preserved when the client does not send it
    // (undefined OR explicit JSON null = "not provided"; older clients / the
    // current form do not carry the field). NOTE: the preserve must reference
    // $5 directly in the DO UPDATE SET — COALESCEing $5 to false inside
    // VALUES would make EXCLUDED.quality_derank false and silently reset the
    // opt-in flag on every legacy save. Only a literal boolean is accepted:
    // any other value preserves the existing flag rather than silently
    // disabling an opt-in.
    const qualityDerank = body.quality_derank === true || body.quality_derank === false
      ? body.quality_derank
      : null;
    await pool.query(
      `INSERT INTO team_auto_route_settings (team_id, enabled, strategy, max_fallbacks, quality_derank, updated_at)
       VALUES ($1, $2, $3, $4, COALESCE($5, false), now())
       ON CONFLICT (team_id) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         strategy = EXCLUDED.strategy,
         max_fallbacks = EXCLUDED.max_fallbacks,
         quality_derank = COALESCE($5, team_auto_route_settings.quality_derank),
         updated_at = now()`,
      [teamId, enabled, strategy, maxFallbacks, qualityDerank],
    );
    // Return the EFFECTIVE flag (preserved value when the client omitted it)
    // so the response is truthful for every caller.
    const { rows: stored } = await pool.query<{ quality_derank: boolean }>(
      'SELECT quality_derank FROM team_auto_route_settings WHERE team_id = $1',
      [teamId],
    );
    const effectiveQualityDerank = stored[0]?.quality_derank === true;

    try {
      await invalidateProxyAutoRouteCache(teamId);
    } catch (err) {
      console.error('Auto-route proxy cache invalidation failed:', err);
      return NextResponse.json({
        success: true,
        enabled,
        strategy,
        max_fallbacks: maxFallbacks,
        quality_derank: effectiveQualityDerank,
        proxy_cache_invalidated: false,
        proxy_cache_error: 'proxy_cache_invalidation_failed',
        cache_ttl_seconds: 30,
      });
    }

    return NextResponse.json({
      success: true,
      enabled,
      strategy,
      max_fallbacks: maxFallbacks,
      quality_derank: effectiveQualityDerank,
      proxy_cache_invalidated: true,
    });
  } catch (err) {
    console.error('Auto-route update failed:', err);
    return NextResponse.json({ error: 'Failed to update settings' }, { status: 500 });
  }
}
