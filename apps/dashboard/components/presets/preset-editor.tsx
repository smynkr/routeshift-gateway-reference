'use client';

import { useState, type FormEvent } from 'react';
import { EFFECTIVE_DISPATCHABLE_CHAT_MODELS, MAX_JURISDICTION_CODES, PROVIDERS, applyProviderPreferences, getModelEndpoints, parseModelSuffixes, parseProviderPreferences } from '@routeshift/shared';
import type { ProviderPreferences } from '@routeshift/shared';
import { REASONING_EFFORTS, THINKING_LEVELS, validateReasoningParams } from '@/lib/reasoning-params';
import { ModelAutocomplete } from '@/components/models/model-autocomplete';

export interface Preset {
  slug: string;
  version: number;
  model: string;
  params: unknown;
  system_prompt: string | null;
  provider_prefs: unknown;
  enabled: boolean;
  updated_at: string;
}

interface PresetEditorProps {
  mode: 'create' | 'edit';
  preset?: Preset;
  enableOnPublish?: boolean;
  onClose: () => void;
  onSaved: (payload: unknown) => Promise<void>;
}

interface PresetDraft {
  slug: string;
  model: string;
  temperature: string;
  maxTokens: string;
  topP: string;
  frequencyPenalty: string;
  presencePenalty: string;
  stop: string;
  reasoningEffort: string;
  thinkingLevel: string;
  thinkingBudgetTokens: string;
  systemPrompt: string;
  order: string;
  allow: string;
  deny: string;
  dataResidency: string;
  dataCollection: '' | 'allow' | 'deny';
  sort: '' | 'price' | 'throughput';
  fallbackBehavior: 'default' | 'allow' | 'deny';
  enabled: boolean;
}

type BuildResult<T> = { ok: true; value: T } | { ok: false; error: string };

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CANONICAL_MODELS = new Set(EFFECTIVE_DISPATCHABLE_CHAT_MODELS.map((model) => model.canonical_name));

function isSupportedPresetModel(model: string): boolean {
  if (CANONICAL_MODELS.has(model)) return true;
  const parsed = parseModelSuffixes(model);
  return parsed.ok && CANONICAL_MODELS.has(parsed.model);
}

function getRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function getText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function getNumberText(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

function getListText(value: unknown): string {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) return '';
  return value.join(', ');
}

function emptyDraft(): PresetDraft {
  return {
    slug: '',
    model: '',
    temperature: '',
    maxTokens: '',
    topP: '',
    frequencyPenalty: '',
    presencePenalty: '',
    stop: '',
    reasoningEffort: '',
    thinkingLevel: '',
    thinkingBudgetTokens: '',
    systemPrompt: '',
    order: '',
    allow: '',
    deny: '',
    dataResidency: '',
    dataCollection: '',
    sort: '',
    fallbackBehavior: 'default',
    enabled: true,
  };
}

function draftFromPreset(preset: Preset, enableOnPublish: boolean): PresetDraft {
  const params = getRecord(preset.params);
  const parsedPrefs = parseProviderPreferences(preset.provider_prefs);
  const prefs = parsedPrefs.ok && parsedPrefs.value ? parsedPrefs.value : {};
  const stopValue = params.stop;
  const reasoningEffort = params.reasoning_effort;
  const thinkingLevel = params.thinking_level;
  const thinkingBudgetTokens = params.thinking_budget_tokens;

  return {
    slug: preset.slug,
    model: preset.model,
    temperature: getNumberText(params.temperature),
    maxTokens: getNumberText(params.max_tokens),
    topP: getNumberText(params.top_p),
    frequencyPenalty: getNumberText(params.frequency_penalty),
    presencePenalty: getNumberText(params.presence_penalty),
    stop: Array.isArray(stopValue) ? getListText(stopValue) : getText(stopValue),
    reasoningEffort: typeof reasoningEffort === 'string' && REASONING_EFFORTS.includes(reasoningEffort as (typeof REASONING_EFFORTS)[number]) ? reasoningEffort : '',
    thinkingLevel: typeof thinkingLevel === 'string' && THINKING_LEVELS.includes(thinkingLevel as (typeof THINKING_LEVELS)[number]) ? thinkingLevel : '',
    thinkingBudgetTokens: typeof thinkingBudgetTokens === 'number' && Number.isSafeInteger(thinkingBudgetTokens) && thinkingBudgetTokens > 0 ? String(thinkingBudgetTokens) : '',
    systemPrompt: preset.system_prompt ?? '',
    order: getListText(prefs.order),
    allow: getListText(prefs.allow),
    deny: getListText(prefs.deny),
    dataResidency: getListText(prefs.data_residency),
    dataCollection: prefs.data_collection ?? '',
    sort: prefs.sort ?? '',
    fallbackBehavior: prefs.allow_fallbacks === undefined ? 'default' : prefs.allow_fallbacks ? 'allow' : 'deny',
    enabled: enableOnPublish ? true : preset.enabled,
  };
}

function splitProviderList(value: string): string[] {
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function buildParams(draft: PresetDraft): BuildResult<Record<string, unknown>> {
  const params: Record<string, unknown> = {};
  const numericFields: Array<[keyof PresetDraft, string, boolean]> = [
    ['temperature', 'temperature', false],
    ['maxTokens', 'max_tokens', true],
    ['topP', 'top_p', false],
    ['frequencyPenalty', 'frequency_penalty', false],
    ['presencePenalty', 'presence_penalty', false],
  ];

  for (const [draftKey, payloadKey, integer] of numericFields) {
    const raw = draft[draftKey] as string;
    if (!raw.trim()) continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || (integer && !Number.isInteger(value))) {
      return { ok: false, error: 'invalid_preset_params' };
    }
    params[payloadKey] = value;
  }

  if (draft.reasoningEffort.trim()) params.reasoning_effort = draft.reasoningEffort;
  if (draft.thinkingLevel.trim()) params.thinking_level = draft.thinkingLevel;
  if (draft.thinkingBudgetTokens.trim()) params.thinking_budget_tokens = Number(draft.thinkingBudgetTokens);

  const stop = splitProviderList(draft.stop);
  if (stop.length > 0) params.stop = stop;
  return { ok: true, value: params };
}

function buildProviderPrefs(draft: PresetDraft): BuildResult<ProviderPreferences | null> {
  const raw: Record<string, unknown> = {};
  const order = splitProviderList(draft.order);
  const allow = splitProviderList(draft.allow);
  const deny = splitProviderList(draft.deny);
  if (order.length > 0) raw.order = order;
  if (allow.length > 0) raw.allow = allow;
  if (deny.length > 0) raw.deny = deny;
  const dataResidency = splitProviderList(draft.dataResidency);
  if (dataResidency.length > 0) raw.data_residency = dataResidency;
  if (draft.dataCollection) raw.data_collection = draft.dataCollection;
  if (draft.sort) raw.sort = draft.sort;
  if (draft.fallbackBehavior !== 'default') raw.allow_fallbacks = draft.fallbackBehavior === 'allow';

  const parsed = parseProviderPreferences(raw);
  return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, error: parsed.reason };
}

function residencyWouldRefuseAllForDraft(draft: PresetDraft): boolean {
  const built = buildProviderPrefs(draft);
  if (!built.ok || !built.value?.data_residency?.length) return false;
  const parsedModel = parseModelSuffixes(draft.model);
  const candidates = parsedModel.ok ? getModelEndpoints(parsedModel.model) : [];
  const result = applyProviderPreferences(candidates, built.value);
  return !result.ok || result.endpoints.length === 0;
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

export function PresetEditor({ mode, preset, enableOnPublish = false, onClose, onSaved }: PresetEditorProps) {
  const [draft, setDraft] = useState<PresetDraft>(() => preset ? draftFromPreset(preset, enableOnPublish) : emptyDraft());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editing = mode === 'edit';
  const nextVersion = preset ? preset.version + 1 : null;
  const title = editing ? `Edit ${preset?.slug}` : 'Create preset';
  const submitLabel = editing
    ? enableOnPublish ? `Enable & publish v${nextVersion}` : `Publish v${nextVersion}`
    : 'Create preset';
  const residencyCodes = splitProviderList(draft.dataResidency);
  const residencyCodesInvalid = residencyCodes.length > 0 && !parseProviderPreferences({ data_residency: residencyCodes }).ok;
  const residencyWouldRefuseAll = !residencyCodesInvalid && residencyWouldRefuseAllForDraft(draft);
  const residencyNote = residencyCodesInvalid
    ? `Invalid residency codes — two uppercase letters with an optional -SUFFIX of 1-8 uppercase letters or digits (e.g. EU-DE), max ${MAX_JURISDICTION_CODES}.`
    : residencyWouldRefuseAll
      ? 'Fail-closed: with these residency codes and provider preferences, the current catalog yields no eligible endpoint for the selected model — requests using this preset will fail closed.'
      : null;
  const storedPrefsInvalid = preset ? !parseProviderPreferences(preset.provider_prefs).ok : false;
  const storedParams = preset ? getRecord(preset.params) : {};
  const storedReasoningFields = [
    ['reasoning_effort', validateReasoningParams({ reasoning_effort: storedParams.reasoning_effort })],
    ['thinking_level', validateReasoningParams({ thinking_level: storedParams.thinking_level })],
    ['thinking_budget_tokens', validateReasoningParams({ thinking_budget_tokens: storedParams.thinking_budget_tokens })],
  ] as const;
  const storedReasoningErrors = storedReasoningFields.flatMap(([, validationError]) => validationError ? [validationError] : []);

  function updateDraft<Key extends keyof PresetDraft>(key: Key, value: PresetDraft[Key]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const slug = draft.slug.trim();
    if (!editing && !SLUG_RE.test(slug)) {
      setError('invalid_preset_slug');
      return;
    }
    if (!isSupportedPresetModel(draft.model)) {
      setError('invalid_preset_model');
      return;
    }

    const params = buildParams(draft);
    if (!params.ok) {
      setError(params.error);
      return;
    }
    const reasoningError = validateReasoningParams(params.value);
    if (reasoningError) {
      setError(reasoningError);
      return;
    }
    for (const [storedReasoningKey, storedReasoningError] of storedReasoningFields) {
      if (storedReasoningError && params.value[storedReasoningKey] === undefined) {
        setError(storedReasoningError);
        return;
      }
    }

    const providerPrefs = buildProviderPrefs(draft);
    if (!providerPrefs.ok) {
      setError(providerPrefs.error);
      return;
    }

    const body = {
      ...(editing ? {} : { slug }),
      model: draft.model,
      params: params.value,
      system_prompt: draft.systemPrompt || null,
      provider_prefs: providerPrefs.value,
      ...(!editing || enableOnPublish ? { enabled: draft.enabled } : {}),
    };

    setSaving(true);
    setError(null);
    try {
      const response = await fetch(editing ? `/api/presets/${encodeURIComponent(preset!.slug)}` : '/api/presets', {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setError(responseError(payload, editing ? 'Failed to publish preset version.' : 'Failed to create preset.'));
        return;
      }
      await onSaved(payload);
      onClose();
    } catch {
      setError('Network error — could not reach server');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form noValidate aria-label={`${editing ? 'Edit' : 'Create'} preset form`} onSubmit={handleSubmit} className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-lg font-semibold text-white">{title}</h3>
          <p className="mt-1 text-sm text-neutral-500">
            {editing ? 'Every save publishes a new immutable version.' : 'Publish version 1 with a complete request-default bundle.'}
          </p>
          {enableOnPublish && (
            <p className="mt-2 text-sm text-amber-200">Re-enabling publishes a new version; it is not a symmetric status toggle.</p>
          )}
        </div>
        <button type="button" onClick={onClose} disabled={saving} className="text-sm text-neutral-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-50">Cancel</button>
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor="preset-slug" className="text-sm font-medium text-neutral-300">Preset slug</label>
          <input
            id="preset-slug"
            value={draft.slug}
            onChange={(event) => updateDraft('slug', event.target.value)}
            disabled={editing}
            placeholder="support-bot"
            autoComplete="off"
            className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2.5 font-mono text-sm text-white placeholder-neutral-600 outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20 disabled:cursor-not-allowed disabled:text-neutral-500"
          />
          <p className="text-xs text-neutral-600">Lowercase letters, numbers, and hyphens; 64 characters maximum.</p>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="preset-model" className="text-sm font-medium text-neutral-300">Model</label>
          <ModelAutocomplete
            id="preset-model"
            value={draft.model}
            onChange={(model) => updateDraft('model', model)}
            allowAnyValue
            placeholder="Choose a canonical model"
          />
          <p className="text-xs text-neutral-600">Optional RouteShift suffixes: <code>:online</code>, <code>:floor</code>, or <code>:nitro</code>.</p>
        </div>
      </div>

      <fieldset className="mt-5 rounded-lg border border-white/[0.06] p-4">
        <legend className="px-1 text-sm font-medium text-neutral-300">Request parameters</legend>
        {storedReasoningErrors.length > 0 && (
          <p role="status" className="mt-1 text-xs text-amber-200">
            Stored reasoning parameters are invalid — {storedReasoningErrors.join(', ')}; invalid fields are left blank until you select valid replacements.
          </p>
        )}
        <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <NumberField id="preset-temperature" label="Temperature" value={draft.temperature} onChange={(value) => updateDraft('temperature', value)} />
          <NumberField id="preset-max-tokens" label="Max tokens" value={draft.maxTokens} integer onChange={(value) => updateDraft('maxTokens', value)} />
          <NumberField id="preset-top-p" label="Top P" value={draft.topP} onChange={(value) => updateDraft('topP', value)} />
          <NumberField id="preset-frequency-penalty" label="Frequency penalty" value={draft.frequencyPenalty} onChange={(value) => updateDraft('frequencyPenalty', value)} />
          <NumberField id="preset-presence-penalty" label="Presence penalty" value={draft.presencePenalty} onChange={(value) => updateDraft('presencePenalty', value)} />
          <TextField id="preset-stop" label="Stop sequences" value={draft.stop} onChange={(value) => updateDraft('stop', value)} hint="Comma-separated" />
          <SelectField id="preset-reasoning-effort" label="Reasoning effort" value={draft.reasoningEffort} onChange={(value) => updateDraft('reasoningEffort', value)}>
            <option value="">Use provider default</option>
            {REASONING_EFFORTS.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
          </SelectField>
          <SelectField id="preset-thinking-level" label="Thinking level" value={draft.thinkingLevel} onChange={(value) => updateDraft('thinkingLevel', value)}>
            <option value="">Use provider default</option>
            {THINKING_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
          </SelectField>
          <NumberField id="preset-thinking-budget-tokens" label="Thinking budget tokens" value={draft.thinkingBudgetTokens} integer min="1" onChange={(value) => updateDraft('thinkingBudgetTokens', value)} />
        </div>
      </fieldset>

      <div className="mt-5 space-y-1.5">
        <label htmlFor="preset-system-prompt" className="text-sm font-medium text-neutral-300">System prompt</label>
        <textarea
          id="preset-system-prompt"
          value={draft.systemPrompt}
          onChange={(event) => updateDraft('systemPrompt', event.target.value)}
          rows={4}
          placeholder="Optional instructions applied before each request."
          className="w-full resize-y rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2.5 text-sm text-white placeholder-neutral-600 outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20"
        />
      </div>

      <fieldset className="mt-5 rounded-lg border border-white/[0.06] p-4">
        <legend className="px-1 text-sm font-medium text-neutral-300">Provider preferences</legend>
        {storedPrefsInvalid && (
          <p role="status" className="mt-1 text-xs text-amber-200">
            Stored provider preferences on this preset are unparseable — fields show empty defaults and publishing will replace them.
          </p>
        )}
        <p className="mt-1 text-xs text-neutral-600">Supported providers: {PROVIDERS.join(', ')}.</p>
        <div className="mt-3 grid gap-3 md:grid-cols-3 lg:grid-cols-4">
          <TextField id="preset-provider-order" label="Provider order" value={draft.order} onChange={(value) => updateDraft('order', value)} hint="Comma-separated" />
          <TextField id="preset-provider-allow" label="Provider allowlist" value={draft.allow} onChange={(value) => updateDraft('allow', value)} hint="Comma-separated" />
          <TextField id="preset-provider-deny" label="Provider denylist" value={draft.deny} onChange={(value) => updateDraft('deny', value)} hint="Comma-separated" />
          <TextField id="preset-data-residency" label="Data residency" value={draft.dataResidency} onChange={(value) => updateDraft('dataResidency', value)} hint={`Comma-separated uppercase codes, max ${MAX_JURISDICTION_CODES}, e.g. EU-DE`} describedBy={residencyNote ? 'preset-data-residency-note' : undefined} invalid={residencyCodesInvalid} />
        </div>
        {residencyNote && (
          <p id="preset-data-residency-note" role="status" className="mt-2 text-xs text-amber-200">
            {residencyNote}
          </p>
        )}
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <SelectField id="preset-data-collection" label="Data collection" value={draft.dataCollection} onChange={(value) => updateDraft('dataCollection', value as PresetDraft['dataCollection'])}>
            <option value="">Use RouteShift default</option>
            <option value="allow">Allow data collection</option>
            <option value="deny">Require no data collection</option>
          </SelectField>
          <SelectField id="preset-provider-sort" label="Provider sorting" value={draft.sort} onChange={(value) => updateDraft('sort', value as PresetDraft['sort'])}>
            <option value="">Use RouteShift default</option>
            <option value="price">Lowest price</option>
            <option value="throughput">Highest throughput</option>
          </SelectField>
        </div>
        <fieldset className="mt-3">
          <legend className="text-sm font-medium text-neutral-300">Fallback behavior</legend>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-sm text-neutral-400">
            <RadioField name="preset-fallbacks" label="Use RouteShift default" checked={draft.fallbackBehavior === 'default'} onChange={() => updateDraft('fallbackBehavior', 'default')} />
            <RadioField name="preset-fallbacks" label="Allow fallbacks" checked={draft.fallbackBehavior === 'allow'} onChange={() => updateDraft('fallbackBehavior', 'allow')} />
            <RadioField name="preset-fallbacks" label="Disable fallbacks" checked={draft.fallbackBehavior === 'deny'} onChange={() => updateDraft('fallbackBehavior', 'deny')} />
          </div>
        </fieldset>
      </fieldset>

      {!editing ? (
        <label className="mt-5 flex items-center gap-2 text-sm text-neutral-300">
          <input type="checkbox" checked={draft.enabled} onChange={(event) => updateDraft('enabled', event.target.checked)} className="accent-emerald-500" />
          Enable this preset after publishing
        </label>
      ) : enableOnPublish ? (
        <p className="mt-5 text-sm text-emerald-200">This published version will re-enable the preset.</p>
      ) : (
        <p className="mt-5 text-sm text-neutral-500">Use the preset table’s Disable action to stop resolution without publishing a new version.</p>
      )}

      {error && <p className="mt-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-200" role="alert">{error}</p>}

      <div className="mt-5 flex justify-end gap-3">
        <button type="button" onClick={onClose} disabled={saving} className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-4 py-2 text-sm font-medium text-neutral-300 transition-colors hover:bg-white/[0.06] disabled:opacity-50">Cancel</button>
        <button type="submit" disabled={saving} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50">
          {saving ? 'Publishing…' : submitLabel}
        </button>
      </div>
    </form>
  );
}

function NumberField({ id, label, value, onChange, integer = false, min }: { id: string; label: string; value: string; onChange: (value: string) => void; integer?: boolean; min?: string }) {
  return <TextField id={id} label={label} value={value} onChange={onChange} type="number" step={integer ? '1' : 'any'} min={min} />;
}

function TextField({ id, label, value, onChange, hint, type = 'text', step, min, describedBy, invalid }: { id: string; label: string; value: string; onChange: (value: string) => void; hint?: string; type?: 'text' | 'number'; step?: string; min?: string; describedBy?: string; invalid?: boolean }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium text-neutral-300">{label}{hint ? <span className="ml-1 text-xs font-normal text-neutral-600">({hint})</span> : null}</label>
      <input id={id} type={type} step={step} min={min} value={value} onChange={(event) => onChange(event.target.value)} aria-describedby={describedBy} aria-invalid={invalid || undefined} className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-sm text-white placeholder-neutral-600 outline-none focus:border-emerald-500/50" />
    </div>
  );
}

function SelectField({ id, label, value, onChange, children }: { id: string; label: string; value: string; onChange: (value: string) => void; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium text-neutral-300">{label}</label>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)} className="w-full rounded-lg border border-white/[0.06] bg-[#17171a] px-3 py-2 text-sm text-white outline-none focus:border-emerald-500/50">
        {children}
      </select>
    </div>
  );
}

function RadioField({ name, label, checked, onChange }: { name: string; label: string; checked: boolean; onChange: () => void }) {
  return <label className="flex items-center gap-2"><input type="radio" name={name} checked={checked} onChange={onChange} className="accent-emerald-500" />{label}</label>;
}
