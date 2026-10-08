import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { attachMintedKey, pollToken } from '@/lib/oauth-device-service';
import { mintIdentityKey, revokeKeyQuietly } from '@/lib/oauth-key-mint';
import { DEVICE_CODE_GRANT_TYPE, parseOAuthBody } from '@/lib/oauth-http';
import { mintedKeyTtlHours, normalizeDeviceScope } from '@/lib/oauth-device';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '@/lib/rate-limit';

// POST /api/oauth/token  (RFC 8628 §3.4–3.5)
// Public, unauthenticated: the device polls this with its device_code. While
// pending it gets authorization_pending / slow_down; once the user has
// approved in the browser, the *first* successful poll mints an
// identity-scoped key and returns it exactly once.
function oauthError(error: string, status = 400) {
  return NextResponse.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request) {
  // RSH-52: unauthenticated polling endpoint. A compliant device polls every
  // ~5s (≈12/min); cap per IP well above that to stop device_code-guessing and
  // polling storms while leaving legitimate multi-device NAT traffic room.
  const rl = checkRateLimit(`oauth:token:${getClientIp(request)}`, {
    limit: 60,
    windowMs: 60_000,
  });
  if (!rl.allowed) return rateLimitedResponse(rl);

  const body = await parseOAuthBody(request);

  if (body.grant_type !== DEVICE_CODE_GRANT_TYPE) {
    return oauthError('unsupported_grant_type');
  }
  const deviceCode = body.device_code?.trim();
  if (!deviceCode) {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'device_code is required' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  let pool: ReturnType<typeof getPool>;
  let outcome;
  try {
    pool = getPool();
    outcome = await pollToken(pool, deviceCode);
  } catch (err) {
    console.error('oauth/token poll failed:', err);
    return oauthError('server_error', 500);
  }

  switch (outcome.status) {
    case 'authorization_pending':
    case 'slow_down':
    case 'expired_token':
    case 'access_denied':
    case 'invalid_grant':
      return oauthError(outcome.status);
    case 'ready_to_mint':
      break;
  }

  // Approved and not yet redeemed → mint the identity-scoped key now, so the
  // secret never sits at rest in our DB. Claim the authorization atomically;
  // if a concurrent poll beat us, revoke the duplicate we just minted.
  const row = outcome.row;
  if (!row.team_id) {
    // Should be impossible (approve sets team_id), but never mint without one.
    return oauthError('server_error', 500);
  }
  // Defense in depth for authorizations created by an older dashboard build
  // or inserted outside the public route: never mint a scope the current
  // consent and enforcement layers do not understand.
  const normalizedScope = normalizeDeviceScope(row.scope);
  if (!normalizedScope.ok) return oauthError('invalid_scope');

  try {
    const minted = await mintIdentityKey({
      teamId: row.team_id,
      userId: row.user_id,
      email: row.user_email,
      scope: normalizedScope.scope,
      clientName: row.client_name,
    });

    const won = await attachMintedKey(pool, row.id, {
      apiKeyId: minted.id,
      teamId: row.team_id,
      userId: row.user_id,
      email: row.user_email,
    });
    if (!won) {
      await revokeKeyQuietly(minted.id, row.team_id);
      return oauthError('invalid_grant');
    }

    return NextResponse.json(
      {
        access_token: minted.key,
        token_type: 'bearer',
        scope: normalizedScope.scope,
        expires_in: mintedKeyTtlHours() * 3600,
        key_prefix: minted.prefix,
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    console.error('oauth/token mint failed:', err);
    return oauthError('server_error', 500);
  }
}
