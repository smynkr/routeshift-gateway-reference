'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from 'recharts';
import { ChevronDown, TrendingUp, AlertTriangle, Zap, DollarSign, Target } from 'lucide-react';
import { PROVIDERS } from '@routeshift/shared';
import { providerDisplayName, providerHex } from '@/lib/providers';
import { buildActivityHref, parseActivityFilters, type ActivityFilters } from '@/lib/activity-filters';
import { ChartSkeleton, KpiGridSkeleton } from '@/components/ui/skeleton';
import { CostQualificationNotice } from '@/components/cost-qualification-notice';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const MICROCENTS_TO_USD = 100_000_000;
const formatUsd = (mc: number) => {
  const usd = mc / MICROCENTS_TO_USD;
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
};
const formatReasoningCost = (microcents: number | null, unknownRequests: number) => {
  if (microcents === null) return '—';
  return unknownRequests > 0 ? `≥ ${formatUsd(microcents)}` : formatUsd(microcents);
};

interface ReasoningByModelRow {
  provider: string;
  model: string;
  requests: number;
  reasoning_token_requests: number;
  reasoning_tokens: number;
  output_tokens: number;
  reasoning_output_share: number | null;
  reasoning_cost_microcents: number | null;
  unknown_reasoning_cost_requests: number;
}

interface AnalyticsData {
  range: {
    from: string;
    to: string;
  };
  cost_by_model: Array<{
    model: string;
    provider: string;
    requests: number;
    total_cost: number;
    total_billed_cost: number;
    total_savings: number;
    avg_latency_ms: number;
    total_tokens: number;
    unknown_cost_requests: number;
    actual_costs_qualified: boolean;
  }>;
  provider_comparison: Array<{
    provider: string;
    requests: number;
    total_cost: number;
    total_billed_cost: number;
    total_savings: number;
    avg_latency_ms: number;
    p95_latency_ms: number;
    error_rate: number;
    cache_hits: number;
    unknown_cost_requests: number;
    actual_costs_qualified: boolean;
  }>;
  daily_trend: Array<{
    day: string;
    cost: number;
    billed_cost: number;
    original_cost: number;
    savings: number;
    requests: number;
    cache_hits: number;
    unknown_cost_requests: number;
    actual_costs_qualified: boolean;
  }>;
  errors: Array<{
    provider: string;
    status_code: number;
    error_type: string | null;
    count: number;
  }>;
  cache: {
    total: number;
    hits: number;
    savings: number;
  };
  reasoning_by_model: ReasoningByModelRow[];
}

interface TokenHygieneData {
  summary: {
    identity_count: number;
    average_score: number | null;
    lowest_score: number | null;
    total_estimated_waste_microcents: number;
  };
  records: Array<{
    identity_id: string;
    score: number;
    grade: string;
    reasons: string[];
    recommendations: Array<{
      code: string;
      title: string;
      recommendation: string;
      estimated_waste_microcents: number;
    }>;
  }>;
}

interface OneShotData {
  summary: {
    sessions: number;
    edit_turns: number;
    retry_turns: number;
    one_shot_rate: number | null;
  };
  by_model: Array<{
    model: string;
    sessions: number;
    edit_turns: number;
    retry_turns: number;
    one_shot_rate: number | null;
    billed_cost_microcents: number;
    billed_cost_per_successful_edit_microcents: number | null;
    unknown_cost_requests: number;
    actual_costs_qualified: boolean;
    total_cost_microcents: number;
    cost_per_successful_edit_microcents: number | null;
  }>;
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-white/[0.1] bg-[#0c0c0e] px-3 py-2 shadow-xl">
      <p className="text-xs text-neutral-500 mb-1">{label}</p>
      {payload.map((entry: any) => (
        <p key={entry.name} className="text-xs" style={{ color: entry.color }}>
          {entry.name}: {typeof entry.value === 'number' && (
            entry.name.includes('Cost') || entry.name === 'Savings' ||
            entry.name === 'Billed Spend' || entry.name === 'Routing Savings'
          )
            ? formatUsd(entry.value)
            : entry.value?.toLocaleString()}
        </p>
      ))}
    </div>
  );
};

const ANALYTICS_PERIODS = ['24h', '7d', '30d'] as const;
type AnalyticsPeriod = (typeof ANALYTICS_PERIODS)[number];

function isAnalyticsPeriod(value: string): value is AnalyticsPeriod {
  return ANALYTICS_PERIODS.some((period) => period === value);
}

type AnalyticsProvider = NonNullable<ActivityFilters['provider']>;
const PROVIDER_VALUES = new Set<string>(PROVIDERS);

function isKnownProvider(provider: string): provider is AnalyticsProvider {
  return PROVIDER_VALUES.has(provider);
}

export function AnalyticsClient() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [oneShot, setOneShot] = useState<OneShotData | null>(null);
  const [tokenHygiene, setTokenHygiene] = useState<TokenHygieneData | null>(null);
  const [period, setPeriod] = useState<AnalyticsPeriod>('7d');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [secondaryWarnings, setSecondaryWarnings] = useState<string[]>([]);
  const requestSeq = useRef(0);

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    try {
      setError(null);
      setSecondaryWarnings([]);
      const [analyticsRes, oneShotRes, tokenHygieneRes] = await Promise.all([
        fetch(`/api/metrics/analytics?period=${period}`, { signal }),
        fetch(`/api/usage/one-shot?period=${period}`, { signal }),
        // Token hygiene is a calendar-month rollup in the proxy API.
        fetch('/api/usage/token-hygiene', { signal }),
      ]);
      if (!analyticsRes.ok) throw new Error('Failed to fetch');
      const analyticsJson = await analyticsRes.json();
      const warnings: string[] = [];
      const readOptionalMetric = async <T,>(res: Response, label: string): Promise<T | null> => {
        if (!res.ok) {
          warnings.push(`${label} unavailable (${res.status})`);
          return null;
        }
        try {
          return await res.json() as T;
        } catch {
          warnings.push(`${label} unavailable (invalid response)`);
          return null;
        }
      };
      // Secondary metrics are best-effort, but failures should stay visible so
      // the page does not imply the widgets are truly empty.
      const oneShotJson = await readOptionalMetric<OneShotData>(oneShotRes, 'One-shot metrics');
      const tokenHygieneJson = await readOptionalMetric<TokenHygieneData>(tokenHygieneRes, 'Token hygiene');
      // Only apply the latest request's result to avoid out-of-order writes.
      if (seq === requestSeq.current) {
        setData(analyticsJson);
        setOneShot(oneShotJson);
        setTokenHygiene(tokenHygieneJson);
        setSecondaryWarnings(warnings);
      }
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return;
      console.error('Failed to fetch analytics:', err);
      if (seq === requestSeq.current) {
        setError('Failed to load analytics data. Please try again.');
        setSecondaryWarnings([]);
      }
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

  const dailyChartData = data?.daily_trend.map((d) => ({
    // `d.day` is a UTC calendar date (date_trunc('day', …)::date). Format it in
    // UTC so non-UTC users don't see every label shifted back a day.
    day: new Date(d.day).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
    'Billed Spend': d.billed_cost,
    'Actual Routing Cost': d.cost,
    'Original Routing Cost': d.original_cost,
    'Routing Savings': d.savings,
    Requests: d.requests,
    'Cache Hits': d.cache_hits,
  })) ?? [];

  const modelEvidenceRows = data?.cost_by_model.slice(0, 8) ?? [];
  const costByModelChart = modelEvidenceRows.map((m) => ({
    name: m.model.length > 20 ? m.model.slice(0, 18) + '...' : m.model,
    'Billed Spend': m.total_billed_cost,
    'Routing Savings': m.total_savings,
  }));
  const reasoningRows = data?.reasoning_by_model.filter((row) => row.reasoning_token_requests > 0) ?? [];


  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold text-white">Analytics</h2>
          <p className="mt-1 text-neutral-400">Cost trends, provider comparison, and performance insights.</p>
        </div>
        <div className="relative">
          <select
            value={period}
            onChange={(e) => {
              const nextPeriod = e.target.value;
              if (isAnalyticsPeriod(nextPeriod)) {
                setLoading(true);
                setPeriod(nextPeriod);
              }
            }}
            aria-label="Analytics time period"
            className="appearance-none rounded-lg border border-white/[0.06] bg-white/[0.03] py-2 pl-3 pr-8 text-sm text-neutral-300 focus:border-emerald-500/50 focus:outline-none"
          >
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {secondaryWarnings.length > 0 && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
          <p className="font-medium">Some analytics widgets could not be loaded.</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-amber-200/80">
            {secondaryWarnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
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
      ) : data ? (
        <>
          <CostQualificationNotice
            unknownCostRequests={data.daily_trend.reduce((sum, row) => sum + row.unknown_cost_requests, 0)}
          />
          {/* Summary KPIs */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
            {[
              {
                title: 'Total Billed Spend',
                value: formatUsd(data.daily_trend.reduce((s, d) => s + d.billed_cost, 0)),
                Icon: DollarSign,
              },
              {
                title: 'Total Routing Saved',
                value: formatUsd(data.daily_trend.reduce((s, d) => s + d.savings, 0)),
                Icon: TrendingUp,
              },
              {
                title: 'Cache Hit Rate',
                value: data.cache.total > 0
                  ? `${Math.round((data.cache.hits / data.cache.total) * 100)}%`
                  : '0%',
                Icon: Zap,
              },
              {
                title: 'Error Rate',
                value: data.provider_comparison.length > 0
                  ? `${(data.provider_comparison.reduce((s, p) => s + p.error_rate * p.requests, 0) /
                      Math.max(1, data.provider_comparison.reduce((s, p) => s + p.requests, 0)) * 100).toFixed(1)}%`
                  : '0%',
                Icon: AlertTriangle,
              },
            ].map((kpi) => (
              <div
                key={kpi.title}
                className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-5"
              >
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-neutral-500">{kpi.title}</p>
                  <kpi.Icon className="h-4 w-4 text-neutral-600" />
                </div>
                <div className="mt-2 text-2xl font-bold text-white">{kpi.value}</div>
              </div>
            ))}
          </div>

          {/* Billed spend is customer-facing; routing cost/savings remain separate. */}
          {dailyChartData.length > 0 && (
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-6">
              <h3 className="text-lg font-semibold text-white">Daily billed spend &amp; routing trend</h3>
              <p className="mb-4 mt-1 text-xs text-neutral-500">
                Billed spend includes plugin charges; routing cost and savings exclude them.
              </p>
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={dailyChartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                  <XAxis dataKey="day" tick={{ fill: '#737373', fontSize: 12 }} />
                  <YAxis
                    tick={{ fill: '#737373', fontSize: 12 }}
                    tickFormatter={(v) => formatUsd(v)}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <Legend wrapperStyle={{ color: '#737373', fontSize: 12 }} />
                  <Line type="monotone" dataKey="Original Routing Cost" stroke="#525252" strokeDasharray="4 4" dot={false} />
                  <Line type="monotone" dataKey="Actual Routing Cost" stroke="#10b981" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="Billed Spend" stroke="#f59e0b" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="Routing Savings" stroke="#06b6d4" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Cost by Model + Provider Comparison */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {/* Customer-billed spend by model; savings stays routing-only. */}
            {costByModelChart.length > 0 && (
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-6">
                <h3 className="mb-4 text-lg font-semibold text-white">Billed spend by model</h3>
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={costByModelChart} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                    <XAxis type="number" tick={{ fill: '#737373', fontSize: 11 }} tickFormatter={(v) => formatUsd(v)} />
                    <YAxis type="category" dataKey="name" tick={{ fill: '#a3a3a3', fontSize: 11 }} width={130} />
                    <Tooltip content={<CustomTooltip />} />
                    <Bar dataKey="Billed Spend" fill="#f59e0b" radius={[0, 4, 4, 0]} />
                    <Bar dataKey="Routing Savings" fill="#06b6d4" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
                <div className="mt-4 space-y-2" role="group" aria-label="Model request evidence">
                  {modelEvidenceRows.map((m) => {
                    const provider = isKnownProvider(m.provider) ? m.provider : null;
                    const resolvedModel = parseActivityFilters({ resolved_model: m.model }).resolved_model;
                    return (
                      <div key={`${m.provider}:${m.model}`} className="flex items-center justify-between gap-3 text-sm">
                        <span className="min-w-0 truncate text-neutral-300" title={m.model}>{m.model}</span>
                        {provider && resolvedModel ? (
                          <Link
                            href={buildActivityHref({
                              provider,
                              resolved_model: resolvedModel,
                              ...data.range,
                            })}
                            className="shrink-0 text-xs text-cyan-400 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
                          >
                            View {m.model} requests on {providerDisplayName(m.provider)}
                          </Link>
                        ) : (
                          <span className="shrink-0 text-xs text-neutral-400">Filter unavailable</span>
                        )}
                      </div>
                    );
                  })}
              </div>
              </div>
            )}

            {/* Provider Comparison */}
            {data.provider_comparison.length > 0 && (
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-6">
                <h3 className="mb-4 text-lg font-semibold text-white">Provider Comparison</h3>
                <div className="overflow-hidden rounded-lg border border-white/[0.06]">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Provider</TableHead>
                        <TableHead className="text-right">Requests</TableHead>
                        <TableHead className="text-right">Billed spend</TableHead>
                        <TableHead className="text-right">Avg Lat.</TableHead>
                        <TableHead className="text-right">Errors</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                    {data.provider_comparison.map((p) => {
                      const provider = isKnownProvider(p.provider) ? p.provider : null;
                      return (
                        <TableRow key={p.provider}>
                          <TableCell>
                            <span
                              className="inline-flex rounded-md px-2 py-0.5 text-xs font-medium"
                              style={{
                                backgroundColor: `${providerHex(p.provider)}15`,
                                color: providerHex(p.provider),
                              }}
                            >
                              {providerDisplayName(p.provider)}
                            </span>
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="text-neutral-300">{p.requests.toLocaleString()}</div>
                            {provider ? (
                              <Link
                                href={buildActivityHref({
                                  provider,
                                  ...data.range,
                                })}
                                className="text-xs text-emerald-400 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                              >
                                View {providerDisplayName(p.provider)} requests
                              </Link>
                            ) : (
                              <span className="text-xs text-neutral-400">Filter unavailable</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right text-neutral-300">{formatUsd(p.total_billed_cost)}</TableCell>
                          <TableCell className="text-right text-neutral-400">{p.avg_latency_ms}ms</TableCell>
                          <TableCell className="text-right">
                            <span className={p.error_rate > 0.05 ? 'text-red-400' : 'text-neutral-400'}>
                              {(p.error_rate * 100).toFixed(1)}%
                            </span>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
          </div>

          {/* Error Analysis */}
          {data.errors.length > 0 && (
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-6">
              <h3 className="mb-4 text-lg font-semibold text-white flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-red-400" />
                Error Analysis
              </h3>
              <div className="overflow-hidden rounded-lg border border-white/[0.06]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Provider</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Error Type</TableHead>
                      <TableHead className="text-right">Count</TableHead>
                      <TableHead className="text-right">Inspect</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.errors.map((e, i) => {
                      const provider = isKnownProvider(e.provider) ? e.provider : null;
                      return (
                        <TableRow key={i}>
                          <TableCell className="text-neutral-300">{providerDisplayName(e.provider)}</TableCell>
                          <TableCell>
                            <span className="rounded-md bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-400">
                              {e.status_code}
                            </span>
                          </TableCell>
                          <TableCell className="font-mono text-neutral-400">{e.error_type ?? '—'}</TableCell>
                          <TableCell className="text-right text-neutral-300">{e.count}</TableCell>
                          <TableCell className="text-right">
                            {provider ? (
                              <Link
                                href={buildActivityHref({
                                  provider,
                                  status: 'error',
                                  ...data.range,
                                })}
                                className="text-xs text-red-400 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                              >
                                View {providerDisplayName(e.provider)} errors
                              </Link>
                            ) : (
                              <span className="text-xs text-neutral-400">Filter unavailable</span>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}

          {/* Reasoning usage is shown only for rows with reported reasoning telemetry. */}
          {reasoningRows.length > 0 && (
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-6">
              <h3 className="mb-1 text-lg font-semibold text-white">Reasoning usage by model</h3>
              <p className="mb-4 mt-1 text-xs text-neutral-500">
                Provider-reported reasoning tokens; inclusion in output tokens varies by provider. Unavailable
                telemetry or cost is not treated as zero; a dash means the value was not reported.
              </p>
              <div className="overflow-hidden rounded-lg border border-white/[0.06]">
                <Table aria-label="Reasoning usage by model">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Provider / model</TableHead>
                      <TableHead className="text-right">Requests</TableHead>
                      <TableHead className="text-right">Reported reasoning requests</TableHead>
                      <TableHead className="text-right">Reasoning tokens</TableHead>
                      <TableHead className="text-right">Output tokens</TableHead>
                      <TableHead className="text-right">Reasoning share</TableHead>
                      <TableHead className="text-right">Reasoning cost</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {reasoningRows.map((row) => {
                      const reasoningCost = formatReasoningCost(
                        row.reasoning_cost_microcents,
                        row.unknown_reasoning_cost_requests,
                      );
                      return (
                        <TableRow key={`${row.provider}:${row.model}`}>
                          <TableCell>
                            <div className="font-medium text-white">{row.model}</div>
                            <div className="text-xs text-neutral-500">{row.provider}</div>
                          </TableCell>
                          <TableCell className="text-right text-neutral-300">
                            {row.requests.toLocaleString()}
                          </TableCell>
                          <TableCell className="text-right text-neutral-300">
                            {row.reasoning_token_requests.toLocaleString()}
                          </TableCell>
                          <TableCell className="text-right text-neutral-300">
                            {row.reasoning_tokens.toLocaleString()}
                          </TableCell>
                          <TableCell className="text-right text-neutral-300">
                            {row.output_tokens.toLocaleString()}
                          </TableCell>
                          <TableCell className="text-right text-neutral-300">
                            {row.reasoning_output_share != null
                              ? `${Math.round(row.reasoning_output_share * 100)}%`
                              : '—'}
                          </TableCell>
                          <TableCell className="text-right text-neutral-300">{reasoningCost}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}



          {/* Token hygiene recommendations */}
          {tokenHygiene && tokenHygiene.records.length > 0 && (
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-6">
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                  <Target className="h-5 w-5 text-emerald-400" />
                  Token hygiene advisor
                </h3>
                <p className="text-sm text-neutral-500">
                  Average score:{' '}
                  <span className="font-medium text-white">{tokenHygiene.summary.average_score ?? '—'}/100</span>
                </p>
              </div>
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                {tokenHygiene.records
                  .flatMap((record) => record.recommendations.map((recommendation) => ({ record, recommendation })))
                  .sort((a, b) => b.recommendation.estimated_waste_microcents - a.recommendation.estimated_waste_microcents)
                  .slice(0, 6)
                  .map(({ record, recommendation }) => (
                    <div key={`${record.identity_id}:${recommendation.code}`} className="rounded-lg border border-white/[0.06] bg-black/20 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium text-white">{recommendation.title}</p>
                          <p className="mt-1 text-xs text-neutral-400">{recommendation.recommendation}</p>
                        </div>
                        <span className="rounded-md bg-emerald-500/10 px-2 py-0.5 text-xs font-mono text-emerald-400">
                          {record.score}/100
                        </span>
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-neutral-500">
                        <span>{recommendation.code}</span>
                        <span>•</span>
                        <span>identity {record.identity_id.slice(0, 8)}</span>
                        <span>•</span>
                        <span>waste {formatUsd(recommendation.estimated_waste_microcents)}</span>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {/* One-shot rate by model (LAY-314) */}
          {oneShot && oneShot.by_model.length > 0 && (
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-6">
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                  <Target className="h-5 w-5 text-emerald-400" />
                  One-shot rate by model
                </h3>
                {oneShot.summary.one_shot_rate != null && (
                  <p className="text-sm text-neutral-500">
                    Overall:{' '}
                    <span className="font-medium text-white">
                      {Math.round(oneShot.summary.one_shot_rate * 100)}%
                    </span>{' '}
                    across {oneShot.summary.sessions.toLocaleString()} closed sessions
                  </p>
                )}
              </div>
              <CostQualificationNotice
                unknownCostRequests={oneShot.by_model.reduce((sum, row) => sum + row.unknown_cost_requests, 0)}
              />
              <div className="overflow-hidden rounded-lg border border-white/[0.06]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Model</TableHead>
                      <TableHead className="text-right">Sessions</TableHead>
                      <TableHead className="text-right">Edit turns</TableHead>
                      <TableHead className="text-right">Retries</TableHead>
                      <TableHead className="text-right">One-shot</TableHead>
                      <TableHead className="text-right">Billed $/successful edit</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {oneShot.by_model.map((row) => {
                      const ratePct = row.one_shot_rate != null ? Math.round(row.one_shot_rate * 100) : null;
                      const rateColor =
                        ratePct == null ? 'text-neutral-500'
                          : ratePct >= 80 ? 'text-emerald-400'
                          : ratePct >= 60 ? 'text-amber-400'
                          : 'text-red-400';
                      return (
                        <TableRow key={row.model}>
                          <TableCell className="font-medium text-white">{row.model}</TableCell>
                          <TableCell className="text-right text-neutral-300">
                            {row.sessions.toLocaleString()}
                          </TableCell>
                          <TableCell className="text-right text-neutral-300">
                            {row.edit_turns.toLocaleString()}
                          </TableCell>
                          <TableCell className="text-right text-neutral-400">
                            {row.retry_turns.toLocaleString()}
                          </TableCell>
                          <TableCell className={`text-right font-medium ${rateColor}`}>
                            {ratePct != null ? `${ratePct}%` : '—'}
                          </TableCell>
                          <TableCell className="text-right text-neutral-300">
                            {row.billed_cost_per_successful_edit_microcents != null
                              ? formatUsd(row.billed_cost_per_successful_edit_microcents)
                              : '—'}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}

          {/* Cache Performance */}
          {data.cache.total > 0 && (
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-6">
              <h3 className="mb-4 text-lg font-semibold text-white flex items-center gap-2">
                <Zap className="h-5 w-5 text-violet-400" />
                Cache Performance
              </h3>
              <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
                <div>
                  <p className="text-sm text-neutral-500">Total Requests</p>
                  <p className="mt-1 text-2xl font-bold text-white">{data.cache.total.toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-sm text-neutral-500">Cache Hits</p>
                  <p className="mt-1 text-2xl font-bold text-emerald-400">{data.cache.hits.toLocaleString()}</p>
                  <p className="text-xs text-neutral-500">
                    {Math.round((data.cache.hits / data.cache.total) * 100)}% hit rate
                  </p>
                </div>
                <div>
                  <p className="text-sm text-neutral-500">Cache Savings</p>
                  <p className="mt-1 text-2xl font-bold text-cyan-400">{formatUsd(data.cache.savings)}</p>
                </div>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] py-16 text-center">
          <div className="flex justify-center mb-4">
            <TrendingUp className="h-10 w-10 text-neutral-600" />
          </div>
          <h3 className="text-lg font-semibold text-white mb-2">No analytics yet</h3>
          <p className="text-sm text-neutral-500 max-w-md mx-auto">
            Once requests flow through RouteShift, cost trends and provider comparisons will appear here.
          </p>
        </div>
      )}
    </div>
  );
}
