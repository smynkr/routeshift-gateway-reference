-- Migration 009: Add overdraft limit constraint
ALTER TABLE credit_balances
  ADD CONSTRAINT chk_overdraft_limit_negative
  CHECK (overdraft_limit_microcents <= 0);
