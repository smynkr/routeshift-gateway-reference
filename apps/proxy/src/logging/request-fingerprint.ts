// LAY-328: per-request fingerprint helpers for the Optimize engine.
// system_prompt_tokens powers the oversized-system-prompt rule;
// message_hash powers the duplicate-requests rule.

import { createHash } from 'node:crypto';
import type { CanonicalRequest } from '@routeshift/shared';

// chars/4 heuristic — same cheap approximation the proxy already uses for
// `estimatedInputTokens` (proxy-handler.ts) and the credit pre-flight check.
// Good enough to flag prompts that are *clearly* oversized; the rule
// thresholds (>4000 / >8000) are forgiving enough that ~10% drift is fine.
export function estimateSystemPromptTokens(systemPrompt: unknown): number {
  if (typeof systemPrompt === 'string') return Math.ceil(systemPrompt.length / 4);
  if (!Array.isArray(systemPrompt)) return 0;
  return Math.ceil(JSON.stringify(systemPrompt).length / 4);
}

// 16-char (64-bit) prefix of SHA-256 over the canonical request fields that
// determine duplicate/cachable request identity. Collisions across distinct
// payloads at our volume are vanishingly unlikely. The shape mirrors the
// credit pre-flight check so downstream consumers see consistent fingerprinting.
export function computeMessageHash(canonical: CanonicalRequest): string {
  const fingerprint = JSON.stringify({
    messages: canonical.messages,
    system: canonical.system_prompt ?? '',
    tools: canonical.tools ?? [],
    reasoning_effort: canonical.reasoning_effort ?? '',
    thinking_level: canonical.thinking_level ?? '',
    thinking_budget_tokens: canonical.thinking_budget_tokens ?? 0,
  });
  return createHash('sha256').update(fingerprint).digest('hex').slice(0, 16);
}
