'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { DialogPortal } from '@/components/ui/dialog-portal';

const DEFAULT_GRACE_HOURS = 24;
const MAX_GRACE_HOURS = 168;

export function RotateKeyButton({ keyId, keyName }: { keyId: string; keyName: string }) {
  const [open, setOpen] = useState(false);
  const [graceHours, setGraceHours] = useState(DEFAULT_GRACE_HOURS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ key: string; graceUntil: string | null } | null>(null);
  const [copied, setCopied] = useState(false);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const copyButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const target = result ? copyButtonRef.current : inputRef.current;
    target?.focus();
  }, [open, result]);

  useEffect(() => {
    if (!open) return;
    function handler(e: KeyboardEvent) {
      if (e.key === 'Escape' && !result) handleClose();
    }
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, result]);

  function handleClose() {
    const wasRotated = !!result;
    setOpen(false);
    setResult(null);
    setError(null);
    setLoading(false);
    setGraceHours(DEFAULT_GRACE_HOURS);
    setCopied(false);
    if (wasRotated) router.refresh();
  }

  async function handleRotate() {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/keys/${keyId}/rotate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grace_hours: graceHours }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error?.message ?? data.error ?? 'Failed to rotate key');
        return;
      }
      setResult({ key: data.new_key, graceUntil: data.grace_until ?? null });
    } catch {
      setError('Network error — could not reach server');
    } finally {
      setLoading(false);
    }
  }

  async function handleCopy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not access clipboard. Select the key and copy manually.');
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-md border border-white/[0.06] bg-white/[0.03] px-2.5 py-1 text-xs text-neutral-300 transition-colors hover:bg-white/[0.06] hover:text-white"
        title="Rotate this key with a grace period"
      >
        Rotate
      </button>
    );
  }

  return (
    <DialogPortal>
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget && !result) handleClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="rotate-key-dialog-title"
        className="w-[calc(100vw-2rem)] max-w-[500px] rounded-xl border border-white/[0.06] bg-[#0c0c0e] shadow-2xl shadow-black/40"
      >
        <div className="border-b border-white/[0.06] px-6 py-4">
          <h3 id="rotate-key-dialog-title" className="text-lg font-semibold text-white">
            {result ? 'Key Rotated' : `Rotate ${keyName}`}
          </h3>
        </div>

        <div className="px-6 py-5">
          {result ? (
            <div className="space-y-4">
              <p className="text-sm text-neutral-400">
                Copy the new key now. You won&apos;t be able to see it again. The old key keeps working until{' '}
                <span className="text-white">
                  {result.graceUntil ? new Date(result.graceUntil).toLocaleString() : 'the grace window expires'}
                </span>.
              </p>
              {error && (
                <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2">
                  <p className="text-sm text-red-400">{error}</p>
                </div>
              )}
              <div className="flex flex-col gap-2 sm:flex-row">
                <code className="flex-1 rounded-lg border border-white/[0.06] bg-white/[0.03] p-3 font-mono text-sm text-emerald-400 break-all">
                  {result.key}
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
              <p className="text-sm text-neutral-400">
                Issues a new key for the same team and environment. The current key keeps working for the grace period below so callers can roll over without dropping requests.
              </p>
              <div className="space-y-1.5">
                <label htmlFor="rotate-grace-hours" className="text-sm font-medium text-neutral-300">
                  Grace period (hours)
                </label>
                <input
                  ref={inputRef}
                  id="rotate-grace-hours"
                  type="number"
                  min={1}
                  max={MAX_GRACE_HOURS}
                  step={1}
                  value={graceHours}
                  onChange={(e) => {
                    const v = Number.parseInt(e.target.value, 10);
                    setGraceHours(Number.isFinite(v) ? v : DEFAULT_GRACE_HOURS);
                  }}
                  className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2.5 text-sm text-white placeholder-neutral-600 outline-none transition-colors focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20"
                />
                <p className="text-xs text-neutral-500">Between 1 and {MAX_GRACE_HOURS} (1 week).</p>
              </div>
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
                  onClick={handleRotate}
                  disabled={loading || graceHours < 1 || graceHours > MAX_GRACE_HOURS}
                  className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-all hover:bg-emerald-500 disabled:opacity-50"
                >
                  {loading ? 'Rotating...' : 'Rotate'}
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
