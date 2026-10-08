'use client';

/**
 * RSH-155 — create/edit form for shadow experiments.
 *
 * Forwards to the proxy's existing admin API via /api/shadow-experiments;
 * the proxy remains the trust boundary and re-validates everything here.
 *
 * Invariants preserved here:
 * - There is NO enable control. Experiments are created disabled server-side
 *   and enablement is refused by the proxy (409 shadow_enablement_unavailable)
 *   until the approved consent workflow exists.
 * - Identity/config fields (route, sampling versions, verifier reference) are
 *   fixed after creation: the proxy marks sampling versions immutable and the
 *   PATCH whitelist excludes the rest.
 * - Proxy rejection messages and codes are surfaced verbatim, never collapsed.
 * - Edit sends only changed mutable fields (PATCH semantics). A field counts as
 *   changed only when its draft string differs from the initial draft string,
 *   so untouched USD caps (prefilled via float division) never drift ±1
 *   microcent near MAX_SAFE_INTEGER and get silently re-sent.
 */
import { useRef, useState, type FormEvent } from 'react';
import { PROVIDERS } from '@routeshift/shared';
import { ModelAutocomplete } from '@/components/models/model-autocomplete';
import { CURRENT_MODELS } from '@/lib/current-models';
import { providerDisplayName } from '@/lib/providers';
import {
  EXPERIMENT_BOUND_RANGES,
  extractProxyError,
  isValidOptionalTimestamp,
  isValidUsdAmountInput,
  microcentsToUsdInput,
  percentToPpm,
  usdToMicrocents,
  validateExperimentBounds,
  type ExperimentBoundField,
  type ExperimentBoundsInput,
  type PatchShadowExperimentPayload,
  type ShadowExperimentRow,
} from '@/lib/shadow-experiments';

interface ExperimentEditorProps {
  mode: 'create' | 'edit';
  experiment?: ShadowExperimentRow;
  onClose: () => void;
  onSaved: () => Promise<void>;
}

interface ExperimentDraft {
  name: string;
  sourceProvider: string;
  sourceModel: string;
  candidateProvider: string;
  candidateModel: string;
  sampleRatePercent: string;
  samplingVersion: string;
  shadowSamplingKeyVersion: string;
  verifierVersion: string;
  gateFingerprint: string;
  maxSamples: string;
  deadlineMs: string;
  maxConcurrency: string;
  maxQueueCount: string;
  maxQueueBytes: string;
  maxPayloadBytes: string;
  perRunCapUsd: string;
  aggregateCapUsd: string;
  startsAt: string;
  endsAt: string;
}

// Derive defaults from the shared provider list rather than hardcoding, with a
// non-empty guard so an unexpected empty list still yields a usable value.
const DEFAULT_SOURCE_PROVIDER: string = PROVIDERS.length > 0 ? PROVIDERS[0] : 'openai';
const DEFAULT_CANDIDATE_PROVIDER: string = PROVIDERS.length > 1 ? PROVIDERS[1] : DEFAULT_SOURCE_PROVIDER;

function emptyDraft(): ExperimentDraft {
  return {
    name: '',
    sourceProvider: DEFAULT_SOURCE_PROVIDER,
    sourceModel: '',
    candidateProvider: DEFAULT_CANDIDATE_PROVIDER,
    candidateModel: '',
    sampleRatePercent: '',
    samplingVersion: '',
    shadowSamplingKeyVersion: '',
    verifierVersion: '',
    gateFingerprint: '',
    maxSamples: '',
    deadlineMs: '',
    maxConcurrency: '',
    maxQueueCount: '',
    maxQueueBytes: '',
    maxPayloadBytes: '',
    perRunCapUsd: '',
    aggregateCapUsd: '',
    startsAt: '',
    endsAt: '',
  };
}

function toDatetimeLocalValue(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  const base = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.getSeconds() !== 0 ? `${base}:${pad(date.getSeconds())}` : base;
}

function draftFromExperiment(experiment: ShadowExperimentRow): ExperimentDraft {
  return {
    name: experiment.name,
    sourceProvider: experiment.source_provider,
    sourceModel: experiment.source_model,
    candidateProvider: experiment.candidate_provider,
    candidateModel: experiment.candidate_model,
    sampleRatePercent: String(experiment.sample_rate_ppm / 10_000),
    samplingVersion: experiment.sampling_version,
    shadowSamplingKeyVersion: experiment.shadow_sampling_key_version,
    verifierVersion: experiment.verifier_version,
    gateFingerprint: experiment.gate_fingerprint,
    maxSamples: String(experiment.max_samples),
    deadlineMs: String(experiment.deadline_ms),
    maxConcurrency: String(experiment.max_concurrency),
    maxQueueCount: String(experiment.max_queue_count),
    maxQueueBytes: String(experiment.max_queue_bytes),
    maxPayloadBytes: String(experiment.max_payload_bytes),
    perRunCapUsd: microcentsToUsdInput(experiment.per_run_cap_microcents),
    aggregateCapUsd: microcentsToUsdInput(experiment.aggregate_cap_microcents),
    startsAt: toDatetimeLocalValue(experiment.starts_at),
    endsAt: toDatetimeLocalValue(experiment.ends_at),
  };
}

/**
 * Three-way parse of a datetime-local window field: 'unset' (empty), 'invalid'
 * (unparseable), or 'iso' (a valid ISO-with-timezone string). Collapsing empty
 * and invalid into one value previously made the validity check unreachable.
 */
type WindowTimestamp =
  | { kind: 'unset' }
  | { kind: 'invalid' }
  | { kind: 'iso'; value: string };

function parseWindowTimestamp(datetimeLocal: string): WindowTimestamp {
  if (!datetimeLocal) return { kind: 'unset' };
  const date = new Date(datetimeLocal);
  if (Number.isNaN(date.getTime())) return { kind: 'invalid' };
  const iso = date.toISOString();
  if (!isValidOptionalTimestamp(iso)) return { kind: 'invalid' };
  return { kind: 'iso', value: iso };
}

/** Parse a whole-number bound field; only decimal integers are accepted (no hex/exponent/decimals). */
function parseWholeNumber(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed === '') return NaN;
  if (!/^-?\d+$/.test(trimmed)) return NaN;
  return Number(trimmed);
}

/** The full create body the proxy's POST expects (all 18 required fields + optional window). */
interface CreateExperimentBody {
  name: string;
  source_provider: string;
  source_model: string;
  candidate_provider: string;
  candidate_model: string;
  sample_rate_ppm: number;
  sampling_version: string;
  shadow_sampling_key_version: string;
  verifier_version: string;
  gate_fingerprint: string;
  max_samples: number;
  deadline_ms: number;
  max_concurrency: number;
  max_queue_count: number;
  max_queue_bytes: number;
  max_payload_bytes: number;
  per_run_cap_microcents: number;
  aggregate_cap_microcents: number;
  starts_at?: string;
  ends_at?: string;
}

type BuildResult<T> = { ok: true; body: T } | { ok: false; message: string };

// Mutable integer execution bounds the form edits, with their input ids/labels.
const INTEGER_BOUND_FIELDS: Array<{ draftKey: keyof ExperimentDraft; field: ExperimentBoundField; label: string }> = [
  { draftKey: 'maxSamples', field: 'max_samples', label: 'Max samples' },
  { draftKey: 'deadlineMs', field: 'deadline_ms', label: 'Deadline (ms)' },
  { draftKey: 'maxConcurrency', field: 'max_concurrency', label: 'Max concurrency' },
  { draftKey: 'maxQueueCount', field: 'max_queue_count', label: 'Max queue count' },
  { draftKey: 'maxQueueBytes', field: 'max_queue_bytes', label: 'Max queue bytes' },
  { draftKey: 'maxPayloadBytes', field: 'max_payload_bytes', label: 'Max payload bytes' },
];

function boundRangeMessage(field: ExperimentBoundField): string {
  const range = EXPERIMENT_BOUND_RANGES[field];
  return `${field} must be a whole number between ${range.min.toLocaleString()} and ${range.max.toLocaleString()}.`;
}

/**
 * Parse one integer bound field, distinguishing an empty input ("is required")
 * from a malformed non-empty one ("must be a whole number between …"). Range
 * checking is left to `validateExperimentBounds` at the call site.
 */
function parseIntegerBound(
  raw: string,
  field: ExperimentBoundField,
  label: string,
): { ok: true; value: number } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, message: `${label} is required.` };
  const value = parseWholeNumber(trimmed);
  if (Number.isNaN(value)) return { ok: false, message: boundRangeMessage(field) };
  return { ok: true, value };
}

export function ExperimentEditor({ mode, experiment, onClose, onSaved }: ExperimentEditorProps) {
  const [draft, setDraft] = useState<ExperimentDraft>(() =>
    experiment ? draftFromExperiment(experiment) : emptyDraft(),
  );
  // Capture the draft as first rendered so edit can tell which fields the user
  // actually touched (string comparison — immune to float round-trip drift).
  const initialDraftRef = useRef<ExperimentDraft | null>(null);
  if (initialDraftRef.current === null) initialDraftRef.current = draft;

  const [error, setError] = useState<{ message: string; code: string | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const editing = mode === 'edit';
  const title = editing ? `Edit ${experiment?.name ?? 'experiment'}` : 'New shadow experiment';
  const submitLabel = editing ? 'Save changes' : 'Create experiment';

  function updateDraft<Key extends keyof ExperimentDraft>(key: Key, value: ExperimentDraft[Key]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function buildCreateBody(): BuildResult<CreateExperimentBody> {
    const requiredText: Array<[keyof ExperimentDraft, string]> = [
      ['name', 'Name'],
      ['sourceModel', 'Source model'],
      ['candidateModel', 'Candidate model'],
      ['samplingVersion', 'Sampling version'],
      ['shadowSamplingKeyVersion', 'Shadow sampling key version'],
      ['verifierVersion', 'Verifier version'],
      ['gateFingerprint', 'Gate fingerprint'],
    ];
    for (const [key, label] of requiredText) {
      if ((draft[key] as string).trim() === '') {
        return { ok: false, message: `${label} is required.` };
      }
    }

    const sampleRatePercent = Number(draft.sampleRatePercent);
    const sampleRatePpm = percentToPpm(sampleRatePercent);
    if (
      draft.sampleRatePercent.trim() === '' ||
      !Number.isFinite(sampleRatePercent) ||
      Math.abs(sampleRatePercent * 10_000 - sampleRatePpm) > 1e-6
    ) {
      return { ok: false, message: 'Sample rate must be a percentage; it is stored as whole ppm (0.0001% steps).' };
    }

    const bounds: Record<string, number> = { sample_rate_ppm: sampleRatePpm };
    for (const { draftKey, field, label } of INTEGER_BOUND_FIELDS) {
      const parsed = parseIntegerBound(draft[draftKey] as string, field, label);
      if (!parsed.ok) return { ok: false, message: parsed.message };
      bounds[field] = parsed.value;
    }

    // Spend caps are validated on the RAW INPUT STRING (decimal-only, ≤ 8
    // fractional digits) — never on float arithmetic, which falsely rejects
    // large amounts once usd × 1e8 loses precision.
    if (draft.perRunCapUsd.trim() === '') return { ok: false, message: 'Per-run cap (USD) is required.' };
    if (draft.aggregateCapUsd.trim() === '') return { ok: false, message: 'Aggregate cap (USD) is required.' };
    if (!isValidUsdAmountInput(draft.perRunCapUsd) || !isValidUsdAmountInput(draft.aggregateCapUsd)) {
      return { ok: false, message: 'Spend caps must be non-negative USD amounts (up to 8 decimal places).' };
    }
    bounds.per_run_cap_microcents = usdToMicrocents(draft.perRunCapUsd);
    bounds.aggregate_cap_microcents = usdToMicrocents(draft.aggregateCapUsd);

    const boundErrors = validateExperimentBounds(bounds);
    if (boundErrors.length > 0) return { ok: false, message: boundErrors.join(' ') };

    const startsAt = parseWindowTimestamp(draft.startsAt);
    const endsAt = parseWindowTimestamp(draft.endsAt);
    if (startsAt.kind === 'invalid' || endsAt.kind === 'invalid') {
      return { ok: false, message: 'Window timestamps must be valid ISO timestamps.' };
    }

    const body: CreateExperimentBody = {
      name: draft.name.trim(),
      source_provider: draft.sourceProvider,
      source_model: draft.sourceModel.trim(),
      candidate_provider: draft.candidateProvider,
      candidate_model: draft.candidateModel.trim(),
      sample_rate_ppm: sampleRatePpm,
      sampling_version: draft.samplingVersion.trim(),
      shadow_sampling_key_version: draft.shadowSamplingKeyVersion.trim(),
      verifier_version: draft.verifierVersion.trim(),
      gate_fingerprint: draft.gateFingerprint.trim(),
      max_samples: bounds.max_samples,
      deadline_ms: bounds.deadline_ms,
      max_concurrency: bounds.max_concurrency,
      max_queue_count: bounds.max_queue_count,
      max_queue_bytes: bounds.max_queue_bytes,
      max_payload_bytes: bounds.max_payload_bytes,
      per_run_cap_microcents: bounds.per_run_cap_microcents,
      aggregate_cap_microcents: bounds.aggregate_cap_microcents,
    };
    if (startsAt.kind === 'iso') body.starts_at = startsAt.value;
    if (endsAt.kind === 'iso') body.ends_at = endsAt.value;
    return { ok: true, body };
  }

  function buildPatchBody(): BuildResult<PatchShadowExperimentPayload> {
    if (!experiment) return { ok: false, message: 'No experiment to edit.' };

    const initial = initialDraftRef.current ?? draft;

    // PATCH sends only changed mutable fields, and ONLY changed fields are
    // validated — a stored immutable field the dashboard cannot edit (e.g. an
    // empty sampling_version left by another path) must never lock the user
    // out of a rename. "Changed" means the draft string differs from the
    // initial draft string, which keeps untouched USD caps from drifting ±1
    // microcent and being re-sent. `enabled` is never editable.
    const body: PatchShadowExperimentPayload = {};

    if (draft.name.trim() !== initial.name.trim()) {
      if (draft.name.trim() === '') return { ok: false, message: 'Name is required.' };
      body.name = draft.name.trim();
    }

    if (draft.sampleRatePercent !== initial.sampleRatePercent) {
      const sampleRatePercent = Number(draft.sampleRatePercent);
      const sampleRatePpm = percentToPpm(sampleRatePercent);
      if (
        draft.sampleRatePercent.trim() === '' ||
        !Number.isFinite(sampleRatePercent) ||
        Math.abs(sampleRatePercent * 10_000 - sampleRatePpm) > 1e-6
      ) {
        return { ok: false, message: 'Sample rate must be a percentage; it is stored as whole ppm (0.0001% steps).' };
      }
      const rateErrors = validateExperimentBounds({ sample_rate_ppm: sampleRatePpm });
      if (rateErrors.length > 0) return { ok: false, message: rateErrors.join(' ') };
      body.sample_rate_ppm = sampleRatePpm;
    }

    for (const { draftKey, field, label } of INTEGER_BOUND_FIELDS) {
      if ((draft[draftKey] as string) === (initial[draftKey] as string)) continue;
      const parsed = parseIntegerBound(draft[draftKey] as string, field, label);
      if (!parsed.ok) return { ok: false, message: parsed.message };
      const rangeErrors = validateExperimentBounds({ [field]: parsed.value } as ExperimentBoundsInput);
      if (rangeErrors.length > 0) return { ok: false, message: rangeErrors.join(' ') };
      (body as Record<string, unknown>)[field] = parsed.value;
    }

    if (draft.perRunCapUsd !== initial.perRunCapUsd) {
      if (!isValidUsdAmountInput(draft.perRunCapUsd)) {
        return { ok: false, message: 'Spend caps must be non-negative USD amounts (up to 8 decimal places).' };
      }
      const perRun = usdToMicrocents(draft.perRunCapUsd);
      const capErrors = validateExperimentBounds({ per_run_cap_microcents: perRun });
      if (capErrors.length > 0) return { ok: false, message: capErrors.join(' ') };
      body.per_run_cap_microcents = perRun;
    }
    if (draft.aggregateCapUsd !== initial.aggregateCapUsd) {
      if (!isValidUsdAmountInput(draft.aggregateCapUsd)) {
        return { ok: false, message: 'Spend caps must be non-negative USD amounts (up to 8 decimal places).' };
      }
      const aggregate = usdToMicrocents(draft.aggregateCapUsd);
      const capErrors = validateExperimentBounds({ aggregate_cap_microcents: aggregate });
      if (capErrors.length > 0) return { ok: false, message: capErrors.join(' ') };
      body.aggregate_cap_microcents = aggregate;
    }

    // Enforce aggregate >= per_run only when a cap is actually being changed.
    // A stored row whose caps already violate the contract is quarantined by the
    // proxy, not deleted — re-validating untouched caps would lock out every
    // other edit (e.g. a pure rename). When a cap IS changing, compare it
    // against the other cap's changed-or-prefilled value.
    if (body.per_run_cap_microcents !== undefined || body.aggregate_cap_microcents !== undefined) {
      const effectivePerRun = body.per_run_cap_microcents ?? usdToMicrocents(draft.perRunCapUsd);
      const effectiveAggregate = body.aggregate_cap_microcents ?? usdToMicrocents(draft.aggregateCapUsd);
      if (Number.isFinite(effectivePerRun) && Number.isFinite(effectiveAggregate) && effectiveAggregate < effectivePerRun) {
        return { ok: false, message: 'aggregate_cap_microcents must be >= per_run_cap_microcents' };
      }
    }

    const startsAt = parseWindowTimestamp(draft.startsAt);
    const endsAt = parseWindowTimestamp(draft.endsAt);
    if (startsAt.kind === 'invalid' || endsAt.kind === 'invalid') {
      return { ok: false, message: 'Window timestamps must be valid ISO timestamps.' };
    }
    const startsAtIso = startsAt.kind === 'iso' ? startsAt.value : null;
    const endsAtIso = endsAt.kind === 'iso' ? endsAt.value : null;
    if (!sameInstant(startsAtIso, experiment.starts_at)) body.starts_at = startsAtIso;
    if (!sameInstant(endsAtIso, experiment.ends_at)) body.ends_at = endsAtIso;

    if (Object.keys(body).length === 0) {
      return { ok: false, message: 'No changes to save.' };
    }
    return { ok: true, body };
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const built = editing ? buildPatchBody() : buildCreateBody();
    if (!built.ok) {
      setError({ message: built.message, code: null });
      return;
    }

    setSaving(true);
    try {
      const response = await fetch(
        editing ? `/api/shadow-experiments/${encodeURIComponent(experiment!.id)}` : '/api/shadow-experiments',
        {
          method: editing ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(built.body),
        },
      );
      const payload: unknown = await response.json().catch(() => null);
      const failureMessage = editing ? 'Failed to update experiment.' : 'Failed to create experiment.';
      if (!response.ok) {
        setError(extractProxyError(payload, failureMessage));
        return;
      }
      // Defense-in-depth: a success status must never carry an error envelope.
      if (payload && typeof payload === 'object' && (payload as { error?: unknown }).error != null) {
        setError(extractProxyError(payload, failureMessage));
        return;
      }
      await onSaved();
      onClose();
    } catch {
      setError({ message: 'Network error — could not reach server', code: null });
    } finally {
      setSaving(false);
    }
  }

  const inputClasses =
    'w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2.5 text-sm text-white placeholder-neutral-600 outline-none transition-colors focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20 disabled:cursor-not-allowed disabled:text-neutral-500';
  const selectClasses =
    'w-full appearance-none bg-white/[0.05] border border-white/[0.1] rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500/50 cursor-pointer disabled:cursor-not-allowed disabled:text-neutral-500';
  const labelClasses = 'text-sm font-medium text-neutral-300';
  const hintClasses = 'text-xs text-neutral-600';

  return (
    <form
      aria-label={`${editing ? 'Edit' : 'Create'} shadow experiment form`}
      onSubmit={handleSubmit}
      className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-5"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-lg font-semibold text-white">{title}</h3>
          <p className="mt-1 text-sm text-neutral-500">
            {editing
              ? 'Only mutable bounds, the name, and the window can change after creation.'
              : 'Experiments are created disabled; the proxy validates every bound below.'}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={saving}
          className="text-sm text-neutral-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          Cancel
        </button>
      </div>

      {/* Identity */}
      <div className="mt-5 space-y-1.5">
        <label htmlFor="experiment-name" className={labelClasses}>Name</label>
        <input
          id="experiment-name"
          value={draft.name}
          onChange={(event) => updateDraft('name', event.target.value)}
          placeholder={`e.g. Candidate eval: ${CURRENT_MODELS.default} vs ${CURRENT_MODELS.coding}`}
          className={inputClasses}
        />
      </div>

      {/* Route — fixed after creation */}
      <fieldset className="mt-5 rounded-lg border border-white/[0.06] p-4">
        <legend className="px-1 text-sm font-medium text-neutral-300">Route</legend>
        {editing && <p className={hintClasses}>Fixed after creation.</p>}
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="experiment-source-provider" className={labelClasses}>Source provider</label>
            <select
              id="experiment-source-provider"
              value={draft.sourceProvider}
              onChange={(event) => updateDraft('sourceProvider', event.target.value)}
              disabled={editing}
              className={selectClasses}
            >
              {PROVIDERS.map((provider) => (
                <option key={provider} value={provider}>{providerDisplayName(provider)}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="experiment-source-model" className={labelClasses}>Source model</label>
            <ModelAutocomplete
              id="experiment-source-model"
              value={draft.sourceModel}
              onChange={(model) => updateDraft('sourceModel', model)}
              placeholder={`e.g. ${CURRENT_MODELS.default}`}
              disabled={editing}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="experiment-candidate-provider" className={labelClasses}>Candidate provider</label>
            <select
              id="experiment-candidate-provider"
              value={draft.candidateProvider}
              onChange={(event) => updateDraft('candidateProvider', event.target.value)}
              disabled={editing}
              className={selectClasses}
            >
              {PROVIDERS.map((provider) => (
                <option key={provider} value={provider}>{providerDisplayName(provider)}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="experiment-candidate-model" className={labelClasses}>Candidate model</label>
            <ModelAutocomplete
              id="experiment-candidate-model"
              value={draft.candidateModel}
              onChange={(model) => updateDraft('candidateModel', model)}
              placeholder={`e.g. ${CURRENT_MODELS.coding}`}
              disabled={editing}
            />
          </div>
        </div>
      </fieldset>

      {/* Sampling + verifier references — versions/fingerprint fixed, rate editable */}
      <fieldset className="mt-5 rounded-lg border border-white/[0.06] p-4">
        <legend className="px-1 text-sm font-medium text-neutral-300">Sampling &amp; verifier</legend>
        {editing && (
          <p className={hintClasses}>
            Versions and fingerprint are fixed after creation; the sample rate stays editable.
          </p>
        )}
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="experiment-sample-rate" className={labelClasses}>Sample rate (%)</label>
            <input
              id="experiment-sample-rate"
              type="number"
              min={0}
              max={100}
              step="any"
              value={draft.sampleRatePercent}
              onChange={(event) => updateDraft('sampleRatePercent', event.target.value)}
              placeholder="e.g. 5"
              className={inputClasses}
            />
            <p className={hintClasses}>Stored as ppm: 5% = 50,000 ppm. 0.0001% steps.</p>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="experiment-sampling-version" className={labelClasses}>Sampling version</label>
            <input
              id="experiment-sampling-version"
              value={draft.samplingVersion}
              onChange={(event) => updateDraft('samplingVersion', event.target.value)}
              disabled={editing}
              placeholder="e.g. v1"
              className={inputClasses}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="experiment-shadow-key-version" className={labelClasses}>Shadow sampling key version</label>
            <input
              id="experiment-shadow-key-version"
              value={draft.shadowSamplingKeyVersion}
              onChange={(event) => updateDraft('shadowSamplingKeyVersion', event.target.value)}
              disabled={editing}
              placeholder="e.g. key-v1"
              className={inputClasses}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="experiment-verifier-version" className={labelClasses}>Verifier version</label>
            <input
              id="experiment-verifier-version"
              value={draft.verifierVersion}
              onChange={(event) => updateDraft('verifierVersion', event.target.value)}
              disabled={editing}
              placeholder="e.g. rsh72-v1"
              className={inputClasses}
            />
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <label htmlFor="experiment-gate-fingerprint" className={labelClasses}>Gate fingerprint</label>
            <input
              id="experiment-gate-fingerprint"
              value={draft.gateFingerprint}
              onChange={(event) => updateDraft('gateFingerprint', event.target.value)}
              disabled={editing}
              placeholder="e.g. sha256:ab12…"
              className={inputClasses + ' font-mono'}
            />
          </div>
        </div>
      </fieldset>

      {/* Execution bounds */}
      <fieldset className="mt-5 rounded-lg border border-white/[0.06] p-4">
        <legend className="px-1 text-sm font-medium text-neutral-300">Execution bounds</legend>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <NumberField id="experiment-max-samples" label="Max samples" value={draft.maxSamples} onChange={(value) => updateDraft('maxSamples', value)} hint="0 – 2,147,483,647" />
          <NumberField id="experiment-deadline-ms" label="Deadline (ms)" value={draft.deadlineMs} onChange={(value) => updateDraft('deadlineMs', value)} hint="1 – 2,147,483,647" />
          <NumberField id="experiment-max-concurrency" label="Max concurrency" value={draft.maxConcurrency} onChange={(value) => updateDraft('maxConcurrency', value)} hint="1 – 2,147,483,647" />
          <NumberField id="experiment-max-queue-count" label="Max queue count" value={draft.maxQueueCount} onChange={(value) => updateDraft('maxQueueCount', value)} hint="0 – 2,147,483,647" />
          <NumberField id="experiment-max-queue-bytes" label="Max queue bytes" value={draft.maxQueueBytes} onChange={(value) => updateDraft('maxQueueBytes', value)} hint="0 – 2,147,483,647" />
          <NumberField id="experiment-max-payload-bytes" label="Max payload bytes" value={draft.maxPayloadBytes} onChange={(value) => updateDraft('maxPayloadBytes', value)} hint="1 – 2,147,483,647" />
        </div>
      </fieldset>

      {/* Spend caps (USD input, submitted as microcents) */}
      <fieldset className="mt-5 rounded-lg border border-white/[0.06] p-4">
        <legend className="px-1 text-sm font-medium text-neutral-300">Spend caps</legend>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="experiment-per-run-cap" className={labelClasses}>Per-run cap (USD)</label>
            <input
              id="experiment-per-run-cap"
              type="number"
              min={0}
              step="any"
              value={draft.perRunCapUsd}
              onChange={(event) => updateDraft('perRunCapUsd', event.target.value)}
              placeholder="e.g. 0.50"
              className={inputClasses}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="experiment-aggregate-cap" className={labelClasses}>Aggregate cap (USD)</label>
            <input
              id="experiment-aggregate-cap"
              type="number"
              min={0}
              step="any"
              value={draft.aggregateCapUsd}
              onChange={(event) => updateDraft('aggregateCapUsd', event.target.value)}
              placeholder="e.g. 50.00"
              className={inputClasses}
            />
            <p className={hintClasses}>Must be at least the per-run cap. Submitted as microcents (USD × 100,000,000).</p>
          </div>
        </div>
      </fieldset>

      {/* Window (optional) */}
      <fieldset className="mt-5 rounded-lg border border-white/[0.06] p-4">
        <legend className="px-1 text-sm font-medium text-neutral-300">Window (optional)</legend>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="experiment-starts-at" className={labelClasses}>Starts at</label>
            <input
              id="experiment-starts-at"
              type="datetime-local"
              step={1}
              value={draft.startsAt}
              onChange={(event) => updateDraft('startsAt', event.target.value)}
              className={inputClasses}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="experiment-ends-at" className={labelClasses}>Ends at</label>
            <input
              id="experiment-ends-at"
              type="datetime-local"
              step={1}
              value={draft.endsAt}
              onChange={(event) => updateDraft('endsAt', event.target.value)}
              className={inputClasses}
            />
          </div>
        </div>
      </fieldset>

      {/* Truthful enablement state — there is no enable control by design. */}
      <p className="mt-5 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-xs text-neutral-500">
        Enablement is unavailable until the approved consent workflow exists (proxy code:{' '}
        <span className="font-mono text-neutral-400">shadow_enablement_unavailable</span>). New experiments are
        created disabled.
      </p>

      {error && (
        <p className="mt-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-200" role="alert">
          {error.message}
          {error.code && <span className="ml-2 font-mono text-xs text-red-300">{error.code}</span>}
        </p>
      )}

      <div className="mt-5 flex justify-end gap-3">
        <button
          type="button"
          onClick={onClose}
          disabled={saving}
          className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-4 py-2 text-sm font-medium text-neutral-300 transition-colors hover:bg-white/[0.06] disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
        >
          {saving ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  );
}

/**
 * True when the draft's window value is unchanged from the stored experiment.
 * The stored value is normalized through the same prefill round-trip the draft
 * uses (datetime-local truncates to whole seconds), so an untouched field is
 * exactly stable while ANY user edit — including the sub-second change the old
 * 1s tolerance silently masked — is detected. No tolerance window.
 */
function sameInstant(next: string | null, currentStored: string | null): boolean {
  const currentIso = normalizeStoredTimestamp(currentStored);
  if (next === null && currentIso === null) return true;
  if (next === null || currentIso === null) return false;
  return next === currentIso;
}

function normalizeStoredTimestamp(iso: string | null): string | null {
  const datetimeLocal = toDatetimeLocalValue(iso);
  if (!datetimeLocal) return null;
  const date = new Date(datetimeLocal);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function NumberField({ id, label, value, onChange, hint }: { id: string; label: string; value: string; onChange: (value: string) => void; hint?: string }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium text-neutral-300">{label}</label>
      <input
        id={id}
        type="number"
        step="1"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-sm text-white placeholder-neutral-600 outline-none focus:border-emerald-500/50"
      />
      {hint && <p className="text-xs text-neutral-600">{hint}</p>}
    </div>
  );
}
