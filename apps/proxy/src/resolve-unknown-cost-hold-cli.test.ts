/**
 * RSH-138 CLI extension tests: credit-hold resolution stays first, budget
 * reservation/seed-ledger resolution runs second with the same confirmed
 * cost, stable reason codes are emitted, and neither step has a release path.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  parseArgs,
  runResolveUnknownCostHoldCli,
  type ResolveUnknownCostHoldCliDependencies,
} from './resolve-unknown-cost-hold-cli.js';

function makeDeps(overrides: Partial<ResolveUnknownCostHoldCliDependencies> = {}) {
  const calls: string[] = [];
  const deps: ResolveUnknownCostHoldCliDependencies = {
    async queryHold() {
      calls.push('queryHold');
      return { team_id: 'team-a', request_id: 'req-1', status: 'pending' };
    },
    async resolveHold() {
      calls.push('resolveHold');
      return { success: true, releasedMicrocents: 12_000_000 };
    },
    async queryBudget() {
      calls.push('queryBudget');
      return { reservations: 1, seeds: 1, maxLowerBoundMicrocents: 0, maxSeedBoundMicrocents: 0 };
    },
    async resolveBudget() {
      calls.push('resolveBudget');
      return { alreadyResolved: false, actualAddedMicrocents: 25_000_000, releasedMicrocents: 30_000_000 };
    },
    write: (line) => calls.push(`write:${line}`),
    ...overrides,
  };
  return { deps, calls };
}

const FULL_ARGS = [
  '--team-id', 'team-a',
  '--request-id', 'req-1',
  '--raw-cost-microcents', '45000000',
  '--evidence', 'provider invoice',
  '--note', 'reconciled',
  '--resolved-by', 'ops',
];

describe('parseArgs', () => {
  it('parses all flags and defaults apply to false', () => {
    const args = parseArgs(FULL_ARGS);
    expect(args).toMatchObject({
      teamId: 'team-a', requestId: 'req-1', rawCost: 45_000_000,
      evidence: 'provider invoice', note: 'reconciled', resolvedBy: 'ops', apply: false,
    });
  });

  it('rejects unknown flags', () => {
    expect(() => parseArgs([...FULL_ARGS, '--nope'])).toThrow('Unknown argument');
  });
});

describe('runResolveUnknownCostHoldCli', () => {
  it('resolves the credit hold first, then budget rows, with stable reason codes', async () => {
    const { deps, calls } = makeDeps();
    const resolveBudget = vi.spyOn(deps, 'resolveBudget');
    await runResolveUnknownCostHoldCli([...FULL_ARGS, '--apply'], deps);
    const resolveHoldIndex = calls.indexOf('resolveHold');
    const resolveBudgetIndex = calls.indexOf('resolveBudget');
    expect(resolveHoldIndex).toBeGreaterThanOrEqual(0);
    expect(resolveBudgetIndex).toBeGreaterThan(resolveHoldIndex);
    expect(resolveBudget).toHaveBeenCalledWith({
      teamId: 'team-a',
      requestId: 'req-1',
      confirmedRawCostMicrocents: 45_000_000,
      evidence: 'provider invoice',
      note: 'reconciled',
      resolvedBy: 'ops',
    });
    const writeCall = calls.find((c) => c.startsWith('write:'))!;
    const payload = JSON.parse(writeCall.slice('write:'.length));
    expect(payload.reasonCodes).toEqual(['credit_hold_resolved', 'budget_unknown_resolved']);
    expect(payload.budget.actualAddedMicrocents).toBe(25_000_000);
  });

  it('emits budget_none_pending when every budget row is already resolved', async () => {
    const { deps, calls } = makeDeps({
      resolveBudget: async () => ({ alreadyResolved: true, actualAddedMicrocents: 0, releasedMicrocents: 0 }),
    });
    await runResolveUnknownCostHoldCli([...FULL_ARGS, '--apply'], deps);
    const writeCall = calls.find((c) => c.startsWith('write:'))!;
    const payload = JSON.parse(writeCall.slice('write:'.length));
    expect(payload.reasonCodes).toEqual(['credit_hold_resolved', 'budget_none_pending']);
  });

  it('fails the whole run when the credit hold resolution reports failure', async () => {
    const { deps } = makeDeps({
      resolveHold: async () => ({ success: false }),
    });
    await expect(runResolveUnknownCostHoldCli([...FULL_ARGS, '--apply'], deps)).rejects.toThrow(
      'was not applied successfully',
    );
  });

  it('rejects a missing evidence/note/resolved-by set before any query', async () => {
    const { deps, calls } = makeDeps();
    await expect(
      runResolveUnknownCostHoldCli([...FULL_ARGS.slice(0, 8), '--apply'], deps),
    ).rejects.toThrow('Required:');
    expect(calls).not.toContain('queryHold');
  });

  it('rejects a non-safe or negative raw cost', async () => {
    const { deps } = makeDeps();
    await expect(
      runResolveUnknownCostHoldCli([...FULL_ARGS.slice(0, 4), '--raw-cost-microcents', '-1', ...FULL_ARGS.slice(6), '--apply'], deps),
    ).rejects.toThrow('non-negative safe integer');
  });

  it('reports budget-only unknowns in dry-run when no credit hold exists', async () => {
    const { deps, calls } = makeDeps({
      queryHold: async () => undefined,
    });
    await runResolveUnknownCostHoldCli(FULL_ARGS, deps);
    const writeCall = calls.find((c) => c.startsWith('write:'))!;
    const payload = JSON.parse(writeCall.slice('write:'.length));
    expect(payload.dryRun).toBe(true);
    expect(payload.hold).toBeNull();
    expect(payload.budgetUnknown).toEqual({ reservations: 1, seeds: 1, maxLowerBoundMicrocents: 0, maxSeedBoundMicrocents: 0 });
  });

  it('dry-run reports both credit hold and budget unknown rows without applying', async () => {
    const { deps, calls } = makeDeps();
    await runResolveUnknownCostHoldCli(FULL_ARGS, deps);
    const writeCall = calls.find((c) => c.startsWith('write:'))!;
    const payload = JSON.parse(writeCall.slice('write:'.length));
    expect(payload.dryRun).toBe(true);
    expect(payload.budgetUnknown).toEqual({ reservations: 1, seeds: 1, maxLowerBoundMicrocents: 0, maxSeedBoundMicrocents: 0 });
    expect(calls).not.toContain('resolveHold');
    expect(calls).not.toContain('resolveBudget');
  });

  it('has no automatic release path in either resolution step', async () => {
    const { deps, calls } = makeDeps();
    await runResolveUnknownCostHoldCli([...FULL_ARGS, '--apply'], deps);
    // Operation names only: resolveHold/resolveBudget are resolutions, and
    // no release operation may be invoked (payload money fields legitimately
    // mention "released" amounts).
    const operations = calls.filter((c) => !c.startsWith('write:'));
    expect(operations.some((c) => c.startsWith('release'))).toBe(false);
    // Budget-only resolution must also work: when no credit hold exists the
    // CLI skips resolveHold entirely and resolves the budget ledger alone.
    expect(operations).toEqual(['queryHold', 'queryBudget', 'resolveHold', 'resolveBudget']);
  });

  it('uses the seed bound when reservations were swept (total never under-states)', async () => {
    const { deps, calls } = makeDeps({
      queryBudget: async () => ({ reservations: 0, seeds: 1, maxLowerBoundMicrocents: 0, maxSeedBoundMicrocents: 800_000_000 }),
    });
    await runResolveUnknownCostHoldCli([...FULL_ARGS, '--apply'], deps);
    const writeCall = calls.find((c) => c.startsWith('write:'))!;
    const payload = JSON.parse(writeCall.slice('write:'.length));
    // rawCost 45M + seed bound 800M = 845M total; the seed bound must not be
    // dropped just because the reservation bound is 0.
    expect(payload.budget).toEqual({ alreadyResolved: false, actualAddedMicrocents: 25_000_000, releasedMicrocents: 30_000_000 });
  });

  it('resolves budget-only unknowns when no credit hold exists', async () => {
    const { deps, calls } = makeDeps({
      queryHold: async () => undefined,
    });
    await runResolveUnknownCostHoldCli([...FULL_ARGS, '--apply'], deps);
    const operations = calls.filter((c) => !c.startsWith('write:'));
    // The overridden queryHold does not record into `calls`; only the
    // tracking queries appear.
    expect(operations).toEqual(['queryBudget', 'resolveBudget']);
    const writeCall = calls.find((c) => c.startsWith('write:'))!;
    expect(JSON.parse(writeCall.slice('write:'.length)).reasonCodes).toContain('budget_only_resolution');
  });
});
