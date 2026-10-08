'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FlaskConical } from 'lucide-react';

/**
 * "Sample data" switch in the sidebar. Self-contained: it asks /api/demo for
 * its state (since the cookie is httpOnly) and only renders when demo mode is
 * permitted in this environment. Toggling sets/clears the cookie then refreshes
 * so server components re-read it.
 */
export function DemoToggle() {
  const router = useRouter();
  const [enabled, setEnabled] = useState(false);
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/demo', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) {
          setEnabled(Boolean(d.enabled));
          setActive(Boolean(d.active));
        }
      })
      .catch(() => {
        /* sidebar snapshot failure — leave the toggle hidden */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!enabled) return null;

  async function toggle() {
    const next = !active;
    setBusy(true);
    try {
      const res = await fetch('/api/demo', { method: next ? 'POST' : 'DELETE' });
      if (res.ok) {
        setActive(next);
        window.dispatchEvent(new CustomEvent('routeshift:demo-changed'));
        router.refresh();
      }
    } catch {
      /* ignore — state stays as-is */
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      role="switch"
      aria-checked={active}
      aria-label="Toggle sample demo data"
      className="mt-4 flex w-full items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2.5 text-left transition-colors hover:border-white/[0.1] disabled:opacity-50"
    >
      <span className="flex items-center gap-2">
        <FlaskConical className={`h-4 w-4 ${active ? 'text-emerald-400' : 'text-neutral-600'}`} />
        <span className="flex flex-col">
          <span className="text-sm text-neutral-300">Sample data</span>
          <span className="text-[11px] text-neutral-600">
            {active ? 'Showing seeded sample data' : 'Showing workspace data'}
          </span>
        </span>
      </span>
      <span
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
          active ? 'bg-emerald-500' : 'bg-white/[0.12]'
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
            active ? 'translate-x-4' : 'translate-x-0.5'
          }`}
        />
      </span>
    </button>
  );
}
