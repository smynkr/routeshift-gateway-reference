-- Serialize every credit-bearing Stripe PaymentIntent (Checkout credits and
-- auto-topups) across the proxy worker, payment webhooks, and reversal
-- webhooks. This parent row is the cross-process lock that prevents a reversal
-- from being committed just before a concurrent credit.
CREATE TABLE IF NOT EXISTS credit_payment_intents (
  payment_intent_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  credit_kind TEXT NOT NULL CHECK (credit_kind IN ('purchase', 'auto_topup')),
  amount_microcents BIGINT NOT NULL CHECK (amount_microcents > 0),
  credit_applied BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Persist Stripe refunds and disputes even when they arrive before either
-- credit writer records its positive ledger row. Credit writers lock the
-- parent before reconciling this child state.
CREATE TABLE IF NOT EXISTS credit_payment_reversals (
  payment_intent_id TEXT NOT NULL,
  reversal_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('refund', 'dispute')),
  amount_microcents BIGINT NOT NULL CHECK (amount_microcents > 0),
  -- A dispute withdrawal is active until Stripe returns its funds. Refunds
  -- remain active permanently because their money is not reinstated.
  status TEXT NOT NULL CHECK (status IN ('active', 'reinstated')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (payment_intent_id, reversal_id),
  FOREIGN KEY (payment_intent_id)
    REFERENCES credit_payment_intents(payment_intent_id)
    ON DELETE CASCADE,
  CHECK (kind = 'dispute' OR status = 'active')
);

CREATE INDEX IF NOT EXISTS idx_credit_payment_intents_team_created
  ON credit_payment_intents (team_id, created_at DESC);

-- Legacy auto-topup rows may have a NULL idempotency_key (migration 039); the
-- reducer still resolves those by PaymentIntent reference_id during bootstrap.
CREATE INDEX IF NOT EXISTS idx_credit_transactions_auto_topup_reference
  ON credit_transactions (reference_id)
  WHERE type = 'auto_topup' AND reference_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_credit_transactions_auto_topup_reference
  ON credit_transactions (reference_id)
  WHERE type = 'auto_topup' AND reference_id IS NOT NULL;
