import { describe, expect, it, vi } from 'vitest';
import {
  runResolveUnknownCostHoldCli,
  type ResolveUnknownCostHoldCliDependencies,
} from '../src/resolve-unknown-cost-hold-cli.js';

function dependencies(): ResolveUnknownCostHoldCliDependencies & {
  queryHold: ReturnType<typeof vi.fn>;
  resolveHold: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
} {
  return {
    queryHold: vi.fn(async () => ({
      request_id: 'request-1',
      status: 'pending',
      reserved_microcents: 100,
      known_charge_microcents: 80,
      uncollected_known_charge_microcents: 20,
      held_microcents: 50,
      unknown_cost_estimate_microcents: 90,
      markup_percent: 10,
      reason_code: 'served_response_cost_lower_bound',
      created_at: '2026-07-28T00:00:00.000Z',
      updated_at: '2026-07-28T00:01:00.000Z',
      resolved_at: null,
    })),
    resolveHold: vi.fn(async () => ({ success: true, status: 'resolved' })),
    queryBudget: vi.fn(async () => ({ reservations: 0, seeds: 0, maxLowerBoundMicrocents: 0, maxSeedBoundMicrocents: 0 })),
    resolveBudget: vi.fn(async () => ({ alreadyResolved: false, actualAddedMicrocents: 0, releasedMicrocents: 0 })),
    write: vi.fn(),
  };
}

const requiredArgs = [
  '--team-id', 'team-1', '--request-id', 'request-1', '--raw-cost-microcents', '42',
  '--evidence', 'provider invoice', '--note', 'confirmed by finance', '--resolved-by', 'operator-1',
];

describe('resolve unknown-cost hold CLI', () => {
  it('reads a hold but never resolves it in dry-run mode', async () => {
    const deps = dependencies();

    await runResolveUnknownCostHoldCli(requiredArgs, deps);

    expect(deps.queryHold).toHaveBeenCalledWith('team-1', 'request-1');
    expect(deps.queryBudget).toHaveBeenCalledWith('team-1', 'request-1');
    expect(deps.resolveHold).not.toHaveBeenCalled();
    expect(deps.resolveBudget).not.toHaveBeenCalled();
    expect(deps.write).toHaveBeenCalledWith(expect.stringContaining('"dryRun":true'));
    expect(JSON.parse(deps.write.mock.calls[0]![0])).toMatchObject({
      hold: {
        reserved_microcents: 100,
        known_charge_microcents: 80,
        uncollected_known_charge_microcents: 20,
        held_microcents: 50,
        unknown_cost_estimate_microcents: 90,
        markup_percent: 10,
        status: 'pending',
        reason_code: 'served_response_cost_lower_bound',
        created_at: '2026-07-28T00:00:00.000Z',
        updated_at: '2026-07-28T00:01:00.000Z',
        resolved_at: null,
      },
    });
  });

  it('resolves exactly one hold when --apply is supplied', async () => {
    const deps = dependencies();

    await runResolveUnknownCostHoldCli([...requiredArgs, '--apply'], deps);

    expect(deps.queryHold).toHaveBeenCalledWith('team-1', 'request-1');
    expect(deps.resolveHold).toHaveBeenCalledTimes(1);
    expect(deps.resolveHold).toHaveBeenCalledWith({
      teamId: 'team-1', requestId: 'request-1', confirmedUnknownCostMicrocents: 42,
      evidence: 'provider invoice', note: 'confirmed by finance', resolvedBy: 'operator-1',
    });
    expect(deps.resolveBudget).toHaveBeenCalledTimes(1);
    expect(deps.resolveBudget).toHaveBeenCalledWith({
      // total raw cost = unknown portion (42) + the ledger's recorded lower
      // bound (the fake reports 0; the hold's markup-inclusive charge is
      // never de-marked)
      teamId: 'team-1', requestId: 'request-1', confirmedRawCostMicrocents: 42,
      evidence: 'provider invoice', note: 'confirmed by finance', resolvedBy: 'operator-1',
    });
    expect(JSON.parse(deps.write.mock.calls[0]![0])).toMatchObject({ dryRun: false, result: { success: true } });
  });

  it('throws without emitting an apply record when resolution is not successful', async () => {
    const deps = dependencies();
    deps.resolveHold.mockResolvedValueOnce({ success: false, status: 'pending', newBalance: -300 });

    await expect(runResolveUnknownCostHoldCli([...requiredArgs, '--apply'], deps))
      .rejects.toThrow('not applied successfully');

    expect(deps.resolveHold).toHaveBeenCalledTimes(1);
    expect(deps.write).not.toHaveBeenCalled();
  });

  it('rejects invalid arguments before reading or resolving a hold', async () => {
    const deps = dependencies();

    await expect(runResolveUnknownCostHoldCli([
      '--team-id', 'team-1', '--request-id', 'request-1', '--raw-cost-microcents', '-1',
      '--evidence', 'provider invoice', '--note', 'confirmed by finance', '--resolved-by', 'operator-1',
    ], deps)).rejects.toThrow('non-negative safe integer');

    expect(deps.queryHold).not.toHaveBeenCalled();
    expect(deps.resolveHold).not.toHaveBeenCalled();
  });
});
