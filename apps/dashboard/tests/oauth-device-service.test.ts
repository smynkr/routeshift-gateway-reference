import { describe, expect, it } from 'vitest';
import {
  approveAuthorization,
  attachMintedKey,
  createDeviceAuthorization,
  denyAuthorization,
  getAuthorizationByUserCode,
  pollToken,
} from '@/lib/oauth-device-service';
import { hashDeviceCode, normalizeUserCode } from '@/lib/oauth-device';
import { FakeDevicePool } from './helpers/fake-device-pool';

const BASE = 'https://app.routeshift.io';
const CLIENT = { clientId: 'routeshift-connect', clientName: 'RouteShift Connect', scope: 'inference' };

describe('createDeviceAuthorization', () => {
  it('returns an RFC 8628 response and persists a hashed, pending row', async () => {
    const pool = new FakeDevicePool();
    const res = await createDeviceAuthorization(pool, CLIENT, BASE);

    expect(res.device_code).toMatch(/^[0-9a-f]{64}$/);
    expect(res.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(res.verification_uri).toBe(`${BASE}/device`);
    expect(res.verification_uri_complete).toBe(
      `${BASE}/device?user_code=${normalizeUserCode(res.user_code)}`,
    );
    expect(res.expires_in).toBe(600);
    expect(res.interval).toBe(5);

    const [row] = pool.authorizations;
    expect(row.status).toBe('pending');
    expect(row.device_code_hash).toBe(hashDeviceCode(res.device_code));
    // The raw device_code is never stored.
    expect(JSON.stringify(pool.authorizations)).not.toContain(res.device_code);
  });

  it('trims trailing slashes from the base URL', async () => {
    const pool = new FakeDevicePool();
    const res = await createDeviceAuthorization(pool, CLIENT, `${BASE}///`);
    expect(res.verification_uri).toBe(`${BASE}/device`);
  });
});

describe('approve / deny', () => {
  it('approves a pending authorization and attaches identity', async () => {
    const pool = new FakeDevicePool();
    const res = await createDeviceAuthorization(pool, CLIENT, BASE);

    const result = await approveAuthorization(pool, {
      userCodeInput: res.user_code,
      teamId: 'team_dev',
      userId: 'user_1',
      userEmail: 'dev@routeshift.io',
    });
    expect(result).toBe('approved');

    const row = await getAuthorizationByUserCode(pool, res.user_code);
    expect(row?.status).toBe('approved');
    expect(row?.team_id).toBe('team_dev');
    expect(row?.user_id).toBe('user_1');
  });

  it('cannot approve an unknown code', async () => {
    const pool = new FakeDevicePool();
    expect(await approveAuthorization(pool, {
      userCodeInput: 'ZZZZ-ZZZZ', teamId: 't', userId: 'u', userEmail: 'e@x.io',
    })).toBe('not_found');
  });

  it('cannot re-approve an already-denied code', async () => {
    const pool = new FakeDevicePool();
    const res = await createDeviceAuthorization(pool, CLIENT, BASE);
    expect(await denyAuthorization(pool, res.user_code)).toBe('denied');
    expect(await approveAuthorization(pool, {
      userCodeInput: res.user_code, teamId: 't', userId: 'u', userEmail: 'e@x.io',
    })).toBe('already_resolved');
  });

  it('reports expired when approving past the deadline', async () => {
    const pool = new FakeDevicePool();
    const past = new Date('2026-01-01T00:00:00Z');
    const res = await createDeviceAuthorization(pool, CLIENT, BASE, past);
    const later = new Date('2026-01-01T00:20:00Z'); // > 10 min TTL
    expect(await approveAuthorization(pool, {
      userCodeInput: res.user_code, teamId: 't', userId: 'u', userEmail: 'e@x.io',
    }, later)).toBe('expired');
  });
});

describe('pollToken state machine', () => {
  it('unknown device_code → invalid_grant', async () => {
    const pool = new FakeDevicePool();
    expect(await pollToken(pool, 'deadbeef')).toEqual({ status: 'invalid_grant' });
  });

  it('pending → authorization_pending, then slow_down when polled too soon', async () => {
    const pool = new FakeDevicePool();
    const res = await createDeviceAuthorization(pool, CLIENT, BASE);

    const t0 = new Date('2026-05-30T12:00:00Z');
    expect((await pollToken(pool, res.device_code, t0)).status).toBe('authorization_pending');

    const t1 = new Date('2026-05-30T12:00:02Z'); // 2s later, interval 5s
    expect((await pollToken(pool, res.device_code, t1)).status).toBe('slow_down');

    const t2 = new Date('2026-05-30T12:00:09Z'); // 7s after t1
    expect((await pollToken(pool, res.device_code, t2)).status).toBe('authorization_pending');
  });

  it('denied → access_denied', async () => {
    const pool = new FakeDevicePool();
    const res = await createDeviceAuthorization(pool, CLIENT, BASE);
    await denyAuthorization(pool, res.user_code);
    expect((await pollToken(pool, res.device_code)).status).toBe('access_denied');
  });

  it('denied takes precedence over expiry → access_denied, not expired_token', async () => {
    const pool = new FakeDevicePool();
    const res = await createDeviceAuthorization(pool, CLIENT, BASE);
    await denyAuthorization(pool, res.user_code);
    const wayLater = new Date(Date.now() + 60 * 60 * 1000); // past the 10-min TTL
    expect((await pollToken(pool, res.device_code, wayLater)).status).toBe('access_denied');
  });

  it('expired device_code → expired_token and flips status to expired', async () => {
    const pool = new FakeDevicePool();
    const past = new Date('2026-01-01T00:00:00Z');
    const res = await createDeviceAuthorization(pool, CLIENT, BASE, past);
    const later = new Date('2026-01-01T00:20:00Z');
    expect((await pollToken(pool, res.device_code, later)).status).toBe('expired_token');
    expect(pool.authorizations[0].status).toBe('expired');
  });

  it('approved (not yet redeemed) → ready_to_mint; redeemed → invalid_grant', async () => {
    const pool = new FakeDevicePool();
    const res = await createDeviceAuthorization(pool, CLIENT, BASE);
    await approveAuthorization(pool, {
      userCodeInput: res.user_code, teamId: 'team_dev', userId: 'u1', userEmail: 'dev@routeshift.io',
    });

    const out = await pollToken(pool, res.device_code);
    expect(out.status).toBe('ready_to_mint');

    // Simulate the mint claim.
    const won = await attachMintedKey(pool, pool.authorizations[0].id, {
      apiKeyId: 'key_123', teamId: 'team_dev', userId: 'u1', email: 'dev@routeshift.io',
    });
    expect(won).toBe(true);

    // A second poll after redemption is rejected — device_code is single-use.
    expect((await pollToken(pool, res.device_code)).status).toBe('invalid_grant');
  });
});

describe('attachMintedKey', () => {
  it('records the identity→key mapping and rejects a racing second claim', async () => {
    const pool = new FakeDevicePool();
    const res = await createDeviceAuthorization(pool, CLIENT, BASE);
    await approveAuthorization(pool, {
      userCodeInput: res.user_code, teamId: 'team_dev', userId: 'u1', userEmail: 'dev@routeshift.io',
    });
    const id = pool.authorizations[0].id;

    const first = await attachMintedKey(pool, id, {
      apiKeyId: 'key_A', teamId: 'team_dev', userId: 'u1', email: 'dev@routeshift.io',
    });
    const second = await attachMintedKey(pool, id, {
      apiKeyId: 'key_B', teamId: 'team_dev', userId: 'u1', email: 'dev@routeshift.io',
    });

    expect(first).toBe(true);
    expect(second).toBe(false); // lost the race; caller revokes key_B
    expect(pool.keyIdentities).toHaveLength(1);
    expect(pool.keyIdentities[0]).toMatchObject({
      api_key_id: 'key_A', team_id: 'team_dev', user_id: 'u1', created_via: 'oauth_device',
    });
  });
});
