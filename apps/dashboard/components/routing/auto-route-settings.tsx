'use client';

import { useEffect, useState } from 'react';
import { Route, Loader2, CheckCircle, Zap, DollarSign, Scale, AlertCircle } from 'lucide-react';

interface AutoRouteSettings {
  enabled: boolean;
  strategy: 'cheapest' | 'fastest' | 'balanced';
  max_fallbacks: number;
  /** RSH-136: opt-in rolling quality derank from cascade verdicts. */
  quality_derank: boolean;
}

const STRATEGIES = [
  { key: 'cheapest' as const, label: 'Cheapest', icon: DollarSign, desc: 'Prefer lower-cost models when the proxy can route safely.' },
  { key: 'fastest' as const, label: 'Fastest', icon: Zap, desc: 'Prefer lower-latency choices from configured routing data.' },
  { key: 'balanced' as const, label: 'Balanced', icon: Scale, desc: 'Balance configured cost, latency, and context-window preferences.' },
];

interface AutoRouteSettingsProps {
  canEdit?: boolean;
  readOnlyReason?: string;
}

function extractAutoRouteError(payload: unknown, fallback: string): string {
  if (typeof payload === 'string' && payload.trim()) return payload;
  if (payload && typeof payload === 'object') {
    const value = (payload as { error?: unknown }).error;
    if (typeof value === 'string' && value.trim()) return value;
    if (value && typeof value === 'object') {
      const message = (value as { message?: unknown }).message;
      if (typeof message === 'string' && message.trim()) return message;
    }
  }
  return fallback;
}

export function AutoRouteSettings({
  canEdit = true,
  readOnlyReason = 'You do not have permission to edit auto-routing settings.',
}: AutoRouteSettingsProps) {
  const [settings, setSettings] = useState<AutoRouteSettings>({
    enabled: false,
    strategy: 'balanced',
    max_fallbacks: 2,
    quality_derank: false,
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch('/api/auto-route');
        const data = await res.json();
        if (res.ok) {
          if (cancelled) return;
          setSettings({
            enabled: Boolean(data.enabled),
            strategy: data.strategy ?? 'balanced',
            max_fallbacks: data.max_fallbacks ?? 2,
            quality_derank: Boolean(data.quality_derank),
          });
        } else if (!cancelled) {
          setError(extractAutoRouteError(data, 'Failed to load auto-routing settings.'));
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load auto-routing settings.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSave() {
    if (!canEdit) {
      setError(readOnlyReason);
      return;
    }
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const res = await fetch('/api/auto-route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      const data = await res.json();
      if (res.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
        if (data?.proxy_cache_invalidated === false) {
          setError(
            `Settings saved, but the proxy cache was not refreshed. Live routing may use the previous setting for up to ${data.cache_ttl_seconds ?? 30} seconds.`,
          );
        }
      } else {
        setError(extractAutoRouteError(data, 'Failed to save auto-routing settings.'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save auto-routing settings.');
    } finally {
      setSaving(false);
    }
  }

  const disabled = loading || saving || !canEdit;

  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.03]">
      <div className="border-b border-white/[0.06] px-6 py-4 flex items-center gap-2">
        <Route className="h-4 w-4 text-emerald-400" />
        <h3 className="text-base font-semibold text-white">Auto-Routing</h3>
      </div>
      <div className="px-6 py-5 space-y-5">
        <p className="text-sm text-neutral-400">
          When no routing rule matches, RouteShift can apply your configured default
          strategy and fallback preference. Exact provider/model behavior comes from the
          proxy routing rules and pricing/health data available at request time.
        </p>

        {!canEdit && (
          <div className="flex items-start gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-sm text-neutral-500">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-neutral-600" />
            <span>{readOnlyReason}</span>
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        {/* Toggle */}
        <div className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3">
          <div>
            <p className="text-sm font-medium text-white">Enable Auto-Routing</p>
            <p className="text-xs text-neutral-500">Intelligently route requests when no rule matches.</p>
          </div>
          <button
            type="button"
            disabled={disabled}
            aria-label="Toggle auto-routing"
            aria-pressed={settings.enabled}
            onClick={() => setSettings((s) => ({ ...s, enabled: !s.enabled }))}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              settings.enabled ? 'bg-emerald-500' : 'bg-neutral-700'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                settings.enabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>

        {settings.enabled && (
          <>
            {/* Strategy */}
            <div className="space-y-2">
              <p className="text-sm font-medium text-neutral-300">Routing Strategy</p>
              <div className="grid gap-2 sm:grid-cols-3">
                {STRATEGIES.map((s) => (
                  <button
                    key={s.key}
                    type="button"
                    disabled={disabled}
                    onClick={() => setSettings((prev) => ({ ...prev, strategy: s.key }))}
                    className={`flex flex-col items-start gap-1 rounded-lg border px-4 py-3 text-left transition-all disabled:cursor-not-allowed disabled:opacity-60 ${
                      settings.strategy === s.key
                        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                        : 'border-white/[0.06] bg-white/[0.02] text-neutral-400 hover:border-white/[0.1] hover:text-neutral-300'
                    }`}
                  >
                    <span className="flex items-center gap-1.5 text-sm font-medium">
                      <s.icon className="h-4 w-4" />
                      {s.label}
                    </span>
                    <span className="text-[11px] leading-relaxed opacity-80">{s.desc}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Max fallbacks */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-neutral-300" htmlFor="maxFallbacks">
                Max Fallbacks
              </label>
              <input
                id="maxFallbacks"
                type="number"
                min={0}
                max={5}
                value={settings.max_fallbacks}
                disabled={disabled}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, max_fallbacks: Math.min(5, Math.max(0, Number(e.target.value))) }))
                }
                className="w-24 rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-sm text-white outline-none transition-colors focus:border-emerald-500/50 disabled:cursor-not-allowed disabled:opacity-50"
              />
              <p className="text-xs text-neutral-600">
                How many alternative models to try if the primary choice fails.
              </p>
            </div>
            {/* Quality derank (RSH-136) */}
            <div className="flex items-start justify-between gap-4 rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3">
              <div className="space-y-0.5">
                <p className="text-sm font-medium text-neutral-300">Quality Derank</p>
                <p className="text-xs text-neutral-600">
                  Penalize providers whose recent quality-gate verdicts fail often. Opt-in, never on by default;
                  deranked models stay eligible but score worse.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={settings.quality_derank}
                aria-label="Quality derank"
                disabled={disabled}
                onClick={() => setSettings((prev) => ({ ...prev, quality_derank: !prev.quality_derank }))}
                className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  settings.quality_derank ? 'bg-emerald-500' : 'bg-white/10'
                }`}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
                    settings.quality_derank ? 'left-[22px]' : 'left-0.5'
                  }`}
                />
              </button>
            </div>
          </>
        )}

        <div className="flex items-center gap-3 pt-1">
          <button
            type="button"
            onClick={handleSave}
            disabled={disabled}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white transition-all hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving || loading ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <CheckCircle className="h-4 w-4" /> : null}
            {loading ? 'Loading…' : saving ? 'Saving…' : saved ? 'Saved' : 'Save Settings'}
          </button>
        </div>
      </div>
    </div>
  );
}
