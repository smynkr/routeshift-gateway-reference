// LAY-331: api_keys lifecycle audit events.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../src/db/pool.js', () => ({
  getPool: () => ({ query: mockQuery }),
}));

import {
  _resetAuthFailureDedup,
  recordAuditEvent,
} from '../src/auth/audit-events.js';

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  _resetAuthFailureDedup();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('recordAuditEvent', () => {
  it('writes a row for "created" with the actor_user_id', async () => {
    await recordAuditEvent({
      team_id: 'team_a',
      api_key_id: 'key_1',
      key_prefix: 'sk-proxy-live_test',
      event_type: 'created',
      actor_user_id: 'user_1',
      details: { name: 'pilot' },
    });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const params = mockQuery.mock.calls[0]![1] as unknown[];
    expect(params[1]).toBe('team_a');
    expect(params[2]).toBe('key_1');
    expect(params[4]).toBe('created');
    expect(params[5]).toBe('user_1');
    expect(params[6]).toEqual({ name: 'pilot' });
  });

  it('writes a row for "revoked"', async () => {
    await recordAuditEvent({
      team_id: 'team_a',
      api_key_id: 'key_1',
      key_prefix: 'sk-proxy-live_test',
      event_type: 'revoked',
      actor_user_id: 'user_2',
    });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0]![1]).toContain('revoked');
  });

  it('writes a row for "rate_limited" with no actor', async () => {
    await recordAuditEvent({
      team_id: 'team_a',
      api_key_id: 'key_1',
      key_prefix: null,
      event_type: 'rate_limited',
      details: { kind: 'rpm' },
    });
    const params = mockQuery.mock.calls[0]![1] as unknown[];
    expect(params[5]).toBeNull();
  });

  it('rate-limits auth_failed emission to once per minute per (team, prefix)', async () => {
    // First call writes
    await recordAuditEvent({
      team_id: 'team_a',
      api_key_id: null,
      key_prefix: 'sk-proxy-live_test',
      event_type: 'auth_failed',
    });
    expect(mockQuery).toHaveBeenCalledTimes(1);

    // Second call within the dedup window: skipped
    await recordAuditEvent({
      team_id: 'team_a',
      api_key_id: null,
      key_prefix: 'sk-proxy-live_test',
      event_type: 'auth_failed',
    });
    expect(mockQuery).toHaveBeenCalledTimes(1);

    // Third call past 60s: writes
    vi.advanceTimersByTime(61_000);
    await recordAuditEvent({
      team_id: 'team_a',
      api_key_id: null,
      key_prefix: 'sk-proxy-live_test',
      event_type: 'auth_failed',
    });
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('different prefixes do not share dedup state', async () => {
    await recordAuditEvent({
      team_id: 'team_a',
      api_key_id: null,
      key_prefix: 'sk-proxy-live_aaaa',
      event_type: 'auth_failed',
    });
    await recordAuditEvent({
      team_id: 'team_a',
      api_key_id: null,
      key_prefix: 'sk-proxy-live_bbbb',
      event_type: 'auth_failed',
    });
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('non-auth_failed events are NOT subject to the dedup window', async () => {
    // Three rate_limited in rapid succession — all three should write.
    for (let i = 0; i < 3; i++) {
      await recordAuditEvent({
        team_id: 'team_a',
        api_key_id: 'key_1',
        key_prefix: null,
        event_type: 'rate_limited',
      });
    }
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });

  it('swallows DB insert failures without throwing', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB down'));
    await expect(
      recordAuditEvent({
        team_id: 'team_a',
        api_key_id: 'key_1',
        key_prefix: null,
        event_type: 'created',
      }),
    ).resolves.toBeUndefined();
  });
});
