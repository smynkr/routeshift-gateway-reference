// In-memory stand-in for the pg pool that understands exactly the queries the
// OAuth device-flow service issues. It lets the state machine and route
// handlers be exercised end-to-end without a real Postgres, while still
// honoring the conditional WHERE clauses the concurrency guards depend on.

import type { DeviceAuthRow } from '@/lib/oauth-device-service';
import type { Queryable } from '@/lib/db-types';

export interface KeyIdentityRow {
  api_key_id: string;
  team_id: string;
  user_id: string | null;
  email: string | null;
  created_via: string;
}

export class FakeDevicePool implements Queryable {
  authorizations: DeviceAuthRow[] = [];
  keyIdentities: KeyIdentityRow[] = [];
  allowedDomains: Array<{ team_id: string; domain: string }> = [];
  users: Array<{ id: string; email: string }> = [];
  /** When set, the next api_key_id claim loses the race (rowCount 0). */
  forceAttachLoss = false;

  query = async (sql: string, params: unknown[] = []): Promise<{ rows: any[]; rowCount: number | null }> => {
    // --- oauth_device_authorizations -------------------------------------
    if (sql.includes('INSERT INTO oauth_device_authorizations')) {
      const [id, hash, userCode, clientId, clientName, scope, interval, expiresAt] = params as any[];
      this.authorizations.push({
        id,
        device_code_hash: hash,
        user_code: userCode,
        client_id: clientId,
        client_name: clientName,
        scope,
        status: 'pending',
        team_id: null,
        user_id: null,
        user_email: null,
        api_key_id: null,
        interval_seconds: interval,
        last_polled_at: null,
        approved_at: null,
        expires_at: new Date(expiresAt),
        created_at: new Date(),
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('FROM oauth_device_authorizations WHERE user_code')) {
      const row = this.authorizations.find((a) => a.user_code === params[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.includes('FROM oauth_device_authorizations WHERE device_code_hash')) {
      const row = this.authorizations.find((a) => a.device_code_hash === params[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.includes("SET status = 'approved'")) {
      const [id, teamId, userId, userEmail, now] = params as any[];
      const row = this.authorizations.find((a) => a.id === id && a.status === 'pending');
      if (!row) return { rows: [], rowCount: 0 };
      row.status = 'approved';
      row.team_id = teamId;
      row.user_id = userId;
      row.user_email = userEmail;
      row.approved_at = new Date(now);
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("SET status = 'denied'")) {
      const row = this.authorizations.find((a) => a.id === params[0] && a.status === 'pending');
      if (!row) return { rows: [], rowCount: 0 };
      row.status = 'denied';
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("SET status = 'expired'")) {
      const row = this.authorizations.find((a) => a.id === params[0] && a.status === 'pending');
      if (!row) return { rows: [], rowCount: 0 };
      row.status = 'expired';
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('SET last_polled_at')) {
      const row = this.authorizations.find((a) => a.id === params[0]);
      if (row) row.last_polled_at = new Date(params[1] as any);
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (sql.includes('SET api_key_id')) {
      const [id, apiKeyId] = params as any[];
      if (this.forceAttachLoss) {
        this.forceAttachLoss = false;
        return { rows: [], rowCount: 0 };
      }
      const row = this.authorizations.find(
        (a) => a.id === id && a.status === 'approved' && a.api_key_id === null,
      );
      if (!row) return { rows: [], rowCount: 0 };
      row.api_key_id = apiKeyId;
      return { rows: [], rowCount: 1 };
    }

    // --- key_identities --------------------------------------------------
    if (sql.includes('INSERT INTO key_identities')) {
      const [apiKeyId, teamId, userId, email] = params as any[];
      if (!this.keyIdentities.some((k) => k.api_key_id === apiKeyId)) {
        this.keyIdentities.push({
          api_key_id: apiKeyId,
          team_id: teamId,
          user_id: userId,
          email,
          created_via: 'oauth_device',
        });
      }
      return { rows: [], rowCount: 1 };
    }

    // --- allowed_email_domains ------------------------------------------
    if (sql.includes('FROM allowed_email_domains')) {
      const [teamId, domain] = params as any[];
      const match = this.allowedDomains.some(
        (d) => d.team_id === teamId && d.domain.toLowerCase() === domain,
      );
      return { rows: match ? [{ ok: 1 }] : [], rowCount: match ? 1 : 0 };
    }

    // --- users -----------------------------------------------------------
    if (sql.includes('SELECT email FROM users')) {
      const u = this.users.find((x) => x.id === params[0]);
      return { rows: u ? [{ email: u.email }] : [], rowCount: u ? 1 : 0 };
    }

    throw new Error(`FakeDevicePool: unhandled query: ${sql}`);
  };
}
