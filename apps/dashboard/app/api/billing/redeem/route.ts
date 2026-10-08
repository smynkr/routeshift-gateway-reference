import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { requireRole, requireTeamMembership } from '@/lib/rbac';
import { randomUUID } from 'node:crypto';
import { DEMO_WRITE_BLOCKED_MESSAGE, isDemoActive } from '@/lib/demo';

export async function POST(request: Request) {
  try {
    if (await isDemoActive()) {
      return NextResponse.json({ error: DEMO_WRITE_BLOCKED_MESSAGE }, { status: 403 });
    }
    const member = await requireTeamMembership();
    if (!member) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Promo redemption mutates team billing state (plan + credit balance), so
    // it must be admin-gated like every other billing mutation (purchase,
    // auto-topup, budget, mode, portal) — a plain member must not be able to
    // change the team's plan or credits.
    const admin = await requireRole('admin');
    if (!admin) {
      return NextResponse.json({ error: 'Forbidden: admin role required' }, { status: 403 });
    }

    const teamId = member.teamId;
    const { code } = await request.json();

    if (!code || typeof code !== 'string') {
      return NextResponse.json({ error: 'Promo code is required' }, { status: 400 });
    }

    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Serialize all redemptions for this team. Without a real transaction the
      // earlier `FOR UPDATE` released its lock immediately (each pool.query
      // autocommits), so two concurrent redeems could both pass the checks and
      // double-credit / overrun max_uses. The advisory lock also covers the
      // first-time case where no subscription row exists yet to lock.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`promo_redeem:${teamId}`]);

      // Lock the promo code row for the duration of the transaction so
      // concurrent redemptions of the SAME code can't both pass the use check.
      const { rows: codeRows } = await client.query(
        `SELECT id, plan, credits_cents, max_uses, uses_count, expires_at
         FROM promo_codes
         WHERE code = $1
         FOR UPDATE`,
        [code.trim().toUpperCase()],
      );

      if (codeRows.length === 0) {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: 'Invalid promo code' }, { status: 400 });
      }

      const promo = codeRows[0];

      if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: 'Promo code has expired' }, { status: 400 });
      }

      if (promo.uses_count >= promo.max_uses) {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: 'Promo code has already been used' }, { status: 400 });
      }

      // Check if this team already redeemed a code (lock the row if present).
      const { rows: existingSubRows } = await client.query(
        `SELECT promo_code_id, stripe_customer_id FROM subscriptions WHERE team_id = $1 FOR UPDATE`,
        [teamId],
      );
      const existingSub = existingSubRows[0];

      if (existingSub?.promo_code_id) {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: 'Your team has already redeemed a promo code' }, { status: 400 });
      }

      // Never clobber a real Stripe-managed subscription with the 100-year promo
      // sentinel — that would desync billing and never be reconciled by Stripe
      // webhooks (which key on the Stripe subscription id, not `sub_<uuid>`).
      if (
        existingSub?.stripe_customer_id &&
        !String(existingSub.stripe_customer_id).startsWith('promo_')
      ) {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: 'Your team already has an active subscription' }, { status: 400 });
      }

      // Increment uses count
      await client.query(
        `UPDATE promo_codes SET uses_count = uses_count + 1 WHERE id = $1`,
        [promo.id],
      );

      // Upsert subscription
      const subId = `sub_${randomUUID().replace(/-/g, '')}`;
      await client.query(
        `INSERT INTO subscriptions (id, team_id, stripe_customer_id, plan, status, promo_code_id, current_period_start, current_period_end)
         VALUES ($1, $2, $3, $4, 'active', $5, now(), now() + interval '100 years')
         ON CONFLICT (team_id) DO UPDATE SET
           plan = EXCLUDED.plan,
           status = 'active',
           promo_code_id = EXCLUDED.promo_code_id,
           current_period_start = EXCLUDED.current_period_start,
           current_period_end = EXCLUDED.current_period_end,
           updated_at = now()`,
        [subId, teamId, `promo_${teamId}`, promo.plan, promo.id],
      );

      // Update team plan
      await client.query(
        `UPDATE teams SET plan = $1 WHERE id = $2`,
        [promo.plan, teamId],
      );

      // Add credits if specified
      if (promo.credits_cents > 0) {
        const microcents = promo.credits_cents * 1_000_000;
        await client.query(
          `INSERT INTO credit_balances (team_id, balance_microcents) VALUES ($1, 0) ON CONFLICT (team_id) DO NOTHING`,
          [teamId],
        );
        const { rows: balRows } = await client.query(
          `UPDATE credit_balances SET balance_microcents = balance_microcents + $1, updated_at = now() WHERE team_id = $2 RETURNING balance_microcents`,
          [microcents, teamId],
        );
        const txId = `ctx_${randomUUID().replace(/-/g, '')}`;
        await client.query(
          `INSERT INTO credit_transactions (id, team_id, amount_microcents, type, reference_id, description, balance_after_microcents)
           VALUES ($1, $2, $3, 'purchase', $4, $5, $6)`,
          [txId, teamId, microcents, promo.id, `Promo code: ${code}`, Number(balRows[0].balance_microcents)],
        );
      }

      await client.query('COMMIT');

      return NextResponse.json({
        success: true,
        plan: promo.plan,
        credits_cents: promo.credits_cents,
      });
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Promo redemption failed:', err);
    return NextResponse.json({ error: 'Failed to redeem promo code' }, { status: 500 });
  }
}
