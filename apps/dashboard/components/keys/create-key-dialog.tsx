'use client';
import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { EFFECTIVE_PUBLIC_MODELS } from '@routeshift/shared';
import { useDialogA11y } from '@/lib/use-dialog-a11y';
import { DialogPortal } from '@/components/ui/dialog-portal';

const MODEL_OPTIONS = [...new Set(EFFECTIVE_PUBLIC_MODELS.map((model) => model.canonical_name))].sort();

export function CreateKeyDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [environment, setEnvironment] = useState<'live' | 'test'>('live');
  const [allowedModels, setAllowedModels] = useState<string[]>([]);
  const [expiresAt, setExpiresAt] = useState('');
  const [rpm, setRpm] = useState('');
  const [tpm, setTpm] = useState('');
  const [metadataText, setMetadataText] = useState('');
  const [dailyCap, setDailyCap] = useState('');
  const [weeklyCap, setWeeklyCap] = useState('');
  const [monthlyCap, setMonthlyCap] = useState('');
  // RSH-146: optional org-policy preset binding (`slug` or `slug@version`).
  const [preset, setPreset] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const nameInputRef = useRef<HTMLInputElement>(null);
  const copyButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useDialogA11y(dialogRef, open);

  useEffect(() => {
    if (!open) return;
    function handler(e: KeyboardEvent) {
      if (e.key === 'Escape' && !createdKey) {
        handleClose();
      }
    }
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, createdKey]);

  useEffect(() => {
    if (!open) return;
    // Focus the most useful element when the dialog appears (and after the
    // create -> show-key transition).
    const target = createdKey ? copyButtonRef.current : nameInputRef.current;
    target?.focus();
  }, [open, createdKey]);

  function toggleModel(model: string) {
    setAllowedModels((current) =>
      current.includes(model) ? current.filter((m) => m !== model) : [...current, model],
    );
  }

  async function handleCreate() {
    setError(null);

    let metadata: Record<string, unknown> = {};
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

    const payload: Record<string, unknown> = {
      name: name || 'Untitled',
      environment,
      metadata,
    };
    if (allowedModels.length > 0) payload.allowed_models = allowedModels;
    if (expiresAt) payload.expires_at = new Date(expiresAt + 'T00:00:00Z').toISOString();
    if (Object.keys(rateLimitOverride).length > 0) payload.rate_limit_override = rateLimitOverride;
    if (preset.trim().length > 0) payload.preset = preset.trim();
    // RSH-138: per-key budget caps. Blank input → explicit null (clears).
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
    Object.assign(payload, caps);

    setLoading(true);
    try {
      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error?.message ?? data.error ?? 'Failed to create key');
        return;
      }
      if (data.key) {
        setCreatedKey(data.key);
      }
    } catch {
      setError('Network error — could not reach server');
    } finally {
      setLoading(false);
    }
  }

  async function handleCopy() {
    if (!createdKey) return;
    try {
      await navigator.clipboard.writeText(createdKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not access clipboard. Select the key and copy manually.');
    }
  }

  function handleClose() {
    const wasCreated = !!createdKey;
    setOpen(false);
    setCreatedKey(null);
    setName('');
    setEnvironment('live');
    setAllowedModels([]);
    setExpiresAt('');
    setRpm('');
    setTpm('');
    setMetadataText('');
    setDailyCap('');
    setWeeklyCap('');
    setMonthlyCap('');
    setPreset('');
    setShowAdvanced(false);
    setCopied(false);
    setError(null);
    setLoading(false);
    if (wasCreated) router.refresh();
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white transition-all hover:bg-emerald-500 hover:shadow-lg hover:shadow-emerald-500/20"
      >
        Create Key
      </button>
    );
  }

  return (
    <DialogPortal>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm" onClick={(e) => { if (e.target === e.currentTarget && !createdKey) handleClose(); }}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-key-dialog-title"
        className="max-h-[90vh] w-[calc(100vw-2rem)] max-w-[560px] overflow-y-auto rounded-xl border border-white/[0.06] bg-[#0c0c0e] shadow-2xl shadow-black/40"
      >
        {/* Header */}
        <div className="border-b border-white/[0.06] px-6 py-4">
          <h3 id="create-key-dialog-title" className="text-lg font-semibold text-white">
            {createdKey ? 'Key Created' : 'Create API Key'}
          </h3>
        </div>

        {/* Content */}
        <div className="px-6 py-5">
          {createdKey ? (
            <div className="space-y-4">
              <p className="text-sm text-neutral-400">
                Copy this key now. You won&apos;t be able to see it again.
              </p>
              {error && (
                <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2">
                  <p className="text-sm text-red-400">{error}</p>
                </div>
              )}
              <div className="flex flex-col gap-2 sm:flex-row">
                <code className="flex-1 rounded-lg border border-white/[0.06] bg-white/[0.03] p-3 font-mono text-sm text-emerald-400 break-all">
                  {createdKey}
                </code>
                <button
                  ref={copyButtonRef}
                  onClick={handleCopy}
                  className={`shrink-0 rounded-lg px-4 py-2.5 text-sm font-medium transition-all ${
                    copied
                      ? 'bg-emerald-600 text-white'
                      : 'border border-white/[0.06] bg-white/[0.03] text-neutral-400 hover:bg-white/[0.06] hover:text-white'
                  }`}
                >
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <button
                onClick={handleClose}
                className="w-full rounded-lg bg-emerald-600 py-2.5 text-sm font-medium text-white transition-all hover:bg-emerald-500"
              >
                Done
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="create-key-name" className="text-sm font-medium text-neutral-300">Name</label>
                <input
                  ref={nameInputRef}
                  id="create-key-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !loading && !showAdvanced) {
                      e.preventDefault();
                      handleCreate();
                    }
                  }}
                  placeholder="e.g., Production, Staging"
                  className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2.5 text-sm text-white placeholder-neutral-600 outline-none transition-colors focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="create-key-env" className="text-sm font-medium text-neutral-300">Environment</label>
                <select
                  id="create-key-env"
                  value={environment}
                  onChange={(e) => setEnvironment(e.target.value as 'live' | 'test')}
                  className="w-full appearance-none bg-white/[0.05] border border-white/[0.1] rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500/50 cursor-pointer"
                >
                  <option value="live">Live</option>
                  <option value="test">Test</option>
                </select>
              </div>

              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="text-xs text-neutral-400 transition-colors hover:text-white"
              >
                {showAdvanced ? '− Hide' : '+ Show'} advanced options (model allowlist, expiry, rate limits, metadata)
              </button>

              {showAdvanced && (
                <div className="space-y-4 rounded-lg border border-white/[0.04] bg-white/[0.01] p-4">
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium text-neutral-300">
                      Allowed Models{' '}
                      <span className="text-xs text-neutral-500">(empty = all permitted)</span>
                    </label>
                    <div className="max-h-40 overflow-y-auto rounded-lg border border-white/[0.06] bg-white/[0.03] p-2">
                      {MODEL_OPTIONS.map((model) => (
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
                      <label htmlFor="create-key-rpm" className="text-sm font-medium text-neutral-300">
                        RPM <span className="text-xs text-neutral-500">(blank = team default)</span>
                      </label>
                      <input
                        id="create-key-rpm"
                        type="number"
                        min={1}
                        value={rpm}
                        onChange={(e) => setRpm(e.target.value)}
                        placeholder="100"
                        className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-sm text-white outline-none focus:border-emerald-500/50"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label htmlFor="create-key-tpm" className="text-sm font-medium text-neutral-300">
                        TPM <span className="text-xs text-neutral-500">(blank = no cap)</span>
                      </label>
                      <input
                        id="create-key-tpm"
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
                    <label htmlFor="create-key-expires" className="text-sm font-medium text-neutral-300">
                      Expires <span className="text-xs text-neutral-500">(blank = never)</span>
                    </label>
                    <input
                      id="create-key-expires"
                      type="date"
                      value={expiresAt}
                      onChange={(e) => setExpiresAt(e.target.value)}
                      className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-sm text-white outline-none focus:border-emerald-500/50"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="create-key-preset" className="text-sm font-medium text-neutral-300">
                      Preset binding <span className="text-xs text-neutral-500">(slug or slug@version; blank = none)</span>
                    </label>
                    <input
                      id="create-key-preset"
                      type="text"
                      value={preset}
                      onChange={(e) => setPreset(e.target.value)}
                      placeholder="research-assistant@2"
                      className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-sm text-white outline-none focus:border-emerald-500/50"
                    />
                    <p className="text-xs text-neutral-600">
                      Binds the key to a preset: its model, params, system prompt and provider prefs apply on every
                      request, and request-level presets are rejected.
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="create-key-daily-cap" className="text-sm font-medium text-neutral-300">
                      Daily budget cap (USD) <span className="text-xs text-neutral-500">(blank = no cap)</span>
                    </label>
                    <input
                      id="create-key-daily-cap"
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
                    <label htmlFor="create-key-weekly-cap" className="text-sm font-medium text-neutral-300">
                      Weekly budget cap (USD) <span className="text-xs text-neutral-500">(blank = no cap)</span>
                    </label>
                    <input
                      id="create-key-weekly-cap"
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
                    <label htmlFor="create-key-monthly-cap" className="text-sm font-medium text-neutral-300">
                      Monthly budget cap (USD) <span className="text-xs text-neutral-500">(blank = no cap)</span>
                    </label>
                    <input
                      id="create-key-monthly-cap"
                      type="number"
                      min={0}
                      step={1}
                      placeholder="e.g. 500"
                      value={monthlyCap}
                      onChange={(e) => setMonthlyCap(e.target.value)}
                      className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-sm text-white outline-none focus:border-emerald-500/50"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="create-key-metadata" className="text-sm font-medium text-neutral-300">
                      Metadata <span className="text-xs text-neutral-500">(JSON object for tags)</span>
                    </label>
                    <textarea
                      id="create-key-metadata"
                      value={metadataText}
                      onChange={(e) => setMetadataText(e.target.value)}
                      rows={4}
                      placeholder='{"customer_id": "c_42"}'
                      className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 font-mono text-xs text-white outline-none focus:border-emerald-500/50"
                    />
                  </div>
                </div>
              )}

              {error && (
                <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2">
                  <p className="text-sm text-red-400">{error}</p>
                </div>
              )}
              <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:justify-end">
                <button
                  onClick={handleClose}
                  disabled={loading}
                  className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-4 py-2 text-sm font-medium text-neutral-400 transition-all hover:bg-white/[0.06] hover:text-white disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreate}
                  disabled={loading}
                  className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-all hover:bg-emerald-500 disabled:opacity-50"
                >
                  {loading ? 'Creating...' : 'Create'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
    </DialogPortal>
  );
}
