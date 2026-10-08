import { describe, expect, it, vi } from 'vitest';
import { deviceLogin, DeviceFlowError } from '../src/device-flow';

const BASE = 'https://app.routeshift.io';

function deviceCodeResponse() {
  return {
    device_code: 'dc_secret',
    user_code: 'BCDF-GHJK',
    verification_uri: `${BASE}/device`,
    verification_uri_complete: `${BASE}/device?user_code=BCDFGHJK`,
    expires_in: 600,
    interval: 5,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A fetch stub scripted by sequential token-poll responses. */
function scriptedFetch(tokenResponses: Array<{ status: number; body: unknown }>) {
  let poll = 0;
  return vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.endsWith('/api/oauth/device/code')) return jsonResponse(200, deviceCodeResponse());
    if (u.endsWith('/api/oauth/token')) {
      const r = tokenResponses[Math.min(poll, tokenResponses.length - 1)];
      poll++;
      return jsonResponse(r.status, r.body);
    }
    throw new Error(`unexpected url ${u}`);
  });
}

describe('deviceLogin', () => {
  it('polls through pending → slow_down → success and returns the token', async () => {
    const fetchImpl = scriptedFetch([
      { status: 400, body: { error: 'authorization_pending' } },
      { status: 400, body: { error: 'slow_down' } },
      { status: 200, body: { access_token: 'sk-proxy-live_team_xyz', key_prefix: 'sk-proxy-live_team', scope: 'inference' } },
    ]);
    const sleeps: number[] = [];
    const result = await deviceLogin(
      BASE,
      { clientId: 'c', clientName: 'C', scope: 'inference' },
      { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async (ms) => void sleeps.push(ms) },
    );

    expect(result.accessToken).toBe('sk-proxy-live_team_xyz');
    expect(result.keyPrefix).toBe('sk-proxy-live_team');
    // Poll-first ordering: sleep happens BETWEEN polls. After poll 1 (pending)
    // → 5s; after poll 2 (slow_down bumps 5→10) → 10s; poll 3 succeeds, no sleep.
    expect(sleeps).toEqual([5000, 10000]);
  });

  it('rejects an invalid expires_in instead of looping forever (RSH-60)', async () => {
    // A malformed/hostile auth server omits expires_in -> deadline was NaN ->
    // the overall-deadline guard never fires and the CLI polls forever.
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/api/oauth/device/code')) {
        return jsonResponse(200, { ...deviceCodeResponse(), expires_in: undefined });
      }
      return jsonResponse(400, { error: 'authorization_pending' });
    });
    // If validation is missing, control reaches the poll loop and sleeps; make
    // that loud and deterministic instead of hanging the test.
    const sleep = vi.fn(async () => {
      throw new Error('reached the poll loop — expires_in was not validated');
    });

    await expect(
      deviceLogin(
        BASE,
        { clientId: 'c', clientName: 'C', scope: 'inference' },
        { fetchImpl: fetchImpl as unknown as typeof fetch, sleep },
      ),
    ).rejects.toBeInstanceOf(DeviceFlowError);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('surfaces the user code via onUserCode before polling', async () => {
    const fetchImpl = scriptedFetch([
      { status: 200, body: { access_token: 'sk-proxy-live_t_z', key_prefix: 'sk-proxy-live_t' } },
    ]);
    const onUserCode = vi.fn();
    await deviceLogin(
      BASE,
      { clientId: 'c', clientName: 'C', scope: 'inference' },
      { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {}, onUserCode },
    );
    expect(onUserCode).toHaveBeenCalledWith(expect.objectContaining({ user_code: 'BCDF-GHJK' }));
  });

  it('throws access_denied when the user denies', async () => {
    const fetchImpl = scriptedFetch([{ status: 400, body: { error: 'access_denied' } }]);
    await expect(
      deviceLogin(
        BASE,
        { clientId: 'c', clientName: 'C', scope: 'inference' },
        { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} },
      ),
    ).rejects.toMatchObject({ code: 'access_denied' });
  });

  it('throws expired_token when the device_code expires', async () => {
    const fetchImpl = scriptedFetch([{ status: 400, body: { error: 'expired_token' } }]);
    await expect(
      deviceLogin(
        BASE,
        { clientId: 'c', clientName: 'C', scope: 'inference' },
        { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} },
      ),
    ).rejects.toBeInstanceOf(DeviceFlowError);
  });

  it('gives up with expired_token once the overall deadline passes', async () => {
    const fetchImpl = scriptedFetch([{ status: 400, body: { error: 'authorization_pending' } }]);
    let clock = 0;
    await expect(
      deviceLogin(
        BASE,
        { clientId: 'c', clientName: 'C', scope: 'inference' },
        {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          sleep: async () => { clock += 1_000_000; }, // jump past expires_in on first sleep
          now: () => clock,
        },
      ),
    ).rejects.toMatchObject({ code: 'expired_token' });
  });
});
