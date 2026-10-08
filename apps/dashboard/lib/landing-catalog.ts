export interface LandingCatalogStats {
  modelCount: number;
  providerCount: number;
}
export function isLandingCatalogStats(value: unknown): value is LandingCatalogStats {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<LandingCatalogStats>;
  return typeof candidate.modelCount === 'number'
    && Number.isInteger(candidate.modelCount)
    && candidate.modelCount >= 0
    && typeof candidate.providerCount === 'number'
    && Number.isInteger(candidate.providerCount)
    && candidate.providerCount >= 0;
}

type CatalogEndpoint = { provider?: unknown };
type CatalogModel = { endpoints?: unknown };

export function parseLandingCatalog(value: unknown): LandingCatalogStats | null {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || (value as { object?: unknown }).object !== 'list'
    || !Array.isArray((value as { data?: unknown }).data)
    || (value as { data: unknown[] }).data.length === 0
  ) {
    return null;
  }
  const data = (value as { data: unknown[] }).data;

  const providers = new Set<string>();
  for (const model of data) {
    if (typeof model !== 'object' || model === null || Array.isArray(model)) return null;
    const typedModel = model as CatalogModel;
    if (typedModel.endpoints !== undefined && !Array.isArray(typedModel.endpoints)) return null;

    for (const endpoint of (typedModel.endpoints ?? []) as unknown[]) {
      if (typeof endpoint !== 'object' || endpoint === null || Array.isArray(endpoint)) return null;
      const provider = (endpoint as CatalogEndpoint).provider;
      if (provider !== undefined && typeof provider !== 'string') return null;
      if (typeof provider === 'string' && provider.trim()) providers.add(provider.trim());
    }
  }

  if (providers.size === 0) return null;
  return { modelCount: data.length, providerCount: providers.size };
}

export async function fetchLandingCatalogStats(
  baseUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<LandingCatalogStats | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetcher(`${baseUrl.replace(/\/$/, '')}/v1/models`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return parseLandingCatalog(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
