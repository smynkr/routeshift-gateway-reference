import { describe, expect, it, vi } from 'vitest';
const safeFetchMock = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock('../src/plugins/safe-fetch.js', () => safeFetchMock);
import {
  buildSpendAnomalyPayload,
  runSpendAnomalyWorker,
  signSpendAnomalyPayload,
  startSpendAnomalyWorker,
  stopSpendAnomalyWorker,
  type SpendAnomalyPayload,
} from '../src/observability/spend-anomaly-worker.js';

const completeInput = {
  teamId: 'team_a',
  periodStart: '2026-08-07T00:00:00.000Z',
  periodEnd: '2026-08-08T00:00:00.000Z',
  observedSpendMicrocents: 250,
  baselineSpendMicrocents: 100,
  baselineDays: 7,
  baselineCoveredDays: 7,
  thresholdMultiplier: 2,
  unknownCostRequests: 0,
};

const NOW = new Date('2026-08-08T12:00:00.000Z');
const CONFIG_ROW = { team_id: 'team_a', webhook_url: 'https://alerts.example.test/hook', threshold_multiplier: 2, baseline_days: 7, enabled: true };
const METRICS_ROW = {
  observed_spend_microcents: '250',
  baseline_spend_microcents: '100',
  baseline_covered_days: '7',
  unknown_cost_requests: '0',
};

// Rows every run reads before it reaches delivery state: session lock held, one
// enabled config, one anomalous day. Returns null for the delivery SQL each test owns.
function baseRows(sql: string): unknown[] | null {
  if (sql === 'SELECT pg_try_advisory_lock($1)') return [{ pg_try_advisory_lock: true }];
  if (sql.includes('FROM spend_alert_configs')) return [CONFIG_ROW];
  if (sql.includes('FROM request_logs')) return [METRICS_ROW];
  return null;
}

describe('spend anomaly payloads', () => {
  it('requires exact, non-zero, known cost data above the threshold', () => {
    expect(buildSpendAnomalyPayload(completeInput)).toMatchObject({
      schema_version: 1,
      team_id: 'team_a',
      observed_spend_microcents: 250,
      baseline_spend_microcents: 100,
      unknown_cost_requests: 0,
    });
    expect(buildSpendAnomalyPayload({ ...completeInput, baselineSpendMicrocents: 0 })).toBeNull();
    expect(buildSpendAnomalyPayload({ ...completeInput, baselineCoveredDays: 6 })).toBeNull();
    expect(buildSpendAnomalyPayload({ ...completeInput, unknownCostRequests: 1 })).toBeNull();
    expect(buildSpendAnomalyPayload({ ...completeInput, observedSpendMicrocents: 200 })).toBeNull();
  });

  it('uses a stable event id and canonical HMAC signature', () => {
    const first = buildSpendAnomalyPayload(completeInput) as SpendAnomalyPayload;
    const second = buildSpendAnomalyPayload({ ...completeInput }) as SpendAnomalyPayload;
    const body = JSON.stringify(first);
    expect(second.event_id).toBe(first.event_id);
    expect(signSpendAnomalyPayload(body, 'secret')).toBe(
      'sha256=a0c71091296d783c39c5d1809aa801ca2763c7a4858b55abf0af02f08db0948a',
    );
  });
});

describe('spend anomaly scheduling', () => {
  it('runs shortly after startup instead of waiting for a full day', () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const previousSecret = process.env.ROUTESHIFT_ALERT_SIGNING_SECRET;
    process.env.ROUTESHIFT_ALERT_SIGNING_SECRET = 'secret';

    try {
      startSpendAnomalyWorker();
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
      expect(setIntervalSpy).not.toHaveBeenCalled();
    } finally {
      stopSpendAnomalyWorker();
      setTimeoutSpy.mockRestore();
      setIntervalSpy.mockRestore();
      if (previousSecret === undefined) delete process.env.ROUTESHIFT_ALERT_SIGNING_SECRET;
      else process.env.ROUTESHIFT_ALERT_SIGNING_SECRET = previousSecret;
      vi.useRealTimers();
    }
  });
});

describe('runSpendAnomalyWorker', () => {
  it('holds the session advisory lock and does not resend a successful delivery', async () => {
    const event = buildSpendAnomalyPayload(completeInput) as SpendAnomalyPayload;
    let deliveryAlreadySucceeded = false;
    const timeline: string[] = [];
    const queryCalls: string[] = [];
    const client = {
      query: vi.fn(async <T>(sql: string): Promise<{ rows: T[] }> => {
        timeline.push(`query:${sql}`);
        queryCalls.push(sql);
        const base = baseRows(sql);
        if (base) return { rows: base as T[] };
        if (sql.includes('status IN')) return { rows: [] };
        if (sql.startsWith('INSERT INTO spend_alert_deliveries')) {
          if (deliveryAlreadySucceeded) return { rows: [] };
          return { rows: [{ event_id: event.event_id, body: JSON.stringify(event), status: 'pending' } as T] };
        }
        if (sql.startsWith('SELECT event_id, body, status')) {
          return { rows: [{ event_id: event.event_id, body: JSON.stringify(event), status: 'succeeded' } as T] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) };
    const fetcher = vi.fn(async () => {
      timeline.push('fetch');
      return new Response(null, { status: 204 });
    });

    const first = await runSpendAnomalyWorker({ pool, signingSecret: 'secret', fetcher, now: NOW });
    deliveryAlreadySucceeded = true;
    expect(timeline.indexOf('query:COMMIT')).toBeGreaterThanOrEqual(0);
    expect(timeline.indexOf('query:COMMIT')).toBeLessThan(timeline.indexOf('fetch'));
    const second = await runSpendAnomalyWorker({ pool, signingSecret: 'secret', fetcher, now: NOW });

    expect(queryCalls).toContain('SELECT pg_try_advisory_lock($1)');
    expect(first).toMatchObject({ configured: true, teams_processed: 1, anomalies_sent: 1 });
    expect(second.anomalies_sent).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        'x-routeshift-event-id': event.event_id,
        'x-routeshift-signature': expect.stringMatching(/^sha256=/),
      }),
      maxBytes: 64 * 1024,
    });
    const fetchInit = fetcher.mock.calls[0]?.[1] as { body?: string; headers?: Record<string, string> };
    const timestamp = fetchInit.headers?.['x-routeshift-timestamp'];
    expect(timestamp).toMatch(/^\d+$/);
    expect(fetchInit.headers?.['x-routeshift-signature']).toBe(
      signSpendAnomalyPayload(fetchInit.body ?? '', 'secret', timestamp),
    );
    expect(queryCalls.filter((sql) => sql === 'COMMIT')).toHaveLength(3);
  });
  it('reports a delivery status update failure when the row is gone', async () => {
    const client = {
      query: vi.fn(async <T>(sql: string): Promise<{ rows: T[]; rowCount?: number }> => {
        const base = baseRows(sql);
        if (base) return { rows: base as T[] };
        if (sql.includes('status IN')) return { rows: [] };
        if (sql.startsWith('INSERT INTO spend_alert_deliveries')) {
          return { rows: [{ event_id: 'event_1', body: '{}', status: 'pending' } as T] };
        }
        if (sql.startsWith('UPDATE spend_alert_deliveries')) return { rows: [], rowCount: 0 };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) };
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));

    const result = await runSpendAnomalyWorker({ pool, signingSecret: 'secret', fetcher, now: NOW });

    expect(result).toMatchObject({ errored: true, anomalies_sent: 0, anomalies_skipped: 1 });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('accepts a no-content webhook response from safe fetch', async () => {
    safeFetchMock.safeFetch.mockReset().mockResolvedValueOnce({
      statusCode: 204,
      headers: {},
      body: Buffer.alloc(0),
    });
    const client = {
      query: vi.fn(async <T>(sql: string): Promise<{ rows: T[]; rowCount?: number }> => {
        const base = baseRows(sql);
        if (base) return { rows: base as T[] };
        if (sql.includes('status IN')) return { rows: [] };
        if (sql.startsWith('INSERT INTO spend_alert_deliveries')) {
          return { rows: [{ event_id: 'event_1', body: '{}', status: 'pending' } as T] };
        }
        if (sql.startsWith('UPDATE spend_alert_deliveries')) return { rows: [], rowCount: 1 };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) };

    const result = await runSpendAnomalyWorker({ pool, signingSecret: 'secret', now: NOW });

    expect(result).toMatchObject({ errored: false, anomalies_sent: 1 });
    expect(safeFetchMock.safeFetch).toHaveBeenCalledOnce();
  });

  it('suppresses an alert when the baseline lacks a covered day', async () => {
    const client = {
      query: vi.fn(async <T>(sql: string): Promise<{ rows: T[] }> => {
        if (sql === 'SELECT pg_try_advisory_lock($1)') {
          return { rows: [{ pg_try_advisory_lock: true } as T] };
        }
        if (sql.includes('FROM spend_alert_configs')) return { rows: [CONFIG_ROW as T] };
        if (sql.includes('FROM request_logs')) {
          return {
            rows: [{
              ...METRICS_ROW,
              baseline_covered_days: '6',
            } as T],
          };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) };
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));

    const result = await runSpendAnomalyWorker({ pool, signingSecret: 'secret', fetcher, now: NOW });

    expect(result).toMatchObject({ teams_processed: 1, anomalies_sent: 0, anomalies_skipped: 1 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('marks a failed run as errored instead of looking like a quiet run', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = {
      query: vi.fn(async () => {
        throw new Error('database unavailable');
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) };

    const result = await runSpendAnomalyWorker({ pool, signingSecret: 'secret', now: NOW });

    expect(result).toMatchObject({
      configured: true,
      errored: true,
      teams_processed: 0,
      anomalies_sent: 0,
    });
    expect(client.release).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
  });

  it('retries failed delivery with the stored event id and body', async () => {
    const event = buildSpendAnomalyPayload(completeInput) as SpendAnomalyPayload;
    const storedBody = JSON.stringify(event);
    const client = {
      query: vi.fn(async <T>(sql: string): Promise<{ rows: T[] }> => {
        const base = baseRows(sql);
        if (base) return { rows: base as T[] };
        if (sql.includes('status IN')) return { rows: [] };
        if (sql.startsWith('INSERT INTO spend_alert_deliveries')) return { rows: [] };
        if (sql.startsWith('SELECT event_id, body, status')) {
          return { rows: [{ event_id: event.event_id, body: storedBody, status: 'failed' } as T] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const first = await runSpendAnomalyWorker({ pool, signingSecret: 'secret', fetcher, now: NOW });
    const second = await runSpendAnomalyWorker({ pool, signingSecret: 'secret', fetcher, now: NOW });

    expect(first.anomalies_sent).toBe(0);
    expect(second).toMatchObject({ anomalies_sent: 1, retries: 1 });
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ body: storedBody });
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ body: storedBody });
  });

  it('retries a failed prior-day delivery on the next scheduled run', async () => {
    const event = buildSpendAnomalyPayload(completeInput) as SpendAnomalyPayload;
    const storedBody = JSON.stringify(event);
    const client = {
      query: vi.fn(async <T>(sql: string): Promise<{ rows: T[] }> => {
        const base = baseRows(sql);
        if (base) return { rows: base as T[] };
        if (sql.includes('FROM spend_alert_deliveries') && sql.includes('status IN')) {
          return {
            rows: [{
              event_id: event.event_id,
              body: storedBody,
              status: 'failed',
              period_end: '2026-08-08',
              attempt_count: 1,
            } as T],
          };
        }
        if (sql.startsWith('INSERT INTO spend_alert_deliveries')) return { rows: [] };
        if (sql.startsWith('SELECT event_id, body, status')) return { rows: [] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) };
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));

    const result = await runSpendAnomalyWorker({
      pool,
      signingSecret: 'secret',
      fetcher,
      now: new Date('2026-08-10T12:00:00.000Z'),
    });

    expect(result).toMatchObject({ anomalies_sent: 1, retries: 1 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ body: storedBody });
    const retryQuery = client.query.mock.calls.find(([sql]) => sql.includes('status IN'));
    expect(retryQuery?.[1]).toEqual(['team_a', 'daily_spend', 5, '2026-08-02', '2026-08-09']);
  });

  it('does not retry a current-period delivery after the attempt cap', async () => {
    const event = buildSpendAnomalyPayload(completeInput) as SpendAnomalyPayload;
    const client = {
      query: vi.fn(async <T>(sql: string): Promise<{ rows: T[] }> => {
        const base = baseRows(sql);
        if (base) return { rows: base as T[] };
        if (sql.includes('status IN')) return { rows: [] };
        if (sql.startsWith('INSERT INTO spend_alert_deliveries')) return { rows: [] };
        if (sql.startsWith('SELECT event_id, body, status')) {
          return {
            rows: [{
              event_id: event.event_id,
              body: JSON.stringify(event),
              status: 'failed',
              period_end: '2026-08-07',
              attempt_count: 5,
            } as T],
          };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) };
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));

    const result = await runSpendAnomalyWorker({
      pool,
      signingSecret: 'secret',
      fetcher,
      now: NOW,
    });

    expect(result).toMatchObject({ anomalies_sent: 0, anomalies_skipped: 1 });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
