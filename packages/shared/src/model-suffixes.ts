import type { ProviderSortPreference } from './provider-preferences';

export type ModelSuffix = 'online' | 'floor' | 'nitro';

export type ModelSuffixParseResult =
  | {
      ok: true;
      model: string;
      suffixes: ModelSuffix[];
      online: boolean;
      providerPreferences: { sort: Extract<ProviderSortPreference, 'price' | 'throughput'> } | null;
    }
  | { ok: false; reason: 'invalid_model_suffixes' | 'conflicting_model_suffixes' };

const KNOWN_SUFFIXES = new Set<ModelSuffix>(['online', 'floor', 'nitro']);

export function parseModelSuffixes(model: string): ModelSuffixParseResult {
  let baseModel = model;
  const suffixes: ModelSuffix[] = [];

  while (true) {
    const index = baseModel.lastIndexOf(':');
    if (index === -1) break;

    const suffix = baseModel.slice(index + 1);
    if (!KNOWN_SUFFIXES.has(suffix as ModelSuffix)) break;

    suffixes.unshift(suffix as ModelSuffix);
    baseModel = baseModel.slice(0, index);
  }

  if (baseModel.length === 0) return { ok: false, reason: 'invalid_model_suffixes' };

  const hasFloor = suffixes.includes('floor');
  const hasNitro = suffixes.includes('nitro');
  if (hasFloor && hasNitro) return { ok: false, reason: 'conflicting_model_suffixes' };

  const sort = hasFloor ? 'price' : hasNitro ? 'throughput' : undefined;

  return {
    ok: true,
    model: baseModel,
    suffixes,
    online: suffixes.includes('online'),
    providerPreferences: sort ? { sort } : null,
  };
}
