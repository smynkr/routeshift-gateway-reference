'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

interface BillingModeToggleProps {
  currentMode: 'subscription' | 'credits';
}

const MODES = [
  { value: 'subscription' as const, label: 'Subscription' },
  { value: 'credits' as const, label: 'Credits' },
];

export function BillingModeToggle({ currentMode }: BillingModeToggleProps) {
  const router = useRouter();
  const [active, setActive] = useState(currentMode);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSwitch(mode: 'subscription' | 'credits') {
    if (mode === active || loading) return;
    setError(null);
    setLoading(true);

    try {
      const res = await fetch('/api/billing/mode', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error?.message ?? 'Failed to update billing mode');
        return;
      }

      setActive(mode);
      router.refresh();
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="inline-flex rounded-lg border border-white/[0.06] bg-white/[0.02] p-1">
        {MODES.map(({ value, label }) => (
          <button
            key={value}
            onClick={() => handleSwitch(value)}
            disabled={loading}
            className={`relative rounded-md px-4 py-2 text-sm font-medium transition-all ${
              active === value
                ? 'bg-emerald-500/15 text-emerald-400 shadow-sm'
                : 'text-neutral-400 hover:text-neutral-300'
            } disabled:cursor-not-allowed`}
          >
            {label}
            {loading && active !== value && value !== currentMode && (
              <Loader2 className="ml-1.5 inline h-3.5 w-3.5 animate-spin" />
            )}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      <p className="text-xs text-neutral-500">
        {active === 'subscription'
          ? 'You bring your own provider API keys. Provider spend has 0% markup; active paid plans charge 3% of measured savings.'
          : 'RouteShift manages provider keys. Active paid plans charge provider cost plus a 3% credits markup.'}
      </p>
    </div>
  );
}
