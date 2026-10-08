'use client';

// RSH-152: per-team guardrail config management UI.

import { useCallback, useEffect, useState } from 'react';

interface BuiltInPattern {
  id: string;
  name: string;
  description: string;
  category: 'pii' | 'injection';
  severity: 'block' | 'warn';
}

interface PatternOverride {
  id: string;
  enabled: boolean;
  customRegex?: string;
  action?: 'block' | 'warn';
}

interface GuardrailConfigResponse {
  enabled: boolean;
  patterns: PatternOverride[];
  built_in_patterns: BuiltInPattern[];
}

export function GuardrailConfigSection({ canEdit, readOnlyReason }: { canEdit: boolean; readOnlyReason?: string }) {
  const [enabled, setEnabled] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, PatternOverride>>({});
  const [builtIn, setBuiltIn] = useState<BuiltInPattern[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/guardrail-config', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as GuardrailConfigResponse;
        if (!cancelled) {
          setEnabled(data.enabled);
          setBuiltIn(data.built_in_patterns);
          const map: Record<string, PatternOverride> = {};
          for (const p of data.patterns) map[p.id] = p;
          setOverrides(map);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const patterns = Object.values(overrides);
      const res = await fetch('/api/guardrail-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, patterns }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }, [enabled, overrides]);

  function getOverride(id: string): PatternOverride {
    return overrides[id] ?? { id, enabled: true };
  }

  function setOverride(id: string, patch: Partial<PatternOverride>) {
    const current = getOverride(id);
    setOverrides({ ...overrides, [id]: { ...current, ...patch, id } });
  }

  if (loading) {
    return (
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.03]">
        <div className="border-b border-white/[0.06] px-6 py-4">
          <h3 className="text-base font-semibold text-white">Content Guardrails</h3>
        </div>
        <div className="px-6 py-5 text-sm text-neutral-500">Loading…</div>
      </div>
    );
  }

  const disabled = !canEdit;
  const piiPatterns = builtIn.filter((p) => p.category === 'pii');
  const injPatterns = builtIn.filter((p) => p.category === 'injection');

  function renderPattern(p: BuiltInPattern) {
    const ov = getOverride(p.id);
    const isExpanded = expandedId === p.id;
    const effectiveAction = ov.action ?? p.severity;

    return (
      <div key={p.id} className="border-b border-white/[0.04] last:border-0">
        <div className="flex items-center justify-between py-3">
          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={disabled}
              onClick={() => setOverride(p.id, { enabled: !ov.enabled })}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                ov.enabled ? 'bg-emerald-500' : 'bg-neutral-700'
              } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
              role="switch"
              aria-checked={ov.enabled}
              aria-label={`Toggle ${p.name}`}
            >
              <span
                className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
                  ov.enabled ? 'translate-x-4' : 'translate-x-0'
                }`}
              />
            </button>
            <div>
              <p className="text-sm font-medium text-neutral-200">{p.name}</p>
              <p className="text-xs text-neutral-600">{p.description}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${
              effectiveAction === 'block'
                ? 'bg-red-500/10 text-red-400'
                : 'bg-amber-500/10 text-amber-400'
            }`}>
              {effectiveAction}
            </span>
            {canEdit && (
              <button
                type="button"
                onClick={() => setExpandedId(isExpanded ? null : p.id)}
                className="text-xs text-neutral-500 hover:text-neutral-300"
              >
                {isExpanded ? '▲' : '▼'}
              </button>
            )}
          </div>
        </div>

        {isExpanded && canEdit && (
          <div className="mb-3 ml-12 space-y-2 rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-neutral-500">Custom regex (overrides built-in)</label>
              <input
                type="text"
                value={ov.customRegex ?? ''}
                onChange={(e) => setOverride(p.id, { customRegex: e.target.value || undefined })}
                placeholder="Leave empty to use built-in pattern"
                className="w-full rounded-md border border-white/[0.08] bg-white/[0.04] px-2.5 py-1.5 font-mono text-xs text-white outline-none focus:border-emerald-500/50"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-neutral-500">Action override</label>
              <select
                value={ov.action ?? ''}
                onChange={(e) => setOverride(p.id, { action: (e.target.value || undefined) as 'block' | 'warn' | undefined })}
                className="rounded-md border border-white/[0.08] bg-white/[0.04] px-2.5 py-1.5 text-xs text-white outline-none focus:border-emerald-500/50"
              >
                <option value="" className="bg-neutral-900">Default ({p.severity})</option>
                <option value="block" className="bg-neutral-900">Block</option>
                <option value="warn" className="bg-neutral-900">Warn</option>
              </select>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.03]">
      <div className="border-b border-white/[0.06] px-6 py-4">
        <h3 className="text-base font-semibold text-white">Content Guardrails</h3>
        <p className="mt-0.5 text-xs text-neutral-500">
          Pre-dispatch regex scanning for PII and prompt injection. Default off per team.
        </p>
      </div>

      <div className="space-y-4 px-6 py-5">
        {disabled && readOnlyReason && (
          <p className="text-sm text-neutral-500">{readOnlyReason}</p>
        )}

        {error && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        {/* Master toggle */}
        <label className="flex items-center justify-between">
          <span className="text-sm font-medium text-neutral-300">Enable guardrail scanning</span>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            disabled={disabled}
            onClick={() => setEnabled(!enabled)}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
              enabled ? 'bg-emerald-500' : 'bg-neutral-700'
            } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
                enabled ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </label>

        {enabled && (
          <>
            {/* PII patterns */}
            <div>
              <h4 className="mb-1 text-xs font-medium uppercase tracking-wider text-neutral-500">
                PII Detection ({piiPatterns.length})
              </h4>
              <div className="rounded-lg border border-white/[0.06] px-3">
                {piiPatterns.map(renderPattern)}
              </div>
            </div>

            {/* Injection patterns */}
            <div>
              <h4 className="mb-1 text-xs font-medium uppercase tracking-wider text-neutral-500">
                Injection Detection ({injPatterns.length})
              </h4>
              <div className="rounded-lg border border-white/[0.06] px-3">
                {injPatterns.map(renderPattern)}
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
