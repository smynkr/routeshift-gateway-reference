-- RSH-92: durable auto-topup attempts and exact system-disable reasons.
--
-- A durable attempt owns one Stripe idempotency key across process restarts.
-- This closes the crash window where a retry in a later five-minute bucket
-- could otherwise create a second real charge before the prior charge was
-- credited or reflected in last_topup_at.
ALTER TABLE auto_topup_settings
  ADD COLUMN IF NOT EXISTS disabled_reason TEXT,
  ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;

ALTER TABLE auto_topup_settings
  DROP CONSTRAINT IF EXISTS auto_topup_settings_disabled_state_check;
ALTER TABLE auto_topup_settings
  ADD CONSTRAINT auto_topup_settings_disabled_state_check CHECK (
    (disabled_reason IS NULL AND disabled_at IS NULL)
    OR (disabled_reason IS NOT NULL AND disabled_at IS NOT NULL AND enabled = false)
  );

CREATE TABLE IF NOT EXISTS auto_topup_attempts (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL UNIQUE,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  amount_microcents BIGINT NOT NULL CHECK (amount_microcents = amount_cents * 1000000),
  stripe_customer_id TEXT NOT NULL,
  stripe_payment_method_id TEXT NOT NULL,
  payment_intent_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'charged', 'settled', 'failed', 'reconciliation_required')),
  stripe_status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at TIMESTAMPTZ,
  charged_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('charged', 'settled') OR payment_intent_id IS NOT NULL),
  CHECK (status <> 'settled' OR (charged_at IS NOT NULL AND settled_at IS NOT NULL))
);

-- A team can have only one unresolved external-money operation. A pending row
-- deliberately remains active after an ambiguous Stripe/network failure so the
-- next worker reuses its stable idempotency key instead of minting a new charge.
CREATE UNIQUE INDEX IF NOT EXISTS idx_auto_topup_attempts_one_active_team
  ON auto_topup_attempts (team_id)
  WHERE status IN ('pending', 'charged', 'reconciliation_required');

CREATE INDEX IF NOT EXISTS idx_auto_topup_attempts_team_charge_window
  ON auto_topup_attempts (team_id, COALESCE(charged_at, created_at) DESC)
  WHERE status IN ('pending', 'charged', 'settled');
