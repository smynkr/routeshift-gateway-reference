// Pure retry-detection / per-session aggregation for LAY-314 phase 3.
//
// Lives separately from session-aggregator.ts so unit tests can exercise
// the algorithm without pulling in the pg-driven cron wrapper.
//
// A retry cycle inside a session is the pattern Edit → Bash → Edit on the
// same file path within ≤3 turns: walk turns in order, and for each edit
// turn check whether some prior edit turn within the last 3 turns hit a
// path that overlaps the current turn AND a Bash ran somewhere between.
// one_shot_rate = (edit_turns − retry_turns) / edit_turns, or null when
// the session had no edit turns (so empty sessions don't drag the avg).

const RETRY_LOOKBACK_TURNS = 3;

export interface TurnRow {
  timestamp: Date;
  model_resolved: string | null;
  edited_paths: string[] | null;
  had_bash: boolean | null;
  /** Provider/routing cost; deliberately not mutated by plugin billing. */
  actual_cost_microcents: string | number | null;
  /** False when this request's numeric provider cost is only a lower bound. */
  actual_cost_known?: boolean | null;
  /** Measured plugin surcharge. Historical rows may not have the column. */
  plugin_cost_microcents?: string | number | null;
}

export interface SessionStats {
  edit_turns: number;
  retry_turns: number;
  one_shot_rate: number | null;
  primary_model: string | null;
  /** Provider/routing cost retained for legacy routing-efficiency consumers. */
  total_cost_microcents: bigint;
  /** Customer billed spend: provider/routing cost plus plugin surcharges. */
  billed_cost_microcents: bigint;
  /** Request count whose cost makes the session's spend a lower bound. */
  unknown_cost_requests: number;
  first_request_at: Date;
  last_request_at: Date;
}

export function computeSessionStats(turns: TurnRow[]): SessionStats {
  let edit_turns = 0;
  let retry_turns = 0;
  let routing_cost = 0n;
  let billed_cost = 0n;
  let unknown_cost_requests = 0;
  const modelCounts = new Map<string, number>();

  // Track indices of prior edit turns so retry detection stays O(turns).
  const editHistory: Array<{ idx: number; paths: Set<string> }> = [];

  for (let idx = 0; idx < turns.length; idx++) {
    const t = turns[idx]!;
    const paths: string[] = Array.isArray(t.edited_paths) ? t.edited_paths : [];
    const isEditTurn = paths.length > 0;

    if (isEditTurn) {
      edit_turns++;
      const pathSet = new Set(paths);

      const retried = editHistory.some((past) => {
        if (idx - past.idx > RETRY_LOOKBACK_TURNS) return false;
        let bashBetween = false;
        for (let j = past.idx + 1; j < idx; j++) {
          if (turns[j]?.had_bash) {
            bashBetween = true;
            break;
          }
        }
        if (!bashBetween) return false;
        for (const p of pathSet) if (past.paths.has(p)) return true;
        return false;
      });
      if (retried) retry_turns++;

      editHistory.push({ idx, paths: pathSet });
    }

    if (t.model_resolved) {
      modelCounts.set(t.model_resolved, (modelCounts.get(t.model_resolved) ?? 0) + 1);
    }
    // Preserve the established routing-only total for legacy consumers and
    // carry customer spend in a separate billed field. This lets plugin fees
    // appear in billing/yield views without corrupting routing-efficiency and
    // savings semantics.
    const actualCost = parseMicrocents(t.actual_cost_microcents);
    routing_cost += actualCost;
    billed_cost += actualCost + parseMicrocents(t.plugin_cost_microcents);
    if (t.actual_cost_known === false) unknown_cost_requests++;
  }

  const one_shot_rate =
    edit_turns > 0 ? (edit_turns - retry_turns) / edit_turns : null;

  let primary_model: string | null = null;
  let max = 0;
  for (const [m, c] of modelCounts) {
    if (c > max) {
      primary_model = m;
      max = c;
    }
  }

  const first_request_at = turns[0]!.timestamp;
  const last_request_at = turns[turns.length - 1]!.timestamp;

  return {
    edit_turns,
    retry_turns,
    one_shot_rate,
    primary_model,
    total_cost_microcents: routing_cost,
    billed_cost_microcents: billed_cost,
    unknown_cost_requests,
    first_request_at,
    last_request_at,
  };
}

function parseMicrocents(value: string | number | null | undefined): bigint {
  if (value == null) return 0n;
  try {
    return BigInt(value);
  } catch {
    // Ignore malformed values defensively; request_logs stores a bigint.
    return 0n;
  }
}
