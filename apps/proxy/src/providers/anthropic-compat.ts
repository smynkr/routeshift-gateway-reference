import type { CanonicalRequest } from '@routeshift/shared';
import { AnthropicProvider } from './anthropic.js';
import type { ProviderRequest } from './types.js';

interface AnthropicCompatFeatures {
  /**
   * 'x-api-key' — standard Anthropic header (default; matches MiniMax token-plan).
   * 'bearer'    — Authorization: Bearer header (matches Moonshot's ANTHROPIC_AUTH_TOKEN convention).
   */
  authMode: 'x-api-key' | 'bearer';
}

const DEFAULT_FEATURES: AnthropicCompatFeatures = {
  authMode: 'x-api-key',
};

export class AnthropicCompatProvider extends AnthropicProvider {
  private features: AnthropicCompatFeatures;

  constructor(
    providerId: string,
    baseUrl: string,
    features: Partial<AnthropicCompatFeatures> = {},
  ) {
    super(baseUrl);
    Object.defineProperty(this, 'id', { value: providerId, writable: false });
    this.features = { ...DEFAULT_FEATURES, ...features };
  }

  override buildRequest(req: CanonicalRequest, apiKey: string): ProviderRequest {
    const providerReq = super.buildRequest(req, apiKey);
    if (this.features.authMode === 'bearer') {
      delete providerReq.headers['x-api-key'];
      providerReq.headers['Authorization'] = `Bearer ${apiKey}`;
    }
    return providerReq;
  }
}
