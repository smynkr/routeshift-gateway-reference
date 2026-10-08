import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
  log: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../src/db/pool.js', () => ({
  getPool: () => ({ connect: mocks.connect }),
}));

import { refreshSessionMetrics } from '../src/observability/session-aggregator.js';

const SELF_SERVE_TEAM_ID = 'team_1a2b3c4d';
const DEMO_TEAM_ID = 'd0000000-0000-4000-8000-000000000001';

const baseTime = new Date('2026-06-04T00:00:00Z');
const ts = (mins: number) => new Date(baseTime.getTime() + mins * 60 * 1000);

describe('refreshSessionMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(mocks.log);
    vi.spyOn(console, 'error').mockImplementation(mocks.error);

    mocks.release.mockImplementation(() => {});
    mocks.clientQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('pg_try_advisory_xact_lock')) {
        return { rows: [{ pg_try_advisory_xact_lock: true }], rowCount: 1 };
      }
      if (sql.includes('LEFT JOIN session_metrics')) {
        return {
          rows: [
            { team_id: SELF_SERVE_TEAM_ID, session_id: 'sess_self_serve' },
            { team_id: DEMO_TEAM_ID, session_id: 'sess_demo_uuid' },
          ],
          rowCount: 2,
        };
      }
      if (sql.includes('FROM request_logs') && sql.includes('ORDER BY timestamp ASC')) {
        const [sessionId, teamId] = params as [string, string];
        if (sessionId === 'sess_self_serve' && teamId === SELF_SERVE_TEAM_ID) {
          return {
            rows: [
              { timestamp: ts(0), model_resolved: 'gpt-5.4', edited_paths: ['src/app.ts'], had_bash: false, actual_cost_microcents: '100', actual_cost_known: true, plugin_cost_microcents: '10' },
              { timestamp: ts(1), model_resolved: 'gpt-5.4', edited_paths: [], had_bash: true, actual_cost_microcents: '25', actual_cost_known: false, plugin_cost_microcents: '0' },
              { timestamp: ts(2), model_resolved: 'gpt-5.4', edited_paths: ['src/app.ts'], had_bash: false, actual_cost_microcents: '100', actual_cost_known: true, plugin_cost_microcents: '10' },
            ],
            rowCount: 3,
          };
        }
        if (sessionId === 'sess_demo_uuid' && teamId === DEMO_TEAM_ID) {
          return {
            rows: [
              { timestamp: ts(10), model_resolved: 'claude-sonnet-4-6', edited_paths: ['src/demo.ts'], had_bash: false, actual_cost_microcents: '250', actual_cost_known: true, plugin_cost_microcents: '0' },
            ],
            rowCount: 1,
          };
        }
      }
      if (sql.includes('INSERT INTO session_metrics')) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    mocks.connect.mockResolvedValue({
      query: mocks.clientQuery,
      release: mocks.release,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('aggregates both newly registered self-serve team ids and the seeded demo UUID team', async () => {
    const result = await refreshSessionMetrics();

    expect(result).toEqual({ sessions_processed: 2 });

    const inserts = mocks.clientQuery.mock.calls.filter(([sql]) =>
      String(sql).includes('INSERT INTO session_metrics'),
    );
    expect(inserts).toHaveLength(2);

    const selfServeParams = inserts[0]![1] as unknown[];
    expect(selfServeParams[0]).toBe('sess_self_serve');
    expect(selfServeParams[1]).toBe(SELF_SERVE_TEAM_ID);
    expect(selfServeParams[2]).toBe(2);
    expect(selfServeParams[3]).toBe(1);
    expect(selfServeParams[4]).toBe(0.5);
    expect(selfServeParams[6]).toBe('225');
    expect(selfServeParams[7]).toBe('245');
    expect(selfServeParams[8]).toBe(1);

    const demoParams = inserts[1]![1] as unknown[];
    expect(demoParams[0]).toBe('sess_demo_uuid');
    expect(demoParams[1]).toBe(DEMO_TEAM_ID);
    expect(demoParams[2]).toBe(1);
    expect(demoParams[3]).toBe(0);
    expect(demoParams[4]).toBe(1);
    expect(demoParams[6]).toBe('250');
    expect(demoParams[7]).toBe('250');
    expect(demoParams[8]).toBe(0);

    expect(mocks.clientQuery).toHaveBeenCalledWith('COMMIT');
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });
});
