'use client';
import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { EFFECTIVE_PUBLIC_MODELS } from '@routeshift/shared';
import { DialogPortal } from '@/components/ui/dialog-portal';

const PUBLIC_MODEL_OPTIONS = EFFECTIVE_PUBLIC_MODELS.map((model) => model.canonical_name);

interface KeyRow {
  id: string;
  name: string;
  allowed_models: string[] | null;
  expires_at: string | null;
  rate_limit_override: { requests_per_minute?: number; tokens_per_minute?: number } | null;
  metadata: Record<string, unknown>;
  daily_usd_cap?: number | null;
  weekly_usd_cap?: number | null;
  monthly_usd_cap?: number | null;
  preset_slug?: string | null;
  preset_version?: number | null;
}

export function EditKeyDialog({ keyRow }: { keyRow: KeyRow }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(keyRow.name);
  const [allowedModels, setAllowedModels] = useState<string[]>(keyRow.allowed_models ?? []);
  const [expiresAt, setExpiresAt] = useState(
    keyRow.expires_at ? keyRow.expires_at.slice(0, 10) : '',
  );
  const [rpm, setRpm] = useState<string>(
    keyRow.rate_limit_override?.requests_per_minute?.toString() ?? '',
  );
  const [tpm, setTpm] = useState<string>(
    keyRow.rate_limit_override?.tokens_per_minute?.toString() ?? '',
  );
  const [metadataText, setMetadataText] = useState(
    keyRow.metadata && Object.keys(keyRow.metadata).length > 0
      ? JSON.stringify(keyRow.metadata, null, 2)
      : '',
  );
  const [dailyCap, setDailyCap] = useState(keyRow.daily_usd_cap != null ? String(keyRow.daily_usd_cap) : '');
  const [weeklyCap, setWeeklyCap] = useState(keyRow.weekly_usd_cap != null ? String(keyRow.weekly_usd_cap) : '');
  const [monthlyCap, setMonthlyCap] = useState(keyRow.monthly_usd_cap != null ? String(keyRow.monthly_usd_cap) : '');
  const [preset, setPreset] = useState(
    keyRow.preset_slug ? (keyRow.preset_version != null ? `${keyRow.preset_slug}@${keyRow.preset_version}` : keyRow.preset_slug) : '',
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const modelOptions = useMemo(
    () => [...new Set([...PUBLIC_MODEL_OPTIONS, ...(keyRow.allowed_models ?? [])])].sort(),
    [keyRow.allowed_models],
  );

  useEffect(() => {
    if (!open) return;
    function handler(e: KeyboardEvent) {
      if (e.key === 'Escape') handleClose();
    }
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  function handleClose() {
    setOpen(false);
    setError(null);
    // Reset to current props on next open
    setName(keyRow.name);
    setAllowedModels(keyRow.allowed_models ?? []);
    setExpiresAt(keyRow.expires_at ? keyRow.expires_at.slice(0, 10) : '');
    setRpm(keyRow.rate_limit_override?.requests_per_minute?.toString() ?? '');
    setTpm(keyRow.rate_limit_override?.tokens_per_minute?.toString() ?? '');
    setMetadataText(
      keyRow.metadata && Object.keys(keyRow.metadata).length > 0
        ? JSON.stringify(keyRow.metadata, null, 2)
        : '',
    );
    setDailyCap(keyRow.daily_usd_cap != null ? String(keyRow.daily_usd_cap) : '');
    setWeeklyCap(keyRow.weekly_usd_cap != null ? String(keyRow.weekly_usd_cap) : '');
    setMonthlyCap(keyRow.monthly_usd_cap != null ? String(keyRow.monthly_usd_cap) : '');
    setPreset(keyRow.preset_slug ? (keyRow.preset_version != null ? `${keyRow.preset_slug}@${keyRow.preset_version}` : keyRow.preset_slug) : '');
  }

  function toggleModel(model: string) {
    setAllowedModels((current) =>
      current.includes(model) ? current.filter((m) => m !== model) : [...current, model],
    );
  }

  async function handleSave() {
    setError(null);

    let metadata: Record<string, unknown> | null = null;
    if (metadataText.trim().length > 0) {
      try {
        const parsed = JSON.parse(metadataText);
        if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
          setError('metadata must be a JSON object');
          return;
        }
        metadata = parsed;
      } catch {
        setError('metadata must be valid JSON');
        return;
      }
    } else {
      metadata = {};
    }

    const rateLimitOverride: Record<string, number> = {};
    if (rpm.trim().length > 0) {
      const n = Number(rpm);
      if (!Number.isInteger(n) || n <= 0) {
        setError('RPM must be a positive integer');
        return;
      }
      rateLimitOverride.requests_per_minute = n;
    }
    if (tpm.trim().length > 0) {
      const n = Number(tpm);
      if (!Number.isInteger(n) || n <= 0) {
        setError('TPM must be a positive integer');
        return;
      }
      rateLimitOverride.tokens_per_minute = n;
    }

    // RSH-138: per-key budget caps. Blank input → explicit null (clears that
    // window); every cap field is always sent so the proxy preserves the rest.
    const caps: Record<string, number | null> = {};
    for (const [field, raw] of [['daily_usd_cap', dailyCap], ['weekly_usd_cap', weeklyCap], ['monthly_usd_cap', monthlyCap]] as const) {
      if (raw.trim() === '') {
        caps[field] = null;
        continue;
      }
      const n = Number(raw);
      if (Number.isNaN(n) || n < 0) {
        setError(`${field} must be a non-negative number, or empty to disable`);
        return;
      }
      caps[field] = n;
    }

    const payload: Record<string, unknown> = {
      name,
      allowed_models: allowedModels.length > 0 ? allowedModels : null,
      expires_at: expiresAt ? new Date(expiresAt + 'T00:00:00Z').toISOString() : null,
      rate_limit_override:
        Object.keys(rateLimitOverride).length > 0 ? rateLimitOverride : null,
      metadata,
      ...caps,
      // RSH-146: send the preset ONLY when the key has a binding or the
      // user typed one — an unbound key with an empty field must not send
      // `preset: null` (that would clear a binding a stale client missed).
      ...(keyRow.preset_slug || preset.trim().length > 0
        ? { preset: preset.trim().length > 0 ? preset.trim() : null }
        : {}),
    };

    setLoading(true);
    try {
      const res = await fetch(`/api/keys/${keyRow.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error?.message ?? 'Failed to update key');
        return;
      }
      setOpen(false);
      router.refresh();
    } catch {
      setError('Network error — could not reach server');
    } finally {
      setLoading(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-md border border-white/[0.06] bg-white/[0.03] px-2.5 py-1 text-xs text-neutral-300 transition-colors hover:bg-white/[0.06] hover:text-white"
      >
        Edit
      </button>
    );
  }

  return (
    <DialogPortal>
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-key-dialog-title"
        className="max-h-[90vh] w-[calc(100vw-2rem)] max-w-[560px] overflow-y-auto rounded-xl border border-white/[0.06] bg-[#0c0c0e] shadow-2xl shadow-black/40"
      >
        <div className="border-b border-white/[0.06] px-6 py-4">
          <h3 id="edit-key-dialog-title" className="text-lg font-semibold text-white">
            Edit API Key
          </h3>
        </div>

        <div className="space-y-4 px-6 py-5">
          <div className="space-y-1.5">
            <label htmlFor="edit-key-name" className="text-sm font-medium text-neutral-300">
              Name
            </label>
            <input
              id="edit-key-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-sm text-white outline-none focus:border-emerald-500/50"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-neutral-300">
              Allowed Models{' '}
              <span className="text-xs text-neutral-500">
                (empty = all permitted)
              </span>
            </label>
            <div className="max-h-40 overflow-y-auto rounded-lg border border-white/[0.06] bg-white/[0.03] p-2">
              {modelOptions.map((model) => (
                <label
                  key={model}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs text-neutral-300 hover:bg-white/[0.04]"
                >
                  <input
                    type="checkbox"
                    checked={allowedModels.includes(model)}
                    onChange={() => toggleModel(model)}
                    className="accent-emerald-500"
                  />
                  <span className="font-mono">{model}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="edit-key-rpm" className="text-sm font-medium text-neutral-300">
                RPM <span className="text-xs text-neutral-500">(blank = team default)</span>
              </label>
              <input
                id="edit-key-rpm"
                type="number"
                min={1}
                value={rpm}
                onChange={(e) => setRpm(e.target.value)}
                placeholder="100"
                className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-sm text-white outline-none focus:border-emerald-500/50"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="edit-key-tpm" className="text-sm font-medium text-neutral-300">
                TPM <span className="text-xs text-neutral-500">(blank = no cap)</span>
              </label>
              <input
                id="edit-key-tpm"
                type="number"
                min={1}
                value={tpm}
                onChange={(e) => setTpm(e.target.value)}
                placeholder="50000"
                className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-sm text-white outline-none focus:border-emerald-500/50"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="edit-key-expires" className="text-sm font-medium text-neutral-300">
              Expires <span className="text-xs text-neutral-500">(blank = never)</span>
            </label>
            <input
              id="edit-key-expires"
              type="date"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-sm text-white outline-none focus:border-emerald-500/50"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="edit-key-preset" className="text-sm font-medium text-neutral-300">
              Preset binding <span className="text-xs text-neutral-500">(slug or slug@version; blank = clear)</span>
            </label>
            <input
              id="edit-key-preset"
              type="text"
              value={preset}
              onChange={(e) => setPreset(e.target.value)}
              placeholder="research-assistant@2"
              className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-sm text-white outline-none focus:border-emerald-500/50"
            />
            <p className="text-xs text-neutral-600">
              Bound keys apply the preset on every request; request-level presets are rejected.
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="edit-key-metadata" className="text-sm font-medium text-neutral-300">
              Metadata <span className="text-xs text-neutral-500">(JSON object for tags)</span>
            </label>
            <textarea
              id="edit-key-metadata"
              value={metadataText}
              onChange={(e) => setMetadataText(e.target.value)}
              rows={4}
              placeholder='{"customer_id": "c_42"}'
              className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 font-mono text-xs text-white outline-none focus:border-emerald-500/50"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <label htmlFor="edit-key-daily-cap" className="text-sm font-medium text-neutral-300">
                Daily cap (USD) <span className="text-xs text-neutral-500">(blank = clear)</span>
              </label>
              <input
                id="edit-key-daily-cap"
                type="number"
                min={0}
                step={1}
                placeholder="e.g. 50"
                value={dailyCap}
                onChange={(e) => setDailyCap(e.target.value)}
                className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-sm text-white outline-none focus:border-emerald-500/50"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="edit-key-weekly-cap" className="text-sm font-medium text-neutral-300">
                Weekly cap (USD) <span className="text-xs text-neutral-500">(blank = clear)</span>
              </label>
              <input
                id="edit-key-weekly-cap"
                type="number"
                min={0}
                step={1}
                placeholder="e.g. 200"
                value={weeklyCap}
                onChange={(e) => setWeeklyCap(e.target.value)}
                className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-sm text-white outline-none focus:border-emerald-500/50"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="edit-key-monthly-cap" className="text-sm font-medium text-neutral-300">
                Monthly cap (USD) <span className="text-xs text-neutral-500">(blank = clear)</span>
              </label>
              <input
                id="edit-key-monthly-cap"
                type="number"
                min={0}
                step={1}
                placeholder="e.g. 500"
                value={monthlyCap}
                onChange={(e) => setMonthlyCap(e.target.value)}
                className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-sm text-white outline-none focus:border-emerald-500/50"
              />
            </div>
          </div>

          {error && (
            <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2">
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2 border-t border-white/[0.06] px-6 py-4 sm:flex-row sm:justify-end">
          <button
            onClick={handleClose}
            disabled={loading}
            className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-4 py-2 text-sm text-neutral-300 transition-colors hover:bg-white/[0.06] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={loading}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
          >
            {loading ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
    </DialogPortal>
  );
}
