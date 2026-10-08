import type { LLMProvider } from './types.js';
import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import { GeminiProvider } from './gemini.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { AnthropicCompatProvider } from './anthropic-compat.js';
import { AzureOpenAIProvider } from './azure-openai.js';
import { BedrockProvider } from './bedrock.js';
import { ProxyError } from '@routeshift/shared';

const providers = new Map<string, LLMProvider>();

export function registerProvider(provider: LLMProvider): void {
  providers.set(provider.id, provider);
}

export function getProvider(id: string): LLMProvider | undefined {
  return providers.get(id);
}

// Register defaults
registerProvider(new OpenAIProvider());
registerProvider(new AnthropicProvider());
registerProvider(new GeminiProvider());

// Azure OpenAI. LAY-293. URL is built per-request from provider-key metadata
// (resource_name + api_version); deployment name = canonical model.
registerProvider(new AzureOpenAIProvider());

// Amazon Bedrock. LAY-292. v1: Claude models only, non-streaming. Region +
// access_key_id come from provider-key metadata; secret_access_key is the
// encrypted key. Sigv4-signed via aws4.
registerProvider(new BedrockProvider());

// Together AI
registerProvider(new OpenAICompatProvider('together', 'https://api.together.xyz', {
  'llama-3.1-405b': 'meta-llama/Llama-3.1-405B-Instruct-Turbo',
  'llama-3.1-8b': 'meta-llama/Llama-3.1-8B-Instruct-Turbo',
}));

// Groq
registerProvider(new OpenAICompatProvider('groq', 'https://api.groq.com/openai', {
}, { streaming_usage: false }));

// Z.ai (Zhipu GLM). LAY-295. OpenAI-compat at open.bigmodel.cn, Bearer auth.
registerProvider(new OpenAICompatProvider('zai', 'https://open.bigmodel.cn/api/paas/v4', {
  'glm-4.5': 'glm-4.5',
  'glm-4.5-air': 'glm-4.5-air',
  'glm-4.6': 'glm-4.6',
  'glm-4.7': 'glm-4.7',
  'glm-5': 'glm-5',
  'glm-5-turbo': 'glm-5-turbo',
  'glm-5.1': 'glm-5.1',
}));

function cloudflareWorkersAiBaseUrl(metadata?: Record<string, unknown>): string {
  const accountId = metadata === undefined
    ? process.env.CLOUDFLARE_ACCOUNT_ID
    : typeof metadata.account_id === 'string'
      ? metadata.account_id.trim()
      : undefined;
  if (!accountId || !/^[0-9a-f]{32}$/.test(accountId)) {
    throw new ProxyError(
      'Cloudflare provider requires a valid lowercase 32-character hexadecimal account ID in metadata.account_id or CLOUDFLARE_ACCOUNT_ID',
      503,
      false,
      'cloudflare-workers-ai',
    );
  }
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai`;
}

// Cloudflare Workers AI. The OpenAI-compatible endpoint appends /v1 and
// supports streamed usage accounting.
registerProvider(new OpenAICompatProvider('cloudflare-workers-ai', cloudflareWorkersAiBaseUrl, {
  '@cf/zai-org/glm-5.3-flash': '@cf/zai-org/glm-5.3-flash',
}, { streaming_usage: true }));

// NeuralWatt remains available only for explicit legacy GLM-5.2 IDs. Keep its
// historical compatibility behavior conservative until streamed usage is
// verified against a funded credential.
registerProvider(new OpenAICompatProvider('neuralwatt', 'https://api.neuralwatt.com', {
  'glm-5.2': 'glm-5.2',
  'glm-5.2-fast': 'glm-5.2-fast',
  'glm-5.2-short': 'glm-5.2-short',
  'glm-5.2-short-fast': 'glm-5.2-short-fast',
  'glm-5.2-short-fast-flex': 'glm-5.2-short-fast-flex',
}));

// Xiaomi MiMo (Token Plan). LAY-294. OpenAI-compat with `api-key:` header (not Bearer);
// regional clusters cn / sgp / ams. Defaulting to Singapore (Sam's cluster).
registerProvider(new OpenAICompatProvider('xiaomi', 'https://token-plan-sgp.xiaomimimo.com', {
  'mimo-v2.5-pro': 'mimo-v2.5-pro',
  'mimo-v2-flash': 'mimo-v2-flash',
}, { authMode: 'api-key' }));

// MiniMax. LAY-296. Token-plan keys (sk-cp-) use the Anthropic-compatible
// endpoint at api.minimax.io/anthropic with the standard `x-api-key` header.
registerProvider(new AnthropicCompatProvider('minimax', 'https://api.minimax.io/anthropic'));

// Moonshot AI (Kimi). LAY-298. Anthropic-compatible at api.moonshot.ai/anthropic
// with Bearer auth (matches the Anthropic SDK ANTHROPIC_AUTH_TOKEN convention).
registerProvider(new AnthropicCompatProvider('moonshot', 'https://api.moonshot.ai/anthropic', {
  authMode: 'bearer',
}));

// Alibaba DashScope (Qwen). LAY-297. International endpoint by default;
// drop the -intl suffix for the China cluster.
registerProvider(new OpenAICompatProvider('qwen', 'https://dashscope-intl.aliyuncs.com/compatible-mode', {
  'qwen3.7-max': 'qwen3.7-max',
  'qwen3.7-plus': 'qwen3.7-plus',
  'qwen3.6-flash': 'qwen3.6-flash',
}, { streaming_usage: false }));
