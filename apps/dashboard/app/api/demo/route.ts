/**
 * Demo-mode toggle endpoint. GET reports whether demo mode is permitted in
 * this environment and whether it's currently on for this browser; POST turns
 * it on (env-gated); DELETE turns it off. The cookie is httpOnly — the client
 * never reads it directly, it asks GET.
 */
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { auth } from '@/lib/auth';
import { DEMO_COOKIE, isDemoModeEnabled, getDemoProvenance } from '@/lib/demo';

export async function GET() {
  const enabled = isDemoModeEnabled();
  const store = await cookies();
  const active = enabled && store.get(DEMO_COOKIE)?.value === '1';
  // Gate `active` and provenance on the env flag so a stray cookie in a disabled
  // environment never reports as active (it also would not swap data — see
  // getEffectiveTeamId).
  return NextResponse.json({
    enabled,
    active,
    provenance: active ? await getDemoProvenance() : { active: false },
  });
}

export async function POST() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!isDemoModeEnabled()) {
    return NextResponse.json({ error: 'Demo mode is disabled in this environment' }, { status: 403 });
  }
  const store = await cookies();
  store.set(DEMO_COOKIE, '1', {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    // Secure in production (HTTPS); off in local dev so the cookie still sets
    // over http://localhost, which is the primary demo-mode environment.
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24 * 30,
  });
  return NextResponse.json({ active: true });
}

export async function DELETE() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const store = await cookies();
  store.delete(DEMO_COOKIE);
  return NextResponse.json({ active: false });
}
