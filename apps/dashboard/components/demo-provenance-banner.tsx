'use client';

import { useEffect, useCallback, useRef, useState } from 'react';
import { FlaskConical } from 'lucide-react';

type DemoProvenanceResponse =
  | { active: false }
  | {
      active: true;
      label: 'Sample data';
      teamId: string;
      generatedAt: string;
      description: string;
    };

type DemoApiResponse = {
  active: boolean;
  provenance?: DemoProvenanceResponse;
};

type ProvenanceState = DemoProvenanceResponse | 'unverified' | null;

/** Visible provenance banner for RouteShift sample/demo metrics. */
export function DemoProvenanceBanner() {
  const [provenance, setProvenance] = useState<ProvenanceState>(null);
  const cancelLoadRef = useRef<(() => void) | null>(null);

  const loadProvenance = useCallback(() => {
    let cancelled = false;
    fetch('/api/demo', { cache: 'no-store' })
      .then(async (res): Promise<DemoApiResponse | 'unverified'> => {
        if (!res.ok) return 'unverified';
        return (await res.json()) as DemoApiResponse;
      })
      .then((data: DemoApiResponse | 'unverified' | null) => {
        if (cancelled) return;
        if (data === 'unverified') {
          setProvenance('unverified');
          return;
        }
        if (data?.active && data.provenance?.active) {
          setProvenance(data.provenance);
          return;
        }
        setProvenance(data?.active ? 'unverified' : { active: false });
      })
      .catch(() => {
        if (!cancelled) setProvenance('unverified');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    cancelLoadRef.current = loadProvenance();
    function onDemoChanged() {
      cancelLoadRef.current?.();
      cancelLoadRef.current = loadProvenance();
    }
    window.addEventListener('routeshift:demo-changed', onDemoChanged);
    return () => {
      cancelLoadRef.current?.();
      cancelLoadRef.current = null;
      window.removeEventListener('routeshift:demo-changed', onDemoChanged);
    };
  }, [loadProvenance]);

  if (provenance === 'unverified') {
    return (
      <aside
        aria-label="Sample data provenance unavailable"
        className="mb-4 rounded-xl border border-amber-400/20 bg-amber-400/[0.08] px-4 py-3 text-sm text-amber-50 shadow-[0_0_0_1px_rgba(251,191,36,0.04)]"
      >
        <div className="flex flex-wrap items-center gap-2">
          <FlaskConical className="h-4 w-4 text-amber-300" />
          <span className="font-semibold">Sample data status unavailable</span>
        </div>
        <p className="mt-1 text-xs leading-5 text-amber-100/75">
          RouteShift could not verify whether this dashboard is showing seeded sample data. Refresh before treating these metrics as live workspace data.
        </p>
      </aside>
    );
  }

  if (!provenance?.active) return null;

  const generatedDate = new Date(provenance.generatedAt);
  const generated = Number.isFinite(generatedDate.getTime())
    ? generatedDate.toISOString().slice(0, 10)
    : provenance.generatedAt;

  return (
    <aside
      aria-label="Sample data provenance"
      className="mb-4 rounded-xl border border-amber-400/20 bg-amber-400/[0.08] px-4 py-3 text-sm text-amber-50 shadow-[0_0_0_1px_rgba(251,191,36,0.04)]"
    >
      <div className="flex flex-wrap items-center gap-2">
        <FlaskConical className="h-4 w-4 text-amber-300" />
        <span className="font-semibold">Sample data</span>
        <span className="rounded-full border border-amber-300/30 px-2 py-0.5 text-[11px] uppercase tracking-wide text-amber-200">
          demo team {provenance.teamId.slice(0, 8)}
        </span>
        <span className="text-amber-100/70">Generated {generated}</span>
      </div>
      <p className="mt-1 text-xs leading-5 text-amber-100/75">
        {provenance.description}
      </p>
    </aside>
  );
}
