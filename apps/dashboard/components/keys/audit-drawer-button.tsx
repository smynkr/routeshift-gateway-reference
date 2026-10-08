'use client';

import { useEffect, useState } from 'react';
import { auditEventBadgeStyle, auditEventLabel } from '@/lib/key-audit-event';
import { DialogPortal } from '@/components/ui/dialog-portal';

interface AuditEvent {
  id: string;
  // Keep the wire type open so newly added proxy events remain visible while
  // the dashboard catches up with their presentation details.
  event_type: string;
  actor_user_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

export function AuditDrawerButton({
  keyId,
  keyPrefix,
  keyName,
}: {
  keyId: string;
  keyPrefix: string;
  keyName: string;
}) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const res = await fetch(`/api/keys/${keyId}/audit?limit=50`, { cache: 'no-store' });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } | string };
          const msg =
            typeof data.error === 'string'
              ? data.error
              : data.error?.message ?? `HTTP ${res.status}`;
          throw new Error(msg);
        }
        const data = (await res.json()) as { events: AuditEvent[] };
        if (!cancelled) setEvents(data.events ?? []);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load audit events');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, keyId]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-neutral-400 hover:text-neutral-200"
      >
        Audit
      </button>

      {open && (
        <DialogPortal>
        <div
          className="fixed inset-0 z-50 flex justify-end bg-black/60"
          onClick={() => setOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label={`Audit log for ${keyName}`}
        >
          <div
            className="flex h-full w-full max-w-xl flex-col border-l border-white/[0.08] bg-neutral-950"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between border-b border-white/[0.06] px-6 py-4">
              <div>
                <h3 className="text-sm font-semibold text-white">Audit log</h3>
                <p className="mt-0.5 text-xs text-neutral-500">
                  <span className="font-mono">{keyPrefix}…</span> &middot; {keyName}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded p-1 text-neutral-500 hover:bg-white/[0.04] hover:text-neutral-300"
                aria-label="Close audit drawer"
              >
                ×
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4">
              {loading && (
                <p className="text-sm text-neutral-500 italic">Loading events…</p>
              )}
              {error && (
                <p className="rounded-md border border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-sm text-red-300">
                  {error}
                </p>
              )}
              {!loading && !error && events.length === 0 && (
                <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] py-12 text-center">
                  <p className="text-sm text-neutral-500">No audit events yet.</p>
                  <p className="mt-1 text-xs text-neutral-600">
                    Events appear when the key is created, revoked, or hits a guardrail.
                  </p>
                </div>
              )}
              {!loading && !error && events.length > 0 && (
                <ul className="space-y-3">
                  {events.map((event) => (
                    <li
                      key={event.id}
                      className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${auditEventBadgeStyle(event.event_type)}`}
                          >
                            {auditEventLabel(event.event_type)}
                          </span>
                          {typeof event.details?.kind === 'string' && (
                            <span className="rounded-full border border-white/[0.08] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-neutral-400">
                              {event.details.kind as string}
                            </span>
                          )}
                        </div>
                        <time
                          className="text-xs text-neutral-500"
                          dateTime={event.created_at}
                          suppressHydrationWarning
                        >
                          {new Date(event.created_at).toLocaleString()}
                        </time>
                      </div>
                      <div className="mt-2 space-y-1 text-xs text-neutral-400">
                        {event.actor_user_id && (
                          <div>
                            <span className="text-neutral-500">Actor</span>{' '}
                            <span className="font-mono text-neutral-300">{event.actor_user_id}</span>
                          </div>
                        )}
                        {Object.keys(event.details).length > 0 && (
                          <pre className="overflow-x-auto rounded bg-black/40 px-2 py-1.5 font-mono text-[11px] text-neutral-400">
                            {JSON.stringify(event.details, null, 2)}
                          </pre>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
        </DialogPortal>
      )}
    </>
  );
}
