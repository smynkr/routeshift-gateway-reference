-- Promo codes for complimentary upgrades / testing
CREATE TABLE IF NOT EXISTS promo_codes (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL DEFAULT 'starter',
  credits_cents BIGINT NOT NULL DEFAULT 0,
  max_uses INTEGER NOT NULL DEFAULT 1,
  uses_count INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Track which promo code was used for a subscription
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS promo_code_id TEXT REFERENCES promo_codes(id);

-- Team auto-routing settings
CREATE TABLE IF NOT EXISTS team_auto_route_settings (
  team_id TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  strategy TEXT NOT NULL DEFAULT 'balanced' CHECK (strategy IN ('cheapest', 'fastest', 'balanced')),
  max_fallbacks INTEGER NOT NULL DEFAULT 2,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
