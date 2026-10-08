import {
  CATALOG_FRESHNESS_MANIFEST,
  EFFECTIVE_DISPATCHABLE_CHAT_MODELS,
  GOOGLE_PREVIEW_QUARANTINE_IDS,
  MODEL_REGISTRY,
  type EffectiveCatalogDefinition,
} from '@routeshift/shared';

export interface DispatchTarget {
  provider: string;
  model: string;
}

export type DispatchTargetAssessment =
  | { ok: true; contextWindow: number | null }
  | { ok: false; reason: string };

function idsMatch(definition: EffectiveCatalogDefinition, model: string): boolean {
  return definition.canonical_name === model || definition.api_model_id === model;
}

function isGenerated(definition: EffectiveCatalogDefinition): boolean {
  return 'source' in definition && definition.source === 'generated';
}

function quarantineReason(provider: string, model: string): string | null {
  const lowerModel = model.toLowerCase();
  const rows = CATALOG_FRESHNESS_MANIFEST?.quarantined ?? [];
  const providerRow = rows.find((row) => (
    row.kind === 'model'
    && row.reason !== undefined
    && !row.reason.startsWith('duplicate_global_model_id:')
    && row.provider.toLowerCase() === provider.toLowerCase()
    && row.model.toLowerCase() === lowerModel
  ));
  const globalRow = rows.find((row) => (
    row.kind === 'model'
    && row.reason !== undefined
    && !row.reason.startsWith('duplicate_global_model_id:')
    && row.model.toLowerCase() === lowerModel
  ));
  const row = providerRow ?? globalRow;
  if (row?.reason) return row.reason;

  // Keep request-time behavior fail-closed if an older shared generated
  // manifest predates the runtime quarantine list.
  const previewIds = GOOGLE_PREVIEW_QUARANTINE_IDS ?? [
    'gemini-2.5-flash-lite-preview-06-17',
    'gemini-2.5-flash-lite-preview-09-2025',
    'gemini-2.5-flash-preview-09-2025',
    'gemini-3-flash-preview',
    'gemini-3.1-flash-lite-preview',
    'gemini-3.1-pro-preview',
    'gemini-3.1-pro-preview-customtools',
  ];
  if (previewIds.some((id) => id === lowerModel)) {
    return `unsupported_model_alias:google:${model}`;
  }
  if (lowerModel === 'gpt-5.6-cyber') {
    return `unsupported_runtime_model:openai:${model}`;
  }
  return null;
}

function effectiveDefinitionFor(
  target: DispatchTarget,
  effectiveModels: readonly EffectiveCatalogDefinition[] | undefined,
): EffectiveCatalogDefinition | undefined {
  return (effectiveModels ?? []).find((definition) => (
    definition.provider === target.provider && idsMatch(definition, target.model)
  ));
}

function anyEffectiveDefinition(
  model: string,
  effectiveModels: readonly EffectiveCatalogDefinition[] | undefined,
): EffectiveCatalogDefinition | undefined {
  return (effectiveModels ?? []).find((definition) => idsMatch(definition, model));
}

/**
 * Return the context window for the exact provider/model pair in the effective
 * dispatch catalog. Curated model IDs may have alternate provider endpoints;
 * generated rows are provider-qualified and never lend their context to a
 * different provider.
 */
export function contextWindowForDispatchTarget(
  provider: string,
  model: string,
  effectiveModels: readonly EffectiveCatalogDefinition[] = EFFECTIVE_DISPATCHABLE_CHAT_MODELS,
): number | null {
  const target: DispatchTarget = { provider, model };
  const providerDefinition = effectiveDefinitionFor(target, effectiveModels);
  if (providerDefinition) return providerDefinition.context_window;

  const effectiveDefinition = anyEffectiveDefinition(model, effectiveModels);
  if (effectiveDefinition && !isGenerated(effectiveDefinition)) {
    return effectiveDefinition.context_window;
  }

  // Preserve the historical prefix/explicit model path when the effective
  // catalog has no generated row for this request.
  const curated = MODEL_REGISTRY.find((definition) => idsMatch(definition, model));
  return curated?.context_window ?? null;
}

/**
 * Check a final route target against catalog quarantine and generated-provider
 * ownership. Unknown legacy/provider-managed IDs remain eligible here; the
 * provider adapter and credential checks retain their existing responsibility.
 */
export function assessDispatchTarget(
  provider: string,
  model: string,
  effectiveModels: readonly EffectiveCatalogDefinition[] = EFFECTIVE_DISPATCHABLE_CHAT_MODELS,
): DispatchTargetAssessment {
  const reason = quarantineReason(provider, model);
  if (reason) return { ok: false, reason };

  const curated = MODEL_REGISTRY.find((definition) => idsMatch(definition, model));
  if (curated?.public === false && curated.provider === provider) {
    return { ok: false, reason: `model_not_dispatchable:${curated.provider}:${model}` };
  }

  const target = { provider, model };
  const providerDefinition = effectiveDefinitionFor(target, effectiveModels);
  const effectiveDefinition = anyEffectiveDefinition(model, effectiveModels);
  if (
    effectiveDefinition
    && isGenerated(effectiveDefinition)
    && !providerDefinition
  ) {
    // A generated row is an alternate-provider record. A first-party prefix
    // may still pass through its established provider (e.g. bare gpt-* →
    // OpenAI), but it must not silently remap to an unrelated generated row.
    const firstPartyProvider = model.startsWith('gpt-') || model === 'o3'
      || model.startsWith('o3-') || model === 'o4' || model.startsWith('o4-')
      ? 'openai'
      : model.startsWith('claude-')
        ? 'anthropic'
        : model.startsWith('gemini-')
          ? 'google'
          : null;
    if (firstPartyProvider !== provider) {
      return {
        ok: false,
        reason: `model_provider_mismatch:${effectiveDefinition.provider}:${model}`,
      };
    }
  }

  return {
    ok: true,
    contextWindow: contextWindowForDispatchTarget(provider, model, effectiveModels),
  };
}
