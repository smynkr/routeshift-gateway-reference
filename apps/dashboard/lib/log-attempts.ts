export type FallbackAttempt = { provider: string; model: string; error: string; actual_cost_known?: boolean };

export function normalizeFallbackAttempts(value: unknown): FallbackAttempt[] {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((attempt) => {
    if (
      attempt &&
      typeof attempt === 'object' &&
      typeof (attempt as { provider?: unknown }).provider === 'string' &&
      typeof (attempt as { model?: unknown }).model === 'string' &&
      typeof (attempt as { error?: unknown }).error === 'string'
    ) {
      const typed = attempt as FallbackAttempt & { actual_cost_known?: unknown };
      const normalized: FallbackAttempt = { provider: typed.provider, model: typed.model, error: typed.error };
      // Quality-cascade attempts carry whether their cost is exact; skip rows
      // and plain fallbacks omit it. Preserve the boolean when present so the
      // UI can mark unknown-cost attempts instead of silently assuming exact.
      if (typeof typed.actual_cost_known === 'boolean') {
        normalized.actual_cost_known = typed.actual_cost_known;
      }
      return [normalized];
    }
    return [];
  });
}
