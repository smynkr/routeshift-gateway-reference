'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Puzzle } from 'lucide-react';
import { CopyButton } from '@/components/copy-button';
import { KpiCard } from '@/components/stats/kpi-card';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { TableSkeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DEFAULT_PLUGINS_PERIOD,
  formatMicrocentsAsUsd,
  isPluginsUsagePeriod,
  type PluginRecentWarning,
  type PluginUsageByPlugin,
  type PluginsUsageEnvelope,
  type PluginsUsagePeriod,
} from '@/lib/plugins';
import { CURRENT_MODELS } from '@/lib/current-models';
import { extractProxyError } from '@/lib/shadow-experiments';

interface PluginsClientProps {
  demo: boolean;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string; code: string | null }
  | { kind: 'ready'; envelope: PluginsUsageEnvelope; refreshError?: { message: string; code: string | null } };

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Fail-closed envelope guard: every field the renderers dereference must be
 * present, correctly typed, and within range. A corrupt negative or
 * out-of-range value is rejected into the invalid-response error state rather
 * than rendered as a plausible zero (formatMicrocentsAsUsd clamps negatives,
 * which would otherwise mask corruption). plugin_id is any non-empty string —
 * the route unions ids recorded in plugin_runs beyond PLUGIN_IDS, and unknown
 * ids must render verbatim, not be guarded away.
 */
function isByPluginRow(value: unknown): value is PluginUsageByPlugin {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<PluginUsageByPlugin>;
  return (
    typeof row.plugin_id === 'string' &&
    row.plugin_id.length > 0 &&
    isNonNegativeInt(row.runs) &&
    isNonNegativeInt(row.ok) &&
    isNonNegativeInt(row.warning) &&
    isNonNegativeInt(row.error) &&
    isNonNegativeInt(row.skipped) &&
    isNonNegativeInt(row.cost_microcents)
  );
}

function isRecentWarning(value: unknown): value is PluginRecentWarning {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<PluginRecentWarning>;
  return (
    typeof row.plugin_id === 'string' &&
    row.plugin_id.length > 0 &&
    (row.status === 'warning' || row.status === 'error' || row.status === 'skipped') &&
    (row.detail === null || typeof row.detail === 'string') &&
    isNonNegativeInt(row.cost_microcents) &&
    isNonNegativeInt(row.latency_ms) &&
    typeof row.created_at === 'string'
  );
}

function isPluginsUsageEnvelope(value: unknown): value is PluginsUsageEnvelope {
  if (!value || typeof value !== 'object') return false;
  const envelope = value as Partial<PluginsUsageEnvelope>;
  if (typeof envelope.period !== 'string' || !isPluginsUsagePeriod(envelope.period)) return false;
  const summary = envelope.summary;
  if (!summary || typeof summary !== 'object') return false;
  if (!isNonNegativeInt(summary.total_plugin_cost_microcents)) return false;
  if (!isNonNegativeInt(summary.total_runs)) return false;
  if (!isNonNegativeInt(summary.requests_with_plugins)) return false;
  if (!Array.isArray(summary.by_plugin) || !summary.by_plugin.every(isByPluginRow)) return false;
  if (!Array.isArray(envelope.recent_warnings) || !envelope.recent_warnings.every(isRecentWarning)) return false;
  // Cross-field consistency: cost only exists where runs exist, and at least
  // one run belongs to each distinct request. Internally inconsistent but
  // type-valid envelopes fail closed rather than render as plausible zeros.
  if (summary.total_runs === 0 && summary.total_plugin_cost_microcents > 0) return false;
  if (summary.requests_with_plugins > summary.total_runs) return false;
  return true;
}

const ACTIVATION_PATHS = [
  {
    title: 'Top-level plugins array',
    description:
      'Each entry is a plugin spec: id (web or file-parser), plus optional required, max_results, and search_prompt.',
    example: '"plugins": [{ "id": "web", "max_results": 5 }]',
  },
  {
    title: ':online model suffix',
    description:
      'Equivalent to adding { "id": "web" } with default options. The suffix is stripped before the upstream call.',
    example: `"model": "${CURRENT_MODELS.default}:online"`,
  },
  {
    title: 'Implicit file-parser',
    description:
      'Any message (or system / system_prompt) content part of type file or input_file activates file-parser with no explicit entry.',
    example: '{ "type": "file", "file_data": "data:application/pdf;base64,JVBERi0..." }',
  },
] as const;

const FILE_PARSER_BUDGETS = [
  { limit: 'Max decoded size per file', value: '10 MiB' },
  { limit: 'Max combined file size per request', value: '10 MiB' },
  { limit: 'Max PDF pages per file', value: '100' },
  { limit: 'Max extracted text per file', value: '1,000,000 characters' },
  { limit: 'Max combined extracted text per request', value: '1,000,000 characters' },
  { limit: 'Max files per request', value: '10' },
] as const;

const PERIOD_LABELS: Record<PluginsUsagePeriod, string> = {
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
};

const WARNING_BADGE_CLASS: Record<PluginRecentWarning['status'], string> = {
  warning: 'bg-amber-500/10 text-amber-400',
  error: 'bg-red-500/10 text-red-400',
  skipped: 'bg-neutral-500/10 text-neutral-400',
};

const WARNING_BADGE_LABEL: Record<PluginRecentWarning['status'], string> = {
  warning: 'Warning',
  error: 'Error',
  skipped: 'Skipped',
};

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    // The warnings feed is the on-call triage surface; correlating against
    // UTC server logs with an unlabeled browser-local time invites misreads.
    timeZoneName: 'short',
  });
}

function CopyableExample({ example }: { example: string }) {
  return (
    <div className="flex min-w-0 items-center rounded-lg border border-white/[0.06] bg-white/[0.03] pl-3">
      <pre className="min-w-0 flex-1 overflow-x-auto py-2 font-mono text-xs text-neutral-300">{example}</pre>
      <CopyButton text={example} />
    </div>
  );
}

export function PluginsClient({ demo }: PluginsClientProps) {
  const [period, setPeriod] = useState<PluginsUsagePeriod>(DEFAULT_PLUGINS_PERIOD);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  // True whenever a load is in flight after data is already on screen, so the
  // freshly selected period never mislabels the prior period's numbers.
  const [refreshing, setRefreshing] = useState(false);
  // Out-of-order load protection: only the latest request may write state.
  const requestSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const loadUsage = useCallback(async (requestedPeriod: PluginsUsagePeriod) => {
    const seq = ++requestSeqRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setRefreshing(true);
    // Keep data already on screen during a reload (subtle refresh), failure
    // included: a failed refetch must never destroy last-known-good numbers.
    setState((current) =>
      current.kind === 'ready'
        ? { kind: 'ready', envelope: current.envelope }
        : { kind: 'loading' },
    );

    // Terminal failure on a refetch keeps the ready envelope and adds an
    // inline banner; with nothing ever displayed it becomes the full error state.
    const failRefresh = (message: string, code: string | null) => {
      setRefreshing(false);
      setState((current) =>
        current.kind === 'ready'
          ? { ...current, refreshError: { message, code } }
          : { kind: 'error', message, code },
      );
    };

    try {
      const response = await fetch(`/api/plugins/usage?period=${requestedPeriod}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      const payload: unknown = await response.json().catch(() => null);
      if (seq !== requestSeqRef.current) return;
      if (response.status === 401) {
        // Expired/revoked session: send the user to login (house convention:
        // window.location.href). Also surface the error state: if navigation
        // is blocked (sandboxed/embedded context) the card must not hang on an
        // eternal skeleton/Updating spinner with no path forward.
        window.location.href = '/login?callbackUrl=/plugins';
        failRefresh('Session expired — redirecting to login.', null);
        return;
      }
      if (!response.ok) {
        const failure = extractProxyError(payload, 'Failed to load plugin usage.');
        failRefresh(failure.message, failure.code);
        return;
      }
      if (!isPluginsUsageEnvelope(payload)) {
        failRefresh('Received an invalid plugin usage response.', null);
        return;
      }
      if (payload.period !== requestedPeriod) {
        // The selector only emits whitelisted values, so a mismatched echo
        // means the answer does not describe the requested window. Never
        // render a period the user did not ask for.
        failRefresh('Received an invalid plugin usage response.', null);
        return;
      }
      setState({ kind: 'ready', envelope: payload });
      setRefreshing(false);
    } catch (err) {
      if (seq !== requestSeqRef.current) return;
      if (err instanceof Error && err.name === 'AbortError') return;
      failRefresh('Failed to load plugin usage.', null);
    }
  }, []);

  useEffect(() => {
    void loadUsage(period);
    return () => {
      abortRef.current?.abort();
    };
  }, [period, loadUsage]);

  const envelope = state.kind === 'ready' ? state.envelope : null;
  // Keyed on period-scoped runs ONLY: the warnings feed is all-time, so a
  // historical warning must never suppress the honest empty state.
  const isEmpty = envelope !== null && envelope.summary.total_runs === 0;

  return (
    <section className="space-y-6" aria-labelledby="plugins-heading">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 id="plugins-heading" className="text-3xl font-bold text-white">
            Plugins
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-neutral-400">
            Plugins augment a request before it reaches the upstream model: web injects search
            results, file-parser extracts text from files so non-multimodal models can read them.
          </p>
        </div>
      </div>

      {/* Explainer */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Activate plugins</CardTitle>
            <CardDescription>Three ways to turn a plugin on for a request.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {ACTIVATION_PATHS.map((path, index) => (
              <div key={path.title} className="space-y-2">
                <p className="text-sm font-medium text-white">
                  {index + 1}. {path.title}
                </p>
                <p className="text-sm text-neutral-400">{path.description}</p>
                <CopyableExample example={path.example} />
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Web search</CardTitle>
            <CardDescription>The web plugin meters a surcharge per search.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-neutral-500">Price per search</span>
              <span className="text-neutral-300">
                {formatMicrocentsAsUsd(500_000)} default ·{' '}
                <span className="font-mono text-xs">WEB_SEARCH_SURCHARGE_MICROCENTS</span>
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-500">max_results</span>
              <span className="text-neutral-300">Default 5, capped at 10</span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-500">Fetch timeout</span>
              <span className="font-mono text-neutral-300">PLUGIN_FETCH_TIMEOUT_MS · 5000 ms</span>
            </div>
            <p className="text-xs text-neutral-500">
              The timeout is shared: it also bounds file-parser URL fetches.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>File parser</CardTitle>
            <CardDescription>
              Free — no surcharge. Defaults shown; operators tune them via the PLUGIN_MAX_* env vars.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-xl border border-white/[0.06]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Limit</TableHead>
                    <TableHead>Value</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {FILE_PARSER_BUDGETS.map((budget) => (
                    <TableRow key={budget.limit}>
                      <TableCell className="text-neutral-400">{budget.limit}</TableCell>
                      <TableCell className="text-neutral-300">{budget.value}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Failure contract</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm text-neutral-400">
              <li>
                An optional plugin that fails degrades: the request continues upstream and the
                response carries{' '}
                <span className="font-mono text-xs text-neutral-300">X-RouteShift-Plugin-Warning</span>{' '}
                and{' '}
                <span className="font-mono text-xs text-neutral-300">X-RouteShift-Plugin-Skip-Reason</span>{' '}
                headers; non-streaming bodies also gain a{' '}
                <span className="font-mono text-xs text-neutral-300">warnings[]</span> array.
              </li>
              <li>
                A plugin marked <span className="font-mono text-xs text-neutral-300">required: true</span>{' '}
                that fails aborts the request with 502 and code{' '}
                <span className="font-mono text-xs text-neutral-300">plugin_required_failed</span>.
              </li>
              <li>
                A malformed plugins array or unknown plugin id is rejected with 400{' '}
                <span className="font-mono text-xs text-neutral-300">invalid_plugin</span> before any
                upstream call.
              </li>
              <li>Plugin-bearing requests are never served from or written to the response cache.</li>
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Privacy</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-neutral-400">
              Web search results are attacker-controlled. They are injected into the model call as an{' '}
              <span className="font-mono text-xs text-neutral-300">untrusted_web_search_results</span>{' '}
              envelope in a user role message — never into the system message.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Live usage strip */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-1.5">
              <CardTitle>Plugin usage</CardTitle>
              <CardDescription>Runs, outcomes, and cost for the selected period.</CardDescription>
              {demo && (
                <p className="text-xs text-neutral-500">
                  Demo mode — usage reads come from the seeded demo team.
                </p>
              )}
            </div>
            <div className="relative shrink-0">
              <select
                value={period}
                onChange={(event) => {
                  const next = event.target.value;
                  if (isPluginsUsagePeriod(next)) setPeriod(next);
                }}
                aria-label="Usage period"
                className="appearance-none rounded-lg border border-white/[0.06] bg-white/[0.03] py-2 pl-3 pr-8 text-sm text-neutral-300 focus:border-emerald-500/50 focus:outline-none"
              >
                <option value="24h">Last 24 hours</option>
                <option value="7d">Last 7 days</option>
                <option value="30d">Last 30 days</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div aria-label="Plugin usage data" aria-busy={refreshing} role="region">
            {state.kind === 'loading' && <TableSkeleton rows={4} cols={5} />}

            {state.kind === 'error' && (
              <div className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-5 py-4" role="alert">
                <p className="text-sm text-red-200">
                  {state.message}
                  {state.code && <span className="ml-2 font-mono text-xs text-red-300">{state.code}</span>}
                </p>
                <button
                  type="button"
                  onClick={() => void loadUsage(period)}
                  className="mt-3 text-sm font-medium text-red-100 underline decoration-red-400/40 underline-offset-4 hover:text-white"
                >
                  Retry
                </button>
              </div>
            )}

            {refreshing && state.kind === 'ready' && (
              <p className="text-xs text-neutral-500" role="status">
                Updating…
              </p>
            )}

            {state.kind === 'ready' && state.refreshError && (
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-5 py-4" role="alert">
                <p className="text-sm text-amber-200">
                  {state.refreshError.message}
                  {state.refreshError.code && (
                    <span className="ml-2 font-mono text-xs text-amber-300">{state.refreshError.code}</span>
                  )}
                  {/* The selector already advanced to the new period; without the
                      named period here, the old figures would sit under the new label. */}
                  <span className="ml-2 text-amber-300/80">
                    (refresh failed — showing last-known-good numbers for {PERIOD_LABELS[state.envelope.period]})
                  </span>
                </p>
                <button
                  type="button"
                  onClick={() => void loadUsage(period)}
                  className="mt-3 text-sm font-medium text-amber-100 underline decoration-amber-400/40 underline-offset-4 hover:text-white"
                >
                  Retry
                </button>
              </div>
            )}

            {isEmpty && envelope && (
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] px-5 py-14 text-center">
                <Puzzle className="mx-auto mb-4 h-10 w-10 text-neutral-600" />
                <h3 className="text-lg font-semibold text-white">No plugin usage</h3>
                <p className="mx-auto mt-2 max-w-md text-sm text-neutral-500">
                  No plugin runs recorded for this team in the selected period. Activate a plugin on a
                  request to see runs and spend here.
                </p>
              </div>
            )}

            {!isEmpty && envelope && (
              <div className="space-y-6">
                <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                  <KpiCard
                    title="Total plugin cost"
                    value={formatMicrocentsAsUsd(envelope.summary.total_plugin_cost_microcents)}
                    subtitle="Web search surcharge; file-parser is free"
                  />
                  <KpiCard title="Total runs" value={envelope.summary.total_runs.toLocaleString()} />
                  <KpiCard
                    title="Requests with plugins"
                    value={envelope.summary.requests_with_plugins.toLocaleString()}
                  />
                </div>

                <div className="overflow-x-auto rounded-xl border border-white/[0.06]">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Plugin</TableHead>
                        <TableHead>Runs</TableHead>
                        <TableHead>OK</TableHead>
                        <TableHead>Warning</TableHead>
                        <TableHead>Error</TableHead>
                        <TableHead>Skipped</TableHead>
                        <TableHead>Cost</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {envelope.summary.by_plugin.map((row) => (
                        <TableRow key={row.plugin_id}>
                          <TableCell className="font-mono text-white">{row.plugin_id}</TableCell>
                          <TableCell className="text-neutral-300">{row.runs.toLocaleString()}</TableCell>
                          <TableCell className="text-neutral-300">{row.ok.toLocaleString()}</TableCell>
                          <TableCell className="text-amber-300">{row.warning.toLocaleString()}</TableCell>
                          <TableCell className="text-red-300">{row.error.toLocaleString()}</TableCell>
                          <TableCell className="text-neutral-400">{row.skipped.toLocaleString()}</TableCell>
                          <TableCell className="text-neutral-300">{formatMicrocentsAsUsd(row.cost_microcents)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}

            {envelope && envelope.recent_warnings.length > 0 && (
              <div className={!isEmpty ? 'mt-6 space-y-2' : 'space-y-2'}>
                <div>
                  <h4 className="text-sm font-semibold text-white">Recent warnings</h4>
                  <p className="text-xs text-neutral-500">
                    The 20 most recent non-ok plugin runs for this team, newest first — all-time, not
                    filtered by the selected period.
                  </p>
                </div>
                <ul className="space-y-2">
                  {envelope.recent_warnings.map((warning, index) => (
                    <li
                      key={`${warning.created_at}:${index}`}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-xs"
                    >
                      <span className="font-mono text-neutral-300">{warning.plugin_id}</span>
                      <span
                        className={`inline-flex rounded-md px-2 py-0.5 font-medium ${WARNING_BADGE_CLASS[warning.status]}`}
                      >
                        {WARNING_BADGE_LABEL[warning.status]}
                      </span>
                      {/* Verbatim — exact detail codes are never collapsed. */}
                      <span className="break-all font-mono text-neutral-400">{warning.detail ?? '—'}</span>
                      <span className="ml-auto whitespace-nowrap text-neutral-500">
                        {formatMicrocentsAsUsd(warning.cost_microcents)} ·{' '}
                        {warning.latency_ms.toLocaleString()}ms · {formatTimestamp(warning.created_at)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
