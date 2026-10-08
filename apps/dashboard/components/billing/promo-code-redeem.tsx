'use client';

import { useState } from 'react';
import { Gift, Loader2, CheckCircle, AlertCircle } from 'lucide-react';

export function PromoCodeRedeem() {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;

    setLoading(true);
    setResult(null);

    try {
      const res = await fetch('/api/billing/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim() }),
      });

      const data = await res.json();

      if (!res.ok) {
        setResult({ success: false, message: data.error ?? 'Failed to redeem code' });
        return;
      }

      setResult({
        success: true,
        message: `Redeemed! You now have the ${data.plan} plan${data.credits_cents > 0 ? ` + $${(data.credits_cents / 100).toFixed(2)} credits` : ''}.`,
      });
      setCode('');
    } catch {
      setResult({ success: false, message: 'Network error. Please try again.' });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.03]">
      <div className="border-b border-white/[0.06] px-6 py-4">
        <h3 className="text-base font-semibold text-white">Promo Code</h3>
      </div>
      <div className="px-6 py-5">
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Gift className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-600" />
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Enter promo code"
                className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] py-2.5 pl-9 pr-3 text-sm text-white placeholder-neutral-600 outline-none transition-colors focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20"
              />
            </div>
            <button
              type="submit"
              disabled={loading || !code.trim()}
              className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white transition-all hover:bg-emerald-500 disabled:opacity-50"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Redeem'}
            </button>
          </div>

          {result && (
            <div
              className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                result.success
                  ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
                  : 'border-red-500/20 bg-red-500/10 text-red-400'
              }`}
            >
              {result.success ? <CheckCircle className="h-4 w-4 shrink-0" /> : <AlertCircle className="h-4 w-4 shrink-0" />}
              {result.message}
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
