'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CostQualificationNotice } from '@/components/cost-qualification-notice';

const MICROCENTS_TO_USD = 100_000_000;
const PERIODS = [
  { value: 'mtd', label: 'Month to date' },
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
] as const;

type PeriodValue = (typeof PERIODS)[number]['value'];

interface KeyRow {
  api_key_id: string;
  prefix: string | null;
  name: string;
  metadata: Record<string, unknown>;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cost_microcents: number;
  unknown_cost_requests: number;
  actual_costs_qualified: boolean;
  identity_windows?: {
    identity_id: string;
    windows: Array<{
      kind: 'daily' | 'weekly' | 'monthly';
      cap_usd: number | null;
      committed_usd: number;
      unknown_held_usd: number;
      unknown_cost_requests: number;
      status: 'ok' | 'alert' | 'throttle' | 'block';
      action: 'alert' | 'throttle' | 'block' | null;
      reset_at: string;
    }>;
  } | null;
  budget_windows?: Array<{
    kind: 'daily' | 'weekly' | 'monthly';
    cap_usd: number | null;
    committed_usd: number;
    unknown_held_usd: number;
    unknown_cost_requests: number;
    status: 'ok' | 'alert' | 'throttle' | 'block';
    action: 'alert' | 'throttle' | 'block' | null;
    reset_at: string;
  }>;
}

interface TagRow {
  tag_value: string;
  keys: number;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cost_microcents: number;
  unknown_cost_requests: number;
  actual_costs_qualified: boolean;
}

interface ByKeyResponse {
  period: string;
  rows: KeyRow[];
  total_cost_microcents: number;
  unknown_cost_requests: number;
  actual_costs_qualified: boolean;
}

interface ByTagResponse {
  period: string;
  key: string | null;
  rows: TagRow[];
  total_cost_microcents: number;
  unknown_cost_requests: number;
  actual_costs_qualified: boolean;
  available_keys: string[];
}

function formatUsd(microcents: number): string {
  const usd = microcents / MICROCENTS_TO_USD;
  if (usd >= 100) return usd.toFixed(0);
  if (usd >= 1) return usd.toFixed(2);
  return usd.toFixed(4);
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toString();
}

export function SpendBreakdown() {
  const [tab, setTab] = useState<'key' | 'tag'>('key');
  const [period, setPeriod] = useState<PeriodValue>('mtd');
  const [byKey, setByKey] = useState<ByKeyResponse | null>(null);
  const [byTag, setByTag] = useState<ByTagResponse | null>(null);
  const [tagKey, setTagKey] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setLoading(true);
    const url =
      tab === 'key'
        ? `/api/billing/by-key?period=${period}`
        : `/api/billing/by-tag?period=${period}${tagKey ? `&key=${encodeURIComponent(tagKey)}` : ''}`;
    fetch(url)
      .then(async (res) => {
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(data.error ?? 'Failed to load breakdown');
          return;
        }
        if (tab === 'key') {
          setByKey(data as ByKeyResponse);
        } else {
          setByTag(data as ByTagResponse);
          // Auto-select the first available tag if none picked yet.
          if (!tagKey && data.available_keys?.length > 0) {
            setTagKey(data.available_keys[0]);
          }
        }
      })
      .catch(() => {
        if (!cancelled) setError('Network error — could not reach server');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, period, tagKey]);

  const total =
    tab === 'key' ? byKey?.total_cost_microcents ?? 0 : byTag?.total_cost_microcents ?? 0;
  const unknownCostRequests = tab === 'key'
    ? byKey?.unknown_cost_requests ?? 0
    : byTag?.unknown_cost_requests ?? 0;

  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-white">Spend Breakdown</h3>
          <p className="text-xs text-neutral-500">
            Per-key and per-tag billed spend, including plugin charges. Cache hits excluded.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value as PeriodValue)}
            className="rounded-md border border-white/[0.06] bg-white/[0.03] px-2 py-1 text-xs text-white"
          >
            {PERIODS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <CostQualificationNotice unknownCostRequests={unknownCostRequests} />

      <div className="mb-3 flex gap-1 rounded-lg border border-white/[0.06] bg-white/[0.02] p-1 w-fit">
        <button
          onClick={() => setTab('key')}
          className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
            tab === 'key' ? 'bg-white/[0.08] text-white' : 'text-neutral-400 hover:text-white'
          }`}
        >
          By key
        </button>
        <button
          onClick={() => setTab('tag')}
          className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
            tab === 'tag' ? 'bg-white/[0.08] text-white' : 'text-neutral-400 hover:text-white'
          }`}
        >
          By tag
        </button>
      </div>

      {tab === 'tag' && byTag && byTag.available_keys.length > 0 && (
        <div className="mb-3 flex items-center gap-2 text-xs text-neutral-400">
          <span>Group by metadata key:</span>
          <select
            value={tagKey}
            onChange={(e) => setTagKey(e.target.value)}
            className="rounded-md border border-white/[0.06] bg-white/[0.03] px-2 py-1 text-xs text-white"
          >
            {byTag.available_keys.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
      )}

      {tab === 'tag' && byTag && byTag.available_keys.length === 0 && (
        <p className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-4 text-sm text-neutral-500">
          No keys have metadata tags set. Add tags via the <Link href="/keys" className="underline">/keys</Link> page
          (Edit → Metadata) — useful for grouping spend by `customer_id` or environment label.
        </p>
      )}

      {error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      {loading && !error && (
        <p className="text-sm text-neutral-500">Loading…</p>
      )}

      {!loading && !error && tab === 'key' && byKey && (
        <BreakdownTable
          rows={byKey.rows.map((r) => ({
            label: `${r.name} (${r.prefix ?? '—'})`,
            sublabel: Object.keys(r.metadata).length > 0
              ? Object.entries(r.metadata).map(([k, v]) => `${k}=${String(v)}`).join('  ')
              : null,
            href: `/activity?api_key_id=${encodeURIComponent(r.api_key_id)}`,
            requests: r.requests,
            input_tokens: r.input_tokens,
            output_tokens: r.output_tokens,
            cost_microcents: r.cost_microcents,
            primary: 'name',
            budget_windows: r.budget_windows,
            identity_windows: r.identity_windows,
          }))}
          total={total}
          emptyText="No keyed activity in this period."
        />
      )}

      {!loading && !error && tab === 'tag' && byTag && byTag.key && (
        <BreakdownTable
          rows={byTag.rows.map((r) => ({
            label: r.tag_value,
            sublabel: `${r.keys} key${r.keys === 1 ? '' : 's'}`,
            href: null,
            requests: r.requests,
            input_tokens: r.input_tokens,
            output_tokens: r.output_tokens,
            cost_microcents: r.cost_microcents,
            primary: 'tag',
          }))}
          total={total}
          emptyText={`No activity for tag "${byTag.key}" in this period.`}
        />
      )}
    </div>
  );
}

interface DisplayRow {
  label: string;
  sublabel: string | null;
  href: string | null;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cost_microcents: number;
  primary: 'name' | 'tag';
  budget_windows?: KeyRow['budget_windows'];
  identity_windows?: KeyRow['identity_windows'];
}

function BreakdownTable({
  rows,
  total,
  emptyText,
}: {
  rows: DisplayRow[];
  total: number;
  emptyText: string;
}) {
  if (rows.length === 0) {
    return <p className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-4 text-sm text-neutral-500">{emptyText}</p>;
  }
  return (
    <div className="overflow-hidden rounded-lg border border-white/[0.06]">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Key</TableHead>
            <TableHead className="text-right">Requests</TableHead>
            <TableHead className="text-right">In tokens</TableHead>
            <TableHead className="text-right">Out tokens</TableHead>
            <TableHead className="text-right">Billed spend</TableHead>
            <TableHead className="text-right">% total</TableHead>
            <TableHead>Window caps</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => {
            const pct = total > 0 ? (r.cost_microcents / total) * 100 : 0;
            return (
              <TableRow key={`${r.label}-${i}`}>
                <TableCell className="whitespace-normal text-white">
                  {r.href ? (
                    <Link href={r.href} className="hover:underline">
                      {r.label}
                    </Link>
                  ) : (
                    r.label
                  )}
                  {r.sublabel && (
                    <span className="ml-2 text-xs text-neutral-500">{r.sublabel}</span>
                  )}
                </TableCell>
                <TableCell className="text-right font-mono text-neutral-300">{r.requests}</TableCell>
                <TableCell className="text-right font-mono text-neutral-400">{formatTokens(r.input_tokens)}</TableCell>
                <TableCell className="text-right font-mono text-neutral-400">{formatTokens(r.output_tokens)}</TableCell>
                <TableCell className="text-right font-mono text-emerald-400">${formatUsd(r.cost_microcents)}</TableCell>
                <TableCell className="text-right font-mono text-neutral-500">{pct.toFixed(1)}%</TableCell>
                <TableCell>
                  {r.identity_windows || (r.budget_windows && r.budget_windows.length > 0) ? (
                    <div className="flex flex-col gap-0.5 text-xs">
                      {r.identity_windows ? (
                        <>
                          <span className="text-[10px] uppercase tracking-wide text-neutral-600">
                            identity {r.identity_windows.identity_id.length > 10
                              ? `${r.identity_windows.identity_id.slice(0, 10)}…`
                              : r.identity_windows.identity_id}
                          </span>
                          {r.identity_windows.windows.map((w) => (
                            <span key={w.kind} className="whitespace-nowrap">
                              <span className="capitalize text-neutral-500">{w.kind}</span>{' '}
                              <span className={w.status === 'ok' ? 'text-neutral-400' : w.status === 'alert' ? 'text-amber-400' : 'text-red-400'}>
                                {w.cap_usd != null ? `$${w.cap_usd.toFixed(2)} cap · ${w.status}` : 'no cap'}
                              </span>
                              {w.unknown_cost_requests > 0 || w.unknown_held_usd > 0 ? (
                                <span className="text-amber-300" title="Unknown cost is a lower bound, held unresolved">
                                  {' '}· lower bound
                                </span>
                              ) : null}
                            </span>
                          ))}
                        </>
                      ) : null}
                      {r.budget_windows && r.budget_windows.length > 0 ? (
                        <>
                          {r.identity_windows ? (
                            <span className="text-[10px] uppercase tracking-wide text-neutral-600">key</span>
                          ) : null}
                          {r.budget_windows.map((w) => (
                        <span key={w.kind} className="whitespace-nowrap">
                          <span className="capitalize text-neutral-500">{w.kind}</span>{' '}
                          <span className={w.status === 'ok' ? 'text-neutral-400' : w.status === 'alert' ? 'text-amber-400' : 'text-red-400'}>
                            {w.cap_usd != null ? `$${w.cap_usd.toFixed(2)} cap · ${w.status}` : 'no cap'}
                          </span>
                          {w.unknown_cost_requests > 0 || w.unknown_held_usd > 0 ? (
                            <span className="text-amber-300" title="Unknown cost is a lower bound, held unresolved">
                              {' '}· lower bound
                            </span>
                          ) : null}
                        </span>
                      ))}
                        </>
                      ) : null}
                    </div>
                  ) : (
                    <span className="text-xs text-neutral-600">—</span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell className="text-xs uppercase tracking-wide text-neutral-500">Total</TableCell>
            <TableCell className="text-right font-mono text-neutral-400">—</TableCell>
            <TableCell className="text-right font-mono text-neutral-400">—</TableCell>
            <TableCell className="text-right font-mono text-neutral-400">—</TableCell>
            <TableCell className="text-right font-mono text-emerald-300">${formatUsd(total)}</TableCell>
            <TableCell className="text-right font-mono text-neutral-500">100%</TableCell>
            <TableCell />
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  );
}
