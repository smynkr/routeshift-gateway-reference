import { NextResponse } from 'next/server';
import { stripe } from '@/lib/stripe';
import { requireRole, requireTeamMembership } from '@/lib/rbac';
import { getRequiredAppOrigin } from '@/lib/app-origin';
import { DEMO_WRITE_BLOCKED_MESSAGE, isDemoActive } from '@/lib/demo';

export async function POST(request: Request) {
  try {
    if (await isDemoActive()) {
      return NextResponse.json({ error: DEMO_WRITE_BLOCKED_MESSAGE }, { status: 403 });
    }
    // Initiating a team-credit purchase is billing-sensitive, so it must be
    // admin-gated for consistency with the auto-topup billing routes.
    const member = await requireTeamMembership();
    if (!member) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
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

    const { amount_cents } = body;

    if (typeof amount_cents !== 'number' || !Number.isInteger(amount_cents) || amount_cents < 1000 || amount_cents > 1_000_000) {
      return NextResponse.json({ error: 'Amount must be between $10 and $10,000' }, { status: 400 });
    }

    const origin = getRequiredAppOrigin('credit purchase URLs');

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'payment',
      // Pin card so settlement is synchronous: the credits webhook only grants
      // balance when checkout.session.completed arrives with payment_status
      // 'paid'. Async methods (ACH/SEPA) fire 'completed' as 'unpaid' first and
      // settle days later via a separate event we don't handle — credits should
      // be instant, so restrict to cards rather than silently dropping them.
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: { name: 'RouteShift Credits' },
            unit_amount: amount_cents,
          },
          quantity: 1,
        },
      ],
      metadata: { type: 'credits', team_id: teamId },
      // Checkout Session metadata is not automatically copied to its
      // PaymentIntent. Reversal webhooks can arrive before
      // checkout.session.completed, so the signed PaymentIntent must carry the
      // same provenance for the credit reducer to safely persist state.
      payment_intent_data: { metadata: { type: 'credits', team_id: teamId } },
      success_url: `${origin}/billing?credits_success=true`,
      cancel_url: `${origin}/billing?credits_canceled=true`,
    });

    return NextResponse.json({ url: checkoutSession.url });
  } catch (err) {
    console.error('Credits purchase failed:', err);
    return NextResponse.json({ error: 'Failed to create checkout session' }, { status: 500 });
  }
}
