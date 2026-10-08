-- RSH-149: request-scoped credit reservation lifecycle. A row is created in
-- the same transaction as the debit before dispatch, moved to pending when
-- provider spend is unknown, and only terminalised by an explicit operator
-- reconciliation. Normal exact settlements delete their row to avoid an
-- unbounded terminal-row table.
CREATE TABLE IF NOT EXISTS pending_unknown_cost_holds (
  team_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  reserved_microcents BIGINT NOT NULL,
  known_charge_microcents BIGINT NOT NULL DEFAULT 0,
  uncollected_known_charge_microcents BIGINT NOT NULL DEFAULT 0,
  held_microcents BIGINT NOT NULL DEFAULT 0,
  unknown_cost_estimate_microcents BIGINT,
  markup_percent NUMERIC NOT NULL DEFAULT 0,
  reason_code TEXT NOT NULL DEFAULT 'credit_reservation',
  unknown_attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'reserved',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolution_raw_cost_microcents BIGINT,
  resolution_charge_microcents BIGINT,
  resolution_evidence TEXT,
  resolution_note TEXT,
  resolved_by TEXT,
  CONSTRAINT pending_unknown_cost_holds_pkey PRIMARY KEY (team_id, request_id),
  CONSTRAINT pending_unknown_cost_holds_team_fk FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  CONSTRAINT pending_unknown_cost_holds_reserved_nonnegative CHECK (reserved_microcents >= 0),
  CONSTRAINT pending_unknown_cost_holds_known_charge_nonnegative CHECK (known_charge_microcents >= 0),
  CONSTRAINT pending_unknown_cost_holds_uncollected_known_charge_nonnegative CHECK (uncollected_known_charge_microcents >= 0),
  CONSTRAINT pending_unknown_cost_holds_held_bounds CHECK (
    held_microcents >= 0 AND held_microcents <= reserved_microcents
  ),
  CONSTRAINT pending_unknown_cost_holds_estimate_nonnegative CHECK (
    unknown_cost_estimate_microcents IS NULL OR unknown_cost_estimate_microcents >= 0
  ),
  CONSTRAINT pending_unknown_cost_holds_markup_nonnegative CHECK (markup_percent >= 0),
  CONSTRAINT pending_unknown_cost_holds_reason_nonempty CHECK (length(trim(reason_code)) > 0),
  CONSTRAINT pending_unknown_cost_holds_unknown_attempts_nonnegative CHECK (unknown_attempts >= 0),
  CONSTRAINT pending_unknown_cost_holds_status_valid CHECK (
    status IN ('reserved', 'pending', 'reconciliation_required', 'reconciled', 'released')
  ),
  CONSTRAINT pending_unknown_cost_holds_resolution_values_nonnegative CHECK (
    resolution_raw_cost_microcents IS NULL OR resolution_raw_cost_microcents >= 0
  ),
  CONSTRAINT pending_unknown_cost_holds_resolution_charge_nonnegative CHECK (
    resolution_charge_microcents IS NULL OR resolution_charge_microcents >= 0
  ),
  CONSTRAINT pending_unknown_cost_holds_terminal_resolution CHECK (
    status NOT IN ('reconciled', 'released')
    OR (resolved_at IS NOT NULL AND resolution_raw_cost_microcents IS NOT NULL
        AND resolution_charge_microcents IS NOT NULL
        AND uncollected_known_charge_microcents = 0
        AND length(trim(COALESCE(resolution_evidence, ''))) > 0
        AND length(trim(COALESCE(resolution_note, ''))) > 0
        AND length(trim(COALESCE(resolved_by, ''))) > 0)
  )
);

CREATE INDEX IF NOT EXISTS idx_pending_unknown_cost_holds_active
  ON pending_unknown_cost_holds (status, updated_at ASC)
  WHERE status IN ('reserved', 'pending', 'reconciliation_required');
