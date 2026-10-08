-- Idempotent savings reporting.
--
-- One row per (team, billing window) that has been reported to the Stripe
-- savings meter. The primary key makes it impossible to bill the same window
-- twice — even across a process crash and even if Stripe's own meter-event
-- dedup window has lapsed (our reporter runs every 24h, which can exceed it).
--
-- The reporter claims a window here (INSERT ... ON CONFLICT DO NOTHING) BEFORE
-- calling Stripe; if the claim conflicts, the window was already billed and is
-- skipped. On a Stripe failure the claim row is deleted so the window retries.
-- This favors at-most-once (a rare crash-window skip, no customer harm) over
-- ever double-charging a customer.
CREATE TABLE IF NOT EXISTS savings_reports (
  team_id      TEXT        NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  window_end   TIMESTAMPTZ NOT NULL,
  share_cents  BIGINT      NOT NULL,
  reported_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, window_start)
);
