// RFC 8628 device-flow client. Drives /api/oauth/device/code and polls
// /api/oauth/token, honoring interval / slow_down / expired_token / access_denied.
// All side effects (fetch, sleep, user-code display, browser open) are injected
// so the polling state machine is fully unit-testable.

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface DeviceLoginResult {
  accessToken: string;
  keyPrefix?: string;
  scope?: string;
}

export class DeviceFlowError extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? code);
    this.name = 'DeviceFlowError';
  }
}

export interface DeviceLoginDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onUserCode?: (info: DeviceCodeResponse) => void;
  openBrowser?: (url: string) => void;
  /** Monotonic ms clock; injectable so the overall-deadline guard is testable. */
  now?: () => number;
}

export interface DeviceLoginOptions {
  clientId: string;
  clientName: string;
  scope: string;
}

const SLOW_DOWN_STEP_SECONDS = 5; // RFC 8628 §3.5

export async function deviceLogin(
  baseUrl: string,
  opts: DeviceLoginOptions,
  deps: DeviceLoginDeps = {},
): Promise<DeviceLoginResult> {
  const doFetch = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const origin = baseUrl.replace(/\/+$/, '');

  const startRes = await doFetch(`${origin}/api/oauth/device/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: opts.clientId,
      client_name: opts.clientName,
      scope: opts.scope,
    }).toString(),
  });
  if (!startRes.ok) {
    throw new DeviceFlowError('device_code_request_failed', `Authorization server returned ${startRes.status}`);
  }
  const start = (await startRes.json()) as DeviceCodeResponse;

  deps.onUserCode?.(start);
  deps.openBrowser?.(start.verification_uri_complete);

  let intervalSeconds = start.interval > 0 ? start.interval : 5;
  // A malformed/hostile auth server can omit or corrupt expires_in; an unvalidated
  // NaN deadline makes the overall-deadline guard never fire, so the CLI polls
  // forever. Require a positive finite number and fail loudly otherwise (RSH-60).
  if (typeof start.expires_in !== 'number' || !Number.isFinite(start.expires_in) || start.expires_in <= 0) {
    throw new DeviceFlowError(
      'invalid_device_code_response',
      'Authorization server returned an invalid expires_in.',
    );
  }
  const deadline = now() + start.expires_in * 1000;

  // Poll until approval, denial, or expiry. We poll first and sleep BETWEEN
  // polls, so an instant approval is returned without an upfront interval of
  // latency.
  for (;;) {
    const res = await doFetch(`${origin}/api/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: start.device_code,
        client_id: opts.clientId,
      }).toString(),
    });

    if (res.ok) {
      const data = (await res.json().catch(() => ({}))) as { access_token?: unknown; key_prefix?: string; scope?: string };
      // A 200 with no usable token must fail loudly — otherwise the CLI writes
      // the literal string "undefined" as the API key into every tool config,
      // producing a broken setup that looks successful.
      if (typeof data.access_token !== 'string' || !data.access_token) {
        throw new DeviceFlowError('invalid_token_response', 'Authorization server returned no access token.');
      }
      return { accessToken: data.access_token, keyPrefix: data.key_prefix, scope: data.scope };
    }

    const err = (await res.json().catch(() => ({}))) as { error?: string };
    switch (err.error) {
      case 'authorization_pending':
        break; // wait, then poll again
      case 'slow_down':
        intervalSeconds += SLOW_DOWN_STEP_SECONDS;
        break;
      case 'access_denied':
        throw new DeviceFlowError('access_denied', 'The request was denied in the browser.');
      case 'expired_token':
        throw new DeviceFlowError('expired_token', 'The sign-in request expired. Please run connect again.');
      default:
        throw new DeviceFlowError(err.error ?? 'token_error', `Authorization failed (${err.error ?? res.status}).`);
    }

    // Still pending — wait between polls, bounded by the overall deadline.
    if (now() >= deadline) {
      throw new DeviceFlowError('expired_token', 'The sign-in request timed out. Please run connect again.');
    }
    await sleep(intervalSeconds * 1000);
  }
}
