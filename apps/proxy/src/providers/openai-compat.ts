import { OpenAIProvider } from './openai.js';
import type { CanonicalRequest } from '@routeshift/shared';
import type { ProviderRequest } from './types.js';

interface CompatFeatures {
  streaming_usage: boolean;
  tool_use: boolean;
  json_mode: boolean;
  /**
   * 'bearer'  — standard `Authorization: Bearer <key>` (default).
   * 'api-key' — `api-key: <key>` header instead (matches Xiaomi MiMo token-plan).
   */
  authMode: 'bearer' | 'api-key';
}

const DEFAULT_FEATURES: CompatFeatures = {
  streaming_usage: false,
  tool_use: true,
  json_mode: true,
  authMode: 'bearer',
};

export class OpenAICompatProvider extends OpenAIProvider {
  private modelMapping: Record<string, string>;
  private supportedFeatures: CompatFeatures;

  // Usage parsing intentionally stays inherited from OpenAIProvider. Current
  // pricing sources include cache-read rates for groq, zai, and qwen.
  constructor(
    providerId: string,
    baseUrl: string | (() => string),
    modelMapping: Record<string, string> = {},
    supportedFeatures: Partial<CompatFeatures> = {},
  ) {
    super(baseUrl);
    Object.defineProperty(this, 'id', { value: providerId, writable: false });
    this.modelMapping = modelMapping;
    this.supportedFeatures = { ...DEFAULT_FEATURES, ...supportedFeatures };
  }

  override buildRequest(
    req: CanonicalRequest,
    apiKey: string,
    metadata?: Record<string, unknown>,
  ): ProviderRequest {
    const mappedModel = this.modelMapping[req.model] ?? req.model;
    const modifiedReq: CanonicalRequest = { ...req, model: mappedModel };

    // Strip unsupported features
    if (!this.supportedFeatures.tool_use) {
      delete modifiedReq.tools;
      delete modifiedReq.tool_choice;
    }
    if (!this.supportedFeatures.json_mode) {
      delete modifiedReq.response_format;
    }

    const providerReq = super.buildRequest(modifiedReq, apiKey, metadata);

    // Remove stream_options if provider doesn't support it
    if (!this.supportedFeatures.streaming_usage && req.stream) {
      const body = JSON.parse(providerReq.body);
      delete body.stream_options;
      providerReq.body = JSON.stringify(body);
    }

    if (this.supportedFeatures.authMode === 'api-key') {
      delete providerReq.headers['Authorization'];
      providerReq.headers['api-key'] = apiKey;
    }

    return providerReq;
  }
}
