import type { Provider } from './models';

export interface EmbeddingModel {
  provider: Provider;
  api_model_id: string;
  context_window: number;
  /**
   * If false, hidden from the unauthenticated /v1/models catalog. Authenticated
   * keys still see it when explicitly listed in allowedModels. Defaults to true.
   */
  public?: boolean;
}

export const EMBEDDING_MODELS: Record<string, EmbeddingModel> = {
  'text-embedding-3-small': { provider: 'openai', api_model_id: 'text-embedding-3-small', context_window: 8_192 },
  'text-embedding-3-large': { provider: 'openai', api_model_id: 'text-embedding-3-large', context_window: 8_192 },
  'text-embedding-004': { provider: 'google', api_model_id: 'text-embedding-004', context_window: 2_048 },
};

export function resolveEmbeddingModel(model: string): Provider | null {
  return EMBEDDING_MODELS[model]?.provider ?? null;
}
