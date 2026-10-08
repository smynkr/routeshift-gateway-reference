'use client';

// LAY-326: Per-provider Load Balancing disclosure. Lists all labeled keys,
// lets admins add/edit/delete and pick a strategy. Hidden by default — the
// existing single-key form is unchanged when only the 'default' label
// exists, which keeps the simple case simple.

import { useState } from 'react';
import { ChevronDown, ChevronRight, Plus, Trash2, Loader2 } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface KeyInfo {
  label: string;
  weight: number;
  enabled: boolean;
  updated_at: string;
  metadata: Record<string, unknown>;
}

type Strategy = 'weighted_round_robin' | 'latency_based' | 'least_busy';
const METADATA_BACKED_PROVIDERS = new Set(['azure', 'bedrock']);

interface Props {
  provider: string;
  keys: KeyInfo[];
  strategy: Strategy;
  onMutate: () => Promise<void> | void;
}

export function ProviderLoadBalancing({ provider, keys, strategy, onMutate }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [savingStrategy, setSavingStrategy] = useState(false);
  const [strategyError, setStrategyError] = useState<string | null>(null);

  const [newLabel, setNewLabel] = useState('');
  const [newKey, setNewKey] = useState('');
  const [newWeight, setNewWeight] = useState(1);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [pendingRow, setPendingRow] = useState<string | null>(null); // label being mutated
  const [rowError, setRowError] = useState<string | null>(null);

  // Hide entirely when there are no keys yet — the empty-state disclosure
  // would just be visual noise. The default-key form is the right entry
  // point for a brand-new provider.
  if (keys.length === 0) {
    return null;
  }

  // Single-key compat: when there's exactly one key with the 'default' label,
  // the existing single-key form already covers everything. Only surface the
  // disclosure as a small "+ Add key" affordance.
  const isSingleDefault = keys.length === 1 && keys[0]!.label === 'default';
  const addKeyRequiresMetadata = METADATA_BACKED_PROVIDERS.has(provider);

  async function handleStrategyChange(next: Strategy) {
    setSavingStrategy(true);
    setStrategyError(null);
    try {
      const res = await fetch(`/api/provider-keys/${provider}/strategy`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategy: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setStrategyError(data?.error?.message ?? 'Failed to update strategy');
        return;
      }
      const data = await res.json().catch(() => null);
      if (data?.proxy_cache_invalidated === false) {
        setStrategyError(`Strategy saved, but proxy cache may use the previous strategy for up to ${data.cache_ttl_seconds ?? 300} seconds.`);
      }
      await onMutate();
    } catch (err) {
      setStrategyError(err instanceof Error ? err.message : 'Network error — could not update strategy');
    } finally {
      setSavingStrategy(false);
    }
  }

  async function responseError(res: Response, fallback: string): Promise<string> {
    const data = await res.json().catch(() => null);
    if (data && typeof data === 'object') {
      const value = (data as { error?: unknown }).error;
      if (typeof value === 'string' && value.trim()) return value;
      if (value && typeof value === 'object') {
        const message = (value as { message?: unknown }).message;
        if (typeof message === 'string' && message.trim()) return message;
      }
    }
    return fallback;
  }

  async function handleAddKey() {
    setAddError(null);
    if (newLabel.trim().length === 0) {
      setAddError('Label is required');
      return;
    }
    if (newKey.trim().length === 0) {
      setAddError('Key is required');
      return;
    }
    setAdding(true);
    try {
      const res = await fetch(`/api/provider-keys/${provider}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: newLabel.trim(),
          key: newKey,
          weight: Number(newWeight) || 1,
          enabled: true,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAddError(data?.error?.message ?? 'Failed to add key');
        return;
      }
      if (data?.proxy_cache_invalidated === false) {
        setAddError(`Key added, but proxy cache may use the previous key set for up to ${data.cache_ttl_seconds ?? 300} seconds.`);
      }
      setNewLabel('');
      setNewKey('');
      setNewWeight(1);
      await onMutate();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Network error — could not add key');
    } finally {
      setAdding(false);
    }
  }

  async function handlePatch(label: string, body: Partial<{ weight: number; enabled: boolean }>) {
    setPendingRow(label);
    setRowError(null);
    try {
      const res = await fetch(`/api/provider-keys/${provider}/${encodeURIComponent(label)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setRowError(await responseError(res, `Failed to update ${label}.`));
        return;
      }
      const data = await res.json().catch(() => null);
      if (data?.proxy_cache_invalidated === false) {
        setRowError(`Key updated, but proxy cache may use the previous row for up to ${data.cache_ttl_seconds ?? 300} seconds.`);
      }
      await onMutate();
    } catch (err) {
      setRowError(err instanceof Error ? err.message : `Failed to update ${label}.`);
    } finally {
      setPendingRow(null);
    }
  }

  async function handleDelete(label: string) {
    if (!confirm(`Delete the '${label}' key for ${provider}?`)) return;
    setPendingRow(label);
    setRowError(null);
    try {
      const res = await fetch(`/api/provider-keys/${provider}/${encodeURIComponent(label)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        setRowError(await responseError(res, `Failed to delete ${label}.`));
        return;
      }
      const data = await res.json().catch(() => null);
      if (data?.proxy_cache_invalidated === false) {
        setRowError(`Key deleted, but proxy cache may use it for up to ${data.cache_ttl_seconds ?? 300} seconds.`);
      }
      await onMutate();
    } catch (err) {
      setRowError(err instanceof Error ? err.message : `Failed to delete ${label}.`);
    } finally {
      setPendingRow(null);
    }
  }

  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02]">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-xs text-neutral-400 hover:text-white"
      >
        <span className="inline-flex items-center gap-1.5">
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          Load balancing
          {!isSingleDefault && (
            <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
              {keys.length} keys
            </span>
          )}
        </span>
        <span className="text-[10px] uppercase tracking-wide text-neutral-500">
          {strategy === 'weighted_round_robin' ? 'Weighted RR' : strategy === 'latency_based' ? 'Latency' : 'Least busy'}
        </span>
      </button>

      {expanded && (
        <div className="space-y-3 border-t border-white/[0.06] px-3 py-3">
          {/* Strategy selector */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-neutral-400">Selection strategy</label>
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  { value: 'weighted_round_robin', label: 'Weighted RR' },
                  { value: 'latency_based', label: 'Latency-based' },
                  { value: 'least_busy', label: 'Least busy' },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => handleStrategyChange(opt.value)}
                  disabled={savingStrategy || strategy === opt.value}
                  className={`rounded-md px-2 py-1 text-xs transition-colors ${
                    strategy === opt.value
                      ? 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30'
                      : 'border border-white/[0.06] bg-white/[0.03] text-neutral-300 hover:bg-white/[0.06]'
                  } disabled:opacity-50`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {strategyError && <p className="text-xs text-red-400">{strategyError}</p>}
            {rowError && <p className="text-xs text-red-400">{rowError}</p>}
          </div>

          {/* Keys list */}
          {keys.length > 0 && (
            <div className="overflow-hidden rounded-md border border-white/[0.06]">
              <Table className="text-xs">
                <TableHeader>
                  <TableRow>
                    <TableHead className="h-8 px-2">Label</TableHead>
                    <TableHead className="h-8 px-2 text-right">Weight</TableHead>
                    <TableHead className="h-8 px-2 text-center">Enabled</TableHead>
                    <TableHead className="h-8 px-2"><span className="sr-only">Actions</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {keys.map((k) => {
                    const isPending = pendingRow === k.label;
                    return (
                      <TableRow key={k.label}>
                        <TableCell className="px-2 py-1.5 font-mono text-white">{k.label}</TableCell>
                        <TableCell className="px-2 py-1.5 text-right">
                          <input
                            type="number"
                            min={1}
                            max={1000}
                            defaultValue={k.weight}
                            disabled={isPending}
                            aria-label={`Weight for ${k.label}`}
                            onBlur={(e) => {
                              const next = Math.max(1, Math.min(1000, Number(e.currentTarget.value) || 1));
                              if (next !== k.weight) handlePatch(k.label, { weight: next });
                            }}
                            className="w-16 rounded border border-white/[0.06] bg-white/[0.03] px-2 py-0.5 text-right text-white"
                          />
                        </TableCell>
                        <TableCell className="px-2 py-1.5 text-center">
                          <input
                            type="checkbox"
                            checked={k.enabled}
                            disabled={isPending}
                            aria-label={`Enable ${k.label}`}
                            onChange={(e) => handlePatch(k.label, { enabled: e.currentTarget.checked })}
                            className="accent-emerald-500"
                          />
                        </TableCell>
                        <TableCell className="px-2 py-1.5 text-right">
                          {keys.length > 1 ? (
                            <button
                              onClick={() => handleDelete(k.label)}
                              disabled={isPending}
                              aria-label={`Delete ${k.label} key`}
                              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-red-400 transition hover:bg-red-500/10 disabled:opacity-50"
                            >
                              {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                            </button>
                          ) : (
                            <span className="text-[10px] text-neutral-600" title="Use the bucket-wide Remove button to clear the last key">
                              last
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}

          {/* Add key form */}
          {addKeyRequiresMetadata ? (
            <div className="rounded-md border border-dashed border-white/[0.08] p-2 text-xs text-neutral-400">
              Additional {provider} keys must be added through the provider setup form so required metadata is saved with the encrypted key.
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-white/[0.08] p-2">
              <p className="mb-2 text-[10px] uppercase tracking-wide text-neutral-500">Add key</p>
              <div className="flex flex-wrap gap-2">
                <input
                  type="text"
                  placeholder="label"
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  disabled={adding}
                  className="w-28 rounded border border-white/[0.06] bg-white/[0.03] px-2 py-1 text-xs text-white"
                />
                <input
                  type="password"
                  placeholder="sk-..."
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  disabled={adding}
                  className="flex-1 min-w-[200px] rounded border border-white/[0.06] bg-white/[0.03] px-2 py-1 font-mono text-xs text-white"
                />
                <input
                  type="number"
                  min={1}
                  max={1000}
                  value={newWeight}
                  onChange={(e) => setNewWeight(Number(e.target.value) || 1)}
                  disabled={adding}
                  title="Weight (1-1000)"
                  className="w-16 rounded border border-white/[0.06] bg-white/[0.03] px-2 py-1 text-xs text-white"
                />
                <button
                  onClick={handleAddKey}
                  disabled={adding}
                  className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
                >
                  {adding ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                  Add
                </button>
              </div>
              {addError && <p className="mt-2 text-xs text-red-400">{addError}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
