import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/rbac';
import { getPool } from '@/lib/db';
import { DEMO_WRITE_BLOCKED_MESSAGE, isDemoActive } from '@/lib/demo';
import { PROXY_URL, adminHeaders, assertAdminSecret } from '@/lib/proxy';
import { decryptProviderKey } from '@/lib/crypto';
import { classifyEnvelope, isEncryptionScheme } from '@routeshift/shared/provider-key-envelope';

const VALID_MODES = ['subscription', 'credits'];

export async function PATCH(request: Request) {
  try {
    if (await isDemoActive()) {
      return NextResponse.json({ error: { message: DEMO_WRITE_BLOCKED_MESSAGE } }, { status: 403 });
    }
    const user = await requireRole('owner');
    if (!user) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    let body: any;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { mode } = body;

    if (!mode || !VALID_MODES.includes(mode)) {
      return NextResponse.json(
        { error: { message: `Invalid mode. Must be one of: ${VALID_MODES.join(', ')}` } },
        { status: 400 },
      );
    }

    const pool = getPool();

    if (mode === 'credits') {
      // Check team has a live paid subscription (not 'free', not canceled).
      // Stripe cancellation keeps the row with status='canceled' and the
      // prior paid plan — without the status check, a team with a historical
      // canceled sub could switch to credits mode without a current paid
      // subscription.
      const { rows: subs } = await pool.query(
        `SELECT id FROM subscriptions
          WHERE team_id = $1 AND plan != 'free'
            AND status IN ('active', 'trialing', 'past_due')
          LIMIT 1`,
        [user.teamId],
      );
      if (subs.length === 0) {
        return NextResponse.json(
          { error: { message: 'A paid subscription plan is required to switch to credits mode' } },
          { status: 400 },
        );
      }
    }

    if (mode === 'subscription') {
      // Check the team has at least one usable BYOK credential. Disabled or
      // blank rows cannot make subscription mode dispatch-ready.
      const { rows: keys } = await pool.query<{ encrypted_key: string; encryption_scheme: string | null }>(
        `SELECT encrypted_key, encryption_scheme FROM provider_keys
          WHERE team_id = $1 AND enabled = true AND encrypted_key <> ''
          ORDER BY updated_at DESC`,
        [user.teamId],
      );
      let hasUsableKey = false;
      for (const row of keys) {
        try {
          const classifiedScheme = classifyEnvelope(row.encrypted_key);
          const declaredScheme = row.encryption_scheme ?? null;
          if (declaredScheme !== null && !isEncryptionScheme(declaredScheme)) {
            continue;
          }
          if (declaredScheme !== null && declaredScheme !== classifiedScheme) {
            continue;
          }
          if ((await decryptProviderKey(row.encrypted_key)).trim()) {
            hasUsableKey = true;
            break;
          }
        } catch {
          // A key that cannot be decrypted is not dispatch-ready. Keep looking
          // in case another enabled provider key is usable.
        }
      }
      if (!hasUsableKey) {
        return NextResponse.json(
          { error: { message: 'At least one usable provider key is required to switch to subscription mode' } },
          { status: 400 },
        );
      }
    }

    await pool.query('UPDATE teams SET billing_mode = $1 WHERE id = $2', [mode, user.teamId]);

    // Bust the proxy's 60s billingModeCache so mode flips take effect within
    // one request instead of briefly charging/enforcing under the prior mode.
    try {
      assertAdminSecret();
      await fetch(`${PROXY_URL}/admin/billing-mode/invalidate`, {
        method: 'POST',
        headers: adminHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ team_id: user.teamId }),
      });
    } catch (err) {
      // Non-fatal: the 60s TTL is the multi-instance fallback.
      console.warn('billing-mode cache invalidation failed (non-fatal):', err);
    }

    return NextResponse.json({ success: true, mode });
  } catch (err) {
    console.error('Failed to update billing mode:', err);
    return NextResponse.json({ error: { message: 'Internal server error' } }, { status: 500 });
  }
}
