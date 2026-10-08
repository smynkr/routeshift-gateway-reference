// RTSH-1: small HTTP helpers shared by the OAuth route handlers. RFC 8628
// clients send application/x-www-form-urlencoded, but we also accept JSON so
// the bundled connect CLI and curl-based testing both work.

export async function parseOAuthBody(request: Request): Promise<Record<string, string>> {
  const contentType = request.headers.get('content-type') ?? '';
  try {
    if (contentType.includes('application/json')) {
      const json = await request.json();
      if (!json || typeof json !== 'object' || Array.isArray(json)) return {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(json)) {
        if (typeof v === 'string') out[k] = v;
      }
      return out;
    }
    // Default: treat as form-encoded (the RFC's wire format).
    const text = await request.text();
    const params = new URLSearchParams(text);
    const out: Record<string, string> = {};
    for (const [k, v] of params) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/**
 * The public issuer origin used to build verification URIs. Prefer an explicit
 * configured value so the link a user sees points at the canonical domain even
 * behind a proxy; fall back to the request origin for local dev.
 */
export function resolveIssuerBaseUrl(request: Request): string {
  const configured =
    process.env.OAUTH_ISSUER_URL ??
    process.env.AUTH_URL ??
    process.env.NEXTAUTH_URL ??
    process.env.NEXT_PUBLIC_APP_URL;
  if (configured) return configured.replace(/\/+$/, '');
  return new URL(request.url).origin;
}

export const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/**
 * CSRF defense for the cookie-authenticated, state-changing approve/deny
 * endpoints. They are only ever called by the first-party /device page, so we
 * require the request's Origin (or, for browsers that omit it on same-origin
 * POSTs, the Referer) to match a known dashboard origin. A cross-site form or
 * fetch carries the attacker's Origin (or none), and is rejected — closing the
 * "trick a logged-in user into approving the attacker's device_code" hole.
 *
 * This is independent of the session cookie's SameSite setting, so it holds
 * even if that configuration changes. The public token/device-code endpoints
 * are unauthenticated and intentionally do NOT use this.
 */
export function isSameOriginRequest(request: Request): boolean {
  const allowed = new Set<string>();
  try {
    allowed.add(new URL(request.url).origin);
  } catch {
    /* request.url should always parse; ignore if not */
  }
  for (const value of [
    process.env.OAUTH_ISSUER_URL,
    process.env.AUTH_URL,
    process.env.NEXTAUTH_URL,
    process.env.NEXT_PUBLIC_APP_URL,
  ]) {
    if (value) {
      try {
        allowed.add(new URL(value).origin);
      } catch {
        /* skip malformed config */
      }
    }
  }

  const origin = request.headers.get('origin');
  if (origin) return allowed.has(origin);

  // No Origin header (some browsers omit it on same-origin POSTs): fall back to
  // the Referer's origin. Absent both on a state-changing authenticated request
  // → reject.
  const referer = request.headers.get('referer');
  if (referer) {
    try {
      return allowed.has(new URL(referer).origin);
    } catch {
      return false;
    }
  }
  return false;
}
