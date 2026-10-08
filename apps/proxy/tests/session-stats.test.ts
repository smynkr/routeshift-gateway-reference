import { describe, expect, it } from 'vitest';
import { computeSessionStats, type TurnRow } from '../src/observability/session-stats.js';

const t0 = new Date('2026-04-29T00:00:00Z');
const ts = (mins: number) => new Date(t0.getTime() + mins * 60 * 1000);

const turn = (
  paths: string[] = [],
  bash = false,
  model: string | null = 'claude-sonnet-4-6',
  cost: number = 0,
  at: Date = t0,
  pluginCost: number = 0,
  actualCostKnown: boolean = true,
): TurnRow => ({
  timestamp: at,
  model_resolved: model,
  edited_paths: paths,
  had_bash: bash,
  actual_cost_microcents: cost,
  plugin_cost_microcents: pluginCost,
  actual_cost_known: actualCostKnown,
});

describe('computeSessionStats', () => {
  it("matches the ticket's synthetic Edit→Bash→Edit retry pattern", () => {
    const stats = computeSessionStats([
      turn(['/foo.ts'], false, 'claude-sonnet-4-6', 0, ts(0)),
      turn([], true, 'claude-sonnet-4-6', 0, ts(1)),
      turn(['/foo.ts'], false, 'claude-sonnet-4-6', 0, ts(2)),
    ]);
    expect(stats.edit_turns).toBe(2);
    expect(stats.retry_turns).toBe(1);
    expect(stats.one_shot_rate).toBe(0.5);
  });

  it('counts a single edit as 1 edit, 0 retries, one-shot 1.0', () => {
    const stats = computeSessionStats([turn(['/a.ts'])]);
    expect(stats.edit_turns).toBe(1);
    expect(stats.retry_turns).toBe(0);
    expect(stats.one_shot_rate).toBe(1);
  });

  it('returns one_shot_rate=null when there are zero edit turns', () => {
    const stats = computeSessionStats([turn([], true), turn([], true)]);
    expect(stats.edit_turns).toBe(0);
    expect(stats.retry_turns).toBe(0);
    expect(stats.one_shot_rate).toBeNull();
  });

  it('does NOT count back-to-back same-file edits as retries when no Bash ran between', () => {
    const stats = computeSessionStats([turn(['/foo.ts']), turn(['/foo.ts'])]);
    expect(stats.retry_turns).toBe(0);
    expect(stats.one_shot_rate).toBe(1);
  });

  it('does NOT count Edit→Bash→Edit when the file path differs', () => {
    const stats = computeSessionStats([
      turn(['/a.ts']),
      turn([], true),
      turn(['/b.ts']),
    ]);
    expect(stats.retry_turns).toBe(0);
  });

  it('only looks back 3 turns — a re-edit beyond that window is fresh', () => {
    const stats = computeSessionStats([
      turn(['/foo.ts']),
      turn([], true),
      turn([]),
      turn([]),
      turn(['/foo.ts']),
    ]);
    expect(stats.edit_turns).toBe(2);
    expect(stats.retry_turns).toBe(0);
  });

  it('counts a retry on path overlap when a path is in common across multi-path turns', () => {
    const stats = computeSessionStats([
      turn(['/foo.ts'], false),
      turn([], true),
      turn(['/foo.ts', '/bar.ts'], false),
    ]);
    expect(stats.retry_turns).toBe(1);
  });

  it('handles Edit→Edit→Bash→Edit (3 edits, 1 retry — the third edit retries the first)', () => {
    const stats = computeSessionStats([
      turn(['/a.ts']),
      turn(['/b.ts']),
      turn([], true),
      turn(['/a.ts']),
    ]);
    expect(stats.edit_turns).toBe(3);
    expect(stats.retry_turns).toBe(1);
    expect(stats.one_shot_rate).toBeCloseTo(2 / 3, 6);
  });

  it('one_shot_rate stays in [0, 1]', () => {
    const stats = computeSessionStats([
      turn(['/x.ts']),
      turn([], true),
      turn(['/x.ts']),
      turn([], true),
      turn(['/x.ts']),
    ]);
    expect(stats.one_shot_rate).not.toBeNull();
    expect(stats.one_shot_rate!).toBeGreaterThanOrEqual(0);
    expect(stats.one_shot_rate!).toBeLessThanOrEqual(1);
  });

  it('picks the most-used model as primary_model', () => {
    const stats = computeSessionStats([
      turn([], false, 'claude-sonnet-4-6'),
      turn(['/a.ts'], false, 'claude-sonnet-4-6'),
      turn([], false, 'gpt-5'),
    ]);
    expect(stats.primary_model).toBe('claude-sonnet-4-6');
  });

  it('returns null primary_model when no turn has a resolved model', () => {
    const stats = computeSessionStats([turn(['/a.ts'], false, null)]);
    expect(stats.primary_model).toBeNull();
  });

  it('keeps routing and billed session totals distinct as bigints', () => {
    const stats = computeSessionStats([
      turn(['/a.ts'], false, 'm', 1000, t0, 250),
      turn(['/b.ts'], false, 'm', 2500, t0, 0),
    ]);
    expect(stats.total_cost_microcents).toBe(3500n);
    expect(stats.billed_cost_microcents).toBe(3750n);
  });

  it('counts only explicitly unknown request costs for session qualification', () => {
    const stats = computeSessionStats([
      turn(['/a.ts'], false, 'm', 100, t0, 0, true),
      turn(['/b.ts'], false, 'm', 200, ts(1), 0, false),
    ]);
    expect(stats.unknown_cost_requests).toBe(1);
  });

  it('captures first and last request timestamps from the turn list', () => {
    const stats = computeSessionStats([
      turn(['/a.ts'], false, 'm', 0, ts(0)),
      turn([], false, 'm', 0, ts(5)),
      turn(['/b.ts'], false, 'm', 0, ts(10)),
    ]);
    expect(stats.first_request_at).toEqual(ts(0));
    expect(stats.last_request_at).toEqual(ts(10));
  });

  it('skips Bash-only turns for the edit count', () => {
    const stats = computeSessionStats([turn([], true), turn([], true)]);
    expect(stats.edit_turns).toBe(0);
  });
});
