-- 064-key-audit-updated.sql
-- RSH-146: key edits (incl. preset-binding changes) are audited with a new
-- 'updated' event type. Additive: widen the event_type CHECK (mirror the
-- migration-046 pattern: drop + re-add with the new value; the TS union in
-- admin/keys.ts TEAM_AUDIT_EVENT_TYPES stays the runtime allowlist).

ALTER TABLE api_key_audit_events DROP CONSTRAINT IF EXISTS api_key_audit_events_event_type_values;
ALTER TABLE api_key_audit_events ADD CONSTRAINT api_key_audit_events_event_type_values
  CHECK (event_type IN ('created', 'revoked', 'rotated', 'updated', 'auth_failed', 'rate_limited', 'budget_exceeded', 'sso_issued'));
