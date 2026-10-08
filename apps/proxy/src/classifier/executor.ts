import type { CanonicalMessage, CanonicalRequest } from '@routeshift/shared';
import { getProvider } from '../providers/registry.js';
import { getDecryptedProviderKey } from '../billing/provider-key-crypto.js';
import { computeRequestCost } from '../cost/calculator.js';
import { stripPii } from './pii-strip.js';
import {
  MAX_CLASSIFIER_INPUT_CHARS,
  type ClassifierConfig,
  type ClassificationResult,
} from './types.js';

function buildClassificationPrompt(config: ClassifierConfig, text: string): string {
  const dimensionLines = config.dimensions.map(
    (d) => `- ${d.id} (${d.prompt || d.name}): ${JSON.stringify(d.values)}`,
  );
  return [
    'Classify the following text across these dimensions. Return ONLY a JSON object mapping dimension IDs to one of their allowed values.',
    '',
    'Dimensions:',
    ...dimensionLines,
    '',
    'Text (PII-redacted):',
    text.slice(0, MAX_CLASSIFIER_INPUT_CHARS),
    '',
    'Respond with ONLY valid JSON: {"dimension_id": "value", ...}',
  ].join('\n');
}

function extractText(messages: CanonicalMessage[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      parts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text' && typeof (part as any).text === 'string') {
          parts.push((part as any).text);
        }
      }
    }
  }
  return parts.join(' ');
}

export async function executeClassification(
  config: ClassifierConfig,
  messages: CanonicalMessage[],
  requestId: string,
): Promise<ClassificationResult | null> {
  const start = Date.now();
  try {
    const rawText = extractText(messages);
    if (!rawText.trim()) return null;

    const stripped = stripPii(rawText);
    const prompt = buildClassificationPrompt(config, stripped);

    const provider = getProvider(config.classifierProvider);
    if (!provider) return null;

    const keyConfig = await getDecryptedProviderKey(config.teamId, config.classifierProvider);
    if (!keyConfig) return null;

    const canonicalReq: CanonicalRequest = {
      model: config.classifierModel,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      max_output_tokens: 256,
      temperature: 0,
    };

    const providerReq = provider.buildRequest(canonicalReq, keyConfig.key, keyConfig.metadata);
    const res = await fetch(providerReq.url, {
      method: providerReq.method,
      headers: providerReq.headers,
      body: providerReq.body,
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) return null;
    const body = await res.json();
    const parsed_response = provider.parseResponse(body);
    const rawContent: unknown = parsed_response.content;
    let content = '';
    if (typeof rawContent === 'string') {
      content = rawContent;
    } else if (Array.isArray(rawContent)) {
      content = (rawContent as Array<{ type?: string; text?: string }>)
        .filter((p) => p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text!)
        .join('');
    }
    if (!content) return null;

    let parsed: Record<string, string>;
    try {
      const jsonStr = content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      parsed = JSON.parse(jsonStr);
    } catch {
      return null;
    }

    const validDimensions: Record<string, string> = {};
    for (const dim of config.dimensions) {
      const value = parsed[dim.id];
      if (typeof value === 'string' && dim.values.includes(value)) {
        validDimensions[dim.id] = value;
      }
    }

    const inputTokens = parsed_response.usage?.input_tokens ?? Math.ceil(prompt.length / 4);
    const outputTokens = parsed_response.usage?.output_tokens ?? Math.ceil(content.length / 4);
    const cost = await computeRequestCost(
      config.classifierModel,
      config.classifierProvider,
      config.classifierModel,
      config.classifierProvider,
      { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
    );

    return {
      requestId,
      teamId: config.teamId,
      dimensions: validDimensions,
      costMicrocents: cost.actual_cost_microcents,
      latencyMs: Date.now() - start,
      classifiedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error(`[classifier] classification failed for request=${requestId}:`, err);
    return null;
  }
}
