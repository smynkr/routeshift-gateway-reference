import { NextResponse } from 'next/server';
import { stripe } from '@/lib/stripe';
import { getPool } from '@/lib/db';
import { requireRole } from '@/lib/rbac';
import { getRequiredAppOrigin } from '@/lib/app-origin';
import { DEMO_WRITE_BLOCKED_MESSAGE, isDemoActive } from '@/lib/demo';

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
    const pool = getPool();

    const { rows: teamRows } = await pool.query(
      'SELECT stripe_customer_id FROM teams WHERE id = $1',
      [teamId],
    );

    const customerId = teamRows[0]?.stripe_customer_id;
    if (!customerId) {
      return NextResponse.json({ error: 'No billing account found' }, { status: 404 });
    }

    const origin = getRequiredAppOrigin('billing URLs');

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${origin}/billing`,
    });

    return NextResponse.json({ url: portalSession.url });
  } catch (err) {
    console.error('Portal session creation failed:', err);
    return NextResponse.json({ error: 'Failed to create portal session' }, { status: 500 });
  }
}
