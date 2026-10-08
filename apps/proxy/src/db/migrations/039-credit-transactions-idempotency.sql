-- 039: make auto-topup credit application idempotent on the Stripe PaymentIntent.
--
-- addCredits (the auto-topup path) bumped the balance and inserted a ledger row with
-- no dedup, so a crash/retry that replayed the same already-succeeded PaymentIntent
-- (Stripe returns the same charge for an idempotency-keyed create) could credit a
-- team twice for a single charge. A nullable idempotency_key column plus a partial
-- unique index makes the credit at-most-once per key.
--
-- The column is NULL for every existing row, so this is purely additive: it cannot
-- conflict with historical data and cannot fail to apply on boot (unlike a unique
-- index on the shared, non-unique reference_id column would).
ALTER TABLE credit_transactions ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS credit_transactions_idempotency_key_uniq
  ON credit_transactions (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
