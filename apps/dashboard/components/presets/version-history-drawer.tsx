'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useDialogA11y } from '@/lib/use-dialog-a11y';
import { DialogPortal } from '@/components/ui/dialog-portal';

export interface PresetVersion {
  version: number;
  model: string;
  params: unknown;
  system_prompt: string | null;
  provider_prefs: unknown;
  created_by: string | null;
  created_at: string;
}

interface VersionHistoryDrawerProps {
  slug: string;
  onClose: () => void;
}

function responseError(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback;
  const error = (payload as { error?: unknown }).error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return fallback;
}

function isPresetVersion(value: unknown): value is PresetVersion {
  if (!value || typeof value !== 'object') return false;
  const version = value as Partial<PresetVersion>;
  return typeof version.version === 'number' && typeof version.model === 'string';
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown date';
  return date.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function compactJson(value: unknown): string {
  if (value == null) return 'None';
  return JSON.stringify(value, null, 2);
}

function changed(before: unknown, after: unknown): boolean {
  return JSON.stringify(before) !== JSON.stringify(after);
}

export function VersionHistoryDrawer({ slug, onClose }: VersionHistoryDrawerProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const snapshotRequestRef = useRef(0);
  const [versions, setVersions] = useState<PresetVersion[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<PresetVersion | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);

  useDialogA11y(dialogRef, true);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const response = await fetch(`/api/presets/${encodeURIComponent(slug)}/versions`, { cache: 'no-store' });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(responseError(payload, 'Failed to load preset history.'));
      const rows = payload && typeof payload === 'object' ? (payload as { versions?: unknown }).versions : undefined;
      if (!Array.isArray(rows) || !rows.every(isPresetVersion)) {
        throw new Error('Received an invalid preset history response.');
      }
      const newestFirst = [...rows].sort((a, b) => b.version - a.version);
      setVersions(newestFirst);
      setSelectedVersion(newestFirst[0]?.version ?? null);
    } catch (err) {
      setVersions([]);
      setSelectedVersion(null);
      setSnapshot(null);
      setHistoryError(err instanceof Error ? err.message : 'Failed to load preset history.');
    } finally {
      setHistoryLoading(false);
    }
  }, [slug]);

  const loadSnapshot = useCallback(async (version: number) => {
    const requestId = snapshotRequestRef.current + 1;
    snapshotRequestRef.current = requestId;
    setSnapshotLoading(true);
    setSnapshotError(null);
    setSnapshot(null);
    try {
      const response = await fetch(`/api/presets/${encodeURIComponent(slug)}/versions/${version}`, { cache: 'no-store' });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(responseError(payload, 'Failed to load preset version.'));
      const value = payload && typeof payload === 'object' ? (payload as { version?: unknown }).version : undefined;
      if (!isPresetVersion(value)) throw new Error('Received an invalid preset version response.');
      if (snapshotRequestRef.current !== requestId) return;
      setSnapshot(value);
    } catch (err) {
      if (snapshotRequestRef.current !== requestId) return;
      setSnapshotError(err instanceof Error ? err.message : 'Failed to load preset version.');
    } finally {
      if (snapshotRequestRef.current === requestId) setSnapshotLoading(false);
    }
  }, [slug]);

  useEffect(() => () => {
    snapshotRequestRef.current += 1;
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    if (selectedVersion !== null) void loadSnapshot(selectedVersion);
  }, [loadSnapshot, selectedVersion]);

  useEffect(() => {
    closeButtonRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const previous = useMemo(() => {
    if (!snapshot) return null;
    return versions.filter((version) => version.version < snapshot.version).sort((a, b) => b.version - a.version)[0] ?? null;
  }, [snapshot, versions]);

  return (
    <DialogPortal>
    <div
      className="fixed inset-0 z-50 bg-black/60 p-0 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="preset-version-history-title"
        className="ml-auto flex h-full w-full max-w-3xl flex-col border-l border-white/[0.08] bg-[#0c0c0e] shadow-2xl shadow-black/40"
      >
        <header className="flex items-start justify-between border-b border-white/[0.06] px-5 py-4 sm:px-6">
          <div>
            <h2 id="preset-version-history-title" className="text-lg font-semibold text-white">Version history for {slug}</h2>
            <p className="mt-1 text-sm text-neutral-500">Snapshots are immutable. Rollback is intentionally unavailable.</p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Close version history"
            className="rounded-lg p-2 text-neutral-400 transition-colors hover:bg-white/[0.06] hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        {historyLoading ? (
          <div className="p-6 text-sm text-neutral-500">Loading version history…</div>
        ) : historyError ? (
          <div className="m-6 rounded-xl border border-red-500/20 bg-red-500/[0.06] p-4" role="alert">
            <p className="text-sm text-red-200">{historyError}</p>
            <button type="button" onClick={() => void loadHistory()} className="mt-3 text-sm font-medium text-red-100 underline underline-offset-4">Retry history</button>
          </div>
        ) : versions.length === 0 ? (
          <div className="p-6 text-sm text-neutral-500">No published versions are available for this preset.</div>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden md:grid-cols-[12rem_minmax(0,1fr)]">
            <aside className="border-b border-white/[0.06] bg-white/[0.02] p-3 md:overflow-y-auto md:border-b-0 md:border-r">
              <p className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-600">Newest first</p>
              <div className="flex gap-2 overflow-x-auto md:flex-col">
                {versions.map((version) => (
                  <button
                    key={version.version}
                    type="button"
                    onClick={() => setSelectedVersion(version.version)}
                    aria-label={`View version ${version.version}`}
                    aria-pressed={selectedVersion === version.version}
                    className={`min-w-28 rounded-lg px-3 py-2 text-left transition-colors md:min-w-0 ${
                      selectedVersion === version.version
                        ? 'bg-emerald-500/10 text-emerald-300'
                        : 'text-neutral-400 hover:bg-white/[0.05] hover:text-white'
                    }`}
                  >
                    <span className="block font-mono text-sm font-medium">v{version.version}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-neutral-600">{formatDate(version.created_at)}</span>
                  </button>
                ))}
              </div>
            </aside>

            <div className="min-h-0 overflow-y-auto p-5 sm:p-6">
              {snapshotLoading ? (
                <p className="text-sm text-neutral-500">Loading version snapshot…</p>
              ) : snapshotError ? (
                <div className="rounded-xl border border-red-500/20 bg-red-500/[0.06] p-4" role="alert">
                  <p className="text-sm text-red-200">{snapshotError}</p>
                  {selectedVersion !== null && <button type="button" onClick={() => void loadSnapshot(selectedVersion)} className="mt-3 text-sm font-medium text-red-100 underline underline-offset-4">Retry version</button>}
                </div>
              ) : snapshot ? (
                <div className="space-y-6">
                  <section aria-labelledby="preset-snapshot-title">
                    <h3 id="preset-snapshot-title" className="text-base font-semibold text-white">Version {snapshot.version} snapshot</h3>
                    <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                      <SnapshotItem label="Model" value={snapshot.model} mono />
                      <SnapshotItem label="Published" value={formatDate(snapshot.created_at)} />
                      <SnapshotItem label="Parameters" value={compactJson(snapshot.params)} pre />
                      <SnapshotItem label="Provider preferences" value={compactJson(snapshot.provider_prefs)} pre />
                      <SnapshotItem label="System prompt" value={snapshot.system_prompt || 'None'} pre />
                    </dl>
                  </section>

                  <section aria-labelledby="preset-diff-title">
                    <h3 id="preset-diff-title" className="text-base font-semibold text-white">
                      {previous ? `Changed from v${previous.version}` : 'First published version'}
                    </h3>
                    {previous ? (
                      <ul className="mt-3 space-y-2 text-sm text-neutral-300">
                        {changed(previous.model, snapshot.model) && <li>Model changed</li>}
                        {changed(previous.params, snapshot.params) && <li>Parameters changed</li>}
                        {changed(previous.system_prompt, snapshot.system_prompt) && <li>System prompt changed</li>}
                        {changed(previous.provider_prefs, snapshot.provider_prefs) && <li>Provider preferences changed</li>}
                        {!changed(previous.model, snapshot.model) && !changed(previous.params, snapshot.params) && !changed(previous.system_prompt, snapshot.system_prompt) && !changed(previous.provider_prefs, snapshot.provider_prefs) && <li>No configuration fields changed.</li>}
                      </ul>
                    ) : (
                      <p className="mt-3 text-sm text-neutral-500">This is the baseline snapshot for the preset.</p>
                    )}
                  </section>
                </div>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
    </DialogPortal>
  );
}

function SnapshotItem({ label, value, mono = false, pre = false }: { label: string; value: string; mono?: boolean; pre?: boolean }) {
  return (
    <div className={pre ? 'sm:col-span-2' : ''}>
      <dt className="text-xs font-medium uppercase tracking-wider text-neutral-600">{label}</dt>
      <dd className={`mt-1 rounded-lg border border-white/[0.06] bg-white/[0.03] p-2 text-sm text-neutral-200 ${mono || pre ? 'font-mono' : ''} ${pre ? 'max-h-44 overflow-auto whitespace-pre-wrap break-words' : ''}`}>{value}</dd>
    </div>
  );
}
