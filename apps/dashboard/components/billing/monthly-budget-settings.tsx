'use client';

import { useCallback, useEffect, useState } from 'react';
import { Wallet, AlertTriangle } from 'lucide-react';

// RSH-138: three UTC budget windows (daily, weekly, monthly) with shared alert
// threshold + hard-cap action. Blank cap input clears that window's cap
// (explicit null); omitted fields are preserved server-side.

interface BudgetWindowReport {
  kind: 'daily' | 'weekly' | 'monthly';
  cap_usd: number | null;
  known_spend_usd: number;
  reserved_usd: number;
  unknown_held_usd: number;
  committed_usd: number;
  unknown_cost_requests: number;
  status: 'ok' | 'alert' | 'throttle' | 'block';
  action: 'alert' | 'throttle' | 'block' | null;
  period_start: string;
  period_end: string;
  reset_at: string;
}

interface BudgetState {
  windows: BudgetWindowReport[];
  actual_costs_qualified: boolean;
  alert_at_pct: number;
  hard_cap_action: 'alert' | 'throttle' | 'block';
}

const ACTION_LABELS: Record<BudgetState['hard_cap_action'], string> = {
  alert: 'Alert only — never block traffic',
  throttle: 'Throttle — return 429 once cap is reached',
  block: 'Block — return 402 once cap is reached',
};

const WINDOW_LABELS: Record<BudgetWindowReport['kind'], string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
};

const WINDOW_HINTS: Record<BudgetWindowReport['kind'], string> = {
  daily: 'Resets every day at 00:00 UTC.',
  weekly: 'Resets Monday at 00:00 UTC (ISO week).',
  monthly: 'Resets the 1st at 00:00 UTC.',
};

const STATUS_COLOR: Record<BudgetWindowReport['status'], string> = {
  ok: 'text-emerald-400',
  alert: 'text-amber-400',
  throttle: 'text-orange-400',
  block: 'text-red-400',
};

export function MonthlyBudgetSettings({
  canEdit = true,
  readOnlyReason = 'Only admins can manage budgets.',
}: {
  canEdit?: boolean;
  readOnlyReason?: string;
}) {
  const [state, setState] = useState<BudgetState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capInputs, setCapInputs] = useState<Record<BudgetWindowReport['kind'], string>>({
    daily: '',
    weekly: '',
    monthly: '',
  });
  const [alertPctInput, setAlertPctInput] = useState('80');
  const [actionInput, setActionInput] = useState<BudgetState['hard_cap_action']>('alert');
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch('/api/billing/budget');
      if (!res.ok) throw new Error('fetch failed');
      const data = (await res.json()) as BudgetState;
      setState(data);
      setCapInputs({
        daily: data.windows.find((w) => w.kind === 'daily')?.cap_usd != null
          ? String(data.windows.find((w) => w.kind === 'daily')!.cap_usd)
          : '',
        weekly: data.windows.find((w) => w.kind === 'weekly')?.cap_usd != null
          ? String(data.windows.find((w) => w.kind === 'weekly')!.cap_usd)
          : '',
        monthly: data.windows.find((w) => w.kind === 'monthly')?.cap_usd != null
          ? String(data.windows.find((w) => w.kind === 'monthly')!.cap_usd)
          : '',
      });
      setAlertPctInput(String(data.alert_at_pct));
      setActionInput(data.hard_cap_action);
    } catch (err) {
      console.error('budget fetch:', err);
      setError('Failed to load budget settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchState();
  }, [fetchState]);

  const save = async () => {
    if (!canEdit) {
      setError(readOnlyReason);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const caps: Record<string, number | null> = {};
      for (const kind of ['daily', 'weekly', 'monthly'] as const) {
        const raw = capInputs[kind].trim();
        if (raw === '') {
          caps[`${kind}_usd_cap`] = null;
          continue;
        }
        const value = Number(raw);
        if (Number.isNaN(value) || value < 0) {
          setError(`${WINDOW_LABELS[kind]} cap must be a non-negative number, or empty to disable.`);
          setSaving(false);
          return;
        }
        caps[`${kind}_usd_cap`] = value;
      }
      const alertPct = Number(alertPctInput);
      if (Number.isNaN(alertPct) || alertPct < 0 || alertPct > 100) {
        setError('Alert threshold must be 0–100.');
        setSaving(false);
        return;
      }
      const res = await fetch('/api/billing/budget', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...caps,
          alert_at_pct: alertPct,
          hard_cap_action: actionInput,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? 'Failed to save budget settings.');
        setSaving(false);
        return;
      }
      setState(await res.json());
      setSavedAt(Date.now());
      setTimeout(() => setSavedAt(null), 2000);
    } catch (err) {
      console.error('budget save:', err);
      setError('Failed to save budget settings.');
    } finally {
      setSaving(false);
    }
  };

  const unknownTotal = state?.windows.reduce((s, w) => s + w.unknown_cost_requests, 0) ?? 0;
  const hasUnknownSpend = state?.windows.some(
    (w) => w.unknown_cost_requests > 0 || w.unknown_held_usd > 0,
  ) ?? false;

  return (
    <section className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-6">
      <header className="mb-4 flex items-center gap-3">
        <Wallet className="h-5 w-5 text-emerald-400" />
        <h3 className="text-lg font-semibold text-white">Budget windows</h3>
      </header>

      <p className="mb-4 text-sm text-neutral-400">
        Set daily, weekly, and monthly spending guardrails in UTC. Each window resets
        independently; committed spend counts settled, held, and reserved cost.
      </p>

      {!canEdit && (
        <div className="mb-4 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-sm text-neutral-500">
          {readOnlyReason}
        </div>
      )}

      {state?.actual_costs_qualified === false && (
        <p className="mb-4 text-sm text-amber-200">
          Budget spend is an observed lower bound; {unknownTotal} request{unknownTotal === 1 ? '' : 's'} have
          unknown cost that is held, not shown as exact spend.
        </p>
      )}
      {state?.windows.some((w) => w.unknown_held_usd > 0) && (
        <p className="mb-4 text-sm text-amber-200">Spend and savings are observed lower bounds while unknown cost is held.</p>
      )}

      {/* Per-window status cards */}
      {!loading && (
        <div className="mb-5 grid grid-cols-1 gap-4 md:grid-cols-3">
          {state?.windows.map((w) => {
            const pctUsed = w.cap_usd != null && w.cap_usd > 0
              ? Math.min(100, (w.committed_usd / w.cap_usd) * 100)
              : 0;
            const barColor =
              pctUsed >= 95 ? 'bg-red-500' : pctUsed >= 70 ? 'bg-amber-500' : 'bg-emerald-500';
            return (
              <div key={w.kind} className="rounded-lg border border-white/[0.04] bg-white/[0.02] p-4">
                <div className="mb-2 flex items-baseline justify-between text-sm">
                  <span className="font-medium text-white">{WINDOW_LABELS[w.kind]}</span>
                  <span className={`text-xs ${STATUS_COLOR[w.status]}`}>{w.status}</span>
                </div>
                {w.cap_usd != null && w.cap_usd > 0 ? (
                  <>
                    <p className="mb-1 text-xs text-neutral-400">
                      <span className="font-medium text-white">${w.committed_usd.toFixed(2)}</span> of ${w.cap_usd.toFixed(0)} committed ({Math.round(pctUsed)}%)
                    </p>
                    <div className="mb-2 h-2 w-full overflow-hidden rounded-full bg-white/[0.06]">
                      <div className={`h-full ${barColor} transition-all duration-500`} style={{ width: `${pctUsed}%` }} />
                    </div>
                  </>
                ) : (
                  <p className="mb-2 text-xs text-neutral-500">No cap configured — window is uncapped.</p>
                )}
                <p className="text-xs text-neutral-500">
                  Resets at {new Date(w.reset_at).toISOString()}
                  {w.unknown_cost_requests > 0
                    ? ` · ${w.unknown_cost_requests} unknown cost request${w.unknown_cost_requests === 1 ? '' : 's'}`
                    : ''}
                </p>
                {(w.unknown_cost_requests > 0 || w.unknown_held_usd > 0) && (
                  <p className="mt-1 text-xs text-amber-200">
                    Unknown cost is a lower bound; ${w.unknown_held_usd.toFixed(2)} held unresolved.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Inputs */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {(['daily', 'weekly', 'monthly'] as const).map((kind) => (
          <div key={kind}>
            <label htmlFor={`budget-cap-${kind}`} className="mb-1 block text-xs font-medium text-neutral-400">
              {WINDOW_LABELS[kind]} cap (USD)
            </label>
            <input
              id={`budget-cap-${kind}`}
              type="number"
              min={0}
              step={1}
              placeholder="e.g. 500 (empty = disabled)"
              value={capInputs[kind]}
              onChange={(e) => setCapInputs((prev) => ({ ...prev, [kind]: e.target.value }))}
              disabled={!canEdit || saving}
              className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-emerald-500/50 focus:outline-none"
            />
            <p className="mt-1 text-xs text-neutral-600">{WINDOW_HINTS[kind]}</p>
          </div>
        ))}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <label htmlFor="budget-alert-pct" className="mb-1 block text-xs font-medium text-neutral-400">Alert threshold (% of cap)</label>
          <input
            id="budget-alert-pct"
            type="number"
            min={0}
            max={100}
            step={5}
            value={alertPctInput}
            onChange={(e) => setAlertPctInput(e.target.value)}
            disabled={!canEdit || saving}
            className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-sm text-white focus:border-emerald-500/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          />
        </div>
        <div>
          <label htmlFor="budget-action" className="mb-1 block text-xs font-medium text-neutral-400">Action when exceeded</label>
          <select
            id="budget-action"
            value={actionInput}
            onChange={(e) => setActionInput(e.target.value as BudgetState['hard_cap_action'])}
            disabled={!canEdit || saving}
            className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-sm text-white focus:border-emerald-500/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          >
            {(Object.keys(ACTION_LABELS) as Array<BudgetState['hard_cap_action']>).map((k) => (
              <option key={k} value={k}>
                {ACTION_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {hasUnknownSpend && (
        <p className="mt-3 text-xs text-amber-200">
          <AlertTriangle className="mr-1 inline h-3 w-3" />
          Held unknown spend stays visible until resolved; it is never treated as exact.
        </p>
      )}

      {error && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          <AlertTriangle className="h-4 w-4" />
          {error}
        </div>
      )}

      <div className="mt-4 flex items-center justify-end gap-3">
        {savedAt && <span className="text-xs text-emerald-400">Saved.</span>}
        <button
          type="button"
          onClick={() => void save()}
          disabled={!canEdit || saving}
          className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-emerald-950 transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save budget windows'}
        </button>
      </div>
    </section>
  );
}
