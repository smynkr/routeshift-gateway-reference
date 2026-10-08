// LAY-326: extend GET to return all labeled keys per provider plus the
// team's chosen selection strategy. The legacy fields (configured /
// updated_at / metadata) stay populated from the 'default' label so the
// existing single-key UI keeps rendering without changes.

import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { redactProviderMetadata, VALID_PROVIDERS } from '@/lib/provider-metadata';
import { requireTeamMembership } from '@/lib/rbac';
import { getEffectiveTeamId } from '@/lib/demo';

interface KeyRow {
  provider: string;
  label: string;
  weight: number;
  enabled: boolean;
  updated_at: Date;
  metadata: Record<string, unknown> | null;
}

interface StrategyRow {
  provider: string;
  strategy: 'weighted_round_robin' | 'latency_based' | 'least_busy';
}

export async function GET() {
  try {
    const member = await requireTeamMembership();
    if (!member) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const teamId = (await getEffectiveTeamId(member.teamId)) as string;
    const pool = getPool();

    const [keysRes, strategiesRes] = await Promise.all([
      pool.query<KeyRow>(
        `SELECT provider, label, weight, enabled, updated_at, metadata
           FROM provider_keys
          WHERE team_id = $1
          ORDER BY provider, weight DESC, label ASC`,
        [teamId],
      ),
      pool.query<StrategyRow>(
        `SELECT provider, strategy FROM team_provider_strategies WHERE team_id = $1`,
        [teamId],
      ),
    ]);

    const keysByProvider = new Map<string, KeyRow[]>();
    for (const row of keysRes.rows) {
      const list = keysByProvider.get(row.provider) ?? [];
      list.push(row);
      keysByProvider.set(row.provider, list);
    }
    const strategyByProvider = new Map(strategiesRes.rows.map((r) => [r.provider, r.strategy]));

    // Single source of truth: the shared-derived allowlist (the hand-copied
    // listing array here drifted to 12 behind the shared 16 — keys for
    // xai/deepseek/mistral/meta could be PUT but never listed).
    const result = VALID_PROVIDERS.map((p) => {
      const keys = keysByProvider.get(p) ?? [];
      const defaultKey = keys.find((k) => k.label === 'default') ?? keys[0];
      return {
        provider: p,
        configured: keys.length > 0,
        // Legacy fields populated from the default key for backward compat.
        updated_at: defaultKey?.updated_at ?? null,
        metadata: redactProviderMetadata(defaultKey?.metadata),
        // LAY-326 additions: full keys list + strategy.
        keys: keys.map((k) => ({
          label: k.label,
          weight: k.weight,
          enabled: k.enabled,
          updated_at: k.updated_at,
          metadata: redactProviderMetadata(k.metadata),
        })),
        strategy: strategyByProvider.get(p) ?? 'weighted_round_robin',
      };
    });

    return NextResponse.json(result);
  } catch (err) {
    console.error('Failed to list provider keys:', err);
    return NextResponse.json({ error: { message: 'Internal server error' } }, { status: 500 });
  }
}
