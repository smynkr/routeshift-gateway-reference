'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ModelAutocomplete } from '@/components/models/model-autocomplete';
import { ChevronDown, ChevronUp, Minus, ArrowLeftRight } from 'lucide-react';
import { CostQualificationNotice } from '@/components/cost-qualification-notice';

const MICROCENTS_TO_USD = 100_000_000;

const formatUsd = (mc: number, precision = 2) => {
  const usd = mc / MICROCENTS_TO_USD;
  if (usd >= 100) return `$${usd.toFixed(0)}`;
  if (usd >= 1) return `$${usd.toFixed(precision)}`;
  return `$${usd.toFixed(4)}`;
};

interface ModelMetrics {
  model: string;
  requests: number;
  /** Customer spend: routing actual cost plus plugin charges. */
  total_cost_microcents: number;
  /** Routing-only actual cost, kept separate from billed spend. */
  routing_cost_microcents: number;
  unknown_cost_requests: number;
  actual_costs_qualified: boolean;
  total_tokens: number;
  output_tokens: number;
  cache_hits: number;
  p50_latency_ms: number | null;
  p95_latency_ms: number | null;
  p99_latency_ms: number | null;
  one_shot_rate: number | null;
  edit_turns: number;
  retry_turns: number;
  billed_cost_per_successful_edit_microcents: number | null;
  billed_cost_per_successful_edit_unknown_cost_requests: number;
  billed_cost_per_successful_edit_qualified: boolean;
  cost_per_successful_edit_microcents: number | null;
}

interface CompareData {
  a: ModelMetrics;
  b: ModelMetrics;
  period: string;
}

const EQUAL_THRESHOLD = 0.05;

type Comparator = 'higher' | 'lower';

interface CompareClientProps {
  initialA: string;
  initialB: string;
  initialPeriod: string;
}

export function CompareClient({ initialA, initialB, initialPeriod }: CompareClientProps) {
  const router = useRouter();
  const [a, setA] = useState(initialA);
  const [b, setB] = useState(initialB);
  const [period, setPeriod] = useState(initialPeriod);
  const [data, setData] = useState<CompareData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchCompare = useCallback(async () => {
    if (!a || !b) return;
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(`/api/models/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}&period=${period}`);
      if (!res.ok) throw new Error('Failed to fetch');
      setData(await res.json());
    } catch (err) {
      console.error('compare fetch error:', err);
      setError('Failed to load comparison.');
    } finally {
      setLoading(false);
    }
  }, [a, b, period]);

  useEffect(() => {
    void fetchCompare();
  }, [fetchCompare]);

  // Sync URL when picks change so the view is shareable. Build the query from
  // scratch (not from `searchParams`) and keep `searchParams` out of the deps —
  // depending on it while calling router.replace re-runs the effect on every
  // navigation tick (router.replace yields a new searchParams identity).
  useEffect(() => {
    const next = new URLSearchParams();
    next.set('a', a);
    next.set('b', b);
    next.set('period', period);
    router.replace(`?${next.toString()}`, { scroll: false });
  }, [a, b, period, router]);

  const winners = data ? computeWinners(data) : null;

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-3xl font-bold text-white flex items-center gap-3">
          <ArrowLeftRight className="h-7 w-7 text-emerald-400" />
          Compare Models
        </h2>
        <p className="mt-1 text-neutral-400">
          Side-by-side metrics on your team&apos;s traffic.
        </p>
      </div>

      {/* Pickers */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_auto_1fr_auto]">
        <ModelAutocomplete value={a} onChange={setA} placeholder="Model A" />
        <div className="self-center text-neutral-500">vs</div>
        <ModelAutocomplete value={b} onChange={setB} placeholder="Model B" />
        <div className="relative self-start md:self-end">
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            className="appearance-none rounded-lg border border-white/[0.06] bg-white/[0.03] py-2 pl-3 pr-8 text-sm text-neutral-300 focus:border-emerald-500/50 focus:outline-none"
          >
            <option value="24h">24 hours</option>
            <option value="7d">7 days</option>
            <option value="30d">30 days</option>
            <option value="all">All time</option>
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Diff summary */}
      {!loading && data && winners && winners.length > 0 && (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-2">
            Where each wins
          </p>
          <div className="space-y-1.5 text-sm text-neutral-300">
            {winners.map((w, i) => (
              <p key={i}>
                <span className="font-medium text-white">{w.winner === 'a' ? a : b}</span>{' '}
                <span className="text-neutral-500">wins on</span>{' '}
                <span className="font-medium text-emerald-400">{w.metric}</span>
              </p>
            ))}
          </div>
        </div>
      )}

      {data && (
        <CostQualificationNotice unknownCostRequests={data.a.unknown_cost_requests + data.b.unknown_cost_requests} />
      )}

      {/* Side-by-side cards */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {data && (
          <>
            <ModelCard
              metrics={data.a}
              other={data.b}
              loading={loading}
            />
            <ModelCard
              metrics={data.b}
              other={data.a}
              loading={loading}
            />
          </>
        )}
        {loading && !data && (
          <>
            <div className="h-96 animate-pulse rounded-xl border border-white/[0.06] bg-white/[0.03]" />
            <div className="h-96 animate-pulse rounded-xl border border-white/[0.06] bg-white/[0.03]" />
          </>
        )}
      </div>

      {/* Empty-state hint when neither model has team traffic */}
      {data && data.a.requests === 0 && data.b.requests === 0 && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] px-4 py-3 text-sm text-amber-300">
          Neither model has team traffic in this window.
          {' '}<a href="/routing/new" className="underline hover:text-amber-200">Create a routing rule</a>{' '}
          to start collecting data.
        </div>
      )}
    </div>
  );
}

function ModelCard({
  metrics,
  other,
  loading,
}: {
  metrics: ModelMetrics;
  other: ModelMetrics;
  loading: boolean;
}) {
  const noTraffic = metrics.requests === 0;

  return (
    <article className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-6">
      <header className="mb-4 flex items-center justify-between">
        <h3 className="font-mono text-lg font-semibold text-white">{metrics.model}</h3>
      </header>

      {noTraffic ? (
        <p className="mb-4 rounded-lg border border-white/[0.04] bg-white/[0.02] px-3 py-2 text-xs text-neutral-500">
          No team traffic on this model in the selected period.
        </p>
      ) : null}

      <Section title="Volume">
        <Row label="Requests" value={metrics.requests.toLocaleString()} loading={loading} />
        <Row label="Total billed spend" value={formatUsd(metrics.total_cost_microcents)} loading={loading} />
        <Row label="Total tokens" value={metrics.total_tokens.toLocaleString()} loading={loading} />
      </Section>

      <Section title="Performance">
        <Row
          label="One-shot rate"
          value={metrics.one_shot_rate != null ? `${Math.round(metrics.one_shot_rate * 100)}%` : '—'}
          comparator="higher"
          mine={metrics.one_shot_rate}
          theirs={other.one_shot_rate}
          loading={loading}
        />
        <Row
          label="Retry rate"
          value={metrics.edit_turns > 0 ? `${Math.round((metrics.retry_turns / metrics.edit_turns) * 100)}%` : '—'}
          comparator="lower"
          mine={metrics.edit_turns > 0 ? metrics.retry_turns / metrics.edit_turns : null}
          theirs={other.edit_turns > 0 ? other.retry_turns / other.edit_turns : null}
          loading={loading}
        />
        <Row
          label="p50 latency"
          value={metrics.p50_latency_ms != null ? `${metrics.p50_latency_ms}ms` : '—'}
          comparator="lower"
          mine={metrics.p50_latency_ms}
          theirs={other.p50_latency_ms}
          loading={loading}
        />
        <Row
          label="p95 latency"
          value={metrics.p95_latency_ms != null ? `${metrics.p95_latency_ms}ms` : '—'}
          comparator="lower"
          mine={metrics.p95_latency_ms}
          theirs={other.p95_latency_ms}
          loading={loading}
        />
        <Row
          label="p99 latency"
          value={metrics.p99_latency_ms != null ? `${metrics.p99_latency_ms}ms` : '—'}
          comparator="lower"
          mine={metrics.p99_latency_ms}
          theirs={other.p99_latency_ms}
          loading={loading}
        />
      </Section>

      <Section title="Efficiency">
        <Row
          label="Billed $/successful edit"
          value={metrics.billed_cost_per_successful_edit_microcents != null ? formatUsd(metrics.billed_cost_per_successful_edit_microcents, 4) : '—'}
          comparator="lower"
          mine={metrics.billed_cost_per_successful_edit_microcents}
          theirs={other.billed_cost_per_successful_edit_microcents}
          loading={loading}
        />
        {!metrics.billed_cost_per_successful_edit_qualified && (
          <p className="-mt-2 text-xs text-amber-300">
            Observed lower bound; {metrics.billed_cost_per_successful_edit_unknown_cost_requests} session request{metrics.billed_cost_per_successful_edit_unknown_cost_requests === 1 ? '' : 's'} have unknown historical cost.
          </p>
        )}
        <Row
          label="Billed spend / call"
          value={metrics.requests > 0 ? formatUsd(metrics.total_cost_microcents / metrics.requests, 4) : '—'}
          comparator="lower"
          mine={metrics.requests > 0 ? metrics.total_cost_microcents / metrics.requests : null}
          theirs={other.requests > 0 ? other.total_cost_microcents / other.requests : null}
          loading={loading}
        />
        <Row
          label="Output tokens / call"
          value={metrics.requests > 0 ? Math.round(metrics.output_tokens / metrics.requests).toLocaleString() : '—'}
          loading={loading}
        />
        <Row
          label="Cache hit rate"
          value={metrics.requests > 0 ? `${Math.round((metrics.cache_hits / metrics.requests) * 100)}%` : '—'}
          comparator="higher"
          mine={metrics.requests > 0 ? metrics.cache_hits / metrics.requests : null}
          theirs={other.requests > 0 ? other.cache_hits / other.requests : null}
          loading={loading}
        />
      </Section>

    </article>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5 last:mb-0">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">{title}</p>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function Row({
  label,
  value,
  loading,
  comparator,
  mine,
  theirs,
}: {
  label: string;
  value: string;
  loading?: boolean;
  comparator?: Comparator;
  mine?: number | null;
  theirs?: number | null;
}) {
  const verdict = comparator && mine != null && theirs != null
    ? compareValues(mine, theirs, comparator)
    : 'tie';

  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-neutral-400">{label}</span>
      <span className={`flex items-center gap-1.5 font-medium ${verdict === 'win' ? 'text-emerald-400' : verdict === 'lose' ? 'text-neutral-500' : 'text-neutral-300'}`}>
        {loading ? <span className="h-3 w-12 animate-pulse rounded bg-white/[0.05]" /> : value}
        {!loading && verdict === 'win' && <ChevronUp className="h-3.5 w-3.5" />}
        {!loading && verdict === 'lose' && <ChevronDown className="h-3.5 w-3.5" />}
        {!loading && verdict === 'tie' && comparator && <Minus className="h-3 w-3 text-neutral-600" />}
      </span>
    </div>
  );
}

function compareValues(mine: number, theirs: number, comparator: Comparator): 'win' | 'lose' | 'tie' {
  const denom = Math.max(Math.abs(mine), Math.abs(theirs), 1e-9);
  const ratio = Math.abs(mine - theirs) / denom;
  if (ratio < EQUAL_THRESHOLD) return 'tie';
  if (comparator === 'higher') return mine > theirs ? 'win' : 'lose';
  return mine < theirs ? 'win' : 'lose';
}

function computeWinners(data: CompareData) {
  const out: Array<{ winner: 'a' | 'b'; metric: string }> = [];
  const test = (mine: number | null | undefined, theirs: number | null | undefined, comparator: Comparator, metric: string) => {
    if (mine == null || theirs == null) return;
    const verdict = compareValues(mine, theirs, comparator);
    if (verdict === 'tie') return;
    out.push({ winner: verdict === 'win' ? 'a' : 'b', metric });
  };

  test(
    data.a.billed_cost_per_successful_edit_microcents,
    data.b.billed_cost_per_successful_edit_microcents,
    'lower',
    'Billed $/successful edit',
  );
  test(data.a.one_shot_rate, data.b.one_shot_rate, 'higher', 'one-shot rate');
  test(data.a.p95_latency_ms, data.b.p95_latency_ms, 'lower', 'p95 latency');
  return out;
}
