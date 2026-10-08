import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveUnknownCostHold } from './billing/credits.js';
import { resolveBudgetUnknownReservation } from './billing/budget-reservations.js';
import { closePool, getPool } from './db/pool.js';

export interface ResolveUnknownCostHoldArgs {
  teamId?: string;
  requestId?: string;
  rawCost?: number;
  evidence?: string;
  note?: string;
  resolvedBy?: string;
  apply: boolean;
}

export interface BudgetUnknownStatus {
  reservations: number;
  seeds: number;
  /** Max known_lower_bound across the request's unknown_held rows (raw). */
  maxLowerBoundMicrocents: number;
  /** Max seeded lower bound across the request's unresolved seed rows (raw). */
  maxSeedBoundMicrocents: number;
}

export interface ResolveUnknownCostHoldCliDependencies {
  queryHold: (teamId: string, requestId: string) => Promise<unknown | undefined>;
  resolveHold: (args: {
    teamId: string;
    requestId: string;
    confirmedUnknownCostMicrocents: number;
    evidence: string;
    note: string;
    resolvedBy: string;
  }) => Promise<unknown>;
  queryBudget: (teamId: string, requestId: string) => Promise<BudgetUnknownStatus>;
  resolveBudget: (args: {
    teamId: string;
    requestId: string;
    confirmedRawCostMicrocents: number;
    evidence: string;
    note: string;
    resolvedBy: string;
  }) => Promise<{
    alreadyResolved: boolean;
    actualAddedMicrocents: number;
    releasedMicrocents: number;
  }>;
  write: (line: string) => void;
}

export function parseArgs(argv: string[]): ResolveUnknownCostHoldArgs {
  const args: ResolveUnknownCostHoldArgs = { apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--apply') args.apply = true;
    else if (value === '--team-id') args.teamId = argv[++i];
    else if (value === '--request-id') args.requestId = argv[++i];
    else if (value === '--raw-cost-microcents') args.rawCost = Number(argv[++i]);
    else if (value === '--evidence') args.evidence = argv[++i];
    else if (value === '--note') args.note = argv[++i];
    else if (value === '--resolved-by') args.resolvedBy = argv[++i];
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

function requireArgs(args: ResolveUnknownCostHoldArgs): asserts args is Required<Omit<ResolveUnknownCostHoldArgs, 'apply'>> & { apply: boolean } {
  if (!args.teamId || !args.requestId || args.rawCost === undefined || !args.evidence || !args.note || !args.resolvedBy) {
    throw new Error('Required: --team-id --request-id --raw-cost-microcents --evidence --note --resolved-by');
  }
}

const defaultDependencies: ResolveUnknownCostHoldCliDependencies = {
  async queryHold(teamId, requestId) {
    const { rows } = await getPool().query(
      `SELECT team_id, request_id, status, reserved_microcents, known_charge_microcents,
              uncollected_known_charge_microcents, held_microcents, unknown_cost_estimate_microcents,
              markup_percent, reason_code, created_at, updated_at, resolved_at
       FROM pending_unknown_cost_holds WHERE team_id = $1 AND request_id = $2`,
      [teamId, requestId],
    );
    return rows[0];
  },
  resolveHold: resolveUnknownCostHold,
  async queryBudget(teamId, requestId) {
    const { rows } = await getPool().query<{ reservations: number; seeds: number; max_lb: string | null; max_seed_lb: string | null }>(
      `SELECT
         (SELECT COUNT(*) FROM budget_reservations r
           JOIN budget_period_usage p ON p.id = r.period_id
          WHERE p.team_id = $1 AND r.request_id = $2 AND r.status = 'unknown_held')::int AS reservations,
         (SELECT COUNT(*) FROM budget_period_seeded_requests s
           JOIN budget_period_usage p ON p.id = s.period_id
          WHERE p.team_id = $1 AND s.request_id = $2 AND s.known_cost = false)::int AS seeds,
         (SELECT MAX(r.known_lower_bound_microcents) FROM budget_reservations r
           JOIN budget_period_usage p ON p.id = r.period_id
          WHERE p.team_id = $1 AND r.request_id = $2 AND r.status = 'unknown_held') AS max_lb,
         (SELECT MAX(s.actual_microcents) FROM budget_period_seeded_requests s
           JOIN budget_period_usage p ON p.id = s.period_id
          WHERE p.team_id = $1 AND s.request_id = $2 AND s.known_cost = false) AS max_seed_lb`,
      [teamId, requestId],
    );
    return {
      reservations: Number(rows[0]?.reservations ?? 0),
      seeds: Number(rows[0]?.seeds ?? 0),
      maxLowerBoundMicrocents: Number(rows[0]?.max_lb ?? 0),
      maxSeedBoundMicrocents: Number(rows[0]?.max_seed_lb ?? 0),
    };
  },
  resolveBudget: resolveBudgetUnknownReservation,
  write: (line) => console.log(line),
};

export async function runResolveUnknownCostHoldCli(
  argv: string[],
  dependencies: ResolveUnknownCostHoldCliDependencies = defaultDependencies,
): Promise<void> {
  const args = parseArgs(argv);
  requireArgs(args);
  if (!Number.isSafeInteger(args.rawCost) || args.rawCost < 0) {
    throw new Error('--raw-cost-microcents must be a non-negative safe integer');
  }
  const hold = await dependencies.queryHold(args.teamId, args.requestId);
  const budgetUnknown = await dependencies.queryBudget(args.teamId, args.requestId);
  if (!args.apply) {
    dependencies.write(
      JSON.stringify({ dryRun: true, hold: hold ?? null, budgetUnknown, requestedRawCostMicrocents: args.rawCost }),
    );
    return;
  }
  // The budget ledger's known lower bound includes the credit hold's already-
  // confirmed known charge; the resolver compares TOTAL raw cost against it.
  // `--raw-cost-microcents` is the previously-unknown portion (runbook
  // contract), so the total is rawCost + knownCharge when a credit hold
  // exists, and rawCost alone for budget-only unknowns (subscription traffic
  // and historical seeds never create a credit hold).
  // The budget ledger's own recorded bounds ARE the raw known portion — read
  // them from the ledger instead of de-marking the credit hold's
  // markup-inclusive known charge (a rounding loss would inflate
  // reconciliation). `--raw-cost-microcents` is the previously-unknown portion
  // (runbook contract), so the total raw cost the budget resolver must compare
  // is rawCost + the highest recorded bound. When reservations were swept
  // (windows closed), only the seed bound remains — never zero it.
  const knownBound = Math.max(
    Number.isSafeInteger(budgetUnknown.maxLowerBoundMicrocents) ? budgetUnknown.maxLowerBoundMicrocents : 0,
    Number.isSafeInteger(budgetUnknown.maxSeedBoundMicrocents) ? budgetUnknown.maxSeedBoundMicrocents : 0,
  );
  const totalRawCostMicrocents = args.rawCost + knownBound;
  // Pre-validate the budget side BEFORE the credit hold is terminalised: a
  // below-bound total would otherwise leave the credit half committed and the
  // budget half unrecoverable through the CLI.
  const worstSeedBound = Number.isSafeInteger(budgetUnknown.maxSeedBoundMicrocents)
    ? budgetUnknown.maxSeedBoundMicrocents
    : 0;
  if (totalRawCostMicrocents < worstSeedBound) {
    throw new Error(
      `--raw-cost-microcents ${args.rawCost} is below the recorded budget lower bound ${worstSeedBound}; refusing to resolve`,
    );
  }

  let creditResult: unknown = null;
  if (hold) {
    // Credit-hold resolution runs first when a credit hold exists; budget rows
    // are resolved only after it is confirmed applied. There is no automatic
    // release path in either step.
    creditResult = await dependencies.resolveHold({
      teamId: args.teamId,
      requestId: args.requestId,
      confirmedUnknownCostMicrocents: args.rawCost,
      evidence: args.evidence,
      note: args.note,
      resolvedBy: args.resolvedBy,
    });
    if (!creditResult || typeof creditResult !== 'object' || (creditResult as { success?: unknown }).success !== true) {
      throw new Error('Unknown-cost hold resolution was not applied successfully');
    }
  }
  const budget = await dependencies.resolveBudget({
    teamId: args.teamId,
    requestId: args.requestId,
    confirmedRawCostMicrocents: totalRawCostMicrocents,
    evidence: args.evidence,
    note: args.note,
    resolvedBy: args.resolvedBy,
  });
  dependencies.write(
    JSON.stringify({
      dryRun: false,
      result: creditResult,
      budget,
      reasonCodes: [
        ...(hold ? ['credit_hold_resolved'] : ['budget_only_resolution']),
        budget.alreadyResolved ? 'budget_none_pending' : 'budget_unknown_resolved',
      ],
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await runResolveUnknownCostHoldCli(process.argv.slice(2));
  } finally {
    await closePool();
  }
}
