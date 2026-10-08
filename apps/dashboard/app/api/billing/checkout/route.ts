import { NextResponse } from 'next/server';
import { stripe } from '@/lib/stripe';
import { getPool } from '@/lib/db';
import { requireRole } from '@/lib/rbac';
import { getRequiredAppOrigin } from '@/lib/app-origin';
import { DEMO_WRITE_BLOCKED_MESSAGE, isDemoActive } from '@/lib/demo';

// LAY-344 Option A: single metered price. No fixed monthly fee — Stripe
// only bills the team when the savings-reporter pushes meter events.
// `pro` is the only plan slug new checkouts use; legacy slugs in
// existing webhook payloads are still resolved by planFromPriceId.
const PRO_METERED_PRICE_ID = process.env.STRIPE_PRO_METERED_PRICE_ID!;
const VALID_PLANS = ['pro'];

export async function POST(request: Request) {
  try {
    if (await isDemoActive()) {
      return NextResponse.json({ error: DEMO_WRITE_BLOCKED_MESSAGE }, { status: 403 });
    }
    const roleCheck = await requireRole('admin');
    if (!roleCheck) {
      return NextResponse.json({ error: 'Forbidden — admin or owner required' }, { status: 403 });
    }

    const teamId = roleCheck.teamId;
    const body = await request.json();
    const { plan } = body;

    if (!plan || !VALID_PLANS.includes(plan)) {
      return NextResponse.json({ error: 'Invalid plan. Must be: pro' }, { status: 400 });
    }

    const pool = getPool();

    // RSH-56 guard: if the team already has a live, non-promo subscription, do
    // not open a second checkout — Stripe would mint a duplicate paid
    // subscription while the DB tracks only one (UNIQUE team_id; the webhook
    // upserts on team_id). Send the admin to the Stripe billing portal to manage
    // the existing plan instead. Promo-only rows (stripe_customer_id 'promo_*')
    // and non-live rows (canceled/incomplete) still fall through to checkout so
    // teams can upgrade from a promo or resubscribe after cancellation.
    const LIVE_SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due', 'unpaid', 'paused'];
    const { rows: existingSubRows } = await pool.query(
      'SELECT stripe_customer_id, status FROM subscriptions WHERE team_id = $1',
      [teamId],
    );
    const existingSub = existingSubRows[0];
    if (
      existingSub?.stripe_customer_id &&
      !String(existingSub.stripe_customer_id).startsWith('promo_') &&
      LIVE_SUBSCRIPTION_STATUSES.includes(existingSub.status)
    ) {
      const portalSession = await stripe.billingPortal.sessions.create({
        customer: existingSub.stripe_customer_id,
        return_url: `${getRequiredAppOrigin('billing URLs')}/billing`,
      });
      return NextResponse.json({ url: portalSession.url, portal: true });
    }

    // Look up team's existing Stripe customer
    const { rows: teamRows } = await pool.query(
      'SELECT id, name, stripe_customer_id FROM teams WHERE id = $1',
      [teamId],
    );
    if (teamRows.length === 0) {
      return NextResponse.json({ error: 'Team not found' }, { status: 404 });
    }

    let customerId = teamRows[0].stripe_customer_id;

    // Create Stripe customer if none exists
    if (!customerId) {
      const customer = await stripe.customers.create({
        name: teamRows[0].name,
        metadata: { team_id: teamId },
      });
      customerId = customer.id;
      await pool.query(
        'UPDATE teams SET stripe_customer_id = $1 WHERE id = $2',
        [customerId, teamId],
      );
    }

    const origin = getRequiredAppOrigin('billing URLs');

    // Stripe requires omitting `quantity` on metered line items — the
    // savings-reporter pushes per-period quantities via meter events.
    const checkoutSession = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: PRO_METERED_PRICE_ID }],
      metadata: { team_id: teamId },
      success_url: `${origin}/billing?success=true`,
      cancel_url: `${origin}/billing?canceled=true`,
      allow_promotion_codes: true,
    });

    return NextResponse.json({ url: checkoutSession.url });
  } catch (err) {
    console.error('Checkout session creation failed:', err);
    return NextResponse.json({ error: 'Failed to create checkout session' }, { status: 500 });
  }
}
