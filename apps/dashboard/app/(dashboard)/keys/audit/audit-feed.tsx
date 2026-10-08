'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollText } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  AUDIT_EVENT_TYPES,
  auditEventBadgeStyle,
  auditEventLabel,
} from '@/lib/key-audit-event';

interface AuditEvent {
  id: string;
  api_key_id: string | null;
  key_prefix: string | null;
  // Keep the wire type open so newer proxy events remain visible instead of
  // crashing or rendering an empty badge while the dashboard catches up.
  event_type: string;
  actor_user_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

interface Filters {
  event_type: string;
  actor: string;
  key_prefix: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: Filters = {
  event_type: '',
  actor: '',
  key_prefix: '',
  from: '',
  to: '',
};

function buildQuery(filters: Filters, next?: string | null): string {
  const qs = new URLSearchParams();
  qs.set('limit', '50');
  for (const [key, value] of Object.entries(filters)) {
    if (value) qs.set(key, value);
  }
  if (next) qs.set('cursor', next);
  return qs.toString();
}

export function AuditFeed() {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const appliedFilters = useRef<Filters>(EMPTY_FILTERS);
  const requestGeneration = useRef(0);
  const replacementInFlight = useRef(false);
  // AXI-7 review round 1: concurrent appends share one generation, so two
  // Load-more activations racing the re-render could both fire and merge in
  // arrival order. One in-flight append at a time closes that window.
  const appendInFlight = useRef(false);

  const load = useCallback(
    async (
      mode: 'replace' | 'append',
      next?: string | null,
      queryFilters: Filters = appliedFilters.current,
    ) => {
      if (mode === 'append') {
        if (replacementInFlight.current || appendInFlight.current) return;
        appendInFlight.current = true;
      }
      const generation =
        mode === 'replace' ? ++requestGeneration.current : requestGeneration.current;
      if (mode === 'replace') {
        replacementInFlight.current = true;
        setCursor(null);
      }
      const setBusy = mode === 'replace' ? setLoading : setLoadingMore;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/keys/audit?${buildQuery(queryFilters, next)}`, {
          cache: 'no-store',
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            error?: { message?: string } | string;
          };
          const msg =
            typeof data.error === 'string'
              ? data.error
              : data.error?.message ?? `HTTP ${res.status}`;
          throw new Error(msg);
        }
        const data = (await res.json()) as { events: AuditEvent[]; next_cursor: string | null };
        if (generation !== requestGeneration.current) return;
        setEvents((prev) => (mode === 'replace' ? data.events : [...prev, ...data.events]));
        setCursor(data.next_cursor);
      } catch (err) {
        if (generation !== requestGeneration.current) return;
        setError(err instanceof Error ? err.message : 'Failed to load audit events');
      } finally {
        if (mode === 'append' || generation === requestGeneration.current) {
          if (mode === 'replace') replacementInFlight.current = false;
          if (mode === 'append') appendInFlight.current = false;
          setBusy(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    void load('replace', null);
  }, [load]);

  function applyFilters(e: React.FormEvent) {
    e.preventDefault();
    appliedFilters.current = filters;
    void load('replace', null, filters);
  }

  function resetFilters() {
    setFilters(EMPTY_FILTERS);
    appliedFilters.current = EMPTY_FILTERS;
    void load('replace', null, EMPTY_FILTERS);
  }

  const hasFilters = Object.values(filters).some((value) => value !== '');

  return (
    <div className="space-y-6">
      <form
        onSubmit={applyFilters}
        className="grid grid-cols-1 gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 md:grid-cols-5"
      >
        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          Event type
          <select
            value={filters.event_type}
            onChange={(e) => setFilters((f) => ({ ...f, event_type: e.target.value }))}
            className="rounded-md border border-white/[0.08] bg-neutral-900 px-2 py-1.5 text-sm text-white focus:border-emerald-500 focus:outline-none"
          >
            <option value="">All</option>
            {AUDIT_EVENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {auditEventLabel(type)}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          Actor user id
          <input
            type="text"
            value={filters.actor}
            onChange={(e) => setFilters((f) => ({ ...f, actor: e.target.value }))}
            placeholder="user_…"
            className="rounded-md border border-white/[0.08] bg-neutral-900 px-2 py-1.5 text-sm text-white placeholder:text-neutral-600 focus:border-emerald-500 focus:outline-none"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          Key prefix
          <input
            type="text"
            value={filters.key_prefix}
            onChange={(e) => setFilters((f) => ({ ...f, key_prefix: e.target.value }))}
            placeholder="rs_live_…"
            className="rounded-md border border-white/[0.08] bg-neutral-900 px-2 py-1.5 text-sm text-white placeholder:text-neutral-600 focus:border-emerald-500 focus:outline-none"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          From
          <input
            type="datetime-local"
            value={filters.from}
            onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
            className="rounded-md border border-white/[0.08] bg-neutral-900 px-2 py-1.5 text-sm text-white focus:border-emerald-500 focus:outline-none"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          To
          <input
            type="datetime-local"
            value={filters.to}
            onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
            className="rounded-md border border-white/[0.08] bg-neutral-900 px-2 py-1.5 text-sm text-white focus:border-emerald-500 focus:outline-none"
          />
        </label>

        <div className="flex items-end gap-2 md:col-span-5">
          <button
            type="submit"
            className="rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-700"
          >
            Apply
          </button>
          <button
            type="button"
            onClick={resetFilters}
            className="rounded-md border border-white/[0.08] px-4 py-1.5 text-sm text-neutral-300 transition-colors hover:bg-white/[0.04]"
          >
            Reset
          </button>
        </div>
      </form>

      {error && (
        <p className="rounded-md border border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      {loading ? (
        <ul className="space-y-2">
          {Array.from({ length: 6 }, (_, i) => (
            <li
              key={i}
              className="h-16 animate-pulse rounded-lg border border-white/[0.04] bg-white/[0.02]"
            />
          ))}
        </ul>
      ) : events.length === 0 ? (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] py-16 text-center">
          <ScrollText className="mx-auto mb-4 h-10 w-10 text-neutral-600" />
          <h3 className="mb-2 text-lg font-semibold text-white">
            {hasFilters ? 'No matching audit events' : 'No audit events yet'}
          </h3>
          <p className="mx-auto max-w-md text-sm text-neutral-500">
            {hasFilters
              ? 'Try adjusting your filters to find what you\'re looking for.'
              : 'Key lifecycle and guardrail events will appear here as they are recorded.'}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-white/[0.06]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Details</TableHead>
                <TableHead>When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((event) => (
                <TableRow key={event.id}>
                  <TableCell className="align-top">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${auditEventBadgeStyle(event.event_type)}`}
                      >
                        {auditEventLabel(event.event_type)}
                      </span>
                      {typeof event.details?.kind === 'string' && (
                        <span className="rounded-full border border-white/[0.08] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-neutral-400">
                          {event.details.kind as string}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="align-top font-mono text-xs text-neutral-300">
                    {event.key_prefix ? `${event.key_prefix}…` : '—'}
                  </TableCell>
                  <TableCell className="align-top font-mono text-xs text-neutral-400">
                    {event.actor_user_id ?? '—'}
                  </TableCell>
                  <TableCell className="align-top whitespace-normal text-xs text-neutral-400">
                    {Object.keys(event.details).length === 0 ? (
                      '—'
                    ) : (
                      <details>
                        <summary className="cursor-pointer text-neutral-500 hover:text-neutral-300">
                          {Object.keys(event.details).length} field
                          {Object.keys(event.details).length === 1 ? '' : 's'}
                        </summary>
                        <pre className="mt-1 overflow-x-auto rounded bg-black/40 px-2 py-1.5 font-mono text-[11px]">
                          {JSON.stringify(event.details, null, 2)}
                        </pre>
                      </details>
                    )}
                  </TableCell>
                  <TableCell
                    className="align-top text-xs text-neutral-500"
                    suppressHydrationWarning
                  >
                    {new Date(event.created_at).toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {cursor && !loading && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => void load('append', cursor)}
            disabled={loadingMore}
            className="rounded-md border border-white/[0.08] px-4 py-1.5 text-sm text-neutral-300 transition-colors hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}
