'use client';

import { useEffect, useState } from 'react';

// LAY-348: workspace-level TPM cap. Per-key TPM (LAY-330) is configured on
// each key directly; this is the aggregate cap that runs in series.

export function TeamRateLimitsSection({ canEdit }: { canEdit: boolean }) {
  const [tpm, setTpm] = useState<number | null>(null);
  const [draft, setDraft] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/team/rate-limits', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { tpm_limit: number | null };
        if (!cancelled) {
          setTpm(data.tpm_limit ?? null);
          setDraft(data.tpm_limit == null ? '' : String(data.tpm_limit));
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      let nextValue: number | null;
      const trimmed = draft.trim();
      if (trimmed === '') {
        nextValue = null;
      } else {
        const parsed = Number(trimmed);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          throw new Error('TPM must be a positive integer or empty');
        }
        nextValue = parsed;
      }
      const res = await fetch('/api/team/rate-limits', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tpm_limit: nextValue }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: { message?: string } | string;
        };
        const msg =
          typeof data.error === 'string'
            ? data.error
            : data.error?.message ?? `HTTP ${res.status}`;
        throw new Error(msg);
      }
      const data = (await res.json()) as { tpm_limit: number | null };
      setTpm(data.tpm_limit ?? null);
      setDraft(data.tpm_limit == null ? '' : String(data.tpm_limit));
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  function clearCap() {
    setDraft('');
  }

  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.03]">
      <div className="border-b border-white/[0.06] px-6 py-4">
        <h3 className="text-base font-semibold text-white">Team rate limits</h3>
      </div>
      <div className="space-y-4 px-6 py-5">
        <p className="text-sm text-neutral-400">
          Workspace-wide tokens-per-minute cap. Runs in series with each key's own
          TPM override — a key with its own override still consumes against this
          cap, so spreading bursts across many keys can't bypass the workspace
          envelope.
        </p>

        {loading ? (
          <p className="text-sm text-neutral-500 italic">Loading…</p>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-xs text-neutral-400">
                Tokens per minute
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={draft}
                  disabled={!canEdit || saving}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    setSavedAt(null);
                  }}
                  placeholder="No cap"
                  className="w-48 rounded-md border border-white/[0.08] bg-neutral-900 px-3 py-1.5 text-sm text-white placeholder:text-neutral-600 focus:border-emerald-500 focus:outline-none disabled:opacity-50"
                />
              </label>

              {canEdit ? (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={save}
                    disabled={saving}
                    className="rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-emerald-400"
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                  {draft !== '' && (
                    <button
                      type="button"
                      onClick={clearCap}
                      disabled={saving}
                      className="text-xs text-neutral-500 hover:text-neutral-300"
                    >
                      Remove cap
                    </button>
                  )}
                </div>
              ) : (
                <p className="text-xs text-neutral-500">
                  Only admins can change the workspace cap.
                </p>
              )}
            </div>

            <p className="text-xs text-neutral-500">
              Currently:{' '}
              {tpm == null
                ? 'no workspace cap'
                : `${tpm.toLocaleString()} tokens / minute`}
              .
            </p>

            {savedAt && !error && (
              <p className="text-xs text-emerald-400">
                Saved. New cap takes effect within 60 seconds.
              </p>
            )}
            {error && <p className="text-xs text-red-400">{error}</p>}
          </>
        )}
      </div>
    </div>
  );
}
