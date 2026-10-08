'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AlertTriangle,
  ChevronDown,
  Clock,
  Database,
  DollarSign,
  Flame,
  Hash,
  Layers,
  RefreshCw,
  Sparkles,
  Zap,
} from 'lucide-react';
import { ChartSkeleton, KpiGridSkeleton } from '@/components/ui/skeleton';
import { CostQualificationNotice } from '@/components/cost-qualification-notice';
import { providerHex } from '@/lib/providers';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const MICROCENTS_TO_USD = 100_000_000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface TokenTrackerData {
  period: string;
  hours: number;
  summary: {
    requests: number;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    system_prompt_tokens: number;
    /** Routing-only actual cost; use with routing-only savings analytics. */
    cost_microcents: number;
    /** Customer billed spend: routing actual cost plus plugin charges. */
    billed_cost_microcents: number;
    avg_tokens_per_request: number;
    p95_input_tokens: number;
    max_input_tokens: number;
    cache_hits: number;
    duplicate_requests: number;
    unknown_cost_requests: number;
    actual_costs_qualified: boolean;
  };
  burn_rate: {
    window_hours: number;
    requests: number;
    tokens: number;
    cost_microcents: number;
    billed_cost_microcents: number;
    projected_daily_tokens: number;
    projected_daily_cost_microcents: number;
    projected_monthly_cost_microcents: number;
    projected_daily_billed_cost_microcents: number;
    projected_monthly_billed_cost_microcents: number;
  };
  daily: TokenTrendPoint[];
  hourly: TokenTrendPoint[];
  heatmap: Array<{
    weekday: number;
    hour: number;
    requests: number;
    total_tokens: number;
    cost_microcents: number;
    billed_cost_microcents: number;
  }>;
  models: Array<{
    model: string;
    requests: number;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    system_prompt_tokens: number;
    cost_microcents: number;
    billed_cost_microcents: number;
    avg_latency_ms: number;
    cache_hits: number;
  }>;
  providers: Array<{
    provider: string;
    requests: number;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cost_microcents: number;
    billed_cost_microcents: number;
    avg_latency_ms: number;
    errors: number;
  }>;
  expensive_requests: Array<{
    id: string;
    timestamp: string;
    provider: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    system_prompt_tokens: number;
    cost_microcents: number;
    actual_cost_known: boolean;
    plugin_cost_microcents: number;
    billed_cost_microcents: number;
    total_latency_ms: number;
    cache_hit: boolean;
    status_code: number;
  }>;
}

interface TokenTrendPoint {
  day?: string;
  hour?: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  system_prompt_tokens?: number;
  cost_microcents: number;
  billed_cost_microcents: number;
  cache_hits?: number;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

function formatUsd(microcents: number): string {
  const usd = microcents / MICROCENTS_TO_USD;
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatPercent(numerator: number, denominator: number): string {
  if (denominator <= 0) return '0%';
  return `${Math.round((numerator / denominator) * 100)}%`;
}

function shortModel(model: string): string {
  return model.length > 26 ? `${model.slice(0, 24)}…` : model;
}


// Bucket keys are built in UTC to match the server API, which truncates
// timestamps with Postgres date_trunc(...) / EXTRACT(...) in UTC. Building
// keys from local time would shift the Map keys for any non-UTC user and
// leave the daily/hourly trend charts empty.
function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function addHours(date: Date, hours: number): Date {
  const next = new Date(date);
  next.setUTCHours(next.getUTCHours() + hours, 0, 0, 0);
  return next;
}

function dayKey(date: Date): string {
  return startOfUtcDay(date).toISOString().slice(0, 10);
}

function hourKey(date: Date): string {
  const d = new Date(date);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

// Defensive guard: a malformed 200 body lacking `summary` (or the arrays we
// index) would otherwise crash rendering at e.g. formatTokens(data.summary.total_tokens).
function isValidTokenTrackerData(payload: unknown): payload is TokenTrackerData {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  if (!p.summary || typeof p.summary !== 'object') return false;
  if (!p.burn_rate || typeof p.burn_rate !== 'object') return false;
  return (
    Array.isArray(p.daily) &&
    Array.isArray(p.hourly) &&
    Array.isArray(p.heatmap) &&
    Array.isArray(p.models) &&
    Array.isArray(p.providers) &&
    Array.isArray(p.expensive_requests)
  );
}

function emptyTrendPoint(): Omit<TokenTrendPoint, 'day' | 'hour'> {
  return {
    requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    system_prompt_tokens: 0,
    cost_microcents: 0,
    billed_cost_microcents: 0,
    cache_hits: 0,
  };
}

// Cap the hourly chart to a fixed recent window; the title is labelled to
// match so the chart is honest for 30d/90d periods (see HOURLY_WINDOW_DAYS).
const HOURLY_WINDOW_DAYS = 14;

function fillDailyBuckets(data: TokenTrackerData): TokenTrendPoint[] {
  const byDay = new Map(data.daily.map((point) => [dayKey(new Date(point.day ?? '')), point]));
  const end = startOfUtcDay(new Date());
  const bucketCount = Math.max(1, Math.ceil(data.hours / 24));
  const start = addDays(end, -(bucketCount - 1));
  return Array.from({ length: bucketCount }, (_, index) => {
    const day = addDays(start, index);
    const key = dayKey(day);
    return { ...emptyTrendPoint(), ...byDay.get(key), day: key };
  });
}

function fillHourlyBuckets(data: TokenTrackerData): TokenTrendPoint[] {
  const byHour = new Map(data.hourly.map((point) => [hourKey(new Date(point.hour ?? '')), point]));
  const bucketCount = Math.max(1, Math.min(data.hours, 24 * HOURLY_WINDOW_DAYS));
  const end = addHours(new Date(), 0);
  const start = addHours(end, -(bucketCount - 1));
  return Array.from({ length: bucketCount }, (_, index) => {
    const hour = addHours(start, index);
    const key = hourKey(hour);
    return { ...emptyTrendPoint(), ...byHour.get(key), hour: key };
  });
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-white/[0.1] bg-[#0c0c0e] px-3 py-2 shadow-xl">
      <p className="mb-1 text-xs text-neutral-500">{label}</p>
      {payload.map((entry: any) => {
        const value = Number(entry.value ?? 0);
        const label = entry.name?.toLowerCase() ?? '';
        const formatted = label.includes('cost') || label.includes('spend') ? formatUsd(value) : formatTokens(value);
        return (
          <p key={entry.name} className="text-xs" style={{ color: entry.color }}>
            {entry.name}: {formatted}
          </p>
        );
      })}
    </div>
  );
};

function KpiCard({ title, value, subtitle, Icon, tone = 'neutral' }: {
  title: string;
  value: string;
  subtitle?: string;
  Icon: any;
  tone?: 'neutral' | 'emerald' | 'amber' | 'red' | 'cyan' | 'violet';
}) {
  const toneClass = {
    neutral: 'text-white',
    emerald: 'text-emerald-400',
    amber: 'text-amber-400',
    red: 'text-red-400',
    cyan: 'text-cyan-400',
    violet: 'text-violet-400',
  }[tone];

  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-5 transition-colors hover:border-white/[0.1]">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-neutral-500">{title}</p>
        <Icon className="h-4 w-4 text-neutral-600" />
      </div>
      <div className={`mt-2 text-2xl font-bold ${toneClass}`}>{value}</div>
      {subtitle && <p className="mt-1 text-xs text-neutral-500">{subtitle}</p>}
    </div>
  );
}

function TokenMixBar({ data }: { data: TokenTrackerData }) {
  const input = data.summary.input_tokens;
  const output = data.summary.output_tokens;
  const system = data.summary.system_prompt_tokens;
  const total = Math.max(1, input + output);
  const outputPct = (output / total) * 100;
  const inputPct = (input / total) * 100;
  const systemPct = input > 0 ? (system / input) * 100 : 0;

  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-6">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-lg font-semibold text-white">Token mix</h3>
        <span className="text-xs text-neutral-500">Input vs output; system prompt is a subset of input</span>
      </div>
      <div className="h-4 overflow-hidden rounded-full bg-white/[0.06]">
        <div className="inline-block h-full bg-emerald-500" style={{ width: `${inputPct}%` }} />
        <div className="inline-block h-full bg-cyan-500" style={{ width: `${outputPct}%` }} />
      </div>
      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="rounded-lg bg-black/20 p-3">
          <p className="text-xs text-neutral-500">Input</p>
          <p className="mt-1 text-lg font-semibold text-emerald-400">{formatTokens(input)}</p>
          <p className="text-xs text-neutral-500">{formatPercent(input, total)} of non-cache tokens</p>
        </div>
        <div className="rounded-lg bg-black/20 p-3">
          <p className="text-xs text-neutral-500">Output</p>
          <p className="mt-1 text-lg font-semibold text-cyan-400">{formatTokens(output)}</p>
          <p className="text-xs text-neutral-500">{formatPercent(output, total)} of non-cache tokens</p>
        </div>
        <div className="rounded-lg bg-black/20 p-3">
          <p className="text-xs text-neutral-500">System prompt</p>
          <p className="mt-1 text-lg font-semibold text-violet-400">{formatTokens(system)}</p>
          <p className="text-xs text-neutral-500">{systemPct.toFixed(1)}% of input tokens</p>
        </div>
      </div>
    </div>
  );
}

function ActivityHeatmap({ data }: { data: TokenTrackerData }) {
  const maxTokens = Math.max(1, ...data.heatmap.map((h) => h.total_tokens));
  const cellByKey = new Map(data.heatmap.map((h) => [`${h.weekday}:${h.hour}`, h]));

  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-6">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-lg font-semibold text-white">Hourly token heatmap</h3>
        <span className="text-xs text-neutral-500">Darker cells mean more tokens</span>
      </div>
      <div className="overflow-x-auto">
        <div className="min-w-[760px]">
          <div className="mb-2 grid grid-cols-[44px_repeat(24,minmax(22px,1fr))] gap-1 text-[10px] text-neutral-600">
            <div />
            {Array.from({ length: 24 }, (_, hour) => (
              <div key={hour} className="text-center">{hour % 6 === 0 ? hour : ''}</div>
            ))}
          </div>
          {WEEKDAYS.map((day, weekday) => (
            <div key={day} className="mb-1 grid grid-cols-[44px_repeat(24,minmax(22px,1fr))] gap-1">
              <div className="py-1 text-xs text-neutral-500">{day}</div>
              {Array.from({ length: 24 }, (_, hour) => {
                const cell = cellByKey.get(`${weekday}:${hour}`);
                const intensity = cell ? Math.max(0.08, cell.total_tokens / maxTokens) : 0;
                return (
                  <div
                    key={hour}
                    title={`${day} ${hour}:00 — ${formatTokens(cell?.total_tokens ?? 0)} tokens, ${cell?.requests ?? 0} requests`}
                    className="h-7 rounded-[5px] border border-white/[0.03]"
                    style={{ backgroundColor: `rgba(16, 185, 129, ${intensity * 0.9})` }}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function TokenTrackerClient() {
  const [period, setPeriod] = useState('7d');
  const [data, setData] = useState<TokenTrackerData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    try {
      setError(null);
      const res = await fetch(`/api/usage/token-tracker?period=${period}`, { cache: 'no-store', signal });
      if (!res.ok) throw new Error('Failed to fetch token tracker data');
      const payload = await res.json();
      if (!isValidTokenTrackerData(payload)) {
        throw new Error('Malformed token tracker response');
      }
      if (seq === requestSeq.current) setData(payload);
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return;
      console.error('Failed to fetch token tracker data:', err);
      if (seq === requestSeq.current) setError('Failed to load token tracker data. Please try again.');
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetchData(controller.signal);
    return () => controller.abort();
  }, [fetchData]);

  const dailyChartData = useMemo(() => data ? fillDailyBuckets(data).map((d) => ({
    day: new Date(d.day ?? '').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
    Input: d.input_tokens,
    Output: d.output_tokens,
    'System prompt': d.system_prompt_tokens ?? 0,
    'Billed Spend': d.billed_cost_microcents,
  })) : [], [data]);

  const hourlyChartData = useMemo(() => data ? fillHourlyBuckets(data).map((h) => ({
    hour: new Date(h.hour ?? '').toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', timeZone: 'UTC' }),
    Tokens: h.total_tokens,
    'Billed Spend': h.billed_cost_microcents,
  })) : [], [data]);

  const modelChartData = useMemo(() => data?.models.slice(0, 8).map((m) => ({
    model: shortModel(m.model),
    fullModel: m.model,
    Input: m.input_tokens,
    Output: m.output_tokens,
    'Billed Spend': m.billed_cost_microcents,
  })) ?? [], [data]);

  const isEmpty = !loading && data?.summary.requests === 0;

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-3xl font-bold text-white">Token Tracker</h2>
          <p className="mt-1 text-neutral-400">
            ccusage/Tokscale-inspired token burn, model mix, cache signals, and expensive request forensics.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => fetchData()}
            className="inline-flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-sm text-neutral-300 hover:border-white/[0.1] hover:text-white"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
          <div className="relative">
            <select
              value={period}
              onChange={(event) => setPeriod(event.target.value)}
              aria-label="Token usage period"
              className="appearance-none rounded-lg border border-white/[0.06] bg-white/[0.03] py-2 pl-3 pr-8 text-sm text-neutral-300 focus:border-emerald-500/50 focus:outline-none"
            >
              <option value="24h">Last 24 hours</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="90d">Last 90 days</option>
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {loading ? (
        <div className="space-y-8">
          <KpiGridSkeleton />
          <ChartSkeleton />
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <ChartSkeleton />
            <ChartSkeleton />
          </div>
        </div>
      ) : isEmpty ? (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] py-16 text-center">
          <div className="mb-4 flex justify-center">
            <Hash className="h-10 w-10 text-neutral-600" />
          </div>
          <h3 className="mb-2 text-lg font-semibold text-white">No token usage yet</h3>
          <p className="mx-auto max-w-md text-sm text-neutral-500">
            Send requests through RouteShift and this page will show token burn, model mix, cache rate, and expensive calls.
          </p>
        </div>
      ) : data ? (
        <>
          <CostQualificationNotice unknownCostRequests={data.summary.unknown_cost_requests} />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            <KpiCard title="Total Tokens" value={formatTokens(data.summary.total_tokens)} subtitle={`${data.summary.requests.toLocaleString()} requests`} Icon={Hash} tone="emerald" />
            <KpiCard title="Total Billed Spend" value={formatUsd(data.summary.billed_cost_microcents)} subtitle={`${formatTokens(data.summary.avg_tokens_per_request)} avg tokens/request`} Icon={DollarSign} tone="cyan" />
            <KpiCard title="Cache Hit Rate" value={formatPercent(data.summary.cache_hits, data.summary.requests)} subtitle={`${data.summary.cache_hits.toLocaleString()} cached requests`} Icon={Zap} tone="violet" />
            <KpiCard title="Billed Burn Projection" value={formatUsd(data.burn_rate.projected_monthly_billed_cost_microcents)} subtitle={`${formatTokens(data.burn_rate.projected_daily_tokens)} tokens/day at last 6h pace`} Icon={Flame} tone="amber" />
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            <KpiCard title="P95 Input" value={formatTokens(data.summary.p95_input_tokens)} subtitle={`Max ${formatTokens(data.summary.max_input_tokens)}`} Icon={Layers} />
            <KpiCard title="System Prompt Tokens" value={formatTokens(data.summary.system_prompt_tokens)} subtitle="Tracked when logged by proxy" Icon={Sparkles} tone="violet" />
            <KpiCard title="Duplicate Requests" value={data.summary.duplicate_requests.toLocaleString()} subtitle="Same message hash inside period" Icon={Database} tone={data.summary.duplicate_requests > 0 ? 'amber' : 'neutral'} />
            <KpiCard title="Active Window" value={formatTokens(data.burn_rate.tokens)} subtitle={`Last ${data.burn_rate.window_hours}h, ${formatUsd(data.burn_rate.billed_cost_microcents)} billed`} Icon={Clock} />
          </div>

          <TokenMixBar data={data} />

          <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-6">
            <h3 className="mb-4 text-lg font-semibold text-white">Daily token trend</h3>
            <ResponsiveContainer width="100%" height={300}>
              <AreaChart data={dailyChartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                <XAxis dataKey="day" tick={{ fill: '#737373', fontSize: 12 }} />
                <YAxis tick={{ fill: '#737373', fontSize: 12 }} tickFormatter={formatTokens} />
                <Tooltip content={<CustomTooltip />} />
                <Area type="monotone" dataKey="Input" stackId="tokens" stroke="#10b981" fill="#10b981" fillOpacity={0.45} />
                <Area type="monotone" dataKey="Output" stackId="tokens" stroke="#06b6d4" fill="#06b6d4" fillOpacity={0.45} />
                <Line type="monotone" dataKey="System prompt" stroke="#8b5cf6" dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {modelChartData.length > 0 && (
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-6">
                <h3 className="mb-4 text-lg font-semibold text-white">Top models by tokens</h3>
                <ResponsiveContainer width="100%" height={320}>
                  <BarChart data={modelChartData} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                    <XAxis type="number" tick={{ fill: '#737373', fontSize: 11 }} tickFormatter={formatTokens} />
                    <YAxis type="category" dataKey="model" tick={{ fill: '#a3a3a3', fontSize: 11 }} width={145} />
                    <Tooltip content={<CustomTooltip />} />
                    <Bar dataKey="Input" stackId="tokens" fill="#10b981" radius={[0, 0, 0, 0]} />
                    <Bar dataKey="Output" stackId="tokens" fill="#06b6d4" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {hourlyChartData.length > 0 && (
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-6">
                <h3 className="mb-4 text-lg font-semibold text-white">
                  {data.hours > 24 * HOURLY_WINDOW_DAYS
                    ? `Hourly burn rate (last ${HOURLY_WINDOW_DAYS} days)`
                    : 'Hourly burn rate'}
                </h3>
                <ResponsiveContainer width="100%" height={320}>
                  <LineChart data={hourlyChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                    <XAxis dataKey="hour" tick={{ fill: '#737373', fontSize: 10 }} minTickGap={24} />
                    <YAxis tick={{ fill: '#737373', fontSize: 11 }} tickFormatter={formatTokens} />
                    <Tooltip content={<CustomTooltip />} />
                    <Line type="monotone" dataKey="Tokens" stroke="#10b981" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          <ActivityHeatmap data={data} />

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            {data.providers.length > 0 && (
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-6">
                <h3 className="mb-4 text-lg font-semibold text-white">Providers</h3>
                <div className="overflow-hidden rounded-lg border border-white/[0.06]">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Provider</TableHead>
                        <TableHead className="text-right">Tokens</TableHead>
                        <TableHead className="text-right">Billed spend</TableHead>
                        <TableHead className="text-right">Avg Lat.</TableHead>
                        <TableHead className="text-right">Errors</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.providers.map((provider) => (
                        <TableRow key={provider.provider}>
                          <TableCell>
                            <span
                              className="inline-flex rounded-md px-2 py-0.5 text-xs font-medium"
                              style={{ backgroundColor: `${providerHex(provider.provider)}15`, color: providerHex(provider.provider) }}
                            >
                              {provider.provider}
                            </span>
                          </TableCell>
                          <TableCell className="text-right text-neutral-300">{formatTokens(provider.total_tokens)}</TableCell>
                          <TableCell className="text-right text-neutral-300">{formatUsd(provider.billed_cost_microcents)}</TableCell>
                          <TableCell className="text-right text-neutral-400">{provider.avg_latency_ms}ms</TableCell>
                          <TableCell className={`text-right ${provider.errors > 0 ? 'text-red-400' : 'text-neutral-400'}`}>{provider.errors}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}

            {data.models.length > 0 && (
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-6">
                <h3 className="mb-4 text-lg font-semibold text-white">Model details</h3>
                <div className="overflow-hidden rounded-lg border border-white/[0.06]">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Model</TableHead>
                        <TableHead className="text-right">Tokens</TableHead>
                        <TableHead className="text-right">System</TableHead>
                        <TableHead className="text-right">Cache</TableHead>
                        <TableHead className="text-right">Billed spend</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.models.slice(0, 10).map((model) => (
                        <TableRow key={model.model}>
                          <TableCell className="max-w-[220px] truncate font-medium text-white" title={model.model}>{model.model}</TableCell>
                          <TableCell className="text-right text-neutral-300">{formatTokens(model.total_tokens)}</TableCell>
                          <TableCell className="text-right text-neutral-400">{formatTokens(model.system_prompt_tokens)}</TableCell>
                          <TableCell className="text-right text-neutral-400">{formatPercent(model.cache_hits, model.requests)}</TableCell>
                          <TableCell className="text-right text-neutral-300">{formatUsd(model.billed_cost_microcents)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
          </div>

          {data.expensive_requests.length > 0 && (
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-6">
              <h3 className="mb-4 flex items-center gap-2 text-lg font-semibold text-white">
                <AlertTriangle className="h-5 w-5 text-amber-400" />
                Most expensive requests by billed spend
              </h3>
              <div className="overflow-x-auto rounded-lg border border-white/[0.06]">
                <Table className="min-w-[900px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Time</TableHead>
                      <TableHead>Provider</TableHead>
                      <TableHead>Model</TableHead>
                      <TableHead className="text-right">Input</TableHead>
                      <TableHead className="text-right">Output</TableHead>
                      <TableHead className="text-right">System</TableHead>
                      <TableHead className="text-right">Billed spend</TableHead>
                      <TableHead className="text-right">Latency</TableHead>
                      <TableHead className="text-right">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.expensive_requests.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="text-xs text-neutral-500" suppressHydrationWarning>{new Date(row.timestamp).toLocaleString()}</TableCell>
                        <TableCell className="text-neutral-300">{row.provider}</TableCell>
                        <TableCell className="max-w-[260px] truncate font-mono text-neutral-300" title={row.model}>{row.model}</TableCell>
                        <TableCell className="text-right text-neutral-300">{formatTokens(row.input_tokens)}</TableCell>
                        <TableCell className="text-right text-neutral-300">{formatTokens(row.output_tokens)}</TableCell>
                        <TableCell className="text-right text-neutral-400">{formatTokens(row.system_prompt_tokens)}</TableCell>
                        <TableCell className="text-right text-neutral-300" title={row.actual_cost_known ? undefined : 'Observed lower bound; final provider cost is unknown'}>
                          {row.actual_cost_known ? formatUsd(row.billed_cost_microcents) : `≥${formatUsd(row.billed_cost_microcents)}`}
                        </TableCell>
                        <TableCell className="text-right text-neutral-400">{row.total_latency_ms}ms</TableCell>
                        <TableCell className="text-right">
                          <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${row.status_code >= 400 ? 'bg-red-500/10 text-red-400' : 'bg-emerald-500/10 text-emerald-400'}`}>
                            {row.status_code}{row.cache_hit ? ' cached' : ''}
                          </span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
