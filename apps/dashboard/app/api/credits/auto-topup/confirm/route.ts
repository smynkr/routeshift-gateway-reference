import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { requireRole } from '@/lib/rbac';
import { stripe } from '@/lib/stripe';
import { DEMO_WRITE_BLOCKED_MESSAGE, isDemoActive } from '@/lib/demo';

function isMissingDisableStateColumns(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '42703';
}

export async function POST(request: Request) {
  try {
    if (await isDemoActive()) {
      return NextResponse.json({ error: DEMO_WRITE_BLOCKED_MESSAGE }, { status: 403 });
    }
    // Attaching a payment method enables recurring auto-charges, so this must
    // be admin-gated like the sibling auto-topup POST/DELETE handlers.
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

    const { payment_method_id } = body;

    if (!payment_method_id || typeof payment_method_id !== 'string') {
      return NextResponse.json({ error: 'Missing payment_method_id' }, { status: 400 });
    }

    const pool = getPool();
    const { rows: teamRows } = await pool.query(
      'SELECT stripe_customer_id FROM teams WHERE id = $1',
      [teamId],
    );
    const stripeCustomerId = teamRows[0]?.stripe_customer_id;
    if (!stripeCustomerId) {
      return NextResponse.json({ error: 'No Stripe customer found for team' }, { status: 400 });
    }

    let paymentMethod;
    try {
      paymentMethod = await stripe.paymentMethods.retrieve(payment_method_id);
    } catch {
      return NextResponse.json({ error: 'Invalid payment_method_id' }, { status: 400 });
    }
    const paymentMethodCustomerId =
      typeof paymentMethod.customer === 'string'
        ? paymentMethod.customer
        : paymentMethod.customer?.id ?? null;

    if (paymentMethodCustomerId !== stripeCustomerId) {
      return NextResponse.json(
        { error: 'Payment method does not belong to this team' },
        { status: 400 },
      );
    }

    const params = [teamId, payment_method_id];
    try {
      await pool.query(
        `INSERT INTO auto_topup_settings (team_id, stripe_payment_method_id, enabled)
         VALUES ($1, $2, true)
         ON CONFLICT (team_id) DO UPDATE SET
           stripe_payment_method_id = $2,
           enabled = true,
           disabled_reason = NULL,
           disabled_at = NULL,
           updated_at = now()`,
        params,
      );
    } catch (error) {
      if (!isMissingDisableStateColumns(error)) throw error;
      await pool.query(
        `INSERT INTO auto_topup_settings (team_id, stripe_payment_method_id, enabled)
         VALUES ($1, $2, true)
         ON CONFLICT (team_id) DO UPDATE SET
           stripe_payment_method_id = $2, enabled = true, updated_at = now()`,
        params,
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Auto-topup confirm failed:', err);
    return NextResponse.json({ error: 'Failed to confirm auto-topup' }, { status: 500 });
  }
}
