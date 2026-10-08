'use client';

import { useEffect, useState } from 'react';
import { RefreshCw, Save, Trash2 } from 'lucide-react';

interface AutoTopUpConfig {
  enabled: boolean;
  threshold_cents: number;
  reload_amount_cents: number;
  disabled_reason: string | null;
  disabled_at: string | null;
}

const AUTO_TOP_UP_DENIAL_COPY: Record<string, string> = {
  daily_cap_exceeded: 'Auto top-up reached the daily automatic-charge ceiling.',
  monthly_cap_exceeded: 'Auto top-up reached the monthly automatic-charge ceiling.',
  daily_and_monthly_caps_exceeded: 'Auto top-up reached both daily and monthly automatic-charge ceilings.',
  topup_velocity_exceeded: 'Auto top-up was halted by the short-window charge-velocity breaker.',
};

interface SaveAutoTopUpResponse {
  enabled?: boolean;
  requires_payment_method?: boolean;
  error?: string;
}

export function AutoTopUpSettings() {
  const [enabled, setEnabled] = useState(false);
  const [editing, setEditing] = useState(false);
  const [threshold, setThreshold] = useState(5);
  const [reloadAmount, setReloadAmount] = useState(25);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [openingPortal, setOpeningPortal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [disabledReason, setDisabledReason] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/credits/auto-topup')
      .then((res) => res.json())
      .then((data: AutoTopUpConfig) => {
        setEnabled(data.enabled);
        setEditing(data.enabled);
        setDisabledReason(data.disabled_reason);
        if (data.threshold_cents) setThreshold(Math.round(data.threshold_cents / 100));
        if (data.reload_amount_cents) setReloadAmount(Math.round(data.reload_amount_cents / 100));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setSuccess('');

    try {
      const res = await fetch('/api/credits/auto-topup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threshold_cents: threshold * 100,
          reload_amount_cents: reloadAmount * 100,
        }),
      });
      const data: SaveAutoTopUpResponse = await res.json();

      if (!res.ok) {
        setError(data.error || 'Failed to save settings');
        return;
      }

      const nextEnabled = Boolean(data.enabled);
      setEnabled(nextEnabled);
      setDisabledReason(null);
      setEditing(nextEnabled || Boolean(data.requires_payment_method));
      setSuccess(
        data.requires_payment_method
          ? 'Settings saved, but auto top-up stays off until a payment method is connected.'
          : 'Auto top-up enabled.',
      );
    } catch {
      setError('Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    setError('');
    setSuccess('');

    try {
      const res = await fetch('/api/credits/auto-topup', {
        method: 'DELETE',
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed to disable auto top-up');
        return;
      }

      setEnabled(false);
      setEditing(false);
      setDisabledReason(null);
      setSuccess('Auto top-up disabled');
    } catch {
      setError('Failed to disable auto top-up');
    } finally {
      setDeleting(false);
    }
  };

  const handleOpenBillingPortal = async () => {
    setOpeningPortal(true);
    setError('');
    setSuccess('');

    try {
      const res = await fetch('/api/billing/portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (!res.ok || !data.url) {
        setError(data.error || 'Failed to open billing portal');
        return;
      }
      window.location.href = data.url;
    } catch {
      setError('Failed to open billing portal');
    } finally {
      setOpeningPortal(false);
    }
  };

  if (loading) {
    return (
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-6">
        <div className="flex items-center gap-2 text-neutral-500">
          <RefreshCw className="h-4 w-4 animate-spin" />
          <span className="text-sm">Loading auto top-up settings...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-white">Auto Top-Up</h3>
          <p className="mt-0.5 text-sm text-neutral-500">
            Automatically reload credits when your balance gets low.
          </p>
        </div>
        <button
          type="button"
          aria-label={
            enabled
              ? 'Disable auto top-up'
              : editing
                ? 'Hide auto top-up settings'
                : 'Configure auto top-up'
          }
          aria-controls={!enabled ? 'auto-topup-settings' : undefined}
          aria-expanded={!enabled ? editing : undefined}
          onClick={() => {
            if (enabled) {
              handleDelete();
            } else {
              setEditing((current) => !current);
              setError('');
              setSuccess('');
            }
          }}
          disabled={deleting}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400 ${
            enabled ? 'bg-emerald-600' : editing ? 'bg-amber-500/80' : 'bg-white/[0.1]'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 rounded-full bg-white transition-transform duration-200 ${
              enabled || editing ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      {editing && !enabled && (
        <div className="mb-4 rounded-lg bg-amber-500/10 px-3 py-3 text-sm text-amber-300">
          <p>
            Auto top-up is configured in draft mode. Add a default payment method in billing and
            it will finish enabling automatically the next time this page loads.
          </p>
          <button
            onClick={handleOpenBillingPortal}
            disabled={openingPortal}
            className="mt-3 inline-flex items-center rounded-lg border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-sm font-medium text-amber-200 transition-colors hover:bg-amber-400/15 disabled:opacity-50"
          >
            {openingPortal ? 'Opening Billing Portal...' : 'Add Payment Method'}
          </button>
        </div>
      )}

      {error && (
        <p className="mb-4 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">{error}</p>
      )}

      {disabledReason && (
        <p className="mb-4 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {AUTO_TOP_UP_DENIAL_COPY[disabledReason] ?? `Auto top-up was disabled: ${disabledReason}`}
          {' '}Review recent billing activity before manually re-enabling it.
        </p>
      )}

      {success && (
        <p className="mb-4 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-400">{success}</p>
      )}

      {(enabled || editing) && (
        <div id="auto-topup-settings" className="space-y-4 border-t border-white/[0.06] pt-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-neutral-400">
                When balance falls below
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-neutral-500">$</span>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={threshold}
                  onChange={(e) => setThreshold(Number(e.target.value))}
                  className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] py-2.5 pl-7 pr-3 text-sm text-white placeholder:text-neutral-600 focus:border-emerald-500/50 focus:outline-none"
                />
              </div>
              <p className="mt-1 text-xs text-neutral-600">$1 - $100</p>
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium text-neutral-400">
                Reload amount
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-neutral-500">$</span>
                <input
                  type="number"
                  min={10}
                  max={500}
                  value={reloadAmount}
                  onChange={(e) => setReloadAmount(Number(e.target.value))}
                  className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] py-2.5 pl-7 pr-3 text-sm text-white placeholder:text-neutral-600 focus:border-emerald-500/50 focus:outline-none"
                />
              </div>
              <p className="mt-1 text-xs text-neutral-600">$10 - $500</p>
            </div>
          </div>

          <div className="flex gap-3">
            <button
              onClick={handleSave}
              disabled={saving || threshold < 1 || threshold > 100 || reloadAmount < 10 || reloadAmount > 500}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {saving ? 'Saving...' : 'Save Settings'}
            </button>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="inline-flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.03] px-4 py-2.5 text-sm font-medium text-neutral-400 transition-colors hover:bg-white/[0.06] disabled:opacity-50"
            >
              <Trash2 className="h-4 w-4" />
              {deleting ? 'Disabling...' : 'Disable'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
