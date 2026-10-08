'use client';

// RSH-151: per-team LLM classifier config management UI.

import { useCallback, useEffect, useState } from 'react';
import { CURRENT_MODELS } from '@/lib/current-models';

interface ClassifierDimension {
  id: string;
  name: string;
  prompt: string;
  values: string[];
}

interface ClassifierConfig {
  enabled: boolean;
  sample_rate_bps: number;
  classifier_provider: string;
  classifier_model: string;
  dimensions: ClassifierDimension[];
}

// Deliberate feature subset (providers with classifier support), NOT the
// provider allowlist — the drift guard in tests/ ignores this name.
const CLASSIFIER_PROVIDERS = ['openai', 'anthropic', 'google']; // not-a-provider-allowlist — classifier runtime subset
const MAX_DIMENSIONS = 8;

function newDimension(): ClassifierDimension {
  return { id: crypto.randomUUID(), name: '', prompt: '', values: [] };
}

export function ClassifierConfigSection({ canEdit, readOnlyReason }: { canEdit: boolean; readOnlyReason?: string }) {
  const [config, setConfig] = useState<ClassifierConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [valuesDrafts, setValuesDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/classifier-config', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as ClassifierConfig;
        if (!cancelled) setConfig(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (config) {
      const drafts: Record<string, string> = {};
      for (const d of config.dimensions) drafts[d.id] = d.values.join(', ');
      setValuesDrafts(drafts);
    }
  }, [config]);

  const save = useCallback(async () => {
    if (!config) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/classifier-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as ClassifierConfig;
      setConfig(data);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }, [config]);

  if (loading) {
    return (
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.03]">
        <div className="border-b border-white/[0.06] px-6 py-4">
          <h3 className="text-base font-semibold text-white">LLM Classifier</h3>
        </div>
        <div className="px-6 py-5 text-sm text-neutral-500">Loading…</div>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-6 py-4 text-sm text-red-300">
        Failed to load classifier config. {error}
      </div>
    );
  }

  const disabled = !canEdit;

  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.03]">
      <div className="border-b border-white/[0.06] px-6 py-4">
        <h3 className="text-base font-semibold text-white">LLM Classifier</h3>
        <p className="mt-0.5 text-xs text-neutral-500">
          Async request classification — sampled, PII-stripped, billed via plugin cost.
        </p>
      </div>

      <div className="space-y-5 px-6 py-5">
        {disabled && readOnlyReason && (
          <p className="text-sm text-neutral-500">{readOnlyReason}</p>
        )}

        {error && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        {/* Enable toggle */}
        <label className="flex items-center justify-between">
          <span className="text-sm font-medium text-neutral-300">Enable classification</span>
          <button
            type="button"
            role="switch"
            aria-checked={config.enabled}
            disabled={disabled}
            onClick={() => setConfig({ ...config, enabled: !config.enabled })}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
              config.enabled ? 'bg-emerald-500' : 'bg-neutral-700'
            } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
                config.enabled ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </label>

        {config.enabled && (
          <>
            {/* Sample rate */}
            <div>
              <label className="mb-1.5 block text-sm font-medium text-neutral-300">
                Sample rate — {config.sample_rate_bps} bps ({(config.sample_rate_bps / 100).toFixed(1)}%)
              </label>
              <input
                type="range"
                min={100}
                max={10000}
                step={100}
                value={config.sample_rate_bps}
                disabled={disabled}
                onChange={(e) => setConfig({ ...config, sample_rate_bps: Number(e.target.value) })}
                className="w-full accent-emerald-500"
              />
              <div className="mt-1 flex justify-between text-xs text-neutral-600">
                <span>1%</span>
                <span>100%</span>
              </div>
            </div>

            {/* Provider + Model */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-neutral-300">Provider</label>
                <select
                  value={config.classifier_provider}
                  disabled={disabled}
                  onChange={(e) => setConfig({ ...config, classifier_provider: e.target.value })}
                  className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm text-white outline-none focus:border-emerald-500/50"
                >
                  {CLASSIFIER_PROVIDERS.map((p) => (
                    <option key={p} value={p} className="bg-neutral-900">{p}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-neutral-300">Model</label>
                <input
                  type="text"
                  value={config.classifier_model}
                  disabled={disabled}
                  onChange={(e) => setConfig({ ...config, classifier_model: e.target.value })}
                  className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm text-white outline-none focus:border-emerald-500/50"
                  placeholder={CURRENT_MODELS.economy}
                />
              </div>
            </div>

            {/* Dimensions */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <label className="text-sm font-medium text-neutral-300">
                  Dimensions ({config.dimensions.length}/{MAX_DIMENSIONS})
                </label>
                {canEdit && config.dimensions.length < MAX_DIMENSIONS && (
                  <button
                    type="button"
                    onClick={() => setConfig({ ...config, dimensions: [...config.dimensions, newDimension()] })}
                    className="rounded-md bg-white/[0.06] px-2.5 py-1 text-xs font-medium text-neutral-300 hover:bg-white/[0.1]"
                  >
                    + Add
                  </button>
                )}
              </div>

              {config.dimensions.length === 0 && (
                <p className="text-xs text-neutral-600">No dimensions configured. Add one to classify requests.</p>
              )}

              <div className="space-y-3">
                {config.dimensions.map((dim, i) => (
                  <div key={dim.id} className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-xs font-medium text-neutral-500">Dimension {i + 1}</span>
                      {canEdit && (
                        <button
                          type="button"
                          onClick={() => setConfig({
                            ...config,
                            dimensions: config.dimensions.filter((d) => d.id !== dim.id),
                          })}
                          className="text-xs text-red-400 hover:text-red-300"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        type="text"
                        value={dim.name}
                        disabled={disabled}
                        onChange={(e) => {
                          const dims = [...config.dimensions];
                          dims[i] = { ...dim, name: e.target.value };
                          setConfig({ ...config, dimensions: dims });
                        }}
                        placeholder="Name (e.g. intent)"
                        className="rounded-md border border-white/[0.08] bg-white/[0.04] px-2.5 py-1.5 text-sm text-white outline-none focus:border-emerald-500/50"
                      />
                      <input
                        type="text"
                        value={valuesDrafts[dim.id] ?? ''}
                        disabled={disabled}
                        onChange={(e) => setValuesDrafts({ ...valuesDrafts, [dim.id]: e.target.value })}
                        onBlur={() => {
                          const raw = valuesDrafts[dim.id] ?? '';
                          const parsed = raw.split(',').map((v) => v.trim()).filter(Boolean);
                          const dims = [...config.dimensions];
                          dims[i] = { ...dim, values: parsed };
                          setConfig({ ...config, dimensions: dims });
                        }}
                        placeholder="Values (comma-separated)"
                        className="rounded-md border border-white/[0.08] bg-white/[0.04] px-2.5 py-1.5 text-sm text-white outline-none focus:border-emerald-500/50"
                      />
                    </div>
                    <input
                      type="text"
                      value={dim.prompt}
                      disabled={disabled}
                      onChange={(e) => {
                        const dims = [...config.dimensions];
                        dims[i] = { ...dim, prompt: e.target.value };
                        setConfig({ ...config, dimensions: dims });
                      }}
                      placeholder="Classification prompt (optional)"
                      className="mt-2 w-full rounded-md border border-white/[0.08] bg-white/[0.04] px-2.5 py-1.5 text-sm text-white outline-none focus:border-emerald-500/50"
                    />
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Save */}
        {canEdit && (
          <div className="flex items-center gap-3 pt-1">
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            {savedAt && !saving && (
              <span className="text-sm text-emerald-400">Saved ✓</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
