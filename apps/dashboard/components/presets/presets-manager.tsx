'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { PresetEditor, type Preset } from '@/components/presets/preset-editor';
import { VersionHistoryDrawer } from '@/components/presets/version-history-drawer';
import { useDialogA11y } from '@/lib/use-dialog-a11y';
import { DialogPortal } from '@/components/ui/dialog-portal';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface PresetsManagerProps {
  canManage: boolean;
  demo: boolean;
  readOnlyReason: string;
}

type EditorState =
  | { mode: 'create' }
  | { mode: 'edit'; preset: Preset; enableOnPublish?: boolean };

type PendingAction = { kind: 'disable' | 'delete'; preset: Preset };

function responseError(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback;
  const error = (payload as { error?: unknown }).error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return fallback;
}

function isPreset(value: unknown): value is Preset {
  if (!value || typeof value !== 'object') return false;
  const preset = value as Partial<Preset>;
  return typeof preset.slug === 'string'
    && typeof preset.version === 'number'
    && typeof preset.model === 'string'
    && typeof preset.enabled === 'boolean';
}

function cacheInvalidationWarning(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const result = payload as {
    proxy_cache_invalidated?: unknown;
    proxy_cache_error?: unknown;
    cache_ttl_seconds?: unknown;
  };
  if (result.proxy_cache_invalidated !== false || result.proxy_cache_error !== 'proxy_cache_invalidation_failed') {
    return null;
  }
  const ttl = typeof result.cache_ttl_seconds === 'number' && Number.isFinite(result.cache_ttl_seconds) && result.cache_ttl_seconds > 0
    ? ` for up to ${result.cache_ttl_seconds} seconds`
    : ' until the cache expires';
  return `Preset change was saved, but proxy cache invalidation failed. New requests may use the prior preset${ttl} (proxy_cache_invalidation_failed).`;
}

export function PresetsManager({ canManage, demo, readOnlyReason }: PresetsManagerProps) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [cacheWarning, setCacheWarning] = useState<string | null>(null);
  const [historySlug, setHistorySlug] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const historyTriggerRef = useRef<HTMLButtonElement>(null);
  const actionTriggerRef = useRef<HTMLButtonElement>(null);
  const actionDialogRef = useRef<HTMLDivElement>(null);

  useDialogA11y(actionDialogRef, pendingAction !== null);

  const loadPresets = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/presets', { cache: 'no-store' });
      const payload: unknown = await response.json();
      if (!response.ok) {
        throw new Error(responseError(payload, 'Failed to load presets.'));
      }
      const rows = payload && typeof payload === 'object' ? (payload as { presets?: unknown }).presets : undefined;
      if (!Array.isArray(rows) || !rows.every(isPreset)) {
        throw new Error('Received an invalid presets response.');
      }
      setPresets(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load presets.');
      setPresets([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!canManage) {
      setEditor(null);
      setPendingAction(null);
      setActionError(null);
    }
    if (demo) setHistorySlug(null);
    void loadPresets();
  }, [canManage, demo, loadPresets]);

  useEffect(() => {
    if (!pendingAction) return;
    actionDialogRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || actionLoading) return;
      event.preventDefault();
      dismissPendingAction();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [actionLoading, pendingAction]);

  function openCreate() {
    dismissPendingAction(false);
    setEditor({ mode: 'create' });
  }

  function openEditor(next: EditorState) {
    dismissPendingAction(false);
    setEditor(next);
  }

  function openPendingAction(kind: PendingAction['kind'], preset: Preset, trigger: HTMLButtonElement) {
    actionTriggerRef.current = trigger;
    setEditor(null);
    setActionError(null);
    setPendingAction({ kind, preset });
  }

  function dismissPendingAction(restoreFocus = true) {
    setPendingAction(null);
    setActionError(null);
    if (restoreFocus) window.setTimeout(() => actionTriggerRef.current?.focus(), 0);
  }

  function closeHistory() {
    setHistorySlug(null);
    window.setTimeout(() => historyTriggerRef.current?.focus(), 0);
  }

  async function confirmAction() {
    if (!pendingAction) return;
    const { kind, preset } = pendingAction;
    setActionLoading(true);
    setActionError(null);
    try {
      const response = await fetch(
        `/api/presets/${encodeURIComponent(preset.slug)}${kind === 'disable' ? '?disable=true' : ''}`,
        { method: 'DELETE' },
      );
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setActionError(responseError(payload, kind === 'disable' ? 'Failed to disable preset.' : 'Failed to delete preset.'));
        return;
      }
      setCacheWarning(cacheInvalidationWarning(payload));
      dismissPendingAction(false);
      await loadPresets();
      window.setTimeout(() => headingRef.current?.focus(), 0);
    } catch {
      setActionError('Network error — could not reach server');
    } finally {
      setActionLoading(false);
    }
  }

  return (
    <section className="space-y-6" aria-labelledby="presets-heading">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 ref={headingRef} id="presets-heading" tabIndex={-1} className="text-3xl font-bold text-white">Presets</h2>
          <p className="mt-1 max-w-2xl text-sm text-neutral-400">
            Versioned request defaults for the models, parameters, prompts, and provider preferences your team uses.
          </p>
        </div>
        {canManage ? (
          <button
            type="button"
            onClick={openCreate}
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white transition-all hover:bg-emerald-500 hover:shadow-lg hover:shadow-emerald-500/20"
          >
            <Plus className="h-4 w-4" />
            Create preset
          </button>
        ) : (
          <p className="rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-sm text-amber-200" role="status">
            {demo ? 'Demo mode — ' : ''}{readOnlyReason}
          </p>
        )}
      </div>

      {cacheWarning && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-4 py-3 text-sm text-amber-100" role="status">
          {cacheWarning}
        </div>
      )}

      {loading ? (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] px-5 py-10 text-sm text-neutral-500">
          Loading presets…
        </div>
      ) : error ? (
        <div className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-5 py-4" role="alert">
          <p className="text-sm text-red-200">{error}</p>
          <button
            type="button"
            onClick={() => void loadPresets()}
            className="mt-3 text-sm font-medium text-red-100 underline decoration-red-400/40 underline-offset-4 hover:text-white"
          >
            Retry
          </button>
        </div>
      ) : presets.length === 0 ? (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] px-5 py-14 text-center">
          <h3 className="text-lg font-semibold text-white">No presets yet</h3>
          <p className="mx-auto mt-2 max-w-md text-sm text-neutral-500">
            Create a versioned preset to keep application request defaults consistent.
          </p>
          {canManage && (
            <button
              type="button"
              onClick={openCreate}
              className="mt-5 inline-flex h-9 items-center gap-1.5 rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white transition-all hover:bg-emerald-500"
            >
              <Plus className="h-4 w-4" />
              Create preset
            </button>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-white/[0.06]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Preset</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {presets.map((preset) => (
                <TableRow key={preset.slug}>
                  <TableCell className="font-mono text-sm font-medium text-white">{preset.slug}</TableCell>
                  <TableCell className="font-mono text-xs text-neutral-300">{preset.model}</TableCell>
                  <TableCell><span className="text-sm text-neutral-300">v{preset.version}</span></TableCell>
                  <TableCell>
                    <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${
                      preset.enabled ? 'bg-emerald-500/10 text-emerald-400' : 'bg-neutral-500/10 text-neutral-400'
                    }`}>
                      {preset.enabled ? 'Enabled' : 'Disabled'}
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-neutral-500">
                    {formatUpdatedAt(preset.updated_at)}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-3">
                      <button
                        type="button"
                        onClick={(event) => {
                          historyTriggerRef.current = event.currentTarget;
                          setHistorySlug(preset.slug);
                        }}
                        aria-label={`View history for ${preset.slug}`}
                        className="text-sm font-medium text-neutral-300 hover:text-white"
                      >
                        History
                      </button>
                      {canManage && (
                        <>
                        <button
                          type="button"
                          onClick={() => openEditor({ mode: 'edit', preset })}
                          aria-label={`Edit ${preset.slug}`}
                          className="text-sm font-medium text-emerald-400 hover:text-emerald-300"
                        >
                          Edit
                        </button>
                        {preset.enabled ? (
                          <button
                            type="button"
                            onClick={(event) => openPendingAction('disable', preset, event.currentTarget)}
                            aria-label={`Disable ${preset.slug}`}
                            className="text-sm font-medium text-amber-300 hover:text-amber-200"
                          >
                            Disable
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => openEditor({ mode: 'edit', preset, enableOnPublish: true })}
                            aria-label={`Enable and publish ${preset.slug} version ${preset.version + 1}`}
                            className="text-sm font-medium text-emerald-400 hover:text-emerald-300"
                          >
                            Enable &amp; publish v{preset.version + 1}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={(event) => openPendingAction('delete', preset, event.currentTarget)}
                          aria-label={`Delete ${preset.slug}`}
                          className="text-sm font-medium text-red-300 hover:text-red-200"
                        >
                          Delete
                        </button>
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {editor && canManage && (
        <PresetEditor
          key={editor.mode === 'edit' ? `edit:${editor.preset.slug}:${editor.enableOnPublish ? 'enable' : 'publish'}` : 'create'}
          mode={editor.mode}
          preset={editor.mode === 'edit' ? editor.preset : undefined}
          enableOnPublish={editor.mode === 'edit' && editor.enableOnPublish}
          onClose={() => setEditor(null)}
          onSaved={async (payload) => {
            setCacheWarning(cacheInvalidationWarning(payload));
            await loadPresets();
          }}
        />
      )}

      {historySlug && <VersionHistoryDrawer slug={historySlug} onClose={closeHistory} />}

      {canManage && pendingAction && (
        <DialogPortal>
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !actionLoading) dismissPendingAction();
          }}
        >
          <div
            ref={actionDialogRef}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="preset-action-title"
            className="w-full max-w-lg rounded-xl border border-amber-500/20 bg-[#141416] p-5 shadow-2xl shadow-black/40"
          >
            <h3 id="preset-action-title" className="text-base font-semibold text-white">
              {pendingAction.kind === 'disable' ? `Disable ${pendingAction.preset.slug}?` : `Delete ${pendingAction.preset.slug}?`}
            </h3>
            <p className="mt-2 text-sm text-neutral-300">
              {pendingAction.kind === 'disable'
                ? 'New requests stop resolving this preset after proxy cache invalidation. Disabling does not publish a new version.'
                : 'This permanently deletes the preset and its immutable version history.'}
            </p>
            {actionError && <p className="mt-3 text-sm text-red-200" role="alert">{actionError}</p>}
            <div className="mt-4 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => dismissPendingAction()}
                disabled={actionLoading}
                className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-4 py-2 text-sm font-medium text-neutral-300 hover:bg-white/[0.06] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmAction()}
                disabled={actionLoading}
                aria-label={`Confirm ${pendingAction.kind} ${pendingAction.preset.slug}`}
                className={`rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${
                  pendingAction.kind === 'disable' ? 'bg-amber-600 hover:bg-amber-500' : 'bg-red-600 hover:bg-red-500'
                }`}
              >
                {actionLoading ? 'Working…' : pendingAction.kind === 'disable' ? 'Disable preset' : 'Delete preset'}
              </button>
            </div>
          </div>
        </div>
        </DialogPortal>
      )}
    </section>
  );
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
