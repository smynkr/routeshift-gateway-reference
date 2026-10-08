'use client';

import { useEffect, useRef, useState } from 'react';
import { X, Plus, CreditCard } from 'lucide-react';
import { useDialogA11y } from '@/lib/use-dialog-a11y';
import { DialogPortal } from '@/components/ui/dialog-portal';

const PRESETS = [10, 25, 50, 100, 500];
const MIN_CREDIT_USD = 10;
// Must match the server cap in app/api/credits/purchase/route.ts (amount_cents
// <= 1_000_000 = $10,000); otherwise amounts in between pass client validation
// and then hit a confusing server 400.
const MAX_CREDIT_USD = 10_000;

export function AddCreditsDialog({ onSuccess }: { onSuccess?: () => void }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState<number | ''>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const customAmountRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useDialogA11y(dialogRef, open);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !loading) setOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, loading]);

  useEffect(() => {
    if (open) customAmountRef.current?.focus();
  }, [open]);

  const selectedAmount = typeof amount === 'number' ? amount : 0;
  const isValid = selectedAmount >= MIN_CREDIT_USD && selectedAmount <= MAX_CREDIT_USD;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) return;

    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/credits/purchase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount_cents: Math.round(selectedAmount * 100) }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed to create checkout session');
        return;
      }

      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      }
    } catch {
      setError('Failed to create checkout session');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button
        onClick={() => { setOpen(true); setError(''); setAmount(''); }}
        className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white transition-all duration-200 hover:bg-emerald-500"
      >
        <Plus className="h-4 w-4" />
        Add Credits
      </button>

      {open && (
        <DialogPortal>
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-credits-title"
            className="relative w-full max-w-md rounded-xl border border-white/[0.06] bg-[#0c0c0e] p-6 shadow-2xl"
          >
            <button
              onClick={() => setOpen(false)}
              aria-label="Close dialog"
              className="absolute right-4 top-4 rounded p-1 text-neutral-500 transition-colors hover:bg-white/[0.05] hover:text-neutral-300"
            >
              <X className="h-5 w-5" />
            </button>

            <div className="mb-5 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-500/10">
                <CreditCard className="h-5 w-5 text-emerald-400" />
              </div>
              <div>
                <h3 id="add-credits-title" className="text-lg font-semibold text-white">Add Credits</h3>
                <p className="text-sm text-neutral-500">Purchase credits via Stripe Checkout</p>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-neutral-400">
                  Select amount
                </label>
                <div className="flex flex-wrap gap-2">
                  {PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setAmount(preset)}
                      className={`rounded-lg px-4 py-2 text-sm font-medium transition-all duration-200 ${
                        amount === preset
                          ? 'bg-emerald-600 text-white'
                          : 'border border-white/[0.06] bg-white/[0.03] text-neutral-400 hover:bg-white/[0.06]'
                      }`}
                    >
                      ${preset}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium text-neutral-400">
                  Or enter custom amount
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-neutral-500">$</span>
                  <input
                    ref={customAmountRef}
                    type="number"
                    min={MIN_CREDIT_USD}
                    max={MAX_CREDIT_USD}
                    step={1}
                    value={amount === '' ? '' : amount}
                    onChange={(e) => setAmount(e.target.value ? Number(e.target.value) : '')}
                    placeholder="10"
                    className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] py-2.5 pl-7 pr-3 text-sm text-white placeholder:text-neutral-600 focus:border-emerald-500/50 focus:outline-none"
                  />
                </div>
                {typeof amount === 'number' && amount > 0 && amount < MIN_CREDIT_USD && (
                  <p className="mt-1 text-xs text-red-400">Minimum amount is ${MIN_CREDIT_USD}</p>
                )}
                {typeof amount === 'number' && amount > MAX_CREDIT_USD && (
                  <p className="mt-1 text-xs text-red-400">Maximum amount is ${MAX_CREDIT_USD.toLocaleString()}</p>
                )}
              </div>

              {error && (
                <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">{error}</p>
              )}

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="flex-1 rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2.5 text-sm font-medium text-neutral-400 transition-colors hover:bg-white/[0.06]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loading || !isValid}
                  className="flex-1 rounded-lg bg-emerald-600 px-3 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
                >
                  {loading ? 'Redirecting...' : `Purchase $${isValid ? selectedAmount : '...'}`}
                </button>
              </div>
            </form>
          </div>
        </div>
        </DialogPortal>
      )}
    </>
  );
}
