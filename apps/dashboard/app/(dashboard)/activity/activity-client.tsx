'use client';

import { Fragment, useCallback, useEffect, useRef, useState, useTransition } from 'react';
import {
  RefreshCw,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  AlertCircle,
  CheckCircle2,
  ArrowRightLeft,
  Zap,
  Search,
  ScrollText,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PROVIDERS } from '@routeshift/shared';
import { buildActivityHref, parseActivityFilters, serializeActivityFilters, type ActivityFilters } from '@/lib/activity-filters';
import { providerBadgeClass } from '@/lib/providers';
import { ACTIVITY_CATEGORIES, categoryColor, categoryLabel } from '@/lib/activity-categories';
import { qualityReasonLabel, cascadeAttemptsHeader } from '@/lib/quality-reasons';
import {
  MICROCENTS_TO_USD,
  formatCost,
  formatObservedCost,
  shouldShowRoutingSavings,
  type ActivityLog,
} from '@/lib/activity-log';

import { TableSkeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
export { shouldShowRoutingSavings } from '@/lib/activity-log';


interface LogsResponse {
  logs: ActivityLog[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

interface ActivityClientProps {
  initialFilters?: ActivityFilters;
}

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffSec = Math.max(0, Math.floor(diffMs / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}


function StatusBadge({ code }: { code: number }) {
  if (code < 400) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-400">
        <CheckCircle2 className="h-3 w-3" />
        {code}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-400">
      <AlertCircle className="h-3 w-3" />
      {code}
    </span>
  );
}

function ProviderBadge({ provider }: { provider: string }) {
  return (
    <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${providerBadgeClass(provider)}`}>
      {provider}
    </span>
  );
}

function ExpandedRow({ log, onFilterSession }: { log: ActivityLog; onFilterSession: (sessionId: string) => void }) {
  const wasRouted = log.model_requested !== log.model_resolved;
  const savingsUsd = log.savings_microcents / MICROCENTS_TO_USD;
  const errorTypeLabel = qualityReasonLabel(log.error_type);

  return (
    <TableRow>
      <TableCell colSpan={7} className="whitespace-normal bg-white/[0.01] px-6 py-4">
        <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
          {/* Routing */}
          <div className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">Routing</h4>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-neutral-500">Requested</span>
                <span className="font-mono text-neutral-300">{log.model_requested}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500">Resolved</span>
                <span className="font-mono text-neutral-300">{log.model_resolved}</span>
              </div>
              {wasRouted && (
                <div className="flex items-center gap-1.5 text-xs text-amber-400">
                  <ArrowRightLeft className="h-3 w-3" />
                  Routed to different model
                </div>
              )}
              {log.is_fallback && (
                <div className="flex items-center gap-1.5 text-xs text-orange-400">
                  <Zap className="h-3 w-3" />
                  Fallback activated
                </div>
              )}
              {log.fallback_attempts.length > 0 && (
                <div className="space-y-2 border-t border-white/[0.06] pt-3">
                  <h5 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
                    {cascadeAttemptsHeader(log)}
                  </h5>
                  <div className="space-y-2">
                    {log.fallback_attempts.map((attempt, index) => {
                      const reasonLabel = qualityReasonLabel(attempt.error);
                      return (
                        <div key={`${attempt.provider}-${attempt.model}-${index}`} className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <ProviderBadge provider={attempt.provider} />
                            <span className="font-mono text-xs text-neutral-300">{attempt.model}</span>
                            {/* Only cascade attempts carry actual_cost_known; plain fallback/skip
                                rows omit it and have no per-attempt cost to mark. */}
                            {attempt.actual_cost_known === false && (
                              <span
                                className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-xs font-medium text-amber-400"
                                title="This attempt's cost is not exactly known"
                              >
                                cost unknown
                              </span>
                            )}
                          </div>
                          {/* Raw code first, human label additive — exact reasons are never collapsed. */}
                          <div className="break-words font-mono text-xs text-red-300">
                            {attempt.error}
                            {reasonLabel && <span className="ml-2 font-sans text-neutral-500">{reasonLabel}</span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              {log.plugin_warnings.length > 0 && (
                <div className="space-y-2 border-t border-white/[0.06] pt-3">
                  <h5 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">Plugin Warnings</h5>
                  <div className="space-y-2">
                    {log.plugin_warnings.map((warning, index) => (
                      <div key={`${warning.plugin}-${warning.code}-${index}`} className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="inline-flex rounded-md bg-cyan-500/10 px-2 py-0.5 text-xs font-medium text-cyan-300">
                            {warning.plugin}
                          </span>
                          <span className="font-mono text-xs text-neutral-400">{warning.code}</span>
                        </div>
                        <div className="break-words font-mono text-xs text-amber-300">{warning.message}</div>
                        <div className="break-words font-mono text-xs text-neutral-500">
                          reason: <span className="text-amber-300">{warning.reason}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Tokens & Cost */}
          <div className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">Tokens & Cost</h4>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-neutral-500">Input tokens</span>
                <span className="text-neutral-300">{log.input_tokens.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500">Output tokens</span>
                <span className="text-neutral-300">{log.output_tokens.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500">Original routing cost</span>
                <span className="text-neutral-300">{formatCost(log.original_cost_microcents)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500">Actual routing cost</span>
                <span className="font-medium text-white">{formatObservedCost(log, log.actual_cost_microcents)}</span>
              </div>
              {log.plugin_cost_microcents > 0 && (
                <div className="flex justify-between">
                  <span className="text-neutral-500">Plugin charges</span>
                  <span className="font-medium text-white">{formatCost(log.plugin_cost_microcents)}</span>
                </div>
              )}
              <div className="flex justify-between border-t border-white/[0.06] pt-2">
                <span className="text-neutral-500">Billed spend</span>
                <span className="font-medium text-white">{formatObservedCost(log, log.billed_cost_microcents)}</span>
              </div>
              {shouldShowRoutingSavings(log) && savingsUsd > 0 && (
                <div className="flex justify-between">
                  <span className="text-neutral-500">Routing savings</span>
                  <span className="font-medium text-emerald-400">{formatCost(log.savings_microcents)}</span>
                </div>
              )}
            </div>
          </div>

          {/* Performance */}
          <div className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">Performance</h4>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-neutral-500">Total latency</span>
                <span className="text-neutral-300">{log.total_latency_ms}ms</span>
              </div>
              {log.ttft_ms != null && (
                <div className="flex justify-between">
                  <span className="text-neutral-500">Time to first token</span>
                  <span className="text-neutral-300">{log.ttft_ms}ms</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-neutral-500">Streaming</span>
                <span className="text-neutral-300">{log.is_streaming ? 'Yes' : 'No'}</span>
              </div>
              {log.error_type && (
                <div className="flex justify-between gap-2">
                  <span className="shrink-0 text-neutral-500">Error</span>
                  <span className="text-right font-mono text-red-400">
                    {log.error_type}
                    {errorTypeLabel && (
                      <span className="ml-2 font-sans text-xs text-neutral-500">{errorTypeLabel}</span>
                    )}
                  </span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-neutral-500">Request ID</span>
                <span className="font-mono text-xs text-neutral-500">{log.id}</span>
              </div>
              {log.session_id && (
                <div className="flex justify-between">
                  <span className="text-neutral-500">Session ID</span>
                  <button
                    type="button"
                    onClick={() => onFilterSession(log.session_id!)}
                    title={`Filter activity by session ${log.session_id}`}
                    className="rounded font-mono text-xs text-emerald-400/80 underline-offset-2 transition-colors hover:text-emerald-300 hover:underline focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
                  >
                    {log.session_id.slice(0, 12)}…
                  </button>
                </div>
              )}
              {log.api_key_id && (
                <div className="flex justify-between">
                  <span className="text-neutral-500">API key</span>
                  <span className="font-mono text-xs text-neutral-500" title={log.api_key_id}>
                    {log.api_key_id.slice(0, 12)}…
                  </span>
                </div>
              )}
              <div className="border-t border-white/[0.06] pt-3">
                <Link
                  href={`/activity/${encodeURIComponent(log.id)}`}
                  onClick={(event) => event.stopPropagation()}
                  className="inline-flex items-center rounded text-sm text-emerald-400 underline-offset-2 transition-colors hover:text-emerald-300 hover:underline focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
                >
                  View generation details
                </Link>
              </div>
            </div>
          </div>
        </div>
      </TableCell>
    </TableRow>
  );
}

export function ActivityClient({ initialFilters = {} }: ActivityClientProps) {
  const router = useRouter();
  const [isNavigationPending, startNavigationTransition] = useTransition();
  const [navigationGeneration, setNavigationGeneration] = useState(0);
  const [data, setData] = useState<LogsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [page, setPage] = useState(1);
  const [provider, setProvider] = useState<ActivityFilters['provider'] | ''>(initialFilters.provider ?? '');
  const [model, setModel] = useState(initialFilters.model ?? '');
  const [committedModel, setCommittedModel] = useState(initialFilters.model ?? '');
  const [resolvedModel, setResolvedModel] = useState(initialFilters.resolved_model ?? '');
  const [status, setStatus] = useState<ActivityFilters['status'] | ''>(initialFilters.status ?? '');
  const [category, setCategory] = useState<ActivityFilters['category'] | ''>(initialFilters.category ?? '');
  const [apiKeyId, setApiKeyId] = useState(initialFilters.api_key_id ?? '');
  const [session, setSession] = useState(initialFilters.session ?? '');
  const [from, setFrom] = useState(initialFilters.from ?? '');
  const [to, setTo] = useState(initialFilters.to ?? '');
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const committedModelRef = useRef(initialFilters.model ?? '');
  const currentFiltersRef = useRef<ActivityFilters>({});
  const pendingFiltersRef = useRef<ActivityFilters | null>(null);
  const appliedFiltersHrefRef = useRef(buildActivityHref(initialFilters));
  const staleNavigationHrefsRef = useRef(new Set<string>());
  const initialFiltersIdentityRef = useRef(initialFilters);
  const lastLocalNavigationHrefRef = useRef<string | null>(null);
  const navigationGenerationRef = useRef(0);
  const pendingNavigationGenerationRef = useRef<number | null>(null);
  const observedNavigationGenerationRef = useRef<number | null>(null);
  const requestSeqRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  const currentFilters: ActivityFilters = {
    provider: provider || undefined,
    model: committedModel || undefined,
    resolved_model: resolvedModel || undefined,
    status: status || undefined,
    category: category || undefined,
    api_key_id: apiKeyId || undefined,
    session: session || undefined,
    from: from || undefined,
    to: to || undefined,
  };
  currentFiltersRef.current = currentFilters;

  const replaceFilters = useCallback((nextFilters: ActivityFilters) => {
    const normalizedFilters = parseActivityFilters(Object.fromEntries(serializeActivityFilters(nextFilters)));
    const targetHref = buildActivityHref(normalizedFilters);
    const pending = pendingFiltersRef.current;
    const pendingHref = pending ? buildActivityHref(pending) : null;
    if (!pending && targetHref === appliedFiltersHrefRef.current) {
      pendingFiltersRef.current = null;
      pendingNavigationGenerationRef.current = null;
      observedNavigationGenerationRef.current = null;
      return;
    }
    if (pendingHref === targetHref) return;
    const appliedHref = appliedFiltersHrefRef.current;
    if (appliedHref !== targetHref) staleNavigationHrefsRef.current.add(appliedHref);
    if (lastLocalNavigationHrefRef.current && lastLocalNavigationHrefRef.current !== targetHref) {
      staleNavigationHrefsRef.current.add(lastLocalNavigationHrefRef.current);
    }
    lastLocalNavigationHrefRef.current = targetHref;
    pendingFiltersRef.current = normalizedFilters;
    const generation = navigationGenerationRef.current + 1;
    navigationGenerationRef.current = generation;
    pendingNavigationGenerationRef.current = generation;
    observedNavigationGenerationRef.current = null;
    setPage(1);
    startNavigationTransition(() => {
      setNavigationGeneration(generation);
      router.replace(targetHref, { scroll: false });
    });
  }, [router, startNavigationTransition]);
  const incomingFiltersHref = buildActivityHref(initialFilters);

  const canApplyIncomingFilters = useCallback(() => {
    const pending = pendingFiltersRef.current;
    if (!pending) {
      staleNavigationHrefsRef.current.clear();
      lastLocalNavigationHrefRef.current = null;
      appliedFiltersHrefRef.current = incomingFiltersHref;
      return true;
    }
    if (buildActivityHref(pending) !== incomingFiltersHref) return false;
    pendingFiltersRef.current = null;
    pendingNavigationGenerationRef.current = null;
    observedNavigationGenerationRef.current = null;
    staleNavigationHrefsRef.current.clear();
    lastLocalNavigationHrefRef.current = null;
    appliedFiltersHrefRef.current = incomingFiltersHref;
    return true;
  }, [incomingFiltersHref]);

  useEffect(() => {
    const previousInitialFilters = initialFiltersIdentityRef.current;
    if (previousInitialFilters === initialFilters) return;
    initialFiltersIdentityRef.current = initialFilters;
    const pending = pendingFiltersRef.current;
    if (pending && buildActivityHref(pending) === incomingFiltersHref) {
      pendingFiltersRef.current = null;
      pendingNavigationGenerationRef.current = null;
      observedNavigationGenerationRef.current = null;
      staleNavigationHrefsRef.current.clear();
      appliedFiltersHrefRef.current = incomingFiltersHref;
      return;
    }
    if (!pending && incomingFiltersHref === appliedFiltersHrefRef.current) {
      staleNavigationHrefsRef.current.clear();
      lastLocalNavigationHrefRef.current = null;
    }
  }, [initialFilters, incomingFiltersHref]);
  useEffect(() => {
    const generation = pendingNavigationGenerationRef.current;
    if (generation === null) return;
    if (isNavigationPending) {
      observedNavigationGenerationRef.current = generation;
      return;
    }
    if (generation !== navigationGenerationRef.current) return;
    const pending = pendingFiltersRef.current;
    if (pending) {
      const targetHref = buildActivityHref(pending);
      pendingFiltersRef.current = null;
      pendingNavigationGenerationRef.current = null;
      observedNavigationGenerationRef.current = null;
      appliedFiltersHrefRef.current = targetHref;
      staleNavigationHrefsRef.current.clear();
      lastLocalNavigationHrefRef.current = null;
    }
  }, [isNavigationPending, navigationGeneration]);

  const replaceWithFilterChange = (change: Partial<ActivityFilters>) => {
    replaceFilters({ ...currentFiltersRef.current, ...change });
  };

  // Keep the manual input responsive, but commit its URL/API value as one
  // debounced change so the shareable state and request cannot diverge.
  useEffect(() => {
    clearTimeout(debounceRef.current!);
    if (model === committedModelRef.current) return;
    debounceRef.current = setTimeout(() => {
      const normalizedModel = parseActivityFilters({ model }).model ?? '';
      if (normalizedModel === committedModelRef.current) {
        setModel(normalizedModel);
        return;
      }
      committedModelRef.current = normalizedModel;
      setModel(normalizedModel);
      setCommittedModel(normalizedModel);
      replaceFilters({
        ...currentFiltersRef.current,
        model: normalizedModel || undefined,
      });
    }, 300);
    return () => { clearTimeout(debounceRef.current!); };
  }, [model, replaceFilters]);

  // A router refresh can update non-model filters while the manual model is
  // still waiting for its 300ms commit. Only an actual external model change
  // may replace that draft.
  useEffect(() => {
    const pending = pendingFiltersRef.current;
    if (pending && buildActivityHref(pending) !== incomingFiltersHref) return;
    if (pending) pendingFiltersRef.current = null;
    appliedFiltersHrefRef.current = incomingFiltersHref;
    const nextModel = initialFilters.model ?? '';
    committedModelRef.current = nextModel;
    setModel(nextModel);
    setCommittedModel(nextModel);
    setPage(1);
  }, [initialFilters.model]);

  useEffect(() => {
    if (!canApplyIncomingFilters()) return;
    setProvider(initialFilters.provider ?? '');
    setResolvedModel(initialFilters.resolved_model ?? '');
    setStatus(initialFilters.status ?? '');
    setCategory(initialFilters.category ?? '');
    setApiKeyId(initialFilters.api_key_id ?? '');
    setSession(initialFilters.session ?? '');
    setFrom(initialFilters.from ?? '');
    setTo(initialFilters.to ?? '');
    setPage(1);
  }, [
    initialFilters.provider,
    initialFilters.resolved_model,
    initialFilters.status,
    initialFilters.category,
    initialFilters.api_key_id,
    initialFilters.session,
    initialFilters.from,
    initialFilters.to,
    canApplyIncomingFilters,
  ]);

  const fetchLogs = useCallback(async () => {
    const sequence = ++requestSeqRef.current;
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      setError(null);
      const params = new URLSearchParams({ page: String(page), limit: '50' });
      const filterParams = serializeActivityFilters(currentFiltersRef.current);
      for (const [key, value] of filterParams) params.set(key, value);

      const res = await fetch(`/api/logs?${params}`, { signal: controller.signal });
      if (!res.ok) throw new Error('Failed to fetch');
      const json = await res.json();
      if (sequence !== requestSeqRef.current || controller.signal.aborted) return;
      setData(json);
    } catch (err) {
      if (controller.signal.aborted || (err as { name?: string })?.name === 'AbortError') return;
      if (sequence !== requestSeqRef.current) return;
      console.error('Failed to fetch logs:', err);
      setError('Failed to load activity data. Please try again.');
    } finally {
      if (sequence === requestSeqRef.current) {
        setLoading(false);
        if (abortControllerRef.current === controller) abortControllerRef.current = null;
      }
    }
  }, [page, provider, committedModel, resolvedModel, status, category, apiKeyId, session, from, to]);

  useEffect(() => {
    setLoading(true);
    void fetchLogs();
    return () => abortControllerRef.current?.abort();
  }, [fetchLogs]);

  const hasFixedRange = Boolean(from || to);

  useEffect(() => {
    if (autoRefresh && !hasFixedRange) {
      intervalRef.current = setInterval(() => { void fetchLogs(); }, 5000);
    }
    return () => {
      clearInterval(intervalRef.current!);
    };
  }, [autoRefresh, hasFixedRange, fetchLogs]);

  const clearFilters = () => {
    clearTimeout(debounceRef.current!);
    committedModelRef.current = '';
    setProvider('');
    setModel('');
    setCommittedModel('');
    setResolvedModel('');
    setStatus('');
    setCategory('');
    setApiKeyId('');
    setSession('');
    setFrom('');
    setTo('');
    replaceFilters({});
  };

  const hasFilters = Boolean(provider || model || resolvedModel || status || category || apiKeyId || session || from || to);

  useEffect(() => {
    if (hasFixedRange && autoRefresh) setAutoRefresh(false);
  }, [hasFixedRange, autoRefresh]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold text-white">Activity</h2>
          <p className="mt-1 text-neutral-400">Real-time feed of API requests flowing through the proxy.</p>
        </div>
        <button
          disabled={hasFixedRange}
          onClick={() => setAutoRefresh((v) => !v)}
          className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-60 ${
            autoRefresh
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
              : 'border-white/[0.06] bg-white/[0.03] text-neutral-400 hover:border-white/[0.1] hover:text-neutral-300'
          }`}
        >
          <RefreshCw className={`h-4 w-4 ${autoRefresh ? 'animate-spin' : ''}`} />
          {hasFixedRange ? 'Fixed range' : autoRefresh ? 'Live' : 'Auto-refresh'}
        </button>
      </div>
      {hasFixedRange && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-3 py-2 text-sm text-cyan-100">
          <span>
            UTC range: {from || '—'} → {to || '—'}
          </span>
          <span>Clear the time range to restore live refresh.</span>
          <button
            type="button"
            aria-label="Clear time range filter"
            onClick={() => {
              setFrom('');
              setTo('');
              replaceWithFilterChange({ from: undefined, to: undefined });
            }}
            className="inline-flex min-h-11 items-center rounded-md px-2 font-medium text-cyan-100 underline-offset-2 hover:text-white hover:underline focus:outline-none focus:ring-2 focus:ring-cyan-300"
          >
            Clear
          </button>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <select
            value={provider}
            onChange={(e) => {
              const value = e.target.value;
              const providerValue = value as ActivityFilters['provider'] | '';
              setProvider(providerValue);
              replaceWithFilterChange({ provider: providerValue || undefined });
            }}
            className="appearance-none rounded-lg border border-white/[0.06] bg-white/[0.03] py-2 pl-3 pr-8 text-sm text-neutral-300 transition-colors hover:border-white/[0.1] focus:border-emerald-500/50 focus:outline-none"
          >
            <option value="">All providers</option>
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
          <input
            type="text"
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
            }}
            placeholder="Filter by model..."
            maxLength={200}
            className="rounded-lg border border-white/[0.06] bg-white/[0.03] py-2 pl-9 pr-3 text-sm text-neutral-300 placeholder:text-neutral-600 transition-colors hover:border-white/[0.1] focus:border-emerald-500/50 focus:outline-none"
          />
        </div>

        <div className="relative">
          <select
            value={status}
            onChange={(e) => {
              const value = e.target.value;
              const statusValue = value as ActivityFilters['status'] | '';
              setStatus(statusValue);
              replaceWithFilterChange({ status: statusValue || undefined });
            }}
            className="appearance-none rounded-lg border border-white/[0.06] bg-white/[0.03] py-2 pl-3 pr-8 text-sm text-neutral-300 transition-colors hover:border-white/[0.1] focus:border-emerald-500/50 focus:outline-none"
          >
            <option value="">All status</option>
            <option value="success">Success</option>
            <option value="error">Error</option>
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
        </div>

        <div className="relative">
          <select
            value={category}
            onChange={(e) => {
              const value = e.target.value;
              const categoryValue = value as ActivityFilters['category'] | '';
              setCategory(categoryValue);
              replaceWithFilterChange({ category: categoryValue || undefined });
            }}
            className="appearance-none rounded-lg border border-white/[0.06] bg-white/[0.03] py-2 pl-3 pr-8 text-sm text-neutral-300 transition-colors hover:border-white/[0.1] focus:border-emerald-500/50 focus:outline-none"
          >
            <option value="">All activity</option>
            {ACTIVITY_CATEGORIES.map((c) => (
              <option key={c} value={c}>{categoryLabel(c)}</option>
            ))}
            <option value="uncategorized">Uncategorized</option>
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
        </div>

        {apiKeyId && (
          <span
            title={apiKeyId}
            className="inline-flex items-center rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-300"
          >
            Key {apiKeyId.slice(0, 12)}{apiKeyId.length > 12 ? '...' : ''}
          </span>
        )}

        {session && (
          <span
            title={session}
            className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-300"
          >
            Session {session.slice(0, 12)}{session.length > 12 ? '...' : ''}
            <button
              type="button"
              aria-label="Clear session filter"
              onClick={() => {
                setSession('');
                replaceWithFilterChange({ session: undefined });
              }}
              className="rounded text-emerald-300/80 transition-colors hover:text-emerald-200"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        )}

        {resolvedModel && (
          <span
            title={resolvedModel}
            className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-3 py-2 text-sm font-medium text-cyan-200"
          >
            Resolved model {resolvedModel.slice(0, 20)}{resolvedModel.length > 20 ? '...' : ''}
            <button
              type="button"
              aria-label="Clear resolved model filter"
              onClick={() => {
                setResolvedModel('');
                replaceWithFilterChange({ resolved_model: undefined });
              }}
              className="rounded text-cyan-200/80 transition-colors hover:text-cyan-100"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        )}

        {hasFilters && (
          <button
            onClick={clearFilters}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-sm text-neutral-400 transition-colors hover:border-white/[0.1] hover:text-neutral-300"
          >
            <X className="h-3.5 w-3.5" />
            Clear
          </button>
        )}

        {data && (
          <span className="ml-auto text-sm text-neutral-500">
            {data.total.toLocaleString()} request{data.total !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Table */}
      {loading && !data ? (
        <TableSkeleton rows={6} cols={7} />
      ) : data && data.logs.length === 0 ? (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] py-16 text-center">
          <ScrollText className="mx-auto mb-4 h-10 w-10 text-neutral-600" />
          <h3 className="text-lg font-semibold text-white mb-2">
            {hasFilters ? 'No matching requests' : 'No requests yet'}
          </h3>
          <p className="text-sm text-neutral-500 max-w-md mx-auto">
            {hasFilters
              ? 'Try adjusting your filters to find what you\'re looking for.'
              : 'Point your application at RouteShift to start seeing activity here.'}
          </p>
        </div>
      ) : data && (
        <>
          <div className="overflow-hidden rounded-xl border border-white/[0.06]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8"><span className="sr-only">Expand</span></TableHead>
                  <TableHead>Time</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right">Status</TableHead>
                  <TableHead className="text-right">Latency</TableHead>
                  <TableHead className="text-right">Billed spend</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.logs.map((log) => {
                  const isExpanded = expandedId === log.id;
                  const wasRouted = log.model_requested !== log.model_resolved;
                  return (
                    <Fragment key={log.id}>
                      <TableRow
                        onClick={() => setExpandedId(isExpanded ? null : log.id)}
                        aria-expanded={isExpanded}
                        className={`cursor-pointer ${isExpanded ? 'bg-white/[0.02]' : ''}`}
                      >
                        <TableCell className="text-neutral-500">
                          <button
                            type="button"
                            aria-label={`${isExpanded ? 'Collapse' : 'Expand'} request ${log.id}`}
                            aria-expanded={isExpanded}
                            onClick={(event) => {
                              event.stopPropagation();
                              setExpandedId(isExpanded ? null : log.id);
                            }}
                            className="rounded p-1 text-neutral-500 transition-colors hover:bg-white/[0.04] hover:text-neutral-300 focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
                          >
                            {isExpanded ? (
                              <ChevronDown className="h-4 w-4" />
                            ) : (
                              <ChevronRight className="h-4 w-4" />
                            )}
                          </button>
                        </TableCell>
                        <TableCell className="text-neutral-400" suppressHydrationWarning>
                          {formatTimestamp(log.timestamp)}
                        </TableCell>
                        <TableCell>
                          <ProviderBadge provider={log.provider} />
                        </TableCell>
                        <TableCell className="whitespace-normal">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-sm text-neutral-300">
                              {log.model_resolved}
                            </span>
                            {wasRouted && (
                              <span className="text-xs text-neutral-600">
                                (from {log.model_requested})
                              </span>
                            )}
                          </div>
                          {log.activity_category && (
                            <span className="mt-1 inline-flex items-center gap-1 text-xs text-neutral-500">
                              <span className={`inline-block h-1.5 w-1.5 rounded-full ${categoryColor(log.activity_category)}`} />
                              {categoryLabel(log.activity_category)}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <span className="inline-flex items-center gap-1.5">
                            {log.cache_hit && (
                              <span className="rounded-md bg-violet-500/10 px-1.5 py-0.5 text-xs font-medium text-violet-400">
                                CACHED
                              </span>
                            )}
                            <StatusBadge code={log.status_code} />
                          </span>
                        </TableCell>
                        <TableCell className="text-right text-neutral-400">
                          {log.total_latency_ms}ms
                        </TableCell>
                        <TableCell className="text-right text-neutral-300">
                          {formatObservedCost(log, log.billed_cost_microcents)}
                        </TableCell>
                      </TableRow>
                      {isExpanded && (
                        <ExpandedRow
                          key={`${log.id}-detail`}
                          log={log}
                          onFilterSession={(id) => {
                            const normalizedSession = parseActivityFilters({ session: id }).session;
                            setExpandedId(null);
                            if (!normalizedSession) return;
                            setSession(normalizedSession);
                            replaceWithFilterChange({ session: normalizedSession });
                          }}
                        />
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          {data.totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-neutral-500">
                Page {data.page} of {data.totalPages}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-sm text-neutral-400 transition-colors hover:border-white/[0.1] hover:text-neutral-300 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <ChevronLeft className="h-4 w-4" />
                  Previous
                </button>
                <button
                  onClick={() => setPage((p) => Math.min(data.totalPages, p + 1))}
                  disabled={page === data.totalPages}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-sm text-neutral-400 transition-colors hover:border-white/[0.1] hover:text-neutral-300 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Next
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
