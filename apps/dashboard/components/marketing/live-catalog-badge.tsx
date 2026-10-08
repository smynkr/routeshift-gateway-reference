'use client';

import { useEffect, useState } from 'react';
import { isLandingCatalogStats, type LandingCatalogStats } from '@/lib/landing-catalog';

export function LiveCatalogBadge({ label }: { label: string }) {
  const [liveStats, setLiveStats] = useState<LandingCatalogStats | null>(null);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    void fetch('/api/public/catalog-stats', {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return;
        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.toLowerCase().includes('application/json')) return;
        const payload: unknown = await response.json();
        if (active && isLandingCatalogStats(payload)) setLiveStats(payload);
      })
      .catch(() => {
        // The server-rendered label remains the source of truth when the enhancement is unavailable.
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  return (
    <p className="mt-2 text-xs text-emerald-300/80" aria-live="polite">
      {liveStats
        ? `Live catalog · ${liveStats.modelCount.toLocaleString()} models · ${liveStats.providerCount.toLocaleString()} providers`
        : label}
    </p>
  );
}
