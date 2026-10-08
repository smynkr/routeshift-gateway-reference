import type { NextRequest } from 'next/server';
import { handlers } from '@/lib/auth';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '@/lib/rate-limit';

export const { GET } = handlers;

// RSH-57: NextAuth re-exports handlers directly, so the credentials sign-in
// (POST /api/auth/callback/credentials) runs bcrypt.compare against a cost-12
// hash with no throttle — online brute-force + bcrypt CPU-exhaustion DoS. Wrap
// POST and apply the existing per-IP limiter, but ONLY to the credentials
// callback so session/CSRF/provider POSTs are unaffected. Keyed on the
// non-spoofable cf-connecting-ip (see getClientIp).
export async function POST(request: Request) {
  if (new URL(request.url).pathname.endsWith('/callback/credentials')) {
    const rl = checkRateLimit(`auth:credentials:${getClientIp(request)}`, {
      limit: 10,
      windowMs: 60_000,
    });
    if (!rl.allowed) return rateLimitedResponse(rl);
  }
  // Next invokes this route with a NextRequest at runtime; the wrapper accepts a
  // plain Request so it stays trivially testable. NextRequest derives from Request.
  return handlers.POST(request as NextRequest);
}
