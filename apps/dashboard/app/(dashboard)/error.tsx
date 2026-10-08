'use client';

import { useEffect } from 'react';
import { AlertCircle, RotateCcw } from 'lucide-react';

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Dashboard route error:', error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="max-w-md rounded-xl border border-red-500/20 bg-red-500/[0.04] p-8 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-500/10">
          <AlertCircle className="h-6 w-6 text-red-400" />
        </div>
        <h2 className="text-lg font-semibold text-white">Something went wrong</h2>
        <p className="mt-2 text-sm text-neutral-400">
          We hit an unexpected error rendering this page. Try again — if it keeps happening, check the dashboard logs.
        </p>
        {error.digest && (
          <p className="mt-3 font-mono text-[11px] text-neutral-500">
            ref: {error.digest}
          </p>
        )}
        <button
          onClick={reset}
          className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-white/[0.06] px-4 py-2 text-sm font-medium text-neutral-200 transition-colors hover:bg-white/[0.1]"
        >
          <RotateCcw className="h-4 w-4" />
          Try again
        </button>
      </div>
    </div>
  );
}
