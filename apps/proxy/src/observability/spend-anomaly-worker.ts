import { createHash, createHmac } from 'node:crypto';
import { getPool } from '../db/pool.js';
import { retainQualityVerdicts } from '../db/quality-verdicts.js';
import { safeFetch } from '../plugins/safe-fetch.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 60 * 1000;
const REFRESH_INTERVAL_MS = DAY_MS;
const RETRY_WINDOW_DAYS = 7;
const MAX_DELIVERY_ATTEMPTS = 5;
const SPEND_ANOMALY_LOCK_ID = 7;
const METRIC = 'daily_spend';
const WEBHOOK_TIMEOUT_MS = 10_000;
export interface SpendAlertConfig {
  team_id: string;
  webhook_url: string;
  threshold_multiplier: number;
  baseline_days: number;
  enabled: boolean;
}

export interface SpendAnomalyPayload {
  schema_version: 1;
  event_id: string;
  team_id: string;
  period_start: string;
  period_end: string;
  observed_spend_microcents: number;
  baseline_spend_microcents: number;
  threshold_multiplier: number;
  unknown_cost_requests: number;
}

export interface SpendAnomalyInput {
  teamId: string;
  periodStart: string;
  periodEnd: string;
  observedSpendMicrocents: number;
  baselineSpendMicrocents: number;
  baselineDays: number;
  baselineCoveredDays: number;
  thresholdMultiplier: number;
  unknownCostRequests: number;
}

interface SpendMetrics {
  observed_spend_microcents: number | string;
  baseline_spend_microcents: number | string;
  baseline_covered_days: number | string;
  unknown_cost_requests: number | string;
  observed_unknown_cost_requests?: number | string;
  baseline_unknown_cost_requests?: number | string;
}

interface SpendDelivery {
  event_id: string;
  body: string;
  status: 'pending' | 'succeeded' | 'failed';
  period_end?: string;
  attempt_count?: number;
}

interface SpendDbResult<T> {
  rows: T[];
  rowCount?: number;
}

interface SpendDbClient {
  query<T = unknown>(sql: string, params?: readonly unknown[]): Promise<SpendDbResult<T>>;
  release(): void;
}

interface SpendDbPool {
  connect(): Promise<SpendDbClient>;
}

interface SpendWebhookRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  maxBytes?: number;
  signal?: AbortSignal;
}

export interface SpendAnomalyRunOptions {
  pool?: SpendDbPool;
  signingSecret?: string;
  fetcher?: (input: string, init?: SpendWebhookRequestInit) => Promise<Response>;
  now?: Date;
}

export interface SpendAnomalyRunResult {
  configured: boolean;
  /** True when the run aborted before its counters describe a complete run. */
  errored: boolean;
  teams_processed: number;
  anomalies_sent: number;
  anomalies_skipped: number;
  retries: number;
}

let timer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;

export function buildSpendAnomalyPayload(input: SpendAnomalyInput): SpendAnomalyPayload | null {
  if (!input.teamId || !input.periodStart || !input.periodEnd) return null;
  if (!Number.isSafeInteger(input.observedSpendMicrocents) || input.observedSpendMicrocents < 0) return null;
  if (!Number.isSafeInteger(input.baselineSpendMicrocents) || input.baselineSpendMicrocents <= 0) return null;
  if (!Number.isSafeInteger(input.baselineDays) || input.baselineDays < 1) return null;
  if (!Number.isSafeInteger(input.baselineCoveredDays) || input.baselineCoveredDays < input.baselineDays) return null;
  if (!Number.isFinite(input.thresholdMultiplier) || input.thresholdMultiplier < 1) return null;
  // Fail closed: the baseline comparison is only valid when every request in the window has a known cost.
  if (input.unknownCostRequests !== 0) return null;
  if (input.observedSpendMicrocents <= input.baselineSpendMicrocents * input.thresholdMultiplier) return null;

  const eventKey = `${input.teamId}:${METRIC}:${input.periodEnd}`;
  const eventId = `spend_${createHash('sha256').update(eventKey).digest('hex').slice(0, 32)}`;
  return {
    schema_version: 1,
    event_id: eventId,
    team_id: input.teamId,
    period_start: input.periodStart,
    period_end: input.periodEnd,
    observed_spend_microcents: input.observedSpendMicrocents,
    baseline_spend_microcents: input.baselineSpendMicrocents,
    threshold_multiplier: input.thresholdMultiplier,
    unknown_cost_requests: input.unknownCostRequests,
  };
}

export function signSpendAnomalyPayload(body: string, secret: string, timestamp?: string): string {
  const signedContent = timestamp === undefined ? body : `${timestamp}.${body}`;
  return `sha256=${createHmac('sha256', secret).update(signedContent).digest('hex')}`;
}

export function startSpendAnomalyWorker(): void {
  if (!process.env.ROUTESHIFT_ALERT_SIGNING_SECRET) {
    console.warn('[spend-anomaly] disabled: ROUTESHIFT_ALERT_SIGNING_SECRET is not set');
    return;
  }
  if (timer || initialTimer) return;

  initialTimer = setTimeout(() => {
    initialTimer = null;
    runScheduled();
    timer = setInterval(runScheduled, REFRESH_INTERVAL_MS);
    timer.unref();
  }, INITIAL_DELAY_MS);
  initialTimer.unref();
  console.log('[spend-anomaly] started (24h interval)');
}

export function stopSpendAnomalyWorker(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function runScheduled(): void {
  void runSpendAnomalyWorker().catch((error: unknown) => {
    console.error('[spend-anomaly] run failed:', error);
  });
  // RSH-136: the verdict table is trimmed on the same daily cadence.
  void retainQualityVerdicts().catch((error: unknown) => {
    console.error('[quality-verdicts] retention failed:', error);
  });
}

export async function runSpendAnomalyWorker(options: SpendAnomalyRunOptions = {}): Promise<SpendAnomalyRunResult> {
  const signingSecret = options.signingSecret ?? process.env.ROUTESHIFT_ALERT_SIGNING_SECRET;
  if (!signingSecret) {
    console.warn('[spend-anomaly] disabled: ROUTESHIFT_ALERT_SIGNING_SECRET is not set');
    return emptyResult(false);
  }

  const pool: SpendDbPool = options.pool ?? (getPool() as unknown as SpendDbPool);
  const fetcher = options.fetcher ?? sendSafeWebhook;
  const now = options.now ?? new Date();
  const periodEnd = startOfUtcDay(now);
  const periodStart = new Date(periodEnd.getTime() - DAY_MS);
  // spend_alert_deliveries.period_end is a DATE keyed to the covered day, which is
  const retryCutoffDate = new Date(periodStart.getTime() - RETRY_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);

  // the start of the [periodStart, periodEnd) window.
  const periodEndDate = periodStart.toISOString().slice(0, 10);

  const client = await pool.connect();
  let advisoryLockHeld = false;
  try {
    // A session-level lock serializes workers without keeping a transaction open
    // across the outbound webhook. The previous xact lock was held for the whole
    // run, including DNS/HTTP, and retained every read lock until delivery ended.
    const lock = await client.query<{ pg_try_advisory_lock: boolean }>(
      'SELECT pg_try_advisory_lock($1)',
      [SPEND_ANOMALY_LOCK_ID],
    );
    if (!lock.rows[0]?.pg_try_advisory_lock) return emptyResult(true);
    advisoryLockHeld = true;

    const configs = await client.query<SpendAlertConfig>(
      `SELECT team_id, webhook_url, threshold_multiplier, baseline_days, enabled
         FROM spend_alert_configs
        WHERE enabled = true`,
    );

    let teamsProcessed = 0;
    let anomaliesSent = 0;
    let anomaliesSkipped = 0;
    let retries = 0;
    let runErrored = false;

    for (const rawConfig of configs.rows) {
      const config = normalizeConfig(rawConfig);
      if (!config || !config.enabled || !isHttpsUrl(config.webhook_url)) continue;
      try {
        const retryResult = await retryPendingDeliveries(
          client,
          config,
          retryCutoffDate,
          periodEndDate,
          signingSecret,
          fetcher,
        );
        anomaliesSent += retryResult.anomaliesSent;
        retries += retryResult.retries;
        if (retryResult.errored) {
          runErrored = true;
          anomaliesSkipped++;
        }
      } catch (error) {
        runErrored = true;
        anomaliesSkipped++;
        console.error('[spend-anomaly] pending delivery retry failed:', error);
      }
    }

    for (const rawConfig of configs.rows) {
      let config: SpendAlertConfig | null = null;
      let delivery: SpendDelivery | null = null;
      try {
        await client.query('BEGIN');
        config = normalizeConfig(rawConfig);
        if (!config || !config.enabled || !isHttpsUrl(config.webhook_url)) {
          await client.query('ROLLBACK');
          anomaliesSkipped++;
          continue;
        }
        teamsProcessed++;

        const baselineStart = new Date(periodStart.getTime() - config.baseline_days * DAY_MS);
        const metricsResult = await client.query<SpendMetrics>(
          `SELECT
             COALESCE(SUM(actual_cost_microcents + COALESCE(plugin_cost_microcents, 0))
               FILTER (WHERE timestamp >= $2 AND timestamp < $3 AND actual_cost_known = true), 0)::bigint
               AS observed_spend_microcents,
             COALESCE((SUM(actual_cost_microcents + COALESCE(plugin_cost_microcents, 0))
               FILTER (WHERE timestamp >= $4 AND timestamp < $2 AND actual_cost_known = true)
               / NULLIF($5::numeric, 0)), 0)::bigint AS baseline_spend_microcents,
             COUNT(DISTINCT (timestamp AT TIME ZONE 'UTC')::date)
               FILTER (WHERE actual_cost_known = true AND timestamp >= $4 AND timestamp < $2)::int
               AS baseline_covered_days,
             COUNT(*) FILTER (WHERE actual_cost_known = false AND timestamp >= $2 AND timestamp < $3)::int
               AS observed_unknown_cost_requests,
             COUNT(*) FILTER (WHERE actual_cost_known = false AND timestamp >= $4 AND timestamp < $2)::int
               AS baseline_unknown_cost_requests,
             COUNT(*) FILTER (WHERE actual_cost_known = false AND timestamp >= $4 AND timestamp < $3)::int
               AS unknown_cost_requests
           FROM request_logs
          WHERE team_id = $1
            AND timestamp >= $4
            AND timestamp < $3`,
          [config.team_id, periodStart, periodEnd, baselineStart, config.baseline_days],
        );
        const metrics = normalizeMetrics(metricsResult.rows[0]);
        if (!metrics) {
          await client.query('ROLLBACK');
          anomaliesSkipped++;
          continue;
        }

        const payload = buildSpendAnomalyPayload({
          teamId: config.team_id,
          periodStart: periodStart.toISOString(),
          periodEnd: periodEnd.toISOString(),
          observedSpendMicrocents: metrics.observedSpendMicrocents,
          baselineSpendMicrocents: metrics.baselineSpendMicrocents,
          baselineDays: config.baseline_days,
          baselineCoveredDays: metrics.baselineCoveredDays,
          thresholdMultiplier: config.threshold_multiplier,
          unknownCostRequests: metrics.unknownCostRequests,
        });
        if (!payload) {
          if (metrics.unknownCostRequests > 0) {
            console.warn('[spend-anomaly] skipped unknown-cost window', {
              team_id: config.team_id,
              observed_unknown_cost_requests: metrics.observedUnknownCostRequests,
              baseline_unknown_cost_requests: metrics.baselineUnknownCostRequests,
            });
          }
          await client.query('ROLLBACK');
          anomaliesSkipped++;
          continue;
        }

        delivery = await claimDelivery(client, config.team_id, periodEndDate, payload);
        await client.query('COMMIT');
      } catch (error) {
        console.error('[spend-anomaly] team claim failed:', error);
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          console.error('[spend-anomaly] team claim rollback failed:', rollbackError);
        }
        anomaliesSkipped++;
        continue;
      }

      if (!config || !delivery || delivery.status === 'succeeded') continue;
      if ((delivery.attempt_count ?? 0) >= MAX_DELIVERY_ATTEMPTS) {
        anomaliesSkipped++;
        continue;
      }
      if (delivery.status === 'failed') retries++;
      // Never hold a database transaction while doing DNS, connect, or response
      // buffering. The committed delivery row is the durable idempotency claim.
      const result = await deliverWebhook(config.webhook_url, delivery, signingSecret, fetcher);
      const statusUpdated = await updateDeliveryStatus(
        client,
        config.team_id,
        delivery.period_end ?? periodEndDate,
        result,
      );
      if (!statusUpdated) {
        runErrored = true;
        anomaliesSkipped++;
        continue;
      }
      if (result.ok) anomaliesSent++;
    }

    return {
      configured: true,
      errored: runErrored,
      teams_processed: teamsProcessed,
      anomalies_sent: anomaliesSent,
      anomalies_skipped: anomaliesSkipped,
      retries,
    };
  } catch (error) {
    console.error('[spend-anomaly] error:', error);
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('[spend-anomaly] rollback failed:', rollbackError);
    }
    return emptyResult(true, true);
  } finally {
    if (advisoryLockHeld) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [SPEND_ANOMALY_LOCK_ID]);
      } catch (error) {
        console.error('[spend-anomaly] advisory unlock failed:', error);
      }
    }
    client.release();
  }
}

async function claimDelivery(
  client: SpendDbClient,
  teamId: string,
  periodEnd: string,
  payload: SpendAnomalyPayload,
): Promise<SpendDelivery | null> {
  const inserted = await client.query<SpendDelivery>(
    `INSERT INTO spend_alert_deliveries (
       team_id, metric, period_end, event_id, body, status
     ) VALUES ($1, $2, $3, $4, $5, 'pending')
     ON CONFLICT (team_id, metric, period_end) DO NOTHING
     RETURNING event_id, body, status, period_end, attempt_count`,
    [teamId, METRIC, periodEnd, payload.event_id, JSON.stringify(payload)],
  );
  if (inserted.rows[0]) return inserted.rows[0];

  const existing = await client.query<SpendDelivery>(
    `SELECT event_id, body, status, period_end, attempt_count
       FROM spend_alert_deliveries
      WHERE team_id = $1 AND metric = $2 AND period_end = $3`,
    [teamId, METRIC, periodEnd],
  );
  return existing.rows[0] ?? null;
}

type DeliveryResult = { ok: boolean; status: number | null; error: string | null };

async function retryPendingDeliveries(
  client: SpendDbClient,
  config: SpendAlertConfig,
  retryCutoffDate: string,
  currentPeriodEndDate: string,
  signingSecret: string,
  fetcher: (input: string, init?: SpendWebhookRequestInit) => Promise<Response>,
): Promise<{ anomaliesSent: number; retries: number; errored: boolean }> {
  const pending = await client.query<SpendDelivery>(
    `SELECT event_id, body, status, period_end, attempt_count
       FROM spend_alert_deliveries
      WHERE team_id = $1
        AND metric = $2
        AND status IN ('pending', 'failed')
        AND attempt_count < $3
        AND period_end >= $4::date
        AND period_end < $5::date
      ORDER BY period_end`,
    [config.team_id, METRIC, MAX_DELIVERY_ATTEMPTS, retryCutoffDate, currentPeriodEndDate],
  );

  let anomaliesSent = 0;
  let retries = 0;
  let errored = false;
  for (const delivery of pending.rows) {
    if (!delivery.period_end) {
      errored = true;
      console.error('[spend-anomaly] pending delivery has no period_end', {
        team_id: config.team_id,
        event_id: delivery.event_id,
      });
      continue;
    }
    if (delivery.status === 'failed') retries++;
    const result = await deliverWebhook(config.webhook_url, delivery, signingSecret, fetcher);
    const statusUpdated = await updateDeliveryStatus(client, config.team_id, delivery.period_end, result);
    if (!statusUpdated) {
      errored = true;
      continue;
    }
    if (result.ok) anomaliesSent++;
  }
  return { anomaliesSent, retries, errored };
}

async function updateDeliveryStatus(
  client: SpendDbClient,
  teamId: string,
  periodEndDate: string,
  result: DeliveryResult,
): Promise<boolean> {
  try {
    await client.query('BEGIN');
    const update = await client.query(
      `UPDATE spend_alert_deliveries
          SET status = $4,
              attempt_count = attempt_count + 1,
              response_code = $5,
              error_text = $6,
              updated_at = NOW()
        WHERE team_id = $1 AND metric = $2 AND period_end = $3`,
      [
        teamId,
        METRIC,
        periodEndDate,
        result.ok ? 'succeeded' : 'failed',
        result.status,
        result.error,
      ],
    );
    if (typeof update.rowCount === 'number' && update.rowCount !== 1) {
      throw new Error(`delivery status update matched ${update.rowCount} rows`);
    }
    await client.query('COMMIT');
    return true;
  } catch (error) {
    console.error('[spend-anomaly] delivery status update failed:', error);
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('[spend-anomaly] delivery status rollback failed:', rollbackError);
    }
    return false;
  }
}

async function deliverWebhook(
  webhookUrl: string,
  delivery: SpendDelivery,
  signingSecret: string,
  fetcher: (input: string, init?: SpendWebhookRequestInit) => Promise<Response>,
): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  try {
    const response = await fetcher(webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-routeshift-event-id': delivery.event_id,
        'x-routeshift-timestamp': timestamp,
        'x-routeshift-signature': signSpendAnomalyPayload(delivery.body, signingSecret, timestamp),
      },
      body: delivery.body,
      maxBytes: 64 * 1024,
      signal: controller.signal,
    });
    return response.ok
      ? { ok: true, status: response.status, error: null }
      : { ok: false, status: response.status, error: `webhook_http_${response.status}` };
  } catch (error) {
    return {
      ok: false,
      status: null,
      error: error instanceof Error ? `webhook_request_failed:${error.name}` : 'webhook_request_failed',
    };
  } finally {
    clearTimeout(timeout);
  }
}
async function sendSafeWebhook(input: string, init: SpendWebhookRequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.headers && typeof init.headers === 'object' && !Array.isArray(init.headers)) {
    for (const [key, value] of Object.entries(init.headers as Record<string, string>)) {
      headers[key] = value;
    }
  }
  const result = await safeFetch(input, {
    method: init.method,
    headers,
    body: typeof init.body === 'string' ? init.body : undefined,
    followRedirects: false,
    timeoutMs: WEBHOOK_TIMEOUT_MS,
    maxBytes: init.maxBytes,
  });
  const body = [204, 205, 304].includes(result.statusCode) ? null : new Uint8Array(result.body);
  return new Response(body, { status: result.statusCode });
}
function normalizeConfig(value: SpendAlertConfig): SpendAlertConfig | null {
  if (!value.team_id || typeof value.webhook_url !== 'string' || typeof value.enabled !== 'boolean') return null;
  const multiplier = Number(value.threshold_multiplier);
  const baselineDays = Number(value.baseline_days);
  if (!Number.isFinite(multiplier) || multiplier < 1 || multiplier > 100) return null;
  if (!Number.isInteger(baselineDays) || baselineDays < 1 || baselineDays > 90) return null;
  return {
    ...value,
    threshold_multiplier: multiplier,
    baseline_days: baselineDays,
  };
}

function normalizeMetrics(value: SpendMetrics | undefined): {
  observedSpendMicrocents: number;
  baselineSpendMicrocents: number;
  baselineCoveredDays: number;
  unknownCostRequests: number;
  observedUnknownCostRequests: number;
  baselineUnknownCostRequests: number;
} | null {
  if (!value) return null;
  const observed = Number(value.observed_spend_microcents);
  const baseline = Number(value.baseline_spend_microcents);
  const baselineCoveredDays = Number(value.baseline_covered_days);
  const unknown = Number(value.unknown_cost_requests);
  const observedUnknown = Number(value.observed_unknown_cost_requests ?? 0);
  const baselineUnknown = Number(value.baseline_unknown_cost_requests ?? 0);
  if (!Number.isSafeInteger(observed) || observed < 0) return null;
  if (!Number.isSafeInteger(baseline) || baseline < 0) return null;
  if (!Number.isSafeInteger(baselineCoveredDays) || baselineCoveredDays < 0) return null;
  if (!Number.isSafeInteger(unknown) || unknown < 0) return null;
  if (!Number.isSafeInteger(observedUnknown) || observedUnknown < 0) return null;
  if (!Number.isSafeInteger(baselineUnknown) || baselineUnknown < 0) return null;
  if (observedUnknown + baselineUnknown !== unknown) return null;
  return {
    observedSpendMicrocents: observed,
    baselineSpendMicrocents: baseline,
    baselineCoveredDays,
    unknownCostRequests: unknown,
    observedUnknownCostRequests: observedUnknown,
    baselineUnknownCostRequests: baselineUnknown,
  };
}

function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function emptyResult(configured: boolean, errored = false): SpendAnomalyRunResult {
  return {
    configured,
    errored,
    teams_processed: 0,
    anomalies_sent: 0,
    anomalies_skipped: 0,
    retries: 0,
  };
}
