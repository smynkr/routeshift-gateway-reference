import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { createDeviceAuthorization } from '@/lib/oauth-device-service';
import { parseOAuthBody, resolveIssuerBaseUrl } from '@/lib/oauth-http';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '@/lib/rate-limit';
import { normalizeDeviceScope } from '@/lib/oauth-device';

// POST /api/oauth/device/code  (RFC 8628 §3.1–3.2)
// Public, unauthenticated: this is how a device with no browser starts the
// flow. Returns the device_code (polled at /api/oauth/token) and the user_code
// the human types at the verification_uri.
export async function POST(request: Request) {
  // RSH-52: unauthenticated — rate-limit per IP so this can't be used to flood
  // the DB with device-code rows (unauth DoS / enumeration surface).
  const rl = checkRateLimit(`oauth:device-code:${getClientIp(request)}`, {
    limit: 10,
    windowMs: 60_000,
  });
  if (!rl.allowed) return rateLimitedResponse(rl);

  const body = await parseOAuthBody(request);

  const clientId = body.client_id?.trim();
  if (!clientId) {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'client_id is required' },
      { status: 400 },
    );
  }
  const clientName = (body.client_name?.trim() || clientId).slice(0, 120);
  const normalizedScope = normalizeDeviceScope(body.scope);
  if (!normalizedScope.ok) {
    return NextResponse.json(
      {
        error: 'invalid_scope',
        error_description: "supported scopes are 'inference' and 'read'",
      },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  try {
    const pool = getPool();
    const baseUrl = resolveIssuerBaseUrl(request);
    const response = await createDeviceAuthorization(
      pool,
      { clientId, clientName, scope: normalizedScope.scope },
      baseUrl,
    );
    // No-store: the device_code is a bearer secret.
    return NextResponse.json(response, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    console.error('oauth/device/code failed:', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
