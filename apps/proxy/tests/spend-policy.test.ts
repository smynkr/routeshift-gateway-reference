import { describe, expect, it } from 'vitest';
import { evaluateSpendPolicies, type SpendPolicy } from '../src/billing/spend-policy.js';

const window = { kind: 'rolling' as const, duration_ms: 3_600_000 };
const base: SpendPolicy = { id: 'team-alert', enabled: true, priority: 10, window, dimensions: { team_id: 'team_a' }, limit_microcents: 100, action: 'alert' };

describe('evaluateSpendPolicies', () => {
  it('uses predicted cost and returns the strictest matching action with an exact reason', () => {
    const result = evaluateSpendPolicies([
      base,
      { ...base, id: 'key-block', priority: 20, dimensions: { team_id: 'team_a', api_key_id: 'key_a' }, action: 'block' },
    ], { team_id: 'team_a', api_key_id: 'key_a' }, 90, 10);
    expect(result).toEqual({ status: 'block', policy_id: 'key-block', reason: 'spend_policy_key-block_block' });
  });

  it('matches only allowlisted trusted tags and leaves other dimensions unmodified', () => {
    const tagged = { ...base, id: 'tagged', dimensions: { team_id: 'team_a', trusted_tags: ['managed'] }, action: 'throttle' as const };
    expect(evaluateSpendPolicies([tagged], { team_id: 'team_a', trusted_tags: ['managed', 'safe'] }, 100, 0).status).toBe('throttle');
    expect(evaluateSpendPolicies([tagged], { team_id: 'team_a', trusted_tags: ['untrusted'] }, 100, 0).status).toBe('ok');
  });

  it('fails closed for invalid predicted cost and respects fixed windows', () => {
    expect(evaluateSpendPolicies([base], { team_id: 'team_a' }, 0, -1)).toEqual({ status: 'block', reason: 'invalid_spend_policy' });
    const fixed = { ...base, window: { kind: 'fixed' as const, starts_at: new Date('2026-01-01'), ends_at: new Date('2026-02-01') } };
    expect(evaluateSpendPolicies([fixed], { team_id: 'team_a' }, 100, 0, new Date('2026-03-01')).status).toBe('ok');
  });

  it.each([
    [{ ...base, dimensions: undefined }], [{ ...base, window: { kind: 'unknown' } }], [{ ...base, action: 'route' }],
    [{ ...base, limit_microcents: -1 }], [{ ...base, dimensions: { team_id: 'team_a', trusted_tags: {} } }], new Array(1),
  ])('fails closed for malformed policy runtime shapes', (policies) => {
    expect(evaluateSpendPolicies(policies as unknown as SpendPolicy[], { team_id: 'team_a' }, 0, 0))
      .toEqual({ status: 'block', reason: 'invalid_spend_policy' });
  });
});
