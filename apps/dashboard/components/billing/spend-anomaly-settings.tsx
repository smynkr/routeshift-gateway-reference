'use client';

import { useEffect, useState } from 'react';
import { isHttpsUrl } from '@/lib/url';

interface SpendAlertSettingsValue {
  enabled: boolean;
  webhook_url: string;
  threshold_multiplier: number;
  baseline_days: number;
}

const DEFAULT_SETTINGS: SpendAlertSettingsValue = {
  enabled: false,
  webhook_url: '',
  threshold_multiplier: 2,
  baseline_days: 7,
};

function isValidSettings(value: unknown): value is SpendAlertSettingsValue {
  if (typeof value !== 'object' || value === null) return false;
  const settings = value as Partial<SpendAlertSettingsValue>;
  return (
    typeof settings.enabled === 'boolean'
    && typeof settings.webhook_url === 'string'
    && typeof settings.threshold_multiplier === 'number'
    && typeof settings.baseline_days === 'number'
  );
}

async function readSettingsResponse(response: Response, fallbackMessage: string): Promise<SpendAlertSettingsValue> {
  const data: unknown = await response.json().catch(() => null);
  if (response.ok && isValidSettings(data)) return data;
  throw new Error(
    data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
      ? data.error
      : fallbackMessage,
  );
}

export function SpendAnomalySettings({
  canEdit = true,
  readOnlyReason = 'Only admins can manage spend alert settings.',
}: {
  canEdit?: boolean;
  readOnlyReason?: string;
}) {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(canEdit);
  const [loaded, setLoaded] = useState(!canEdit);
  const [retryCount, setRetryCount] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!canEdit) return;
    let cancelled = false;
    setLoading(true);
    setLoaded(false);
    setError(null);
    fetch('/api/alerts/spend', { cache: 'no-store' })
      .then(async (response) => {
        const data = await readSettingsResponse(response, 'Unable to load spend alert settings.');
        if (!cancelled) {
          setSettings(data);
          setLoaded(true);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setSettings(DEFAULT_SETTINGS);
          setLoaded(false);
          setError(reason instanceof Error ? reason.message : 'Unable to load spend alert settings.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [canEdit, retryCount]);

  async function saveSettings() {
    setSaved(false);
    setError(null);
    if (settings.enabled && !isHttpsUrl(settings.webhook_url)) {
      setError('Webhook URL must use HTTPS when spend alerts are enabled.');
      return;
    }
    setSaving(true);
    try {
      const response = await fetch('/api/alerts/spend', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      const data = await readSettingsResponse(response, 'Unable to save spend alert settings.');
      setSettings(data);
      setSaved(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to save spend alert settings.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="spend-alert-settings-heading" className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-6">
      <div className="mb-5">
        <h3 id="spend-alert-settings-heading" className="text-lg font-semibold text-white">Spend anomaly alerts</h3>
        <p className="mt-1 text-sm text-neutral-500">Receive a signed webhook when complete daily spend exceeds your baseline.</p>
      </div>

      {!canEdit ? (
        <p className="text-sm text-neutral-500">{readOnlyReason}</p>
      ) : loading ? (
        <p className="text-sm text-neutral-500">Loading spend alert settings...</p>
      ) : !loaded ? (
        <div className="space-y-3">
          {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
          <button
            type="button"
            onClick={() => setRetryCount((count) => count + 1)}
            className="rounded-lg border border-white/[0.12] px-4 py-2.5 text-sm font-medium text-neutral-200 transition-colors hover:bg-white/[0.06]"
          >
            Retry
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="spend-alert-webhook" className="text-sm font-medium text-neutral-300">Webhook URL</label>
            <input
              id="spend-alert-webhook"
              aria-label="Webhook URL"
              type="url"
              value={settings.webhook_url}
              onChange={(event) => setSettings((current) => ({ ...current, webhook_url: event.target.value }))}
              placeholder="https://alerts.example.com/routeshift"
              className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2.5 text-sm text-white placeholder-neutral-600 outline-none focus:border-emerald-500/50"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="spend-alert-threshold" className="text-sm font-medium text-neutral-300">Threshold multiplier</label>
              <input
                id="spend-alert-threshold"
                aria-label="Threshold multiplier"
                type="number"
                min={1}
                max={100}
                step="any"
                value={settings.threshold_multiplier}
                onChange={(event) => setSettings((current) => ({ ...current, threshold_multiplier: Number(event.target.value) }))}
                className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2.5 text-sm text-white outline-none focus:border-emerald-500/50"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="spend-alert-baseline" className="text-sm font-medium text-neutral-300">Baseline days</label>
              <input
                id="spend-alert-baseline"
                aria-label="Baseline days"
                type="number"
                min={1}
                max={90}
                step={1}
                value={settings.baseline_days}
                onChange={(event) => setSettings((current) => ({ ...current, baseline_days: Number(event.target.value) }))}
                className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2.5 text-sm text-white outline-none focus:border-emerald-500/50"
              />
            </div>
          </div>
          <label className="inline-flex items-center gap-2 text-sm text-neutral-300">
            <input
              aria-label="Enabled"
              type="checkbox"
              checked={settings.enabled}
              onChange={(event) => setSettings((current) => ({ ...current, enabled: event.target.checked }))}
              className="h-4 w-4 accent-emerald-500"
            />
            Enabled
          </label>
          {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
          {saved && <p className="text-sm text-emerald-400">Spend alert settings saved.</p>}
          <button
            type="button"
            onClick={saveSettings}
            disabled={saving}
            className="rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save spend alerts'}
          </button>
        </div>
      )}
    </section>
  );
}
