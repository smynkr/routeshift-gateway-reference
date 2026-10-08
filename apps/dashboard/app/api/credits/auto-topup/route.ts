import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { requireRole, requireTeamMembership } from '@/lib/rbac';
import { stripe } from '@/lib/stripe';
import { DEMO_WRITE_BLOCKED_MESSAGE, getEffectiveTeamId, isDemoActive } from '@/lib/demo';

const MICROCENTS_PER_CENT = 1_000_000;

function isMissingDisableStateColumns(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '42703';
}

export async function GET() {
  try {
    const member = await requireTeamMembership();
    if (!member) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const teamId = (await getEffectiveTeamId(member.teamId)) as string;
    const pool = getPool();
    let rows;
    try {
      ({ rows } = await pool.query(
        `SELECT enabled, stripe_payment_method_id, threshold_microcents, reload_amount_cents,
                disabled_reason, disabled_at
         FROM auto_topup_settings
         WHERE team_id = $1`,
        [teamId],
      ));
    } catch (error) {
      if (!isMissingDisableStateColumns(error)) throw error;
      ({ rows } = await pool.query(
        `SELECT enabled, stripe_payment_method_id, threshold_microcents, reload_amount_cents
         FROM auto_topup_settings
         WHERE team_id = $1`,
        [teamId],
      ));
    }
    if (rows.length === 0) {
      return NextResponse.json({
        enabled: false,
        threshold_cents: 100,
        reload_amount_cents: 5000,
        disabled_reason: null,
        disabled_at: null,
      });
    }
    const settings = rows[0];
    return NextResponse.json({
      enabled: Boolean(settings.enabled && settings.stripe_payment_method_id),
      threshold_cents: Math.round(Number(settings.threshold_microcents) / MICROCENTS_PER_CENT),
      reload_amount_cents: Number(settings.reload_amount_cents),
      disabled_reason: settings.disabled_reason ?? null,
      disabled_at: settings.disabled_at ?? null,
    });
  } catch (err) {
    console.error('Auto-topup settings fetch failed:', err);
    return NextResponse.json({ error: 'Failed to load settings' }, { status: 500 });
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

    let body: any;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { threshold_cents, reload_amount_cents } = body;

    if (typeof threshold_cents !== 'number' || threshold_cents < 100 || threshold_cents > 10000) {
      return NextResponse.json({ error: 'Threshold must be between $1 (100) and $100 (10000) cents' }, { status: 400 });
    }
    if (typeof reload_amount_cents !== 'number' || reload_amount_cents < 1000 || reload_amount_cents > 50000) {
      return NextResponse.json({ error: 'Reload amount must be between $10 (1000) and $500 (50000) cents' }, { status: 400 });
    }

    const pool = getPool();
    const { rows: existingRows } = await pool.query(
      'SELECT stripe_payment_method_id FROM auto_topup_settings WHERE team_id = $1',
      [teamId],
    );
    const hasStoredPaymentMethod = Boolean(existingRows[0]?.stripe_payment_method_id);

    const settingsParams = [
      teamId,
      threshold_cents * MICROCENTS_PER_CENT,
      reload_amount_cents,
      hasStoredPaymentMethod,
    ];
    try {
      await pool.query(
        `INSERT INTO auto_topup_settings (team_id, threshold_microcents, reload_amount_cents, enabled)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (team_id) DO UPDATE SET
           threshold_microcents = $2,
           reload_amount_cents = $3,
           enabled = $4,
           disabled_reason = CASE WHEN $4 THEN NULL ELSE auto_topup_settings.disabled_reason END,
           disabled_at = CASE WHEN $4 THEN NULL ELSE auto_topup_settings.disabled_at END,
           updated_at = now()`,
        settingsParams,
      );
    } catch (error) {
      if (!isMissingDisableStateColumns(error)) throw error;
      await pool.query(
        `INSERT INTO auto_topup_settings (team_id, threshold_microcents, reload_amount_cents, enabled)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (team_id) DO UPDATE SET
           threshold_microcents = $2, reload_amount_cents = $3, enabled = $4, updated_at = now()`,
        settingsParams,
      );
    }

    if (hasStoredPaymentMethod) {
      return NextResponse.json({ success: true, enabled: true });
    }

    // Get or create Stripe customer for team
    const { rows: teamRows } = await pool.query('SELECT stripe_customer_id FROM teams WHERE id = $1', [teamId]);
    let customerId = teamRows[0]?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ metadata: { team_id: teamId } });
      customerId = customer.id;
      await pool.query('UPDATE teams SET stripe_customer_id = $1 WHERE id = $2', [customerId, teamId]);
    }

    const customer = await stripe.customers.retrieve(customerId);
    if (!customer.deleted) {
      const defaultPaymentMethodId =
        typeof customer.invoice_settings.default_payment_method === 'string'
          ? customer.invoice_settings.default_payment_method
          : customer.invoice_settings.default_payment_method?.id;

      if (defaultPaymentMethodId) {
        try {
          await pool.query(
            `UPDATE auto_topup_settings
             SET stripe_payment_method_id = $2, enabled = true,
                 disabled_reason = NULL, disabled_at = NULL, updated_at = now()
             WHERE team_id = $1`,
            [teamId, defaultPaymentMethodId],
          );
        } catch (error) {
          if (!isMissingDisableStateColumns(error)) throw error;
          await pool.query(
            `UPDATE auto_topup_settings
             SET stripe_payment_method_id = $2, enabled = true, updated_at = now()
             WHERE team_id = $1`,
            [teamId, defaultPaymentMethodId],
          );
        }
        return NextResponse.json({ success: true, enabled: true });
      }
    }

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      usage: 'off_session',
    });

    return NextResponse.json({
      success: true,
      enabled: false,
      requires_payment_method: true,
      client_secret: setupIntent.client_secret,
    });
  } catch (err) {
    console.error('Auto-topup setup failed:', err);
    return NextResponse.json({ error: 'Failed to set up auto-topup' }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    if (await isDemoActive()) {
      return NextResponse.json({ error: DEMO_WRITE_BLOCKED_MESSAGE }, { status: 403 });
    }
    const user = await requireRole('admin');
    if (!user) {
      return NextResponse.json({ error: 'Admin role required' }, { status: 403 });
    }

    const teamId = user.teamId;
    const pool = getPool();

    try {
      await pool.query(
        `UPDATE auto_topup_settings
         SET enabled = false, disabled_reason = NULL, disabled_at = NULL, updated_at = now()
         WHERE team_id = $1`,
        [teamId],
      );
    } catch (error) {
      if (!isMissingDisableStateColumns(error)) throw error;
      await pool.query(
        'UPDATE auto_topup_settings SET enabled = false, updated_at = now() WHERE team_id = $1',
        [teamId],
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Auto-topup disable failed:', err);
    return NextResponse.json({ error: 'Failed to disable auto-topup' }, { status: 500 });
  }
}
