import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the module under test
const mockQuery = vi.fn();
vi.mock('../src/db/pool.js', () => ({
  getPool: () => ({ query: mockQuery }),
}));

vi.mock('../src/billing/plan-limits.js', () => ({
  getTeamPlan: vi.fn(async () => 'growth'),
  getPlanLimits: vi.fn((plan: string) => {
    if (plan === 'free') return { maxKeys: 2, maxRules: 3, fallbacksEnabled: false, savingsSharePercent: 0, creditsMarkupPercent: 0 };
    return { maxKeys: 50, maxRules: Infinity, fallbacksEnabled: true, savingsSharePercent: 3, creditsMarkupPercent: 3.5 };
  }),
}));

import { getRulesForTeam, invalidateRuleCache } from '../src/routing/rule-cache.js';
import { getTeamPlan, getPlanLimits } from '../src/billing/plan-limits.js';

const sampleRows = [
  { id: 'r1', team_id: 'team_a', name: 'Rule 1', priority: 100, enabled: true, condition: {}, action: { type: 'route' } },
  { id: 'r2', team_id: '*', name: 'Wildcard', priority: 200, enabled: true, condition: {}, action: { type: 'route' } },
  { id: 'r3', team_id: 'team_b', name: 'Other team', priority: 300, enabled: true, condition: {}, action: { type: 'route' } },
];

describe('getRulesForTeam', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateRuleCache();
    mockQuery.mockResolvedValue({ rows: sampleRows });
  });

  it('cache miss triggers DB query', async () => {
    const rules = await getRulesForTeam('team_a');
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(rules.length).toBeGreaterThan(0);
  });

  it('cache hit returns cached data without DB query', async () => {
    await getRulesForTeam('team_a');
    expect(mockQuery).toHaveBeenCalledTimes(1);

    mockQuery.mockClear();
    const rules = await getRulesForTeam('team_a');
    expect(mockQuery).not.toHaveBeenCalled();
    expect(rules.length).toBeGreaterThan(0);
  });

  it('cache respects TTL', async () => {
    await getRulesForTeam('team_a');
    expect(mockQuery).toHaveBeenCalledTimes(1);

    // Invalidate the cache to simulate TTL expiration
    invalidateRuleCache();

    mockQuery.mockClear();
    await getRulesForTeam('team_a');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('rules sliced to plan limit', async () => {
    // Set plan to free (maxRules: 3), provide more rules than limit
    vi.mocked(getTeamPlan).mockResolvedValueOnce('free');
    vi.mocked(getPlanLimits).mockReturnValueOnce({
      maxKeys: 2,
      maxRules: 2,
      fallbacksEnabled: false,
      savingsSharePercent: 0,
      creditsMarkupPercent: 0,
    });

    // team_a has r1 (team_a) + r2 (wildcard) = 2 matching, but let's add more
    const manyRows = [
      { id: 'r1', team_id: 'team_x', name: 'Rule 1', priority: 100, enabled: true, condition: {}, action: {} },
      { id: 'r2', team_id: 'team_x', name: 'Rule 2', priority: 200, enabled: true, condition: {}, action: {} },
      { id: 'r3', team_id: 'team_x', name: 'Rule 3', priority: 300, enabled: true, condition: {}, action: {} },
      { id: 'r4', team_id: 'team_x', name: 'Rule 4', priority: 400, enabled: true, condition: {}, action: {} },
    ];
    invalidateRuleCache();
    mockQuery.mockResolvedValueOnce({ rows: manyRows });

    const rules = await getRulesForTeam('team_x');
    expect(rules).toHaveLength(2);
    expect(rules[0].id).toBe('r1');
    expect(rules[1].id).toBe('r2');
  });

  it('wildcard and team-specific rules both returned', async () => {
    invalidateRuleCache();
    mockQuery.mockResolvedValueOnce({ rows: sampleRows });

    const rules = await getRulesForTeam('team_a');
    const ids = rules.map(r => r.id);
    // Should include team_a rule and wildcard rule, but NOT team_b rule
    expect(ids).toContain('r1'); // team_a
    expect(ids).toContain('r2'); // wildcard *
    expect(ids).not.toContain('r3'); // team_b
  });
});
