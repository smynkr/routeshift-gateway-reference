-- 008-credits-system.sql
-- Credits billing system: balances, transactions, purchases, auto-topup, provider keys

-- Add billing_mode to teams
ALTER TABLE teams ADD COLUMN IF NOT EXISTS billing_mode TEXT NOT NULL DEFAULT 'subscription';
DO $$ BEGIN
  ALTER TABLE teams ADD CONSTRAINT chk_teams_billing_mode CHECK (billing_mode IN ('subscription', 'credits'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Add credits_deducted_microcents to request_logs
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS credits_deducted_microcents BIGINT DEFAULT 0;

-- credit_balances
CREATE TABLE IF NOT EXISTS credit_balances (
  team_id TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  balance_microcents BIGINT NOT NULL DEFAULT 0,
  overdraft_limit_microcents BIGINT NOT NULL DEFAULT -500000000,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- credit_transactions
CREATE TABLE IF NOT EXISTS credit_transactions (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  amount_microcents BIGINT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('purchase', 'deduction', 'auto_topup')),
  reference_id TEXT,
  description TEXT,
  balance_after_microcents BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_credit_transactions_team_created
  ON credit_transactions(team_id, created_at DESC);

-- credit_purchases
CREATE TABLE IF NOT EXISTS credit_purchases (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  amount_cents BIGINT NOT NULL,
  stripe_payment_intent_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_credit_purchases_team_created
  ON credit_purchases(team_id, created_at DESC);

-- auto_topup_settings
CREATE TABLE IF NOT EXISTS auto_topup_settings (
  team_id TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  threshold_microcents BIGINT NOT NULL DEFAULT 100000000,
  reload_amount_cents BIGINT NOT NULL DEFAULT 5000,
  stripe_payment_method_id TEXT,
  last_topup_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- auto_topup_queue
CREATE TABLE IF NOT EXISTS auto_topup_queue (
  team_id TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- provider_keys
CREATE TABLE IF NOT EXISTS provider_keys (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('openai', 'anthropic', 'google', 'together', 'groq')),
  encrypted_key TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(team_id, provider)
);

-- Backfill: ensure every team has a credit_balances row
INSERT INTO credit_balances (team_id)
SELECT id FROM teams
ON CONFLICT DO NOTHING;
