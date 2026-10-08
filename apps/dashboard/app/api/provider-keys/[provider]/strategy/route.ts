// LAY-326: per-(team, provider) selection strategy. Mirrors the proxy's
// CHECK constraint on team_provider_strategies.strategy. Upsert because
// new providers won't have a row until the user sets one.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/rbac';
import { getPool } from '@/lib/db';
import { PROXY_URL, adminHeaders } from '@/lib/proxy';
import { DEMO_WRITE_BLOCKED_MESSAGE, isDemoActive } from '@/lib/demo';
import { isValidProvider, VALID_PROVIDERS } from '@/lib/provider-metadata';

const VALID_STRATEGIES = ['weighted_round_robin', 'latency_based', 'least_busy'] as const;
type Strategy = (typeof VALID_STRATEGIES)[number];

async function invalidateProxyCache(teamId: string, provider: string): Promise<void> {
  const res = await fetch(`${PROXY_URL}/admin/provider-keys/invalidate`, {
    method: 'POST',
    headers: adminHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ team_id: teamId, provider }),
  });
  if (!res.ok) throw new Error(`proxy provider-key invalidation failed: ${res.status}`);
}

function providerStrategyCacheLagResponse(provider: string, strategy: string) {
  return NextResponse.json({
    success: true,
    provider,
    strategy,
    proxy_cache_invalidated: false,
    proxy_cache_error: 'proxy_cache_invalidation_failed',
    cache_ttl_seconds: 300,
  });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  try {
    if (await isDemoActive()) {
      return NextResponse.json({ error: { message: DEMO_WRITE_BLOCKED_MESSAGE } }, { status: 403 });
    }
    const user = await requireRole('admin');
    if (!user) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { provider } = await params;
    if (!isValidProvider(provider)) {
      return NextResponse.json(
        { error: { message: `Invalid provider. Must be one of: ${VALID_PROVIDERS.join(', ')}` } },
        { status: 400 },
      );
    }

    const body = await request.json().catch(() => null);
    const strategy = body?.strategy as string | undefined;
    if (!strategy || !VALID_STRATEGIES.includes(strategy as Strategy)) {
      return NextResponse.json(
        { error: { message: `strategy must be one of: ${VALID_STRATEGIES.join(', ')}` } },
        { status: 400 },
      );
    }

    const pool = getPool();
    await pool.query(
      `INSERT INTO team_provider_strategies (team_id, provider, strategy)
         VALUES ($1, $2, $3)
       ON CONFLICT (team_id, provider) DO UPDATE
         SET strategy = EXCLUDED.strategy,
             updated_at = now()`,
      [user.teamId, provider, strategy],
    );

    try {
      await invalidateProxyCache(user.teamId, provider);
    } catch (err) {
      console.error('Provider key cache invalidation failed:', err);
      return providerStrategyCacheLagResponse(provider, strategy);
    }
    return NextResponse.json({ success: true, provider, strategy, proxy_cache_invalidated: true });
  } catch (err) {
    console.error('Failed to set provider key strategy:', err);
    return NextResponse.json({ error: { message: 'Internal server error' } }, { status: 500 });
  }
}
