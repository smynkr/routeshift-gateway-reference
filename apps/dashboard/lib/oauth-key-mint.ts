// RTSH-1: mint an identity-scoped RouteShift key by reusing the proxy's
// existing /admin/keys path. The minted key is a normal team key (NOT an
// org-wide admin secret), carries identity + provenance in its metadata, and
// is short-lived so a Revoke stays effective after it's been copied into
// several tool configs. It is revocable through the existing Revoke flow.

import { PROXY_URL, adminHeaders, assertAdminSecret } from './proxy';
import { mintedKeyTtlHours } from './oauth-device';

export interface MintedKey {
  id: string;
  key: string;
  prefix: string;
}

export interface MintIdentityKeyInput {
  teamId: string;
  userId: string | null;
  email: string | null;
  scope: string;
  clientName: string;
  now?: Date;
}

export async function mintIdentityKey(input: MintIdentityKeyInput): Promise<MintedKey> {
  assertAdminSecret();
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + mintedKeyTtlHours() * 3600 * 1000).toISOString();

  const body = {
    team_id: input.teamId,
    name: `Connect: ${input.clientName}`.slice(0, 80),
    environment: 'live',
    actor_user_id: input.userId ?? undefined,
    expires_at: expiresAt,
    metadata: {
      created_via: 'oauth_device',
      identity_user_id: input.userId,
      identity_email: input.email,
      scope: input.scope,
      client_name: input.clientName,
    },
  };

  const res = await fetch(`${PROXY_URL}/admin/keys`, {
    method: 'POST',
    headers: adminHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Key mint failed: proxy returned ${res.status}`);
  }
  const json = (await res.json()) as { id?: string; key?: string; prefix?: string };
  if (!json.id || !json.key || !json.prefix) {
    throw new Error('Key mint failed: proxy response missing id/key/prefix');
  }
  return { id: json.id, key: json.key, prefix: json.prefix };
}

/**
 * Best-effort revoke used to clean up a duplicate key minted when two polls
 * race for the same authorization. Never throws — a failed cleanup is logged
 * and the key simply expires on its own short TTL.
 */
export async function revokeKeyQuietly(keyId: string, teamId: string): Promise<void> {
  try {
    assertAdminSecret();
    await fetch(`${PROXY_URL}/admin/keys/${encodeURIComponent(keyId)}?team_id=${encodeURIComponent(teamId)}`, {
      method: 'DELETE',
      headers: adminHeaders(),
    });
  } catch (err) {
    console.error('oauth-key-mint: duplicate-key cleanup failed (non-fatal):', err);
  }
}
