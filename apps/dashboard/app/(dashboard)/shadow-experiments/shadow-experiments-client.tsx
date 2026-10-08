'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, FlaskConical, Plus } from 'lucide-react';
import { ExperimentEditor } from '@/components/shadow-experiments/experiment-editor';
import { providerBadgeClass, providerDisplayName } from '@/lib/providers';
import {
  SAMPLE_RATE_MAX_PPM,
  deriveExperimentStatus,
  extractProxyError,
  formatMicrocentsAsUsd,
  formatSampleRatePercent,
  type ShadowExperimentRow,
  type ShadowExperimentStatus,
} from '@/lib/shadow-experiments';
import { TableSkeleton } from '@/components/ui/skeleton';
import { DialogPortal } from '@/components/ui/dialog-portal';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface ShadowExperimentsClientProps {
  canManage: boolean;
  demo: boolean;
  readOnlyReason: string;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'shadow_routing_disabled' }
  | { kind: 'error'; message: string; code: string | null }
  | { kind: 'ready'; experiments: ShadowExperimentRow[] };

type EditorState =
  | { mode: 'create' }
  | { mode: 'edit'; experiment: ShadowExperimentRow };

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isSampleRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= SAMPLE_RATE_MAX_PPM;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Fail-closed row guard: every field the renderers dereference must be present,
 * correctly typed, AND within the proxy's contracted range. A corrupt negative
 * or out-of-range value is rejected into the invalid-response error state
 * rather than rendered as a plausible zero (formatMicrocentsAsUsd clamps
 * negatives, which would otherwise mask corruption).
 */
function isRow(value: unknown): value is ShadowExperimentRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<ShadowExperimentRow>;
  const requiredStrings: unknown[] = [
    row.id, row.team_id, row.name, row.sampling_version, row.shadow_sampling_key_version,
    row.verifier_version, row.gate_fingerprint, row.funding_mode,
    row.source_provider, row.source_model, row.candidate_provider, row.candidate_model,
    row.created_at, row.updated_at,
  ];
  const nullables: unknown[] = [
    row.starts_at, row.ends_at, row.created_by, row.disabled_reason,
    row.kill_switch_at, row.approved_by, row.approved_at,
  ];
  const booleans: unknown[] = [
    row.enabled, row.consent_provider_ack, row.consent_region_ack, row.consent_privacy_ack,
  ];
  if (!requiredStrings.every(isString)) return false;
  if (!nullables.every(isStringOrNull)) return false;
  if (!booleans.every(isBoolean)) return false;
  if (!isSampleRate(row.sample_rate_ppm)) return false;
  if (!isNonNegativeInt(row.max_samples)) return false;
  if (!isPositiveInt(row.deadline_ms)) return false;
  if (!isPositiveInt(row.max_concurrency)) return false;
  if (!isNonNegativeInt(row.max_queue_count)) return false;
  if (!isNonNegativeInt(row.max_queue_bytes)) return false;
  if (!isPositiveInt(row.max_payload_bytes)) return false;
  if (!isNonNegativeInt(row.per_run_cap_microcents)) return false;
  if (!isNonNegativeInt(row.aggregate_cap_microcents)) return false;
  if (row.aggregate_cap_microcents < row.per_run_cap_microcents) return false;
  return true;
}

const STATUS_BADGE_CLASS: Record<ShadowExperimentStatus, string> = {
  killed: 'bg-red-500/10 text-red-400',
  quarantined: 'bg-amber-500/10 text-amber-400',
  enabled: 'bg-emerald-500/10 text-emerald-400',
  disabled: 'bg-neutral-500/10 text-neutral-400',
};

const STATUS_LABEL: Record<ShadowExperimentStatus, string> = {
  killed: 'Killed',
  quarantined: 'Quarantined',
  enabled: 'Enabled',
  disabled: 'Disabled',
};

export function ExperimentStatusBadge({ status }: { status: ShadowExperimentStatus }) {
  return (
    <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_CLASS[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

function ProviderBadge({ provider }: { provider: string }) {
  return (
    <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${providerBadgeClass(provider)}`}>
      {providerDisplayName(provider)}
    </span>
  );
}

function formatDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatWindow(row: ShadowExperimentRow): string {
  if (!row.starts_at && !row.ends_at) return '—';
  const start = row.starts_at ? formatDay(row.starts_at) : '…';
  const end = row.ends_at ? formatDay(row.ends_at) : '…';
  return `${start} → ${end}`;
}

function formatTimestampFull(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function ExpandedExperimentRow({ row }: { row: ShadowExperimentRow }) {
  return (
    <TableRow>
      <TableCell colSpan={9} className="whitespace-normal bg-white/[0.01] px-6 py-4">
        <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
          {/* Sampling & verifier */}
          <div className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">Sampling &amp; Verifier</h4>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-neutral-500">Sample rate</span>
                <span className="text-neutral-300">{formatSampleRatePercent(row.sample_rate_ppm)} ({row.sample_rate_ppm.toLocaleString()} ppm)</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500">Sampling version</span>
                <span className="font-mono text-neutral-300">{row.sampling_version}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500">Shadow sampling key version</span>
                <span className="font-mono text-neutral-300">{row.shadow_sampling_key_version}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500">Verifier version</span>
                <span className="font-mono text-neutral-300">{row.verifier_version}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="shrink-0 text-neutral-500">Gate fingerprint</span>
                <span className="break-all text-right font-mono text-xs text-neutral-400">{row.gate_fingerprint}</span>
              </div>
            </div>
          </div>

          {/* Execution bounds & spend */}
          <div className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">Bounds &amp; Spend</h4>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-neutral-500">Max samples</span>
                <span className="text-neutral-300">{row.max_samples.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500">Deadline</span>
                <span className="text-neutral-300">{row.deadline_ms.toLocaleString()}ms</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500">Max concurrency</span>
                <span className="text-neutral-300">{row.max_concurrency.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500">Max queue</span>
                <span className="text-neutral-300">{row.max_queue_count.toLocaleString()} runs / {row.max_queue_bytes.toLocaleString()} bytes</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500">Max payload</span>
                <span className="text-neutral-300">{row.max_payload_bytes.toLocaleString()} bytes</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500">Funding</span>
                <span className="font-mono text-xs text-neutral-300">{row.funding_mode}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500">Per-run cap</span>
                <span className="text-neutral-300">{formatMicrocentsAsUsd(row.per_run_cap_microcents)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500">Aggregate cap</span>
                <span className="text-neutral-300">{formatMicrocentsAsUsd(row.aggregate_cap_microcents)}</span>
              </div>
            </div>
          </div>

          {/* Consent & lifecycle (read-only) */}
          <div className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">Consent &amp; Lifecycle</h4>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-neutral-500">Provider ack</span>
                <span className="text-neutral-300">{row.consent_provider_ack ? 'Yes' : 'No'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500">Region ack</span>
                <span className="text-neutral-300">{row.consent_region_ack ? 'Yes' : 'No'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500">Privacy ack</span>
                <span className="text-neutral-300">{row.consent_privacy_ack ? 'Yes' : 'No'}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="shrink-0 text-neutral-500">Approved by</span>
                <span className="text-right text-neutral-300">{row.approved_by ?? '—'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500">Approved at</span>
                <span className="text-neutral-300">{formatTimestampFull(row.approved_at)}</span>
              </div>
              {row.disabled_reason && (
                <div className="flex justify-between gap-2">
                  <span className="shrink-0 text-neutral-500">Disabled reason</span>
                  {/* Verbatim — exact reasons are never collapsed. */}
                  <span className="break-words text-right font-mono text-xs text-amber-300">{row.disabled_reason}</span>
                </div>
              )}
              {row.kill_switch_at && (
                <div className="flex justify-between">
                  <span className="text-neutral-500">Kill switch at</span>
                  <span className="text-red-400">{formatTimestampFull(row.kill_switch_at)}</span>
                </div>
              )}
              <div className="flex justify-between gap-2">
                <span className="shrink-0 text-neutral-500">Created by</span>
                <span className="text-right text-neutral-300">{row.created_by ?? '—'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500">Updated</span>
                <span className="text-neutral-400">{formatTimestampFull(row.updated_at)}</span>
              </div>
            </div>
          </div>
        </div>

        <p className="mt-4 border-t border-white/[0.06] pt-3 text-xs text-neutral-600">
          Execution telemetry (shadow_runs) is not written yet — shadow execution (RSH-85 Phase 2) is on hold.
        </p>
      </TableCell>
    </TableRow>
  );
}

export function ShadowExperimentsClient({ canManage, demo, readOnlyReason }: ShadowExperimentsClientProps) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ShadowExperimentRow | null>(null);
  const [actionError, setActionError] = useState<{ message: string; code: string | null } | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const actionDialogRef = useRef<HTMLDivElement>(null);
  // Out-of-order load protection: only the latest request may write state.
  const requestSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const prevPendingDeleteRef = useRef<ShadowExperimentRow | null>(null);

  const loadExperiments = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // Keep data already on screen during a reload (subtle refresh); only the
    // initial load, when nothing has been fetched yet, shows the skeleton.
    setState((current) => (current.kind === 'ready' ? current : { kind: 'loading' }));

    try {
      const response = await fetch('/api/shadow-experiments', { cache: 'no-store', signal: controller.signal });
      const payload: unknown = await response.json().catch(() => null);
      if (seq !== requestSeqRef.current) return;
      const detail = extractProxyError(payload, 'Failed to load shadow experiments.');
      if (response.status === 404 && detail.code === 'shadow_routing_disabled') {
        setState({ kind: 'shadow_routing_disabled' });
        return;
      }
      if (!response.ok) {
        setState({ kind: 'error', message: detail.message, code: detail.code });
        return;
      }
      const rows = payload && typeof payload === 'object' ? (payload as { experiments?: unknown }).experiments : undefined;
      if (!Array.isArray(rows) || !rows.every(isRow)) {
        setState({ kind: 'error', message: 'Received an invalid shadow experiments response.', code: null });
        return;
      }
      setState({ kind: 'ready', experiments: rows });
    } catch (err) {
      if (seq !== requestSeqRef.current) return;
      if (err instanceof Error && err.name === 'AbortError') return;
      setState({ kind: 'error', message: 'Failed to load shadow experiments.', code: null });
    }
  }, []);

  useEffect(() => {
    if (!canManage) {
      setEditor(null);
      setPendingDelete(null);
      setActionError(null);
    }
    void loadExperiments();
    return () => {
      abortRef.current?.abort();
    };
  }, [canManage, loadExperiments]);

  // Focus the first actionable button only when the dialog opens (null → row),
  // not on every actionLoading flip while a delete is in flight.
  useEffect(() => {
    if (pendingDelete && !prevPendingDeleteRef.current) {
      actionDialogRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
    }
    prevPendingDeleteRef.current = pendingDelete;
  }, [pendingDelete]);

  useEffect(() => {
    if (!pendingDelete) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || actionLoading) return;
      event.preventDefault();
      setPendingDelete(null);
      setActionError(null);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [actionLoading, pendingDelete]);

  async function confirmDelete() {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setActionLoading(true);
    setActionError(null);
    try {
      const response = await fetch(`/api/shadow-experiments/${encodeURIComponent(target.id)}`, {
        method: 'DELETE',
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setActionError(extractProxyError(payload, 'Failed to delete experiment.'));
        return;
      }
      // Defense-in-depth: a success status must never carry an error envelope.
      if (payload && typeof payload === 'object' && (payload as { error?: unknown }).error != null) {
        setActionError(extractProxyError(payload, 'Failed to delete experiment.'));
        return;
      }
      setPendingDelete(null);
      await loadExperiments();
      window.setTimeout(() => headingRef.current?.focus(), 0);
    } catch {
      setActionError({ message: 'Network error — could not reach server', code: null });
    } finally {
      setActionLoading(false);
    }
  }

  return (
    <section className="space-y-6" aria-labelledby="shadow-experiments-heading">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 ref={headingRef} id="shadow-experiments-heading" tabIndex={-1} className="text-3xl font-bold text-white">
            Shadow Experiments
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-neutral-400">
            Shadow-routing experiments replay sampled production traffic against a candidate model for comparison.
          </p>
        </div>
        {canManage ? (
          <button
            type="button"
            onClick={() => { setPendingDelete(null); setEditor({ mode: 'create' }); }}
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white transition-all hover:bg-emerald-500 hover:shadow-lg hover:shadow-emerald-500/20"
          >
            <Plus className="h-4 w-4" />
            New experiment
          </button>
        ) : (
          <p className="rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-sm text-amber-200" role="status">
            {demo ? 'Demo mode — ' : ''}{readOnlyReason}
          </p>
        )}
      </div>

      {/* Truthful enablement state — no enable toggle exists anywhere. */}
      <p className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-xs text-neutral-500">
        Enablement is unavailable until the approved consent workflow exists (proxy code:{' '}
        <span className="font-mono text-neutral-400">shadow_enablement_unavailable</span>). Experiments are created
        disabled.
      </p>

      {state.kind === 'loading' && <TableSkeleton rows={6} cols={9} />}

      {state.kind === 'shadow_routing_disabled' && (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] py-16 text-center">
          <FlaskConical className="mx-auto mb-4 h-10 w-10 text-neutral-600" />
          <h3 className="mb-2 text-lg font-semibold text-white">Shadow routing is not enabled</h3>
          <p className="mx-auto max-w-md text-sm text-neutral-500">
            This surface is gated on the proxy <span className="font-mono">SHADOW_ROUTING_ENABLED</span> flag; once
            that flag is on, your team&apos;s experiments appear here.
          </p>
        </div>
      )}

      {state.kind === 'error' && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-5 py-4" role="alert">
          <p className="text-sm text-red-200">
            {state.message}
            {state.code && <span className="ml-2 font-mono text-xs text-red-300">{state.code}</span>}
          </p>
          <button
            type="button"
            onClick={() => void loadExperiments()}
            className="mt-3 text-sm font-medium text-red-100 underline decoration-red-400/40 underline-offset-4 hover:text-white"
          >
            Retry
          </button>
        </div>
      )}

      {state.kind === 'ready' && state.experiments.length === 0 && (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] px-5 py-14 text-center">
          <FlaskConical className="mx-auto mb-4 h-10 w-10 text-neutral-600" />
          <h3 className="text-lg font-semibold text-white">No shadow experiments yet</h3>
          <p className="mx-auto mt-2 max-w-md text-sm text-neutral-500">
            Create an experiment to compare a candidate model against sampled production traffic.
          </p>
          {canManage && (
            <button
              type="button"
              onClick={() => setEditor({ mode: 'create' })}
              className="mt-5 inline-flex h-9 items-center gap-1.5 rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white transition-all hover:bg-emerald-500"
            >
              <Plus className="h-4 w-4" />
              New experiment
            </button>
          )}
        </div>
      )}

      {state.kind === 'ready' && state.experiments.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-white/[0.06]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8"><span className="sr-only">Expand</span></TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Route</TableHead>
                <TableHead>Sample rate</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Caps</TableHead>
                <TableHead>Window</TableHead>
                <TableHead>Created</TableHead>
                <TableHead><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.experiments.map((row) => {
                const isExpanded = expandedId === row.id;
                const status = deriveExperimentStatus(row);
                return (
                  <Fragment key={row.id}>
                    <TableRow
                      onClick={() => setExpandedId(isExpanded ? null : row.id)}
                      className={`cursor-pointer ${isExpanded ? 'bg-white/[0.02]' : ''}`}
                    >
                      <TableCell className="text-neutral-500">
                        <button
                          type="button"
                          aria-label={`${isExpanded ? 'Collapse' : 'Expand'} experiment ${row.name}`}
                          aria-expanded={isExpanded}
                          onClick={(event) => {
                            event.stopPropagation();
                            setExpandedId(isExpanded ? null : row.id);
                          }}
                          className="rounded p-1 text-neutral-500 transition-colors hover:bg-white/[0.04] hover:text-neutral-300 focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
                        >
                          {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </button>
                      </TableCell>
                      <TableCell className="font-medium text-white">{row.name}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1.5 text-xs">
                          <ProviderBadge provider={row.source_provider} />
                          <span className="font-mono text-neutral-400">{row.source_model}</span>
                          <span className="text-neutral-600">→</span>
                          <ProviderBadge provider={row.candidate_provider} />
                          <span className="font-mono text-neutral-400">{row.candidate_model}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-neutral-300">{formatSampleRatePercent(row.sample_rate_ppm)}</TableCell>
                      <TableCell><ExperimentStatusBadge status={status} /></TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-neutral-400">
                        {formatMicrocentsAsUsd(row.per_run_cap_microcents)} / {formatMicrocentsAsUsd(row.aggregate_cap_microcents)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-neutral-400">{formatWindow(row)}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-neutral-500">{formatDay(row.created_at)}</TableCell>
                      <TableCell>
                        {canManage && (
                          <div className="flex items-center justify-end gap-3">
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                setPendingDelete(null);
                                setEditor({ mode: 'edit', experiment: row });
                              }}
                              aria-label={`Edit ${row.name}`}
                              className="text-sm font-medium text-emerald-400 hover:text-emerald-300"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                setEditor(null);
                                setActionError(null);
                                setPendingDelete(row);
                              }}
                              aria-label={`Delete ${row.name}`}
                              className="text-sm font-medium text-red-300 hover:text-red-200"
                            >
                              Delete
                            </button>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                    {isExpanded && <ExpandedExperimentRow key={`${row.id}-detail`} row={row} />}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {editor && canManage && (
        <ExperimentEditor
          key={editor.mode === 'edit' ? `edit:${editor.experiment.id}` : 'create'}
          mode={editor.mode}
          experiment={editor.mode === 'edit' ? editor.experiment : undefined}
          onClose={() => setEditor(null)}
          onSaved={loadExperiments}
        />
      )}

      {canManage && pendingDelete && (
        <DialogPortal>
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !actionLoading) {
              setPendingDelete(null);
              setActionError(null);
            }
          }}
        >
          <div
            ref={actionDialogRef}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="shadow-experiment-delete-title"
            className="w-full max-w-lg rounded-xl border border-red-500/20 bg-[#141416] p-5 shadow-2xl shadow-black/40"
          >
            <h3 id="shadow-experiment-delete-title" className="text-base font-semibold text-white">
              Delete {pendingDelete.name}?
            </h3>
            <p className="mt-2 text-sm text-neutral-300">
              This permanently deletes the experiment configuration. Shadow run telemetry is not written yet, so no
              execution history is lost.
            </p>
            {actionError && (
              <p className="mt-3 text-sm text-red-200" role="alert">
                {actionError.message}
                {actionError.code && <span className="ml-2 font-mono text-xs text-red-300">{actionError.code}</span>}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => { setPendingDelete(null); setActionError(null); }}
                disabled={actionLoading}
                className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-4 py-2 text-sm font-medium text-neutral-300 hover:bg-white/[0.06] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmDelete()}
                disabled={actionLoading}
                aria-label={`Confirm delete ${pendingDelete.name}`}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50"
              >
                {actionLoading ? 'Working…' : 'Delete experiment'}
              </button>
            </div>
          </div>
        </div>
        </DialogPortal>
      )}
    </section>
  );
}
