// RTSH-1: org email-domain allowlist that gates device-flow self-provisioning.
//
// A signed-in user may approve a device authorization (minting a key for their
// team) only if their email's domain is allowlisted for that team. Fail closed
// everywhere: a malformed email, a missing domain, or a team with no rows all
// resolve to "not allowed". This gates ONLY the self-serve device flow; the
// admin-push POST /admin/keys path is unaffected.

import type { Queryable } from './db-types';

/** Lowercased registrable domain portion of an email, or null if malformed. */
export function emailDomain(email: string): string | null {
  if (typeof email !== 'string') return null;
  const at = email.lastIndexOf('@');
  if (at < 0 || at === email.length - 1) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  // Reject anything that still doesn't look like a domain (no dot, stray @).
  if (domain.length === 0 || domain.includes('@') || !domain.includes('.')) {
    return null;
  }
  return domain;
}

export async function isEmailDomainAllowed(
  pool: Queryable,
  teamId: string,
  email: string,
): Promise<boolean> {
  const domain = emailDomain(email);
  if (!domain || !teamId) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM allowed_email_domains
      WHERE team_id = $1 AND lower(domain) = $2
      LIMIT 1`,
    [teamId, domain],
  );
  return rows.length > 0;
}
