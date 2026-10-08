import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDevicePool } from './helpers/fake-device-pool';
import { __resetRateLimitStore } from '@/lib/rate-limit';

// Shared, hoisted handles so the vi.mock factories (which run before the file
// body) can reach the per-test pool and session without a TDZ crash.
const h = vi.hoisted(() => ({
  pool: null as unknown as FakeDevicePool,
  member: null as null | { userId: string; teamId: string; role: string },
}));

vi.mock('@/lib/db', () => ({ getPool: () => h.pool }));
vi.mock('@/lib/rbac', () => ({ requireTeamMembership: async () => h.member }));

import { POST as deviceCodePOST } from '@/app/api/oauth/device/code/route';
import { POST as tokenPOST } from '@/app/api/oauth/token/route';
import { POST as approvePOST } from '@/app/api/oauth/device/approve/route';
import { POST as denyPOST } from '@/app/api/oauth/device/deny/route';

const BASE = 'https://app.routeshift.io';

function jsonReq(path: string, body: Record<string, unknown>) {
  // Include a same-origin Origin header so the CSRF guard on approve/deny
  // passes for the legitimate first-party flow. The public code/token
  // endpoints ignore it.
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify(body),
  });
}

let mintedCounter = 0;
let deletedCounter = 0;
let mintShouldFail = false;
let mintedBodies: Array<{ metadata?: { scope?: string } }> = [];

beforeEach(() => {
  // RSH-52: the device/code + token routes are now rate-limited via a
  // module-level in-memory store. Reset it between tests so cumulative calls
  // (all keyed to the same "unknown" IP here) don't trip the limit mid-suite.
  __resetRateLimitStore();
  mintedCounter = 0;
  deletedCounter = 0;
  mintShouldFail = false;
  mintedBodies = [];
  h.pool = new FakeDevicePool();
  h.pool.users.push({ id: 'user_1', email: 'dev@routeshift.io' });
  h.pool.allowedDomains.push({ team_id: 'team_dev', domain: 'routeshift.io' });
  h.member = { userId: 'user_1', teamId: 'team_dev', role: 'admin' };

  process.env.ADMIN_SECRET = 'test-admin-secret-0123456789';
  process.env.OAUTH_ISSUER_URL = BASE;

  // Mock the proxy admin API the mint/revoke helpers call.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/admin/keys') && (init?.method ?? 'GET') === 'POST') {
        if (mintShouldFail) {
          return new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 });
        }
        if (typeof init?.body === 'string') {
          mintedBodies.push(JSON.parse(init.body) as { metadata?: { scope?: string } });
        }
        mintedCounter += 1;
        const id = `key_${mintedCounter}`;
        return new Response(
          JSON.stringify({ id, key: `sk-proxy-live_team_${id}_secret`, prefix: 'sk-proxy-live_team' }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/admin/keys') && init?.method === 'DELETE') {
        deletedCounter += 1;
        return new Response(JSON.stringify({ revoked: true }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${init?.method} ${u}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function startDeviceFlow(scope: string | null = 'inference') {
  const body: Record<string, unknown> = {
    client_id: 'routeshift-connect',
    client_name: 'RouteShift Connect',
  };
  if (scope !== null) body.scope = scope;
  const res = await deviceCodePOST(
    jsonReq('/api/oauth/device/code', body),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    interval: number;
    expires_in: number;
  };
}

describe('POST /api/oauth/device/code', () => {
  it('requires client_id', async () => {
    const res = await deviceCodePOST(jsonReq('/api/oauth/device/code', {}));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_request');
  });

  it('issues a device_code + user_code', async () => {
    const data = await startDeviceFlow();
    expect(data.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(data.verification_uri).toBe(`${BASE}/device`);
  });

  it('defaults omitted and blank scope to inference before persistence', async () => {
    await startDeviceFlow(null);
    await startDeviceFlow('   ');
    expect(h.pool.authorizations.map((row) => row.scope)).toEqual(['inference', 'inference']);
  });

  it('canonicalizes supported scope combinations before persistence', async () => {
    await startDeviceFlow('read,inference,read');
    expect(h.pool.authorizations[0].scope).toBe('inference read');
  });

  it('rejects unsupported or oversized scopes without persisting a grant', async () => {
    for (const scope of ['billing', 'inference billing', ',,,', 'x'.repeat(201)]) {
      const res = await deviceCodePOST(
        jsonReq('/api/oauth/device/code', {
          client_id: 'routeshift-connect',
          client_name: 'RouteShift Connect',
          scope,
        }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_scope' });
    }
    expect(h.pool.authorizations).toHaveLength(0);
  });
});

describe('POST /api/oauth/token', () => {
  it('rejects an unsupported grant_type', async () => {
    const res = await tokenPOST(jsonReq('/api/oauth/token', { grant_type: 'authorization_code' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('unsupported_grant_type');
  });

  it('returns authorization_pending before approval', async () => {
    const { device_code } = await startDeviceFlow();
    const res = await tokenPOST(
      jsonReq('/api/oauth/token', {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code,
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('authorization_pending');
  });

  it('returns access_denied after the user denies', async () => {
    const { device_code, user_code } = await startDeviceFlow();
    await denyPOST(jsonReq('/api/oauth/device/deny', { user_code }));
    const res = await tokenPOST(
      jsonReq('/api/oauth/token', {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code,
      }),
    );
    expect((await res.json()).error).toBe('access_denied');
  });
});

describe('end-to-end: code → approve → token mints an identity-scoped key', () => {
  it('defaults omitted scope and carries the same canonical grant through consent, mint, and token', async () => {
    const { device_code, user_code } = await startDeviceFlow(null);
    expect(h.pool.authorizations[0].scope).toBe('inference');

    const approveRes = await approvePOST(jsonReq('/api/oauth/device/approve', { user_code }));
    expect(approveRes.status).toBe(200);
    expect((await approveRes.json()).status).toBe('approved');

    const tokenRes = await tokenPOST(
      jsonReq('/api/oauth/token', {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code,
      }),
    );
    expect(tokenRes.status).toBe(200);
    const token = (await tokenRes.json()) as {
      access_token: string;
      token_type: string;
      key_prefix: string;
      scope: string;
    };
    expect(token.token_type).toBe('bearer');
    expect(token.access_token).toMatch(/^sk-proxy-/);
    expect(token.scope).toBe('inference');
    expect(mintedBodies).toHaveLength(1);
    expect(mintedBodies[0].metadata?.scope).toBe('inference');

    // Identity→key mapping recorded for admin visibility.
    expect(h.pool.keyIdentities).toHaveLength(1);
    expect(h.pool.keyIdentities[0]).toMatchObject({
      team_id: 'team_dev',
      user_id: 'user_1',
      email: 'dev@routeshift.io',
      created_via: 'oauth_device',
    });

    // A second poll is rejected — device_code is single-use, only one key minted.
    const replay = await tokenPOST(
      jsonReq('/api/oauth/token', {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code,
      }),
    );
    expect((await replay.json()).error).toBe('invalid_grant');
    expect(mintedCounter).toBe(1);
  });

  it('normalizes a legacy blank authorization again before minting', async () => {
    const { device_code, user_code } = await startDeviceFlow();
    h.pool.authorizations[0].scope = '';
    await approvePOST(jsonReq('/api/oauth/device/approve', { user_code }));

    const tokenRes = await tokenPOST(
      jsonReq('/api/oauth/token', {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code,
      }),
    );

    expect(tokenRes.status).toBe(200);
    expect((await tokenRes.json()).scope).toBe('inference');
    expect(mintedBodies[0].metadata?.scope).toBe('inference');
  });

  it('fails closed when a legacy authorization contains an unsupported scope', async () => {
    const { device_code, user_code } = await startDeviceFlow();
    h.pool.authorizations[0].scope = 'admin';
    await approvePOST(jsonReq('/api/oauth/device/approve', { user_code }));

    const tokenRes = await tokenPOST(
      jsonReq('/api/oauth/token', {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code,
      }),
    );

    expect(tokenRes.status).toBe(400);
    expect((await tokenRes.json()).error).toBe('invalid_scope');
    expect(mintedCounter).toBe(0);
  });
});

describe('governance gate is bypass-proof', () => {
  it('rejects approval from a non-allowlisted email domain, and no key is ever minted', async () => {
    // Same logged-in user, but their domain is not allowlisted for the team.
    h.pool.users[0].email = 'attacker@evil.com';

    const { device_code, user_code } = await startDeviceFlow();

    const approveRes = await approvePOST(jsonReq('/api/oauth/device/approve', { user_code }));
    expect(approveRes.status).toBe(403);
    expect((await approveRes.json()).error).toBe('self_provisioning_forbidden');

    // The authorization must stay pending — the deny path wasn't taken either.
    expect(h.pool.authorizations[0].status).toBe('pending');

    // And the device poll can never advance past pending → no key minted.
    const tokenRes = await tokenPOST(
      jsonReq('/api/oauth/token', {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code,
      }),
    );
    expect((await tokenRes.json()).error).toBe('authorization_pending');
    expect(mintedCounter).toBe(0);
    expect(h.pool.keyIdentities).toHaveLength(0);
  });

  it('requires an authenticated session to approve', async () => {
    h.member = null; // not signed in
    const { user_code } = await startDeviceFlow();
    const res = await approvePOST(jsonReq('/api/oauth/device/approve', { user_code }));
    expect(res.status).toBe(401);
  });

  it('requires an authenticated session to deny', async () => {
    h.member = null;
    const res = await denyPOST(jsonReq('/api/oauth/device/deny', { user_code: 'AAAA-BBBB' }));
    expect(res.status).toBe(401);
  });
});

describe('token route error paths', () => {
  const tokenReq = (device_code: string) =>
    jsonReq('/api/oauth/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code,
    });

  it('returns server_error (500) and mints no identity when the proxy mint fails', async () => {
    const { device_code, user_code } = await startDeviceFlow();
    await approvePOST(jsonReq('/api/oauth/device/approve', { user_code }));
    mintShouldFail = true;

    const res = await tokenPOST(tokenReq(device_code));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('server_error');
    expect(h.pool.keyIdentities).toHaveLength(0);
    expect(deletedCounter).toBe(0);
  });

  it('revokes the orphan key and returns invalid_grant when the mint-claim race is lost', async () => {
    const { device_code, user_code } = await startDeviceFlow();
    await approvePOST(jsonReq('/api/oauth/device/approve', { user_code }));
    h.pool.forceAttachLoss = true; // a concurrent poll won the claim first

    const res = await tokenPOST(tokenReq(device_code));
    expect((await res.json()).error).toBe('invalid_grant');
    expect(mintedCounter).toBe(1); // we did mint a key...
    expect(deletedCounter).toBe(1); // ...and revoked the orphan we lost the race on
    expect(h.pool.keyIdentities).toHaveLength(0);
  });
});

describe('approve/deny status mappings', () => {
  it('approve unknown user_code → 404', async () => {
    await startDeviceFlow();
    const res = await approvePOST(jsonReq('/api/oauth/device/approve', { user_code: 'ZZZZ-ZZZZ' }));
    expect(res.status).toBe(404);
  });

  it('approve an already-denied code → 409', async () => {
    const { user_code } = await startDeviceFlow();
    await denyPOST(jsonReq('/api/oauth/device/deny', { user_code }));
    const res = await approvePOST(jsonReq('/api/oauth/device/approve', { user_code }));
    expect(res.status).toBe(409);
  });

  it('approve an expired code → 410', async () => {
    const { user_code } = await startDeviceFlow();
    h.pool.authorizations[0].expires_at = new Date('2000-01-01T00:00:00Z');
    const res = await approvePOST(jsonReq('/api/oauth/device/approve', { user_code }));
    expect(res.status).toBe(410);
    expect((await res.json()).error).toBe('expired_token');
  });

  it('deny unknown user_code → 404', async () => {
    await startDeviceFlow();
    const res = await denyPOST(jsonReq('/api/oauth/device/deny', { user_code: 'ZZZZ-ZZZZ' }));
    expect(res.status).toBe(404);
  });
});

describe('CSRF protection on approve/deny', () => {
  function req(path: string, body: Record<string, unknown>, headers: Record<string, string>) {
    return new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  it('rejects approve from a foreign Origin and leaves the request pending', async () => {
    const { user_code } = await startDeviceFlow();
    const res = await approvePOST(
      req('/api/oauth/device/approve', { user_code }, { origin: 'https://evil.example' }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('invalid_origin');
    expect(h.pool.authorizations[0].status).toBe('pending');
    expect(mintedCounter).toBe(0);
  });

  it('rejects approve with neither Origin nor Referer', async () => {
    const { user_code } = await startDeviceFlow();
    const res = await approvePOST(req('/api/oauth/device/approve', { user_code }, {}));
    expect(res.status).toBe(403);
    expect(h.pool.authorizations[0].status).toBe('pending');
  });

  it('accepts approve when Referer matches and Origin is absent', async () => {
    const { user_code } = await startDeviceFlow();
    const res = await approvePOST(
      req('/api/oauth/device/approve', { user_code }, { referer: `${BASE}/device?user_code=${user_code}` }),
    );
    expect(res.status).toBe(200);
  });

  it('rejects deny from a foreign Origin', async () => {
    const { user_code } = await startDeviceFlow();
    const res = await denyPOST(
      req('/api/oauth/device/deny', { user_code }, { origin: 'https://evil.example' }),
    );
    expect(res.status).toBe(403);
    expect(h.pool.authorizations[0].status).toBe('pending');
  });
});
