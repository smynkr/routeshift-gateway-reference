// Pure helpers for the team-scoped usage summary endpoint: relative-date
// resolution, time-series zero-filling, and GitHub-style contribution levels.
// No I/O here so the date/level contracts are unit-testable in isolation.

export type Bucket = 'hour' | 'day';

export interface UsageRange {
  since: Date;
  until: Date;
  bucket: Bucket;
  contribDays: number;
}

export type UsageRangeResult =
  | { ok: true; range: UsageRange }
  | { ok: false; status: 400; message: string };

export interface SeriesPoint {
  bucket_start: string;
  spend_microcents: number;
  input_tokens: number;
  output_tokens: number;
  requests: number;
  unknown_cost_requests: number;
  actual_costs_qualified: boolean;
}

export interface ContributionInput {
  date: string; // YYYY-MM-DD (UTC)
  spend_microcents: number;
  tokens: number;
  unknown_cost_requests: number;
  actual_costs_qualified: boolean;
}

export interface ContributionDay extends ContributionInput {
  level: 0 | 1 | 2 | 3 | 4;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const CONTRIB_MAX = 371;
const MAX_HOUR_BUCKETS = 1464; // 61 days
const MAX_DAY_BUCKETS = 371;

/** Resolve query params into an absolute window. `now` is injectable for tests. */
export function resolveUsageRange(params: URLSearchParams, now: Date): UsageRangeResult {
  const untilRaw = params.get('until');
  const until = params.has('until') ? parseInstant(untilRaw) : now;
  if (!until) {
    return { ok: false, status: 400, message: 'until must be a valid ISO-8601 timestamp' };
  }

  const sinceRaw = params.get('since');
  const since = params.has('since') ? resolveSince(sinceRaw, now) : new Date(now.getTime() - 30 * DAY_MS);
  if (!since) {
    return {
      ok: false,
      status: 400,
      message: 'since must be a valid ISO-8601 timestamp or one of today, 7d, 30d, month, ytd',
    };
  }

  if (since.getTime() >= until.getTime()) {
    return { ok: false, status: 400, message: 'since must be before until' };
  }

  const bucketRaw = params.get('bucket');
  const bucket: Bucket = bucketRaw === 'hour' ? 'hour' : 'day';

  const count = bucketCount(since, until, bucket);
  const maxBuckets = bucket === 'hour' ? MAX_HOUR_BUCKETS : MAX_DAY_BUCKETS;
  if (count > maxBuckets) {
    return { ok: false, status: 400, message: `${bucket} bucket window exceeds maximum of ${maxBuckets} buckets` };
  }

  const contribRaw = Number.parseInt(params.get('contrib_days') ?? '', 10);
  const contribDays = Number.isFinite(contribRaw)
    ? Math.min(CONTRIB_MAX, Math.max(1, contribRaw))
    : 365;

  return { ok: true, range: { since, until, bucket, contribDays } };
}

function resolveSince(value: string | null, now: Date): Date | null {
  if (!value) return null;
  switch (value) {
    case 'today': return startOfUtcDay(now);
    case '7d': return new Date(now.getTime() - 7 * DAY_MS);
    case '30d': return new Date(now.getTime() - 30 * DAY_MS);
    case 'month': return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    case 'ytd': return new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    default: return parseInstant(value);
  }
}

function parseInstant(value: string | null): Date | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms);
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function bucketCount(since: Date, until: Date, bucket: Bucket): number {
  const step = bucket === 'hour' ? HOUR_MS : DAY_MS;
  const start = bucket === 'hour' ? startOfUtcHour(since) : startOfUtcDay(since);
  return Math.ceil((until.getTime() - start.getTime()) / step);
}

/** Continuous buckets across [floor(since), until), zeros where no row exists. */
export function zeroFillSeries(
  rows: SeriesPoint[],
  since: Date,
  until: Date,
  bucket: Bucket,
): SeriesPoint[] {
  const step = bucket === 'hour' ? HOUR_MS : DAY_MS;
  const start = bucket === 'hour' ? startOfUtcHour(since) : startOfUtcDay(since);
  const byKey = new Map(rows.map((r) => [floorIso(r.bucket_start, bucket), r]));

  const out: SeriesPoint[] = [];
  for (let t = start.getTime(); t < until.getTime(); t += step) {
    const iso = new Date(t).toISOString();
    const present = byKey.get(iso);
    out.push(present ?? {
      bucket_start: iso, spend_microcents: 0, input_tokens: 0, output_tokens: 0, requests: 0,
      unknown_cost_requests: 0, actual_costs_qualified: true,
    });
  }
  return out;
}

function startOfUtcHour(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours()));
}

function floorIso(iso: string, bucket: Bucket): string {
  // Normalize zoneless DB timestamps (e.g. "2026-05-31 00:00:00") to UTC; ISO
  // strings that already carry a `T`/offset pass through unchanged.
  const d = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  return (bucket === 'hour' ? startOfUtcHour(d) : startOfUtcDay(d)).toISOString();
}

/**
 * Zero-fill the last `contribDays` UTC days ending at `now`, and assign a 0–4
 * intensity level per day from that day's spend relative to the window max
 * (linear thresholds): 0 spend → 0; otherwise ceil(spend/max * 4) clamped to 1–4.
 */
export function buildContributions(
  rows: ContributionInput[],
  contribDays: number,
  now: Date,
): ContributionDay[] {
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const maxSpend = rows.reduce((m, r) => Math.max(m, r.spend_microcents), 0);

  const out: ContributionDay[] = [];
  // Anchor the window to whole UTC days ending on *today* (the final day may be
  // partial). This intentionally differs from the series window, which runs to
  // the exact `until` instant; the handler renders them as separate views.
  const end = startOfUtcDay(now);
  for (let i = contribDays - 1; i >= 0; i--) {
    const date = isoDate(new Date(end.getTime() - i * DAY_MS));
    const present = byDate.get(date);
    const spend = present?.spend_microcents ?? 0;
    out.push({
      date,
      spend_microcents: spend,
      tokens: present?.tokens ?? 0,
      unknown_cost_requests: present?.unknown_cost_requests ?? 0,
      actual_costs_qualified: present?.actual_costs_qualified ?? true,
      level: levelFor(spend, maxSpend),
    });
  }
  return out;
}

export function levelFor(spend: number, maxSpend: number): 0 | 1 | 2 | 3 | 4 {
  if (spend <= 0 || maxSpend <= 0) return 0;
  const ratio = spend / maxSpend;
  return Math.min(4, Math.max(1, Math.ceil(ratio * 4))) as 1 | 2 | 3 | 4;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
