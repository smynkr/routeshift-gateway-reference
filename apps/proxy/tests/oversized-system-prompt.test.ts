import { describe, it, expect, vi } from 'vitest';
import { oversizedSystemPromptRule } from '../src/optimize/rules/oversized-system-prompt.js';
import type { Pool } from 'pg';

function mockPool(rows: any[]): Pool {
  return { query: vi.fn().mockResolvedValue({ rows }) } as unknown as Pool;
}

const ctx = (pool: Pool) => ({ pool, teamId: 'team_a', lookbackDays: 7 });

describe('oversized-system-prompt rule', () => {
  it('returns null when total requests below floor', async () => {
    const pool = mockPool([{
      requests: '50',
      p95_system_tokens: 6000,
      avg_input_tokens: 7000,
      avg_system_tokens: 5000,
      total_cost_microcents: '100000',
      provider: 'anthropic',
    }]);
    expect(await oversizedSystemPromptRule.detect(ctx(pool))).toBeNull();
  });

  it('returns null when p95 below medium threshold', async () => {
    const pool = mockPool([{
      requests: '500',
      p95_system_tokens: 3500,
      avg_input_tokens: 5000,
      avg_system_tokens: 3000,
      total_cost_microcents: '100000',
      provider: 'anthropic',
    }]);
    expect(await oversizedSystemPromptRule.detect(ctx(pool))).toBeNull();
  });

  it('returns null when system share below 30%', async () => {
    // Big system prompt but it's a small fraction of a huge RAG payload —
    // this is exactly the case we DON'T want to flag.
    const pool = mockPool([{
      requests: '500',
      p95_system_tokens: 5000,
      avg_input_tokens: 50000,
      avg_system_tokens: 5000,
      total_cost_microcents: '100000',
      provider: 'anthropic',
    }]);
    expect(await oversizedSystemPromptRule.detect(ctx(pool))).toBeNull();
  });

  it('flags medium severity when p95 in [4000, 8000) and share >= 30%', async () => {
    const pool = mockPool([{
      requests: '500',
      p95_system_tokens: 5000,
      avg_input_tokens: 10000,
      avg_system_tokens: 4000,
      total_cost_microcents: '100000',
      provider: 'anthropic',
    }]);
    const finding = await oversizedSystemPromptRule.detect(ctx(pool));
    expect(finding).not.toBeNull();
    expect(finding!.severity).toBe('medium');
    expect(finding!.body_md).toContain('5,000 tokens');
    expect(finding!.body_md).toContain('40%');
    expect(finding!.fix_md).toContain('cache_control');
  });

  it('flags high severity when p95 >= 8000', async () => {
    const pool = mockPool([{
      requests: '500',
      p95_system_tokens: 9000,
      avg_input_tokens: 12000,
      avg_system_tokens: 8000,
      total_cost_microcents: '500000',
      provider: 'anthropic',
    }]);
    const finding = await oversizedSystemPromptRule.detect(ctx(pool));
    expect(finding!.severity).toBe('high');
  });

  it('switches fix copy by provider', async () => {
    const pool = mockPool([{
      requests: '500',
      p95_system_tokens: 6000,
      avg_input_tokens: 10000,
      avg_system_tokens: 4000,
      total_cost_microcents: '100000',
      provider: 'openai',
    }]);
    const finding = await oversizedSystemPromptRule.detect(ctx(pool));
    expect(finding!.fix_md).toContain('prompt_cache_key');
  });

  it('returns null when no rows are returned', async () => {
    const pool = mockPool([]);
    expect(await oversizedSystemPromptRule.detect(ctx(pool))).toBeNull();
  });
});
