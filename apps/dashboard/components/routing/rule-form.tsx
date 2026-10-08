'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { ModelAutocomplete } from '@/components/models/model-autocomplete';
import {
  QualityGateEditor,
  buildQualityGateConfig,
  defaultQualityGateDraft,
  qualityGateConfigToDraft,
  type QualityGateDraft,
} from '@/components/routing/quality-gate-editor';
import { PROVIDERS } from '@routeshift/shared';
import { getRuleTemplate, getRuleTemplateEditorIssues } from '@/lib/rule-templates';
import { providerDisplayName } from '@/lib/providers';
import { CURRENT_MODELS } from '@/lib/current-models';

/**
 * Shared routing-rule form: create mode (with template/provider/model prefill
 * from search params) and edit mode (hydrated from a stored rule). The edit
 * page MUST check describeRuleEditorGaps(rule) before rendering — this form
 * assumes the rule is representable and round-trips condition/action from its
 * fixed input set without dropping fields.
 */
export interface EditableRule {
  id: string;
  name: string;
  priority: number;
  enabled: boolean;
  condition?: unknown;
  action?: unknown;
}

export function RuleForm({ mode, initialRule }: { mode: 'create' | 'edit'; initialRule?: EditableRule | null }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const prefilledProvider = mode === 'create' ? searchParams.get('provider') : null;
  const templateId = mode === 'create' ? searchParams.get('template') : null;
  const template = templateId ? getRuleTemplate(templateId) : null;
  const prefilledModel = mode === 'create' ? searchParams.get('model') : null;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [name, setName] = useState('');
  const [priority, setPriority] = useState(500);
  const [actionType, setActionType] = useState<'route' | 'block' | 'tag'>('route');

  // route fields — pre-fill from `/models` "Use" button when present
  const [targetProvider, setTargetProvider] = useState(
    prefilledProvider && (PROVIDERS as readonly string[]).includes(prefilledProvider)
      ? prefilledProvider
      : 'openai',
  );
  const [targetModel, setTargetModel] = useState(prefilledModel ?? '');

  // block fields
  const [blockReason, setBlockReason] = useState('');
  const [tagsToAdd, setTagsToAdd] = useState('');

  // condition fields
  const [modelMatch, setModelMatch] = useState('');
  const [conditionTags, setConditionTags] = useState('');
  const [maxTokens, setMaxTokens] = useState('');

  // fallback chain
  const [fallbacks, setFallbacks] = useState<Array<{ provider: string; model: string }>>([]);

  // quality gate (RSH-154) — only attached to 'route' actions
  const [qualityGateEnabled, setQualityGateEnabled] = useState(false);
  const [qualityGateDraft, setQualityGateDraft] = useState<QualityGateDraft>(defaultQualityGateDraft);
  useEffect(() => {
    if (mode !== 'create' || !templateId) return;
    if (!template) {
      setError('Unknown routing rule template.');
      return;
    }
    if (!template.available) {
      setError('This routing rule template is unavailable until endpoint evidence is approved.');
      return;
    }
    const editorIssues = getRuleTemplateEditorIssues(template);
    if (editorIssues.length > 0) {
      setError(`This routing rule template cannot be represented by the editor: ${editorIssues.join(', ')}.`);
      return;
    }

    const { draft } = template;
    const { action, condition } = draft;
    setName(draft.name);
    setPriority(draft.priority);
    setActionType(action.type === 'block' || action.type === 'tag' ? action.type : 'route');
    setTargetProvider(
      action.target_provider && (PROVIDERS as readonly string[]).includes(action.target_provider)
        ? action.target_provider
        : 'openai',
    );
    setTargetModel(action.target_model ?? '');
    setFallbacks(action.fallback_chain ?? []);
    setModelMatch(
      Array.isArray(condition.model_requested)
        ? condition.model_requested.join(', ')
        : condition.model_requested ?? '',
    );
    setConditionTags(condition.tags?.join(', ') ?? '');
    setMaxTokens(condition.max_input_tokens ? String(condition.max_input_tokens) : '');
    setQualityGateEnabled(false);
    setQualityGateDraft(defaultQualityGateDraft);
  }, [template, templateId]);

  useEffect(() => {
    if (mode !== 'edit' || !initialRule) return;
    const action = (initialRule.action ?? {}) as Record<string, any>;
    const condition = (initialRule.condition ?? {}) as Record<string, any>;
    setName(initialRule.name ?? '');
    if (typeof initialRule.priority === 'number') setPriority(initialRule.priority);
    if (action.type === 'block' || action.type === 'tag') {
      setActionType(action.type);
    } else {
      setActionType('route');
    }
    setTargetProvider(
      typeof action.target_provider === 'string' && (PROVIDERS as readonly string[]).includes(action.target_provider)
        ? action.target_provider
        : 'openai',
    );
    setTargetModel(typeof action.target_model === 'string' ? action.target_model : '');
    setBlockReason(typeof action.block_reason === 'string' ? action.block_reason : '');
    setTagsToAdd(Array.isArray(action.add_tags) ? action.add_tags.join(', ') : '');
    setFallbacks(
      Array.isArray(action.fallback_chain)
        ? action.fallback_chain.filter((f: any) => f && typeof f === 'object' && typeof f.provider === 'string' && typeof f.model === 'string')
        : [],
    );
    setModelMatch(
      Array.isArray(condition.model_requested)
        ? condition.model_requested.join(', ')
        : typeof condition.model_requested === 'string'
          ? condition.model_requested
          : '',
    );
    setConditionTags(Array.isArray(condition.tags) ? condition.tags.join(', ') : '');
    setMaxTokens(typeof condition.max_input_tokens === 'number' ? String(condition.max_input_tokens) : '');
    const gate = action.quality_gate;
    if (gate !== undefined) {
      const draft = qualityGateConfigToDraft(gate);
      if (draft) {
        setQualityGateEnabled(true);
        setQualityGateDraft(draft);
      } else {
        // Belt-and-braces: never silently drop a stored gate. The edit page
        // refuses via describeRuleEditorGaps first; this keeps the form from
        // mangling a gate on its own if a future caller skips that check.
        setError('This rule has a quality gate the editor cannot represent; edit is disabled.');
      }
    }
  }, [mode, initialRule]);

  useEffect(() => {
    document.title = mode === 'edit' ? 'Edit Rule | RouteShift' : 'New Rule | RouteShift';
  }, [mode]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    if (mode === 'create' && templateId && (!template || !template.available)) {
      setError(
        template
          ? 'This routing rule template is unavailable until endpoint evidence is approved.'
          : 'Unknown routing rule template.',
      );
      setLoading(false);
      return;
    }
    if (mode === 'create' && templateId && template) {
      const editorIssues = getRuleTemplateEditorIssues(template);
      if (editorIssues.length > 0) {
        setError(`This routing rule template cannot be represented by the editor: ${editorIssues.join(', ')}.`);
        setLoading(false);
        return;
      }
    }

    // Number.isInteger also rejects NaN (from clearing the input), which a bare
    // `< 1 || > 9999` comparison silently lets through (NaN compares false to both),
    // POSTing priority: null to the API.
    if (!Number.isInteger(priority) || priority < 1 || priority > 9999) {
      setError('Priority must be a whole number between 1 and 9999.');
      setLoading(false);
      return;
    }

    const action: Record<string, any> = { type: actionType };
    if (actionType === 'route') {
      action.target_provider = targetProvider;
      if (targetModel.trim()) action.target_model = targetModel.trim();
      if (fallbacks.length > 0) {
        action.fallback_chain = fallbacks.filter((f) => f.provider && f.model);
      }
      if (qualityGateEnabled) {
        // Ends on the same strict validator the proxy admin write-gate runs, so
        // the user sees the exact rejection reason instead of a raw 400.
        const gateResult = buildQualityGateConfig(qualityGateDraft);
        if (!gateResult.ok) {
          setError(gateResult.error);
          setLoading(false);
          return;
        }
        action.quality_gate = gateResult.config;
      }
    } else if (actionType === 'block') {
      if (blockReason.trim()) action.block_reason = blockReason.trim();
    } else if (actionType === 'tag') {
      action.add_tags = tagsToAdd.split(',').map((t) => t.trim()).filter(Boolean);
    }

    const condition: Record<string, any> = {};
    if (modelMatch.trim()) condition.model_requested = modelMatch.trim();
    if (conditionTags.trim()) {
      condition.tags = conditionTags.split(',').map((tag) => tag.trim()).filter(Boolean);
    }
    if (maxTokens.trim()) condition.max_input_tokens = parseInt(maxTokens, 10);

    const body: Record<string, any> = {
      name: name.trim(),
      priority,
      action,
      // Create activates; edit is partial — the toggle owns `enabled`, so an
      // edit must never re-enable a disabled rule.
      ...(mode === 'edit' ? {} : { enabled: true }),
    };
    if (Object.keys(condition).length > 0) {
      body.condition = condition;
    } else if (mode === 'edit' && initialRule?.condition && Object.keys(initialRule.condition as object).length > 0) {
      // Merge-style PATCH only updates present fields: clearing every
      // condition input must still send an explicit empty condition, or the
      // stored one silently survives the user's deletion.
      body.condition = {};
    }

    try {
      const res =
        mode === 'edit' && initialRule
          ? await fetch(`/api/rules/${encodeURIComponent(initialRule.id)}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            })
          : await fetch('/api/rules', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const raw = data?.error;
        setError(typeof raw === 'string' ? raw : raw?.message ?? `Request failed with status ${res.status}`);
        return;
      }

      router.push('/routing');
    } catch (err: any) {
      setError(err.message ?? 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  const inputClasses =
    'w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2.5 text-sm text-white placeholder-neutral-600 outline-none transition-colors focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20';

  const selectClasses =
    'w-full appearance-none bg-white/[0.05] border border-white/[0.1] rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500/50 cursor-pointer';

  return (
    <div className="max-w-xl space-y-8">
      <div>
        <Link
          href="/routing"
          className="mb-3 inline-flex items-center gap-1.5 text-sm text-neutral-500 transition-colors hover:text-white"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to Routing Rules
        </Link>
        <h2 className="text-3xl font-bold text-white">
          {mode === 'edit' ? 'Edit Routing Rule' : 'New Routing Rule'}
        </h2>
        <p className="mt-1 text-neutral-400">
          {mode === 'edit' ? 'Update how certain requests should be handled.' : 'Define how certain requests should be handled.'}
        </p>
      </div>

      <div className="rounded-xl border border-white/[0.06] bg-white/[0.03]">
        {/* Header */}
        <div className="border-b border-white/[0.06] px-6 py-4">
          <h3 className="text-base font-semibold text-white">Rule Details</h3>
        </div>

        {/* Form */}
        <div className="px-6 py-5">
          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Name */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-neutral-300" htmlFor="name">Name</label>
              <input
                id="name"
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={`e.g. Route cheap tasks to ${CURRENT_MODELS.economy}`}
                className={inputClasses}
              />
            </div>

            {/* Priority */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-neutral-300" htmlFor="priority">Priority</label>
              <input
                id="priority"
                type="number"
                required
                min={1}
                max={9999}
                value={Number.isNaN(priority) ? '' : priority}
                onChange={(e) => setPriority(e.target.value === '' ? NaN : parseInt(e.target.value, 10))}
                className={inputClasses}
              />
              <p className="text-xs text-neutral-600">Lower numbers run first (1 = highest priority, max 9999).</p>
            </div>

            {/* Action type */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-neutral-300" htmlFor="actionType">Action Type</label>
              <div className="grid grid-cols-3 gap-2">
                {(['route', 'block', 'tag'] as const).map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setActionType(type)}
                    className={`rounded-lg border px-3 py-2.5 text-sm font-medium capitalize transition-all ${
                      actionType === type
                        ? type === 'block'
                          ? 'border-red-500/30 bg-red-500/10 text-red-400'
                          : type === 'tag'
                            ? 'border-cyan-500/30 bg-cyan-500/10 text-cyan-400'
                            : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                        : 'border-white/[0.06] bg-white/[0.03] text-neutral-500 hover:bg-white/[0.05] hover:text-neutral-300'
                    }`}
                  >
                    {type}
                  </button>
                ))}
              </div>
            </div>

            {/* Route-specific fields */}
            {actionType === 'route' && (
              <>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-neutral-300" htmlFor="targetProvider">Target Provider</label>
                  <select
                    id="targetProvider"
                    value={targetProvider}
                    onChange={(e) => setTargetProvider(e.target.value)}
                    className={selectClasses}
                  >
                    {PROVIDERS.map((p) => (
                      <option key={p} value={p}>
                        {providerDisplayName(p)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-neutral-300" htmlFor="targetModel">Target Model (optional)</label>
                  <ModelAutocomplete
                    id="targetModel"
                    value={targetModel}
                    onChange={setTargetModel}
                    placeholder={`e.g. ${CURRENT_MODELS.economy}`}
                  />
                </div>

                {/* Fallback chain */}
                <div className="space-y-2">
                  <label className="text-sm font-medium text-neutral-300">Fallback Chain</label>
                  <p className="text-xs text-neutral-500">
                    If the primary model fails, try these alternatives in order.
                  </p>
                  <div className="space-y-2">
                    {fallbacks.map((fb, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <select
                          value={fb.provider}
                          onChange={(e) => {
                            const next = [...fallbacks];
                            next[i] = { ...next[i], provider: e.target.value };
                            setFallbacks(next);
                          }}
                          className={selectClasses + ' flex-1'}
                        >
                          {PROVIDERS.map((p) => (
                            <option key={p} value={p}>{providerDisplayName(p)}</option>
                          ))}
                        </select>
                        <div className="flex-[2]">
                          <ModelAutocomplete
                            value={fb.model}
                            onChange={(v) => {
                              const next = [...fallbacks];
                              next[i] = { ...next[i], model: v };
                              setFallbacks(next);
                            }}
                            placeholder="Fallback model"
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => setFallbacks((prev) => prev.filter((_, idx) => idx !== i))}
                          className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-2.5 py-2 text-xs text-neutral-500 hover:bg-white/[0.06] hover:text-red-400"
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => setFallbacks((prev) => [...prev, { provider: 'openai', model: '' }])}
                    className="inline-flex items-center gap-1 rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-xs font-medium text-neutral-400 transition-all hover:bg-white/[0.06] hover:text-neutral-300"
                  >
                    + Add Fallback
                  </button>
                </div>

                {/* Quality gate (RSH-154) */}
                <QualityGateEditor
                  enabled={qualityGateEnabled}
                  onEnabledChange={setQualityGateEnabled}
                  draft={qualityGateDraft}
                  onDraftChange={setQualityGateDraft}
                />
              </>
            )}

            {/* Block-specific fields */}
            {actionType === 'block' && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-neutral-300" htmlFor="blockReason">Block Reason (optional)</label>
                <input
                  id="blockReason"
                  type="text"
                  value={blockReason}
                  onChange={(e) => setBlockReason(e.target.value)}
                  placeholder="e.g. Model not allowed by policy"
                  className={inputClasses}
                />
              </div>
            )}

            {/* Tag-specific fields */}
            {actionType === 'tag' && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-neutral-300" htmlFor="tagsToAdd">Tags to Add</label>
                <input
                  id="tagsToAdd"
                  type="text"
                  value={tagsToAdd}
                  onChange={(e) => setTagsToAdd(e.target.value)}
                  placeholder="e.g. cheap, internal (comma-separated)"
                  className={inputClasses}
                />
              </div>
            )}

            {/* Condition section */}
            <div className="border-t border-white/[0.06] pt-5 space-y-4">
              <p className="text-xs text-neutral-500">Conditions are optional. Leave blank to match all requests.</p>

              <div className="space-y-1.5">
                <label className="text-sm font-medium text-neutral-300" htmlFor="conditionTags">Request Tags</label>
                <input
                  id="conditionTags"
                  type="text"
                  value={conditionTags}
                  onChange={(e) => setConditionTags(e.target.value)}
                  placeholder="e.g. internal, interactive (comma-separated)"
                  className={inputClasses}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-neutral-300" htmlFor="modelMatch">Model Match</label>
                <ModelAutocomplete
                  id="modelMatch"
                  value={modelMatch}
                  onChange={setModelMatch}
                  placeholder={`e.g. ${CURRENT_MODELS.default}`}
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium text-neutral-300" htmlFor="maxTokens">Max Input Tokens</label>
                <input
                  id="maxTokens"
                  type="number"
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(e.target.value)}
                  placeholder="e.g. 4096"
                  className={inputClasses}
                />
              </div>
            </div>

            {error && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2">
                <p className="text-sm text-red-400">{error}</p>
              </div>
            )}

            <div className="flex items-center gap-3 pt-2">
              <button
                type="submit"
                disabled={loading}
                className="rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white transition-all hover:bg-emerald-500 disabled:opacity-50"
              >
                {loading ? (mode === 'edit' ? 'Saving...' : 'Creating...') : mode === 'edit' ? 'Save Changes' : 'Create Rule'}
              </button>
              <button
                type="button"
                onClick={() => router.push('/routing')}
                className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-5 py-2.5 text-sm font-medium text-neutral-400 transition-all hover:bg-white/[0.06] hover:text-white"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
