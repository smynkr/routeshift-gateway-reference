// apps/proxy/src/oauth/sso-device-handlers.ts
// RSH-100: HTTP handlers for the SSO device flow. Thin wrappers over
// sso-device-service.ts (state machine), idp-providers.ts (OIDC client),
// and sso-key-mint.ts (minting) -- see those files for the tested logic
// this glues together.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getPool } from '../db/pool.js';
import { checkIpRateLimit, getTrustedClientIp } from '../rate-limit/ip-limiter.js';
import {
  createSsoDeviceAuthorization,
  DomainNotRegisteredError,
  getAuthorizationByUserCode,
  bindOAuthState,
  denyAuthorization,
  getAuthorizationByOAuthState,
  approveAuthorization,
  pollDeviceToken,
} from './sso-device-service.js';
import { hashDeviceCode } from './sso-device-flow.js';
import { resolveIdpConfigById, validateIssuerViaDiscovery } from './sso-connections.js';
import {
  buildAuthorizationUrl,
  exchangeCodeForIdToken,
  verifyIdToken,
  IdTokenVerificationError,
  DomainClaimMismatchError,
} from './idp-providers.js';
import { mintSsoKey, AuthorizationNotConsumableError } from './sso-key-mint.js';

// Fixed, statically-configured base URL for building the OAuth redirect_uri.
// Deliberately NOT derived from the request's Host header: the redirect_uri
// must exactly match what's registered in each IdP's app console, and
// trusting a client-supplied Host header for a value that gates where an
// authorization code gets redeemed would be a real vulnerability (an
// attacker-controlled Host could redirect the code exchange elsewhere).
function callbackBaseUrl(): string {
  const url = process.env.SSO_CALLBACK_BASE_URL;
  if (!url) throw new Error('SSO_CALLBACK_BASE_URL environment variable is not configured');
  return url.replace(/\/+$/, '');
}

// Requires an application/json Content-Type (an optional ";charset=..."
// suffix is allowed) before parsing the body. Without this, a cross-site
// <form enctype="text/plain"> -- submittable with no JS and no CORS
// preflight -- can carry a text/plain body crafted to be valid JSON, and
// this function would parse it anyway. That would let an attacker's page
// silently drive handleDeviceVerifyPost's approve action, bypassing the
// human-confirmation step that's this flow's load-bearing phishing defense.
function hasJsonContentType(req: IncomingMessage): boolean {
  const contentType = req.headers['content-type'];
  return typeof contentType === 'string' && /^application\/json\s*(;|$)/i.test(contentType);
}

// Cap on the buffered request-body size for the unauthenticated /oauth/device/*
// routes. Every body here is tiny JSON (an email, a user_code, or a
// device_code), so 64KB is generous. Without a cap, readJsonBody would buffer
// an attacker's arbitrarily large body fully into memory before parsing -- an
// unauthenticated heap-exhaustion (OOM) vector on the single proxy instance.
// The money path (proxy-handler.ts) enforces config.maxRequestBodyBytes/413 for
// exactly this reason; this is the device-flow equivalent (an over-cap body
// yields null here, which every caller already maps to a 400).
const MAX_JSON_BODY_BYTES = 64 * 1024;

// Per-IP ceiling for POST /oauth/device/token, applied ON TOP OF the
// device_code-keyed limiter. Deliberately far more generous than the sibling
// endpoints' per-IP caps (device-code 10/min, verify 30/min, callback 60/min):
// legitimate polling is frequent and a NAT'd corporate office may have many
// employees polling distinct device_codes through one egress IP during a
// company-wide SSO rollout. The point is only to put SOME ceiling on a
// single-IP flood of fresh device_codes -- which each land in a brand-new
// device_code-keyed bucket and so would otherwise never be throttled at all.
export const TOKEN_IP_RATE_LIMIT = 600;

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  if (!hasJsonContentType(req)) return null;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    // Over cap: stop buffering and reject (caller maps null -> 400). Returning
    // here abandons the rest of the stream; the caller sends a response and
    // ends, and Node discards the unread remainder -- same shape as
    // proxy-handler.ts's 413 path.
    if (total > MAX_JSON_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString());
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Escapes HTML metacharacters so client-controlled values (e.g. user_code)
// can be safely interpolated into HTML text nodes and attribute values.
// Do not rely on any upstream normalization/validation to make interpolation
// "safe" -- this file must escape at the render site regardless.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Safely embeds a client-controlled string as a JS string literal inside an
// inline <script> block. JSON.stringify() handles quote/backslash/control-char
// escaping correctly, but the HTML parser scans raw script content for a
// literal "</script" sequence irrespective of JS string/quote boundaries --
// a user_code containing "</script>" could otherwise prematurely close the
// surrounding <script> element and inject arbitrary markup after it. Escaping
// every "<" as its unicode escape closes that off entirely.
function jsStringLiteral(s: string): string {
  return JSON.stringify(s).replace(/</g, '\\u003C');
}

// errorDescription is optional and additive -- every existing call site
// that omits it keeps returning exactly the same body shape as before.
function oauthError(res: ServerResponse, error: string, status = 400, errorDescription?: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  const body: Record<string, string> = { error };
  if (errorDescription) body.error_description = errorDescription;
  res.end(JSON.stringify(body));
}

function rateLimited(req: IncomingMessage, res: ServerResponse, bucket: string, limit: number): boolean {
  const ip = getTrustedClientIp(req);
  const result = checkIpRateLimit(`sso:${bucket}:${ip}`, { limit, windowMs: 60_000 });
  if (!result.allowed) {
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Retry-After': String(result.retryAfterSec),
    });
    res.end(JSON.stringify({ error: 'rate_limited' }));
    return true;
  }
  return false;
}

// Rate-limits POST /oauth/device/token keyed by device_code rather than
// source IP. Per the design spec's Error handling section
// ([reviewed: gemini]): device_code is the right key for /token polling --
// unlike the /verify user_code-guessing case, IP-keying /token would let
// multiple legitimate employees behind one shared/NAT'd corporate IP
// false-positive rate-limit each other's independent polling during a
// company-wide SSO rollout. Reuses checkIpRateLimit directly: despite the
// module name, it's a generic sliding-window limiter keyed by an arbitrary
// string -- IP is just its usual key. The key is hashed (not the raw
// device_code) before use so the bearer secret itself never has to be
// carried as an in-memory Map key, even though this store is process-local
// and never persisted/logged -- cheap, and slightly more defensive.
function deviceTokenRateLimited(res: ServerResponse, deviceCode: string): boolean {
  const key = `sso:token:${hashDeviceCode(deviceCode)}`;
  const result = checkIpRateLimit(key, { limit: 60, windowMs: 60_000 });
  if (!result.allowed) {
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Retry-After': String(result.retryAfterSec),
    });
    res.end(JSON.stringify({ error: 'rate_limited' }));
    return true;
  }
  return false;
}

// POST /oauth/device/code
export async function handleDeviceCode(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (rateLimited(req, res, 'device-code', 10)) return;

  const body = await readJsonBody(req);
  const emailOrDomain = body?.email;
  if (typeof emailOrDomain !== 'string' || emailOrDomain.length === 0) {
    return oauthError(res, 'invalid_request', 400);
  }

  try {
    const { response } = await createSsoDeviceAuthorization(getPool(), emailOrDomain, callbackBaseUrl());
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(response));
  } catch (err) {
    if (err instanceof DomainNotRegisteredError) {
      // DomainNotRegisteredError's message is a FIXED, always-identical
      // string regardless of why the lookup failed (malformed email vs.
      // well-formed-but-unregistered domain), so surfacing it carries no
      // enumeration signal -- see that class's own comment. /oauth/device/code
      // is typically driven by a CLI tool that shows this directly to a
      // confused first-time user, so pass it through as error_description
      // per the design spec's Error handling section.
      return oauthError(res, 'invalid_request', 400, err.message);
    }
    throw err;
  }
}

// GET /oauth/device/verify?user_code=...
export async function handleDeviceVerifyGet(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (rateLimited(req, res, 'verify', 30)) return;

  const url = new URL(req.url ?? '/', 'http://localhost');
  const userCode = url.searchParams.get('user_code');
  const auth = userCode ? await getAuthorizationByUserCode(getPool(), userCode) : null;
  if (!auth) {
    res.writeHead(404, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.end('<html><body>Code not found or expired.</body></html>');
    return;
  }

  // Renders a confirmation page displaying user_code prominently (phishing
  // resistance -- see the spec's "Device-code phishing" section) with
  // Approve/Deny actions before either button is submitted.
  //
  // Deliberately NOT a native <form method="POST">: a browser submitting a
  // plain form (no enctype) sends Content-Type: application/x-www-form-
  // urlencoded, which hasJsonContentType() correctly rejects (that gate is
  // the actual CSRF defense against a no-JS cross-origin form replaying this
  // page's approve/deny action -- see hasJsonContentType's comment). A native
  // form here would make the human-confirmation step itself non-functional.
  // Instead, the buttons are wired to fetch() with an explicit
  // application/json body, which both satisfies the gate and can't be
  // replicated by a no-JS cross-origin <form>.
  const safeUserCode = escapeHtml(userCode ?? '');
  const userCodeJs = jsStringLiteral(userCode ?? '');
  res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
  res.end(`<html><body>
<h1>${safeUserCode}</h1>
<p>Does this match your device?</p>
<p id="verify-status"></p>
<button id="verify-approve" type="button">Continue</button>
<button id="verify-deny" type="button">This isn't my code</button>
<script>
(function () {
  var userCode = ${userCodeJs};
  var statusEl = document.getElementById('verify-status');
  var approveBtn = document.getElementById('verify-approve');
  var denyBtn = document.getElementById('verify-deny');

  function submitAction(action) {
    approveBtn.disabled = true;
    denyBtn.disabled = true;
    fetch('/oauth/device/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_code: userCode, action: action }),
    })
      .then(function (res) {
        if (!res.ok) throw new Error('request_failed');
        if (action === 'approve') {
          // handleDeviceVerifyPost returns { redirect_url } (JSON) rather
          // than a raw 302 for the approve action specifically so this
          // fetch() can hand the target off to a real browser navigation --
          // fetch() follows redirects internally and invisibly, so a raw
          // 302 here would never change the tab's visible address bar.
          return res.json().then(function (data) {
            if (!data || typeof data.redirect_url !== 'string') throw new Error('missing_redirect');
            window.location.href = data.redirect_url;
          });
        }
        document.body.innerHTML = '<p>Denied. You can close this window.</p>';
      })
      .catch(function () {
        statusEl.textContent = 'Something went wrong. Please try again.';
        approveBtn.disabled = false;
        denyBtn.disabled = false;
      });
  }

  approveBtn.addEventListener('click', function () { submitAction('approve'); });
  denyBtn.addEventListener('click', function () { submitAction('deny'); });
})();
</script>
</body></html>`);
}

// POST /oauth/device/verify — approve returns the IdP authorization URL as
// JSON (deny marks the row denied). This endpoint is only ever reached via
// the verify page's own fetch() call, which sends an explicit
// application/json body (see handleDeviceVerifyGet) -- that's what lets
// hasJsonContentType()'s strict gate stay in place as the real CSRF defense.
export async function handleDeviceVerifyPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (rateLimited(req, res, 'verify', 30)) return;

  const body = await readJsonBody(req);
  const userCode = body?.user_code;
  const action = body?.action;
  if (typeof userCode !== 'string' || (action !== 'approve' && action !== 'deny')) {
    return oauthError(res, 'invalid_request', 400);
  }

  const pool = getPool();
  const auth = await getAuthorizationByUserCode(pool, userCode);
  if (!auth) return oauthError(res, 'invalid_request', 404);

  if (action === 'deny') {
    await denyAuthorization(pool, auth.id);
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.end('<html><body>Denied. You can close this window.</body></html>');
    return;
  }

  // auth.idp_config_id is already resolved (from /oauth/device/code's
  // home-realm discovery) -- look it up by id, not domain, to avoid a
  // redundant lookup and keep suspended-team exclusion consistent.
  const idpConfig = await resolveIdpConfigById(auth.idp_config_id);
  if (!idpConfig) return oauthError(res, 'invalid_request', 400);

  // Re-fetches discovery on every approve. Acceptable for a first
  // implementation (correctness over premature caching) -- see "Open
  // questions" at the end of this plan for whether to cache this.
  const discovery = await validateIssuerViaDiscovery(idpConfig.issuer);

  // bindOAuthState returns null if the row is no longer 'pending' (e.g. a
  // stale verify-page tab submitted after the row was already
  // denied/expired/approved by another tab or the sweeper) -- must not
  // redirect the browser to the IdP for a state that was never persisted,
  // since the callback would then have no row to bind back to.
  const bound = await bindOAuthState(pool, auth.id);
  if (!bound) return oauthError(res, 'invalid_request', 400);
  const { state, nonce } = bound;

  const redirectUri = `${callbackBaseUrl()}/oauth/device/callback`;
  const authUrl = buildAuthorizationUrl({
    authorizationEndpoint: discovery.authorization_endpoint,
    clientId: idpConfig.clientId,
    redirectUri,
    state,
    nonce,
  });
  // Returned as a JSON body (not a raw 302): the caller here is always the
  // verify page's own fetch(), and fetch() follows redirects internally and
  // invisibly to the tab -- a raw 302 would never change the browser's
  // visible address bar, leaving the user stuck looking at the verify page
  // with no sign of progress. The client reads redirect_url and performs the
  // actual browser navigation itself via window.location.href.
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ redirect_url: authUrl }));
}

// GET /oauth/device/callback?code=...&state=...
export async function handleDeviceCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Unlike the sibling endpoints, this one has no device_code/user_code in
  // scope to key on -- only a `state` param, which isn't known to belong to
  // any particular caller until the DB lookup below runs. IP-keying (the
  // rateLimited helper, same as handleDeviceCode/handleDeviceVerifyGet/Post)
  // is the right fit here, not deviceTokenRateLimited's device_code-keyed
  // scheme, which only applies to /token polling. This endpoint does real
  // work per request (a DB lookup, an outbound OIDC discovery fetch, and a
  // token-exchange call to the real IdP), so unlike its siblings it was
  // previously unthrottled entirely -- a flood of random `state` values is
  // cheap DB load, but a replayed/guessed-valid `state` drives real,
  // expensive outbound IdP traffic. 60/min matches this file's other
  // generous-but-present per-IP limits (handleDeviceVerifyGet/Post) and
  // comfortably covers one real human completing one real login redirect.
  if (rateLimited(req, res, 'callback', 60)) return;

  const url = new URL(req.url ?? '/', 'http://localhost');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const idpError = url.searchParams.get('error');

  const pool = getPool();

  // RFC 6749 §4.1.2.1: on a denied/failed authorization the IdP redirects back
  // with ?error=... and no code. Treat that as a denial of the pending row --
  // mark it denied so the CLI's next poll returns access_denied immediately
  // instead of spinning authorization_pending for the full 10-minute TTL, and
  // so the row's bound oauth_state stops matching a replayed callback -- rather
  // than falling through to a bare invalid_request 400 that leaves the row live.
  if (idpError) {
    if (state) {
      const pending = await getAuthorizationByOAuthState(pool, state);
      if (pending) await denyAuthorization(pool, pending.id);
    }
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.end('<html><body>Login was denied or cancelled at your identity provider. You can close this window and start over from your CLI.</body></html>');
    return;
  }

  if (!code || !state) return oauthError(res, 'invalid_request', 400);

  const auth = await getAuthorizationByOAuthState(pool, state);
  if (!auth) return oauthError(res, 'invalid_request', 400);

  const idpConfig = await resolveIdpConfigById(auth.idp_config_id);
  if (!idpConfig) return oauthError(res, 'invalid_request', 400);

  try {
    const discovery = await validateIssuerViaDiscovery(idpConfig.issuer);
    const idToken = await exchangeCodeForIdToken({
      tokenEndpoint: discovery.token_endpoint,
      clientId: idpConfig.clientId,
      clientSecret: idpConfig.clientSecret,
      code,
      redirectUri: `${callbackBaseUrl()}/oauth/device/callback`,
    });
    const identity = await verifyIdToken({
      idToken,
      issuer: idpConfig.issuer,
      jwksUri: discovery.jwks_uri,
      audience: idpConfig.clientId,
      expectedNonce: auth.oidc_nonce ?? '',
      expectedLoginDomain: idpConfig.loginDomain,
    });
    // approveAuthorization does a conditional UPDATE (WHERE status =
    // 'pending') and returns false if the row was no longer pending by the
    // time this landed (e.g. the sweeper expired it mid-flow, or the user
    // denied it in another browser tab). Not a security issue -- the CLI's
    // actual poll result is independently governed by the real DB row state
    // via pollDeviceToken, not by what this HTML says -- but unconditionally
    // telling the browser "Approved" when nothing was actually approved is a
    // real UX correctness bug, so branch on the return value.
    const approved = await approveAuthorization(pool, auth.id, identity.email);
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    if (approved) {
      res.end('<html><body>Approved. You can close this window and return to your CLI.</body></html>');
    } else {
      res.end('<html><body>This login request is no longer valid (it may have expired or already been handled). Please start over from your CLI.</body></html>');
    }
  } catch (err) {
    if (err instanceof DomainClaimMismatchError || err instanceof IdTokenVerificationError) {
      return oauthError(res, 'access_denied', 403);
    }
    throw err;
  }
}

// POST /oauth/device/token
export async function handleDeviceToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // device_code must be read and validated before the device_code-keyed
  // rate limit: unlike the other device-flow endpoints, that limiter is keyed
  // by device_code (see deviceTokenRateLimited's comment), so there's no valid
  // key to check against until the body has been parsed. A missing/malformed
  // device_code gets its 400 without ever needing to pass a rate-limit check.
  // A per-IP ceiling is also applied below, once a real device_code is in hand.
  const body = await readJsonBody(req);
  const deviceCode = body?.device_code;
  if (typeof deviceCode !== 'string' || deviceCode.length === 0) {
    return oauthError(res, 'invalid_request', 400);
  }

  // Two independent limits apply once a real device_code is in hand (both
  // checked AFTER the missing-code 400 above -- a request with no device_code
  // needs no rate check and computes no key). The per-IP ceiling stops a
  // single IP from flooding with fresh device_codes; the device_code-keyed
  // limiter bounds abuse of any one grant. See TOKEN_IP_RATE_LIMIT's comment
  // for why the per-IP cap is intentionally generous.
  if (rateLimited(req, res, 'token-ip', TOKEN_IP_RATE_LIMIT)) return;
  if (deviceTokenRateLimited(res, deviceCode)) return;

  const outcome = await pollDeviceToken(getPool(), deviceCode);
  if (outcome.status !== 'ready_to_mint') {
    return oauthError(res, outcome.status, 400);
  }

  if (!outcome.row.verified_email) {
    return oauthError(res, 'server_error', 500);
  }

  let minted;
  try {
    minted = await mintSsoKey({
      teamId: outcome.row.team_id,
      email: outcome.row.verified_email,
      authorizationId: outcome.row.id,
    });
  } catch (err) {
    // mintSsoKey's own exactly-once consume guard: if the
    // device_authorizations row is no longer 'approved' by the time the
    // mint transaction's FOR UPDATE lock resolves (e.g. a concurrent poll
    // already consumed it), this is functionally the same as replaying an
    // already-used device_code -- map it to the same invalid_grant an
    // already-consumed row gets from pollDeviceToken itself, not a 500.
    if (err instanceof AuthorizationNotConsumableError) {
      return oauthError(res, 'invalid_grant', 400);
    }
    throw err;
  }

  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({
    access_token: minted.key,
    token_type: 'bearer',
    expires_in: Math.round((minted.expiresAt.getTime() - Date.now()) / 1000),
    key_prefix: minted.prefix,
  }));
}
