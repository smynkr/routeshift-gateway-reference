import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetRateLimitStore } from '@/lib/rate-limit';

// RSH-57: the credentials login and registration endpoints both run cost-12
// bcrypt with no throttle — online brute-force + CPU-exhaustion DoS. Add the
// existing per-IP limiter (the same one already on the OAuth endpoints) before
// any bcrypt work. cf-connecting-ip is used as the (non-spoofable) bucket key.

const auth = vi.hoisted(() => ({
  handlers: {
    GET: vi.fn(),
    POST: vi.fn(async () => new Response('ok', { status: 200 })),
  },
}));
vi.mock('@/lib/auth', () => auth);

import { POST as authPost } from '@/app/api/auth/[...nextauth]/route';
import { POST as registerPost } from '@/app/api/auth/register/route';

function req(path: string, ip: string, body?: unknown) {
  return new Request(`https://app.test${path}`, {
    method: 'POST',
    headers: { 'cf-connecting-ip': ip, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('credentials login rate limit (RSH-57)', () => {
  beforeEach(() => {
    __resetRateLimitStore();
    auth.handlers.POST.mockClear();
  });

  it('blocks credential logins from one IP after 10/min with a 429 (never reaching NextAuth)', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await authPost(req('/api/auth/callback/credentials', '9.9.9.9'));
      expect(res.status).toBe(200);
    }
    const blocked = await authPost(req('/api/auth/callback/credentials', '9.9.9.9'));
    expect(blocked.status).toBe(429);
    expect(auth.handlers.POST).toHaveBeenCalledTimes(10);
  });

  it('does not throttle non-credentials auth requests (session/csrf/provider GETs share no bucket)', async () => {
    for (let i = 0; i < 15; i++) {
      const res = await authPost(req('/api/auth/session', '9.9.9.9'));
      expect(res.status).toBe(200);
    }
    expect(auth.handlers.POST).toHaveBeenCalledTimes(15);
  });

  it('keys the bucket per IP (a different IP is unaffected)', async () => {
    for (let i = 0; i < 11; i++) await authPost(req('/api/auth/callback/credentials', '1.1.1.1'));
    const other = await authPost(req('/api/auth/callback/credentials', '2.2.2.2'));
    expect(other.status).toBe(200);
  });
});

describe('register rate limit (RSH-57)', () => {
  beforeEach(() => {
    __resetRateLimitStore();
  });

  it('blocks registrations from one IP after 5/min with a 429 (before bcrypt/db)', async () => {
    for (let i = 0; i < 5; i++) {
      // Empty body → 400 missing-fields, but each attempt still consumes a hit.
      const res = await registerPost(req('/api/auth/register', '8.8.8.8', {}));
      expect(res.status).toBe(400);
    }
    const blocked = await registerPost(req('/api/auth/register', '8.8.8.8', {}));
    expect(blocked.status).toBe(429);
  });
});
