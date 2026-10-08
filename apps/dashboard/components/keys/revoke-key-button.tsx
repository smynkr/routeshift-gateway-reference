'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useDialogA11y } from '@/lib/use-dialog-a11y';
import { DialogPortal } from '@/components/ui/dialog-portal';

export function RevokeKeyButton({ keyId }: { keyId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useDialogA11y(dialogRef, open);

  useEffect(() => {
    if (!open) return;
    dialogRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || revoking) return;
      event.preventDefault();
      setOpen(false);
      window.setTimeout(() => triggerRef.current?.focus(), 0);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, revoking]);

  function dismiss(restoreFocus = true) {
    setOpen(false);
    if (restoreFocus) window.setTimeout(() => triggerRef.current?.focus(), 0);
  }

  async function handleRevoke() {
    setError(null);
    setRevoking(true);
    try {
      const res = await fetch(`/api/keys/${keyId}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error?.message ?? data.error ?? 'Failed to revoke key');
        return;
      }
      dismiss(false);
      router.refresh();
    } catch {
      setError('Network error — could not revoke key');
    } finally {
      setRevoking(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        ref={triggerRef}
        onClick={() => setOpen(true)}
        disabled={revoking}
        className="text-red-400 hover:text-red-300 text-xs disabled:opacity-50"
      >
        {revoking ? 'Revoking...' : 'Revoke'}
      </button>
      {error && !open && <span className="max-w-48 text-right text-xs text-red-400">{error}</span>}

      {open && (
        <DialogPortal>
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !revoking) dismiss();
          }}
        >
          <div
            ref={dialogRef}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="revoke-key-title"
            aria-describedby="revoke-key-desc"
            className="w-full max-w-lg rounded-xl border border-amber-500/20 bg-[#141416] p-5 shadow-2xl shadow-black/40"
          >
            <h3 id="revoke-key-title" className="text-base font-semibold text-white">
              Revoke this API key?
            </h3>
            <p id="revoke-key-desc" className="mt-2 text-sm text-neutral-300">
              Revoked keys stop working immediately. This cannot be undone.
            </p>
            {error && <p className="mt-3 text-sm text-red-200" role="alert">{error}</p>}
            <div className="mt-4 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => dismiss()}
                disabled={revoking}
                className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-4 py-2 text-sm font-medium text-neutral-300 hover:bg-white/[0.06] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleRevoke()}
                disabled={revoking}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50"
              >
                {revoking ? 'Revoking…' : 'Revoke key'}
              </button>
            </div>
          </div>
        </div>
        </DialogPortal>
      )}
    </span>
  );
}
