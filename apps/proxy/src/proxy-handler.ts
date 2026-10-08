// apps/proxy/src/proxy-handler.ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { CanonicalRequest, EffectiveCatalogDefinition, ModelProviderEndpoint, Provider, ProviderPreferences, RequestContext, RoutingDecision } from '@routeshift/shared';
import { applyProviderPreferences, EFFECTIVE_DISPATCHABLE_CHAT_MODELS, evaluateRules, getModelEndpoints, hasMultiAttemptBillingAck, MODEL_REGISTRY, parseModelSuffixes, parseProviderPreferences, PROVIDER_DATA_POLICY, ProxyError, RouteBlockedError, type QualityGateConfig } from '@routeshift/shared';
import { getProvider } from './providers/registry.js';
import type { ProviderRequest } from './providers/types.js';
import { relayStream } from './streaming/relay.js';
import { computeRequestCost, computeRequestCostDetailed } from './cost/calculator.js';
import { logRequest, type RequestLogRecord } from './logging/logger.js';
import { categorize, extractToolCallsFromChunks } from './logging/categorize.js';
import { estimateSystemPromptTokens, computeMessageHash } from './logging/request-fingerprint.js';
import { deriveSessionId } from './logging/session.js';
import { extractEditedPaths, hasBashCall } from './logging/turn-signals.js';
import { validateApiKey, AuthInfrastructureError } from './auth/api-key.js';
import { layerIdentityFromMetadata } from './auth/layer-identity.js';
import { getRulesForTeam } from './routing/rule-cache.js';
import { classifyPromptTags, DEFAULT_SEMANTIC_CATEGORIES } from './routing/semantic-tags.js';
import {
  estimateAttemptCostForBudget,
  executeFallbackChain,
  projectQualityCascadeReservation,
  type RetryBudget,
} from './routing/fallback.js';
import { assessDispatchTarget } from './routing/dispatch-eligibility.js';
import { executeQualityCascade } from './routing/quality-cascade.js';
import { buildAutoRouteDecision } from './routing/auto-router.js';
import { getAutoRouteProviderSignals } from './routing/auto-route-availability.js';
import { getAutoRouteSettings } from './admin/auto-route.js';
import { getQualityVerdictSignals, insertQualityVerdicts } from './db/quality-verdicts.js';
import { isValidIdentityId } from './admin/identity-budgets.js';
import { QUALITY_DERANK_WINDOW_MS, type QualityVerdictSignal } from '@routeshift/shared';
import { circuitBreaker } from './routing/circuit-breaker.js';
import { rateLimiter } from './rate-limit/limiter.js';
import { getTeamTpmLimit } from './rate-limit/team-tpm.js';
import { config } from './config.js';
import { getTeamPlan, getPlanLimits, getTeamBillingMode } from './billing/plan-limits.js';
import { estimateChatBudget } from './billing/budget-estimate.js';
import { reportBudgetLedgerFailure, settleBudgetExact, settleBudgetUnknown, writeBudgetRejection } from './billing/budget-lifecycle.js';
import {
  adjustBudgetReservation,
  markBudgetReservationDispatched,
  refreshBudgetReservationLease,
  releaseBudgetReservation,
  reserveBudget,
  type BudgetReservation,
} from './billing/budget-reservations.js';
import { resolveAlias } from './routing/model-aliases.js';
import {
  preFlightCreditCheck,
  reserveCredits,
  heartbeatCreditReservation,
  settleReservedCredits,
  settleReservedCreditsWithUnknownCostHold,
  checkAutoTopUpNeeded,
  getCreditPricing,
  applyMarkupMicrocents,
} from './billing/credits.js';
import { captureException } from './observability/sentry.js';
import { captureAiGeneration, resolveDistinctId, pseudonymizeIdentity } from './observability/posthog.js';
import { getDecryptedProviderKey, hasEnabledProviderKey } from './billing/provider-key-crypto.js';
import { markCooldown } from './billing/rate-limit-cooldown.js';
import { recordAuditEvent } from './auth/audit-events.js';
import { keyHasInferenceScope } from './auth/scope.js';
import {
  decrementInFlight,
  incrementInFlight,
  recordLatency,
} from './billing/key-stats.js';
import { responseCache } from './cache/response-cache.js';
import { isOpenAIShapedBody, toOpenAIChatCompletion } from './providers/openai-format.js';
import { resolvePreset } from './presets/resolver.js';
import { collectPluginSpecs } from './plugins/specs.js';
import {
  estimatePluginSurchargeMicrocents,
  PluginRequiredError,
  PluginUnavailableError,
  runPlugins,
  type PluginRunOutcome,
  type PluginWarning,
} from './plugins/runtime.js';
import { getPlatformKey } from './providers/platform-keys.js';
import { getGuardrailConfig, scanMessages } from './guardrails/index.js';
import { getClassifierConfig, executeClassification, shouldSample } from './classifier/index.js';

// Keep explicit denylist entries local so proxy behavior remains fail-closed
// even when the workspace's shared package build predates the registry source.
const GOOGLE_PREVIEW_QUARANTINE_IDS = new Set([
  'gemini-2.5-flash-lite-preview-06-17',
  'gemini-2.5-flash-lite-preview-09-2025',
  'gemini-2.5-flash-preview-09-2025',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite-preview',
  'gemini-3.1-pro-preview',
  'gemini-3.1-pro-preview-customtools',
]);

const OPENAI_COMPAT_PROVIDER_PARAMS = [
  'top_p',
  'frequency_penalty',
  'presence_penalty',
  'stop',
  'seed',
  'user',
  'logit_bias',
  'logprobs',
  'top_logprobs',
  'n',
] as const;
const ANTHROPIC_PROVIDER_PARAMS = ['top_p', 'stop'] as const;
const GEMINI_PROVIDER_PARAMS = ['top_p', 'frequency_penalty', 'presence_penalty', 'stop'] as const;

type CreditReservationState = {
  amountDeducted: number;
  resolved: boolean;
};

type PresetDefaultsResult = {
  status: 'applied' | 'none' | 'not_found';
  providerPrefs: unknown;
  /** The preset's model when status === 'applied' (RSH-146 pin target). */
  model?: string;
};

const PROVIDER_PARAM_SUPPORT: Record<string, ReadonlySet<string>> = {
  openai: new Set(OPENAI_COMPAT_PROVIDER_PARAMS),
  azure: new Set(OPENAI_COMPAT_PROVIDER_PARAMS),
  together: new Set(OPENAI_COMPAT_PROVIDER_PARAMS),
  groq: new Set(OPENAI_COMPAT_PROVIDER_PARAMS),
  zai: new Set(OPENAI_COMPAT_PROVIDER_PARAMS),
  'cloudflare-workers-ai': new Set(OPENAI_COMPAT_PROVIDER_PARAMS),
  neuralwatt: new Set(OPENAI_COMPAT_PROVIDER_PARAMS),
  xiaomi: new Set(OPENAI_COMPAT_PROVIDER_PARAMS),
  qwen: new Set(OPENAI_COMPAT_PROVIDER_PARAMS),
  anthropic: new Set(ANTHROPIC_PROVIDER_PARAMS),
  minimax: new Set(ANTHROPIC_PROVIDER_PARAMS),
  moonshot: new Set(ANTHROPIC_PROVIDER_PARAMS),
  bedrock: new Set(ANTHROPIC_PROVIDER_PARAMS),
  google: new Set(GEMINI_PROVIDER_PARAMS),
};

function firstDisallowedModel(allowedModels: string[] | null, models: string[]): string | null {
  if (!allowedModels || allowedModels.length === 0) return null;
  return models.find((model) => !allowedModels.includes(model)) ?? null;
}

function presetRefFromBody(body: Record<string, unknown>): string | null {
  if (typeof body.preset === 'string' && body.preset.length > 0) return body.preset;
  if (typeof body.model === 'string' && body.model.startsWith('@preset/')) return body.model.slice('@preset/'.length);
  return null;
}

function isPresetModelMarker(model: unknown): boolean {
  return typeof model === 'string' && model.startsWith('@preset/');
}

function hasSystemMessage(body: Record<string, unknown>): boolean {
  return Array.isArray(body.messages) && body.messages.some((message) => (
    typeof message === 'object' && message !== null && (message as { role?: unknown }).role === 'system'
  ));
}

/** Preserve provider system blocks and their metadata. The file parser later
 * replaces only file/input_file blocks with text, so cache-control and other
 * established system-block contracts survive intact. */
function canonicalSystemPromptFromContent(content: unknown): CanonicalRequest['system_prompt'] {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  return content.flatMap((part) => {
    if (typeof part === 'string') return [{ type: 'text', text: part }];
    return part && typeof part === 'object' && !Array.isArray(part)
      ? [part as Record<string, unknown>]
      : [];
  });
}

/** Accept the OpenAI-compatible system message/system_prompt forms plus the
 * top-level block form already recognized for Anthropic cache controls. */
function rawSystemContentFromBody(body: Record<string, unknown>): unknown {
  const systemMessage = Array.isArray(body.messages)
    ? body.messages.find((message) => (
      typeof message === 'object' && message !== null && (message as { role?: unknown }).role === 'system'
    )) as { content?: unknown } | undefined
    : undefined;
  return systemMessage?.content ?? body.system_prompt ?? body.system;
}

/**
 * char/4 input-token heuristic over text and bounded file payloads. It is
 * deliberately conservative for a raw base64/PDF part until plugin
 * augmentation replaces that part with the canonical text/native payload.
 */
export function estimateMessageTokens(messages: ReadonlyArray<{ content?: unknown }> | undefined): number {
  return messages?.reduce(
    (sum, message) => sum + estimateContentTokens(message?.content),
    0,
  ) ?? 0;
}

function estimateContentTokens(content: unknown): number {
  if (typeof content === 'string') return Math.ceil(content.length / 4);
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum, part) => {
    if (typeof part === 'string') return sum + Math.ceil(part.length / 4);
    if (!part || typeof part !== 'object') return sum;
    const candidate = part as Record<string, unknown>;
    if (candidate.type === 'text' && typeof candidate.text === 'string') {
      return sum + Math.ceil(candidate.text.length / 4);
    }
    if (candidate.type === 'pdf' && isPdfPayload(candidate.pdf)) {
      return sum + Math.ceil(candidate.pdf.data.length / 4);
    }
    const rawFileData = fileDataFromContentPart(candidate);
    return rawFileData === undefined ? sum : sum + Math.ceil(rawFileData.length / 4);
  }, 0);
}

function isPdfPayload(value: unknown): value is { data: string } {
  return Boolean(value && typeof value === 'object' && typeof (value as { data?: unknown }).data === 'string');
}

function fileDataFromContentPart(part: Record<string, unknown>): string | undefined {
  if (typeof part.file_data === 'string') return part.file_data;
  const nested = part.file;
  return nested && typeof nested === 'object' && typeof (nested as { file_data?: unknown }).file_data === 'string'
    ? (nested as { file_data: string }).file_data
    : undefined;
}

// Opt-in: this pushes a customer-visible tag (e.g. 'coding') onto every
// matching request's routing context, which could incidentally match an
// existing team's own routing rule condition on that tag name and silently
// change their routing/billing. Off by default until a team explicitly
// enables it.
function semanticPromptTaggingEnabled(): boolean {
  const raw = process.env.ROUTESHIFT_SEMANTIC_TAGS;
  if (raw === undefined) return false;
  return ['1', 'true', 'on', 'enabled'].includes(raw.trim().toLowerCase());
}

function appendPromptTextPart(parts: string[], content: unknown): void {
  if (typeof content === 'string') {
    parts.push(content);
    return;
  }

  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part);
      continue;
    }
    if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
      parts.push((part as { text: string }).text);
    }
  }
}

function semanticPromptTextFromBody(rawBody: { messages?: unknown; system_prompt?: unknown }): string {
  const parts: string[] = [];

  // Only the user's own words represent current intent for classification
  // purposes -- including system_prompt (which can be preset-injected, e.g.
  // "You are a TypeScript coding assistant") or prior assistant turns would
  // let static/stale context (rather than what THIS request is actually
  // about) mis-tag every request that shares that context.
  if (Array.isArray(rawBody.messages)) {
    for (const message of rawBody.messages) {
      if (!message || typeof message !== 'object') continue;
      if ((message as { role?: unknown }).role !== 'user') continue;
      appendPromptTextPart(parts, (message as { content?: unknown }).content);
    }
  }

  return parts.join('\n');
}

interface RequestedModel {
  raw: string;
  model: string;
  online: boolean;
  providerPreferences: ProviderPreferences | null;
}

type ModelInputValidation =
  | { ok: true; models: string[]; explicitModels: boolean }
  | { ok: false; message: string; code: string };

type RequestedModelsResolution =
  | { ok: true; models: RequestedModel[]; explicitModels: boolean }
  | { ok: false; message: string; code: string };

function validateModelInputs(rawBody: Record<string, unknown>): ModelInputValidation {
  const hasModels = rawBody.models !== undefined;
  if (hasModels) {
    if (!Array.isArray(rawBody.models) || rawBody.models.length === 0 || rawBody.models.length > 16) {
      return { ok: false, message: 'models must be a non-empty array of strings', code: 'invalid_models' };
    }
    const models = rawBody.models;
    if (!models.every((model) => typeof model === 'string' && model.length > 0)) {
      return { ok: false, message: 'models must be a non-empty array of strings', code: 'invalid_models' };
    }
    if (rawBody.model !== undefined && typeof rawBody.model !== 'string') {
      return { ok: false, message: 'model field must be a string when provided with models', code: 'invalid_model' };
    }
    if (typeof rawBody.model === 'string' && rawBody.model !== models[0]) {
      return { ok: false, message: 'models[0] must match model when both are provided', code: 'invalid_models' };
    }
    return { ok: true, models: [...models], explicitModels: true };
  }

  if (!rawBody.model || typeof rawBody.model !== 'string') {
    return { ok: false, message: 'model field is required and must be a string', code: 'invalid_model' };
  }
  return { ok: true, models: [rawBody.model], explicitModels: false };
}

async function resolveRequestedModels(
  teamId: string,
  modelInput: { models: string[]; explicitModels: boolean },
): Promise<RequestedModelsResolution> {
  const models: RequestedModel[] = [];
  for (const raw of modelInput.models) {
    const parsed = parseModelSuffixes(raw);
    if (!parsed.ok) {
      return { ok: false, message: 'Invalid model suffix combination', code: parsed.reason };
    }
    models.push({
      raw,
      model: await resolveAlias(teamId, parsed.model),
      online: parsed.online,
      providerPreferences: parsed.providerPreferences,
    });
  }
  return { ok: true, models, explicitModels: modelInput.explicitModels };
}

function serializePluginWarnings(warnings: PluginWarning[]): Array<{ plugin: string; code: string; reason: string; message: string }> {
  return warnings.map((warning) => ({
    plugin: warning.plugin,
    code: warning.code,
    reason: warning.reason,
    message: warning.message,
  }));
}

function setPluginWarningHeaders(res: ServerResponse, warnings: PluginWarning[]): void {
  if (warnings.length === 0) return;
  res.setHeader('X-RouteShift-Plugin-Warning', Array.from(new Set(warnings.map((warning) => warning.code))).join(','));
  res.setHeader('X-RouteShift-Plugin-Skip-Reason', warnings.map((warning) => warning.message).join(' | '));
}

function attachPluginWarnings(body: unknown, warnings: PluginWarning[]): unknown {
  if (warnings.length === 0 || !body || typeof body !== 'object' || Array.isArray(body)) return body;
  const existingWarnings = Array.isArray((body as { warnings?: unknown }).warnings)
    ? (body as { warnings: unknown[] }).warnings
    : [];
  return {
    ...(body as Record<string, unknown>),
    warnings: [...existingWarnings, ...serializePluginWarnings(warnings)],
  };
}

function logPluginWarnings(warnings: PluginWarning[]): void {
  for (const warning of warnings) {
    console.warn(JSON.stringify({
      event: 'routeshift_plugin_skipped',
      plugin: warning.plugin,
      code: warning.code,
      reason: warning.reason,
      message: warning.message,
    }));
  }
}

type FallbackAttempt = NonNullable<RequestLogRecord['fallback_attempts']>[number];
type LoggedPluginWarning = NonNullable<RequestLogRecord['plugin_warnings']>[number];
type LoggedPluginRun = NonNullable<RequestLogRecord['plugin_runs']>[number];
type UnknownCostAttempt = {
  provider: string;
  model: string;
  actual_cost_known?: boolean;
  observed_cost_microcents?: number;
};

/** Normalize a terminal fallback audit to explicit lower-bound totals. Credit
 * retention is handled separately from this pure logging state. */
function fallbackLowerBoundState(
  attempts: readonly FallbackAttempt[],
): { actualCostKnown: boolean; actualCostMicrocents: number; inputTokens: number; outputTokens: number } {
  const actualCostKnown = attempts.every((attempt) => attempt.actual_cost_known !== false);
  return { actualCostKnown, actualCostMicrocents: 0, inputTokens: 0, outputTokens: 0 };
}

async function estimateUnknownCostRemainder(
  attempts: readonly UnknownCostAttempt[],
  canonical: CanonicalRequest,
): Promise<number | null> {
  const unknownAttempts = attempts.filter((attempt) => attempt.actual_cost_known === false);
  if (unknownAttempts.length === 0) return 0;

  const estimatedInputTokens =
    estimateMessageTokens(canonical.messages) + estimateContentTokens(canonical.system_prompt);
  const estimatedOutputTokens = canonical.max_output_tokens ?? 4096;
  const estimates = await Promise.all(unknownAttempts.map(async (attempt) => {
    const projected = await estimateAttemptCostForBudget(
      attempt.provider,
      attempt.model,
      estimatedInputTokens,
      estimatedOutputTokens,
      getCreditPricing,
    );
    if (projected === null) return null;
    return Math.max(0, projected - Math.max(0, attempt.observed_cost_microcents ?? 0));
  }));
  if (estimates.some((estimate) => estimate === null)) return null;
  const total = estimates.reduce<number>((sum, estimate) => sum + (estimate ?? 0), 0);
  return Number.isSafeInteger(total) ? total : null;
}

async function settleUnknownCostReservation(args: {
  reservation: CreditReservationState | null;
  teamId: string;
  requestId: string;
  knownActualCostMicrocents: number;
  attempts: readonly UnknownCostAttempt[];
  canonical: CanonicalRequest;
  markupPercent: number;
  reasonCode: string;
  description: string;
}): Promise<void> {
  const {
    reservation,
    teamId,
    requestId,
    knownActualCostMicrocents,
    attempts,
    canonical,
    markupPercent,
    reasonCode,
    description,
  } = args;
  if (!reservation || reservation.resolved) return;

  const unknownAttempts = attempts.filter((attempt) => attempt.actual_cost_known === false);
  if (unknownAttempts.length === 0) return;
  const estimate = await estimateUnknownCostRemainder(unknownAttempts, canonical);

  try {
    const result = await settleReservedCreditsWithUnknownCostHold(
      teamId,
      reservation.amountDeducted,
      knownActualCostMicrocents,
      estimate,
      markupPercent,
      requestId,
      description,
      reasonCode,
      unknownAttempts.length,
    );
    // Whether the partial settlement succeeded or not, the original reservation
    // remains held. Never let the outer finally refund ambiguous provider spend.
    reservation.resolved = true;
    if (result.success) {
      console.warn(JSON.stringify({
        event: 'routeshift_unknown_provider_cost_hold_created',
        request_id: requestId,
        team_id: teamId,
        reason_code: reasonCode,
        unknown_attempts: unknownAttempts.length,
        known_actual_cost_microcents: knownActualCostMicrocents,
        unknown_cost_estimate_microcents: estimate,
        pending_hold_microcents: result.pendingHoldMicrocents,
        amount_refunded_microcents: result.amountRefunded,
      }));
      await checkAutoTopUpNeeded(teamId, result.newBalance).catch((err) => {
        console.error('Auto top-up check failed (unknown-cost hold):', err);
      });
      return;
    }
    captureException(new Error('Unknown-cost hold settlement returned success=false'), {
      tags: { source: 'unknown_cost_hold', handler: 'chat_proxy', reason_code: reasonCode },
      extra: { request_id: requestId, team_id: teamId, unknown_attempts: unknownAttempts.length },
    });
  } catch (err) {
    // The reservation debit predates this transaction, so a rollback still
    // leaves the conservative amount held. Mark it resolved in memory to keep
    // finally from manufacturing a refund after the tracking write failed.
    reservation.resolved = true;
    captureException(err, {
      tags: { source: 'unknown_cost_hold', handler: 'chat_proxy', reason_code: reasonCode },
      extra: { request_id: requestId, team_id: teamId, unknown_attempts: unknownAttempts.length },
    });
  }
}

function fallbackSuccessAccounting(result: {
  attempts: ReadonlyArray<FallbackAttempt>;
  aggregateActualCostKnown?: boolean;
  aggregateActualCostMicrocents?: number;
  aggregateInputTokens?: number;
  aggregateOutputTokens?: number;
}): {
  costMicrocents: number;
  inputTokens: number;
  outputTokens: number;
  costKnown: boolean;
  priorAttemptCount: number;
} {
  return {
    costMicrocents: result.aggregateActualCostMicrocents ?? 0,
    inputTokens: result.aggregateInputTokens ?? 0,
    outputTokens: result.aggregateOutputTokens ?? 0,
    costKnown: result.aggregateActualCostKnown !== false,
    // Fallback attempts without actual_cost_known were skipped before
    // dispatch (for example, missing keys or an open circuit). Only
    // dispatched predecessors can have consumed unknown reasoning tokens.
    priorAttemptCount: result.attempts.filter((attempt) => attempt.actual_cost_known !== undefined).length,
  };
}

type ReasoningTelemetryValue = number | null | undefined;

function aggregateReasoningTelemetry(
  rows: ReadonlyArray<{ reasoning_tokens?: number; reasoning_cost_microcents?: number }>,
): { tokens: ReasoningTelemetryValue; cost: ReasoningTelemetryValue } {
  const hasReasoningTokens = rows.some((row) => row.reasoning_tokens !== undefined);
  if (!hasReasoningTokens) return { tokens: undefined, cost: undefined };

  const tokens = rows.every((row) => row.reasoning_tokens !== undefined)
    ? rows.reduce((sum, row) => sum + (row.reasoning_tokens ?? 0), 0)
    : null;
  const cost = rows.every((row) => row.reasoning_cost_microcents !== undefined)
    ? rows.reduce((sum, row) => sum + (row.reasoning_cost_microcents ?? 0), 0)
    : null;
  return { tokens, cost };
}

function combineReasoningTelemetry(
  served: ReasoningTelemetryValue,
  prior: ReasoningTelemetryValue,
  hasPriorAttempts: boolean,
): ReasoningTelemetryValue {
  if (!hasPriorAttempts) return served;
  if (served === null || prior === null) return null;
  if (served === undefined && prior === undefined) return undefined;
  if (served === undefined || prior === undefined) return null;
  return served + prior;
}

/**
 * Plugin outcomes are the source of truth for a terminal request's fee. A
 * successful web plugin has already incurred an external cost even if a later
 * gate blocks provider dispatch, so never zero it merely because the LLM did
 * not run. Invalid/overflow values are ignored defensively; plugin runtime
 * outcomes are internal, measured values.
 */
function measuredPluginCostMicrocents(runs: readonly LoggedPluginRun[] | undefined): number {
  let total = 0;
  for (const run of runs ?? []) {
    const cost = run.costMicrocents;
    if (!Number.isSafeInteger(cost) || cost <= 0) continue;
    if (total > Number.MAX_SAFE_INTEGER - cost) return total;
    total += cost;
  }
  return total;
}

function writePluginFailureRequest(args: {
  billingMode: 'subscription' | 'credits';
  requestId: string;
  startTime: number;
  teamId: string;
  apiKeyId: string | null;
  layerIdentityId: string | null;
  providerId: string;
  routedModel: string;
  requestedModel: string;
  statusCode: number;
  canonical: CanonicalRequest;
  sessionId: string;
  systemPromptTokens: number;
  messageHash: string;
  rateLimited: boolean;
  traceparent?: string | null;
  pluginWarnings: LoggedPluginWarning[];
  pluginRuns: LoggedPluginRun[];
  errorType: string;
}): void {
  logRequest({
    id: args.requestId,
    timestamp: new Date().toISOString(),
    team_id: args.teamId,
    api_key_id: args.apiKeyId,
    layer_identity_id: args.layerIdentityId,
    traceparent: args.traceparent ?? null,
    provider: args.providerId,
    model_requested: args.requestedModel,
    model_resolved: args.routedModel,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    total_tokens: 0,
    original_cost_microcents: 0,
    actual_cost_microcents: 0,
    actual_cost_known: true,
    plugin_cost_microcents: measuredPluginCostMicrocents(args.pluginRuns),
    savings_microcents: 0,
    total_latency_ms: Date.now() - args.startTime,
    ttft_ms: null,
    is_streaming: Boolean(args.canonical.stream),
    is_fallback: false,
    status_code: args.statusCode,
    billing_mode: args.billingMode,
    error_type: args.errorType,
    cache_hit: false,
    activity_category: categorize({ messages: args.canonical.messages, toolCalls: [] }),
    session_id: args.sessionId,
    edited_paths: [],
    had_bash: false,
    rate_limited: args.rateLimited,
    system_prompt_tokens: args.systemPromptTokens,
    message_hash: args.messageHash,
    request_kind: 'chat',
    fallback_attempts: [],
    plugin_warnings: args.pluginWarnings,
    plugin_runs: args.pluginRuns,
  });
}

function writeTerminalFailureRequest(args: {
  billingMode: 'subscription' | 'credits';
  requestId: string;
  startTime: number;
  teamId: string;
  apiKeyId: string | null;
  layerIdentityId: string | null;
  providerId: string;
  routedModel: string;
  requestedModel: string;
  statusCode: number;
  canonical: CanonicalRequest;
  sessionId: string;
  systemPromptTokens: number;
  messageHash: string;
  rateLimited: boolean;
  errorType: string;
  fallbackAttempts?: FallbackAttempt[];
  traceparent?: string | null;
  pluginWarnings?: PluginWarning[];
  pluginRuns?: PluginRunOutcome[];
  // RSH-134: a failed quality cascade still dispatched paid attempts. Every
  // other terminal failure genuinely spent nothing upstream, so these default
  // to 0 and no existing caller changes behavior — but logging a cascade's real
  // spend as 0 would make rejected-but-dispatched attempts invisible, and
  // "a dispatched attempt is real spend" is the invariant this exists to keep.
  actualCostMicrocents?: number;
  /** False when aggregate provider spend is only a lower bound. */
  actualCostKnown: boolean;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: ReasoningTelemetryValue;
  reasoningCostMicrocents?: ReasoningTelemetryValue;
}): void {
  const inputTokens = args.inputTokens ?? 0;
  const outputTokens = args.outputTokens ?? 0;
  logRequest({
    id: args.requestId,
    timestamp: new Date().toISOString(),
    team_id: args.teamId,
    api_key_id: args.apiKeyId,
    layer_identity_id: args.layerIdentityId,
    traceparent: args.traceparent ?? null,
    provider: args.providerId,
    model_requested: args.requestedModel,
    model_resolved: args.routedModel,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    reasoning_tokens: args.reasoningTokens,
    reasoning_cost_microcents: args.reasoningCostMicrocents,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    total_tokens: inputTokens + outputTokens,
    original_cost_microcents: 0,
    actual_cost_microcents: args.actualCostMicrocents ?? 0,
    actual_cost_known: args.actualCostKnown,
    plugin_cost_microcents: measuredPluginCostMicrocents(args.pluginRuns),
    // Savings stays 0: a failed cascade served nothing, so there is no
    // original-vs-actual comparison to make. Aggregate savings is RSH-134 §4.4
    // (step 3) and is gated on Q2.
    savings_microcents: 0,
    total_latency_ms: Date.now() - args.startTime,
    ttft_ms: null,
    is_streaming: Boolean(args.canonical.stream),
    is_fallback: false,
    status_code: args.statusCode,
    billing_mode: args.billingMode,
    error_type: args.errorType,
    cache_hit: false,
    activity_category: categorize({ messages: args.canonical.messages, toolCalls: [] }),
    session_id: args.sessionId,
    edited_paths: [],
    had_bash: false,
    rate_limited: args.rateLimited,
    system_prompt_tokens: args.systemPromptTokens,
    message_hash: args.messageHash,
    request_kind: 'chat',
    fallback_attempts: args.fallbackAttempts ?? [],
    // Persist plugin warnings on terminal failures too — they're set as
    // response headers (setPluginWarningHeaders) but were previously dropped
    // from the log, losing observability for failed requests.
    plugin_warnings:
      args.pluginWarnings && args.pluginWarnings.length > 0
        ? serializePluginWarnings(args.pluginWarnings)
        : undefined,
    plugin_runs: args.pluginRuns && args.pluginRuns.length > 0 ? args.pluginRuns : undefined,
  });
}

function missingCreditPricingMessage(provider: string, model: string): string {
  return `Credits billing is unavailable for ${provider}:${model} because pricing is not configured`;
}

function collectProviderParams(rawBody: Record<string, unknown>): CanonicalRequest['provider_params'] | undefined {
  const params: Record<string, unknown> = {};
  for (const key of OPENAI_COMPAT_PROVIDER_PARAMS) {
    if (rawBody[key] !== undefined) params[key] = rawBody[key];
  }
  return Object.keys(params).length > 0 ? params : undefined;
}

function unsupportedProviderParams(providerId: string, params: CanonicalRequest['provider_params'] | undefined): string[] {
  if (!params) return [];
  const supported = PROVIDER_PARAM_SUPPORT[providerId] ?? new Set<string>();
  return Object.keys(params).filter((key) => !supported.has(key));
}

async function applyPresetDefaults(
  teamId: string,
  rawBody: Record<string, unknown>,
  options: { forceModel?: boolean } = {},
): Promise<PresetDefaultsResult> {
  const ref = presetRefFromBody(rawBody);
  if (!ref) return { status: 'none', providerPrefs: null };

  const resolved = await resolvePreset(teamId, ref);
  delete rawBody.preset;
  if (!resolved) return { status: 'not_found', providerPrefs: null };

  // RSH-146: a KEY-BOUND preset is org policy — its model pins the route
  // unconditionally (a request model cannot override the binding; the key's
  // allowed_models gate still applies to the preset's model), and its
  // params/system_prompt are FORCED: request-supplied values cannot override
  // org policy (forceModel).
  const force = options.forceModel === true;
  if (force || !rawBody.model || isPresetModelMarker(rawBody.model)) {
    rawBody.model = resolved.model;
  }

  const shouldApplyMaxTokens = rawBody.max_tokens == null && rawBody.max_completion_tokens == null;
  for (const [key, value] of Object.entries(resolved.params)) {
    if (key === 'max_tokens') continue;
    if (value !== undefined && (force || rawBody[key] == null)) rawBody[key] = value;
  }
  if (resolved.params.max_tokens !== undefined && (force || shouldApplyMaxTokens)) {
    rawBody.max_tokens = resolved.params.max_tokens;
  }
  if (
    resolved.system_prompt
    && (force || (rawBody.system_prompt == null && rawBody.system == null && !hasSystemMessage(rawBody)))
  ) {
    if (force) {
      // org policy wins over EVERY carrier: the system-role message and the
      // OpenAI `system` field both outrank system_prompt in the normalizer,
      // so leaving them would bypass the forced prompt
      delete rawBody.system;
      if (Array.isArray(rawBody.messages)) {
        rawBody.messages = rawBody.messages.filter((message) => (
          typeof message !== 'object' || message === null
          || (message as { role?: unknown }).role !== 'system'
        ));
      }
    }
    rawBody.system_prompt = resolved.system_prompt;
  }
  // Provider preferences have their own field-by-field precedence contract:
  // preset defaults < explicit model suffix < explicit request provider fields.
  // Keep the preset object separate so an unrelated inline provider field does
  // not erase privacy/allowlist defaults before they are parsed and merged.
  return { status: 'applied', providerPrefs: resolved.provider_prefs ?? null, model: resolved.model };
}

export async function handleProxyRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = randomUUID();
  const startTime = Date.now();
  const rawTraceparent = req.headers['traceparent'];
  const traceparent = typeof rawTraceparent === 'string' ? rawTraceparent : null;

  // Read request body
  const bodyChunks: Buffer[] = [];
  let bodySize = 0;
  for await (const chunk of req) {
    bodySize += (chunk as Buffer).length;
    if (bodySize > config.maxRequestBodyBytes) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Request body too large' } }));
      return;
    }
    bodyChunks.push(chunk as Buffer);
  }
  let rawBody: any;
  try {
    rawBody = JSON.parse(Buffer.concat(bodyChunks).toString());
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid JSON in request body' } }));
    return;
  }

  // --- AUTH ---
  const authHeader = req.headers['authorization'];
  const apiKeyStr = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  let teamId: string;
  let keyInfo: import('./auth/types.js').ApiKeyInfo | null = null;
  if (!apiKeyStr || !apiKeyStr.startsWith('sk-proxy-')) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'API key required. Use Authorization: Bearer sk-proxy-...' } }));
    return;
  }
  try {
    keyInfo = await validateApiKey(apiKeyStr);
  } catch (err) {
    // RSH-86: DB/infrastructure failures during auth must surface as 503
    // (transient), not 401 (invalid key). The OpenRouter Feb 2026 incident
    // showed the exact hazard: a backend outage surfaced as auth failures,
    // sending developers down a false debugging path.
    if (err instanceof AuthInfrastructureError) {
      console.error('[auth] infrastructure error during key validation:', err.cause ?? err);
      res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '5' });
      res.end(JSON.stringify({ error: { message: 'Service temporarily unavailable', code: 'auth_infrastructure_error' } }));
      return;
    }
    throw err;
  }
  if (!keyInfo) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
    return;
  }
  teamId = keyInfo.teamId;

  // Device-flow key scope enforcement (RSH-69). Check immediately after
  // authentication so a key without inference consent cannot trigger preset,
  // alias, or other team-scoped resolution work before being rejected. Shared
  // with the embeddings handler so both billable-inference surfaces gate
  // identically.
  if (!keyHasInferenceScope(keyInfo.metadata)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'insufficient_scope: missing inference scope', code: 'insufficient_scope' } }));
    return;
  }

  // RSH-146: a key-bound preset is org policy applied at issuance. The
  // binding is injected as the preset ref BEFORE resolution: a request that
  // supplies its own preset on a bound key CONFLICTS (fail closed — a
  // request must not override org policy), a request-level `models` fallback
  // array is the same override via another door (rejected), and a binding
  // that no longer resolves (preset deleted/disabled since mint) fails
  // closed with 403 rather than silently falling back to an unbound key.
  // The binding's model pins the route via forceModel; the key's
  // allowed_models gate still applies to it (mint-time validation
  // guarantees consistency).
  const keyPresetBound = keyInfo.presetSlug != null;
  if (keyPresetBound) {
    if (presetRefFromBody(rawBody)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: { message: 'This API key is bound to a preset; request-level presets are not allowed', code: 'key_preset_conflict' },
      }));
      return;
    }
    if (rawBody.models !== undefined) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: { message: 'This API key is bound to a preset; request-level model fallback arrays are not allowed', code: 'key_preset_conflict' },
      }));
      return;
    }
    // org policy owns provider prefs too: request provider fields would
    // override the bound preset's ZDR/residency/order posture via the
    // merge precedence — drop them (the preset's prefs are the only input)
    delete rawBody.provider;
    delete rawBody.provider_preferences;
    rawBody.preset = keyInfo.presetVersion != null
      ? `${keyInfo.presetSlug}@${keyInfo.presetVersion}`
      : keyInfo.presetSlug;
  }

  const presetDefaults = await applyPresetDefaults(teamId, rawBody, { forceModel: keyPresetBound });
  if (presetDefaults.status === 'not_found') {
    if (keyPresetBound) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: `The preset bound to this API key is no longer available: ${keyInfo.presetSlug}`,
          code: 'key_preset_unavailable',
        },
      }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Preset not found', code: 'preset_not_found' } }));
    return;
  }
  // RSH-146: the bound preset's model is the route-pin target (checked after
  // routing — a rule or auto-route must not escape it). Preset models may
  // carry request suffixes (e.g. gpt-5.4:floor — pinned by the presets
  // surface tests) which request-model canonicalization strips; the pin must
  // compare the SAME canonical form the router sees, or every bound key with
  // a suffixed preset model would 403 key_preset_model_mismatch on every
  // request (and the fallback filter would drop the whole chain).
  let presetModel: string | undefined;
  if (keyPresetBound && presetDefaults.status === 'applied' && presetDefaults.model) {
    const parsedPresetModel = parseModelSuffixes(presetDefaults.model);
    presetModel = parsedPresetModel.ok
      ? await resolveAlias(teamId, parsedPresetModel.model)
      : presetDefaults.model;
  }

  // --- INPUT VALIDATION ---
  const modelInput = validateModelInputs(rawBody);
  if (!modelInput.ok) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: modelInput.message, code: modelInput.code } }));
    return;
  }

  if (rawBody.messages && !Array.isArray(rawBody.messages)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'messages must be an array' } }));
    return;
  }

  const requestedModels = await resolveRequestedModels(teamId, modelInput);
  if (!requestedModels.ok) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: requestedModels.message, code: requestedModels.code } }));
    return;
  }

  rawBody.model = requestedModels.models[0].model;
  if (requestedModels.explicitModels) rawBody.models = requestedModels.models.map((entry) => entry.model);

  const primarySuffixPrefs = requestedModels.models[0].providerPreferences;
  const pluginSpecs = collectPluginSpecs(rawBody, { online: requestedModels.models[0].online });
  if (pluginSpecs.errors.length > 0) {
    const firstError = pluginSpecs.errors[0];
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: firstError.message, code: firstError.code } }));
    return;
  }
  rawBody.model = pluginSpecs.model ?? rawBody.model;
  // Plugin requests run a pre-upstream augmentation stage (Exa web search and
  // file/PDF parsing are wired). They bypass the response cache entirely:
  // `!hasPlugins` excludes them from isCacheable below, so a plugin-bearing
  // request never builds a cache key — no read, no write; a plugin result must
  // never be silently omitted or served stale under a shared message hash.
  const hasPlugins = pluginSpecs.plugins.length > 0;

  // LAY-318: resolve team-level aliases (e.g. Azure deployment names,
  // OpenAI fine-tunes) to canonical names BEFORE the allowedModels check
  // so the allowlist matches against the canonical model the user really
  // means. resolveAlias is a no-op when no alias is registered.
  // Model suffixes were stripped and aliases were resolved in
  // resolveRequestedModels(), so every downstream check sees canonical strings.

  const requestedAllowlistModels = requestedModels.explicitModels
    ? requestedModels.models.map((entry) => entry.model)
    : [rawBody.model];

  const disallowedRequestedModel = firstDisallowedModel(keyInfo.allowedModels, requestedAllowlistModels);
  if (disallowedRequestedModel) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Model is not permitted for this API key' } }));
    return;
  }

  // Fan out the three independent per-request lookups so we pay one
  // round-trip max instead of three sequentially. None of them depend
  // on each other; only `routingDecision` (computed below) needs them.
  const [billingMode, rules, teamPlan] = await Promise.all([
    getTeamBillingMode(teamId),
    getRulesForTeam(teamId),
    getTeamPlan(teamId),
  ]);
  const logPluginFailureRequest = (
    args: Omit<Parameters<typeof writePluginFailureRequest>[0], 'billingMode'>,
  ) => writePluginFailureRequest({ ...args, billingMode });
  const logTerminalFailureRequest = (
    args: Omit<Parameters<typeof writeTerminalFailureRequest>[0], 'billingMode'>,
  ) => writeTerminalFailureRequest({ ...args, billingMode });

  // --- RATE LIMIT ---
  // LAY-336: a key with an RPM override gets its own bucket. Without this,
  // two keys on the same team with different overrides share one window
  // and the higher-override key starves the others. The team-default
  // bucket is preserved when no override is set, so most keys still share.
  const rpmBucketId = keyInfo?.rateLimitOverride?.requests_per_minute
    ? `${teamId}:${keyInfo.id}`
    : teamId;
  const rateResult = rateLimiter.check(rpmBucketId, keyInfo?.rateLimitOverride?.requests_per_minute);
  if (!rateResult.allowed) {
    // LAY-331: audit-log the rate-limit hit. dedup'd inside recordAuditEvent
    // for the auth_failed type only; rate_limited is unbounded for now —
    // worth revisiting if a single key starts spamming.
    void recordAuditEvent({
      team_id: teamId,
      api_key_id: keyInfo?.id ?? null,
      key_prefix: null,
      event_type: 'rate_limited',
      details: { kind: 'rpm', reset_ms: rateResult.resetMs },
    });
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Retry-After': String(Math.ceil(rateResult.resetMs / 1000)),
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset': String(Math.ceil((Date.now() + rateResult.resetMs) / 1000)),
    });
    res.end(JSON.stringify({ error: { message: 'Rate limit exceeded' } }));
    return;
  }

  // LAY-330: per-key TPM check. Estimate input tokens from the canonical
  // messages (char/4 — same heuristic the fallback executor uses for
  // context-window checks). Pass through unchanged when the key has no
  // tokens_per_minute override, which is the common case today.
  const hasSystemMessageContent = hasSystemMessage(rawBody);
  const tpmEstimate = estimateMessageTokens(rawBody.messages)
    + (hasSystemMessageContent ? 0 : estimateContentTokens(rawSystemContentFromBody(rawBody)));
  // LAY-336: same bucket-isolation logic for TPM — a key with a TPM
  // override gets its own window so it doesn't starve sibling keys.
  const tpmBucketId = keyInfo?.rateLimitOverride?.tokens_per_minute
    ? `${teamId}:${keyInfo.id}`
    : teamId;
  const tpmResult = rateLimiter.checkTpm(
    tpmBucketId,
    tpmEstimate,
    keyInfo?.rateLimitOverride?.tokens_per_minute,
  );
  if (!tpmResult.allowed) {
    void recordAuditEvent({
      team_id: teamId,
      api_key_id: keyInfo?.id ?? null,
      key_prefix: null,
      event_type: 'rate_limited',
      details: { kind: 'tpm', reset_ms: tpmResult.resetMs },
    });
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Retry-After': String(Math.ceil(tpmResult.resetMs / 1000)),
      'X-RateLimit-Tokens-Remaining': '0',
      'X-RateLimit-Tokens-Reset': String(Math.ceil((Date.now() + tpmResult.resetMs) / 1000)),
    });
    res.end(JSON.stringify({ error: { message: 'Token-per-minute limit exceeded' } }));
    return;
  }

  // LAY-348: workspace-level TPM cap. Runs in series with the per-key
  // check above. When the per-key bucket is keyId-scoped (key has its own
  // override), the team bucket is a separate window, so both record entries.
  // When the key has no override, the per-key check is a no-op pass and
  // only the team check actually consumes the bucket — no double-count.
  let teamTpmLimit: number | null;
  try {
    teamTpmLimit = await getTeamTpmLimit(teamId);
  } catch (err) {
    // RSH-60 (error-path variant): the per-key estimate was already reserved
    // above and the finish-handler that releases it is not registered until
    // after this await. If getTeamTpmLimit rejects (DB blip), release the
    // per-key record before the error propagates to the top-level handler —
    // otherwise a phantom estimate lingers in the 60s window and falsely
    // throttles the next request on this key. No-op when recordId is null.
    rateLimiter.removeRecord(tpmResult.recordId);
    throw err;
  }
  const teamTpmResult = rateLimiter.checkTpm(teamId, tpmEstimate, teamTpmLimit ?? undefined);
  if (!teamTpmResult.allowed) {
    // RSH-60: the per-key check above already recorded its estimate in the
    // per-key bucket. Since we're rejecting here, release it so the per-key
    // window doesn't over-count a request that never went upstream. No-op when
    // the key had no override (recordId is null) or buckets coincide.
    rateLimiter.removeRecord(tpmResult.recordId);
    void recordAuditEvent({
      team_id: teamId,
      api_key_id: keyInfo?.id ?? null,
      key_prefix: null,
      event_type: 'rate_limited',
      details: { kind: 'team_tpm', reset_ms: teamTpmResult.resetMs },
    });
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Retry-After': String(Math.ceil(teamTpmResult.resetMs / 1000)),
      'X-RateLimit-Tokens-Remaining': '0',
      'X-RateLimit-Tokens-Reset': String(Math.ceil((Date.now() + teamTpmResult.resetMs) / 1000)),
      'X-RouteShift-Reason': 'team_tpm_exceeded',
    });
    res.end(JSON.stringify({ error: { message: 'Workspace token-per-minute limit exceeded' } }));
    return;
  }
  const tpmRecordIds: Array<string | null> = [tpmResult.recordId, teamTpmResult.recordId];
  // RSH-60 (generalized): release the reserved per-key + team TPM estimates once
  // this response completes via any path that did NOT reach the upstream provider.
  // The success and cache-hit paths reconcile the estimate to the upstream's
  // actual input_tokens via reconcileActualTokens() — which deletes the record —
  // *before* res.end(), so this release is a harmless no-op for them. Every other
  // return (budget 402/429, blocked route, routing/fallback failure, unsupported
  // params, missing key/pricing, circuit-breaker, upstream error, and the early
  // returns inside handleSuccessResponse) would otherwise leave a phantom estimate
  // in the 60s window that falsely throttles the next request. removeRecord() is a
  // no-op on an already-reconciled or unknown id.
  res.once('finish', () => {
    for (const id of tpmRecordIds) rateLimiter.removeRecord(id);
  });
  // --- ROUTING ---
  const originalProvider = resolveProvider(rawBody.model, EFFECTIVE_DISPATCHABLE_CHAT_MODELS);
  const estimatedInputTokens = tpmEstimate;

  // LAY-321: per-request retry budget. Defaults are deliberately generous —
  // existing customers with no header set keep the prior "walk the whole
  // chain" behavior. The body-field fallback lets SDK clients that can't
  // set request headers (e.g. browser fetch through some proxies) still
  // express a budget.
  let retryBudget: RetryBudget = {
    ...parseRetryBudget(req.headers, rawBody, estimatedInputTokens),
    effectiveModels: EFFECTIVE_DISPATCHABLE_CHAT_MODELS,
  };
  if (billingMode === 'credits' || retryBudget.maxCostMicrocents !== undefined) {
    retryBudget = {
      ...retryBudget,
      pricingResolver: getCreditPricing,
      ...(billingMode === 'credits' ? { requireKnownPricing: true } : {}),
    };
  }
  const requestedProviderPrefs = providerPreferencesFromBody(
    rawBody,
    primarySuffixPrefs,
    presetDefaults.providerPrefs,
  );
  if (!requestedProviderPrefs.ok) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid provider preferences', code: requestedProviderPrefs.reason } }));
    return;
  }
  const hasTools = Array.isArray(rawBody.tools) && rawBody.tools.length > 0;
  const hasStructuredOutput = typeof rawBody.response_format === 'object' && rawBody.response_format !== null
    && (rawBody.response_format.type === 'json_schema' || rawBody.response_format.type === 'json_object');
  let hasCodeBlocks = false;
  if (Array.isArray(rawBody.messages)) {
    for (const msg of rawBody.messages) {
      if (typeof msg.content === 'string' && msg.content.includes('```')) {
        hasCodeBlocks = true;
        break;
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text' && typeof part.text === 'string' && part.text.includes('```')) {
            hasCodeBlocks = true;
            break;
          }
        }
      }
      if (hasCodeBlocks) break;
    }
  }

  // RSH-81: detect the highest cache-write TTL tier requested. Anthropic's
  // cache_control blocks can appear on message content parts and system prompt
  // blocks with an optional `ttl` field (e.g., "1h"). If any block uses "1h",
  // we price all cache writes at the 1h tier (2.0× vs 1.25× input price).
  let cacheWriteTtl: '5m' | '1h' | undefined;
  const bodyParts: unknown[] = [];
  // Scan only the effective system content that will reach an adapter. If a
  // system message takes precedence, an ignored top-level system/system_prompt
  // must not alter cache-write billing.
  const effectiveSystemContent = rawSystemContentFromBody(rawBody);
  if (Array.isArray(effectiveSystemContent)) bodyParts.push(...effectiveSystemContent);
  // Collect non-system message content plus any message-level cache control.
  if (Array.isArray(rawBody.messages)) {
    for (const msg of rawBody.messages) {
      if (msg.role !== 'system' && Array.isArray(msg.content)) bodyParts.push(...msg.content);
      // Some requests have cache_control at the message level
      if (msg.cache_control) bodyParts.push(msg);
    }
  }
  for (const part of bodyParts) {
    const cc = (part as any)?.cache_control;
    if (cc && typeof cc === 'object' && cc.ttl === '1h') {
      cacheWriteTtl = '1h';
      break;
    }
  }
  if (!cacheWriteTtl && bodyParts.some((p) => (p as any)?.cache_control)) {
    cacheWriteTtl = '5m'; // explicit cache_control without 1h → default 5m tier
  }

  // --- RSH-139: PRE-DISPATCH GUARDRAIL SCAN ---
  let guardrailConfig: Awaited<ReturnType<typeof getGuardrailConfig>> = null;
  try {
    guardrailConfig = await getGuardrailConfig(teamId);
  } catch {
    // DB outage: fail-open (skip scan) rather than crash the request pipeline.
  }
  if (guardrailConfig && Array.isArray(rawBody.messages)) {
    const scanResult = scanMessages(rawBody.messages as any, guardrailConfig);
    if (scanResult.blocked) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: 'Request blocked by guardrail',
          code: 'guardrail_blocked',
          matches: scanResult.matches.map((m) => ({
            pattern: m.patternName,
            category: m.category,
            severity: m.severity,
          })),
        },
      }));
      return;
    }
  }

  const routingCtx: RequestContext = {
    model_requested: rawBody.model,
    provider_requested: originalProvider,
    tags: [],
    estimated_input_tokens: estimatedInputTokens,
    current_utc_hour: new Date(startTime).getUTCHours(),
    has_tools: hasTools,
    has_structured_output: hasStructuredOutput,
    has_code_blocks: hasCodeBlocks,
    reasoning_effort: rawBody.reasoning_effort,
    thinking_budget_tokens: rawBody.thinking_budget_tokens,
  };
  if (semanticPromptTaggingEnabled()) {
    routingCtx.tags.push(
      ...classifyPromptTags(semanticPromptTextFromBody(rawBody), DEFAULT_SEMANTIC_CATEGORIES),
    );
  }

  let routingDecision: RoutingDecision;
  try {
    routingDecision = evaluateRules(rules, routingCtx, EFFECTIVE_DISPATCHABLE_CHAT_MODELS);
  } catch (err) {
    if (err instanceof RouteBlockedError) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: err.message } }));
      return;
    }
    throw err;
  }

  // --- AUTO-ROUTING ---
  if (routingDecision.is_default && !requestedModels.explicitModels && !keyPresetBound) {
    // RSH-146: a key-bound preset IS the routing policy — auto-route would
    // only ever be rejected by the route-pin check, so it is skipped entirely
    // (the preset model flows through the default routing decision).
    const autoSettings = await getAutoRouteSettings(teamId);
    const providerSignals = autoSettings.enabled
      ? await getAutoRouteProviderSignals(teamId, billingMode)
      : undefined;
    // RSH-136: rolling quality verdicts are fetched ONLY when the team opted
    // in (quality_derank default false — never on by default). A read outage
    // must never fail an otherwise-serviceable request: derank is a routing
    // preference, so we log and route WITHOUT signals (fail open).
    let qualitySignals: QualityVerdictSignal[] | undefined;
    if (autoSettings.enabled && autoSettings.quality_derank) {
      try {
        // Round `since` to the current minute: the signals cache is keyed on
        // it, and a fresh ms-precision Date every request would never hit
        // (the 7-day window itself is fixed, so minute granularity is exact).
        const sinceMs = Math.floor(Date.now() / 60_000) * 60_000 - QUALITY_DERANK_WINDOW_MS;
        qualitySignals = await getQualityVerdictSignals(new Date(sinceMs));
      } catch (error) {
        console.error(`quality_verdicts read failed; routing without derank: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    routingDecision = buildAutoRouteDecision(routingCtx, autoSettings, {
      providerSignals,
      qualitySignals,
      effectiveModels: EFFECTIVE_DISPATCHABLE_CHAT_MODELS,
    });
    logAutoRouteMetadata(requestId, teamId, autoSettings.strategy, routingDecision);
  }

  const planLimits = getPlanLimits(teamPlan);

  if (requestedProviderPrefs.value) {
    const preferenceResult = await applyRoutingProviderPreferences(
      routingDecision,
      requestedProviderPrefs.value,
      teamId,
      billingMode,
      EFFECTIVE_DISPATCHABLE_CHAT_MODELS,
    );
    if (!preferenceResult.ok) {
      res.writeHead(422, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: routingPreferenceErrorMessage(preferenceResult.reason, requestedProviderPrefs.value),
          code: preferenceResult.reason,
        },
      }));
      return;
    }
  }

  if (requestedModels.explicitModels) {
    const explicitFallbacks = await buildExplicitModelFallbackChain(
      requestedModels.models.slice(1),
      requestedProviderPrefs.presetDefaults,
      requestedProviderPrefs.requestOverrides,
      teamId,
      billingMode,
      EFFECTIVE_DISPATCHABLE_CHAT_MODELS,
    );
    if (!explicitFallbacks.ok) {
      res.writeHead(422, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: routingPreferenceErrorMessage(explicitFallbacks.reason, requestedProviderPrefs.value),
          code: explicitFallbacks.reason,
        },
      }));
      return;
    }
    routingDecision.fallback_chain = requestedProviderPrefs.value?.allow_fallbacks === false
      ? []
      : explicitFallbacks.fallback_chain;
  }

  // --- PLAN ENFORCEMENT: Fallback chains ---
  if (!planLimits.fallbacksEnabled) {
    routingDecision.fallback_chain = [];
  }

  // API-key model allowlists constrain the final model that RouteShift will
  // dispatch, not just the model string supplied by the caller. Without this
  // post-routing check, a route or auto-route could silently send a restricted
  // key to a model/provider outside its scope. Unauthorized fallbacks are
  // removed rather than blocking an otherwise-authorized primary request.
  const disallowedRoutedModel = firstDisallowedModel(keyInfo.allowedModels, [routingDecision.model]);
  if (disallowedRoutedModel) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: { message: `Model ${disallowedRoutedModel} is not permitted for this API key` },
    }));
    return;
  }
  if (keyInfo.allowedModels && keyInfo.allowedModels.length > 0) {
    routingDecision.fallback_chain = routingDecision.fallback_chain.filter((entry) =>
      keyInfo.allowedModels!.includes(entry.model),
    );
  }

  // RSH-146: the KEY-BOUND preset pins the ROUTE, not just the request model —
  // a routing rule or auto-route that lands on a different model would escape
  // the org policy (the allowlist gate above only catches it when an allowlist
  // exists). Fail closed with a clear code.
  if (keyPresetBound && presetModel && routingDecision.model !== presetModel) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        message: `This API key's preset pins model ${presetModel}; routing selected ${routingDecision.model}`,
        code: 'key_preset_model_mismatch',
      },
    }));
    return;
  }
  if (keyPresetBound && presetModel) {
    routingDecision.fallback_chain = routingDecision.fallback_chain.filter((entry) => entry.model === presetModel);
  }

  const providerId = routingDecision.provider;
  const routedModel = routingDecision.model;
  const targetAssessment = assessDispatchTarget(
    providerId,
    routedModel,
    EFFECTIVE_DISPATCHABLE_CHAT_MODELS,
  );
  if (!targetAssessment.ok) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        message: `Model is not dispatchable: ${targetAssessment.reason}`,
        code: 'model_not_dispatchable',
        reason: targetAssessment.reason,
      },
    }));
    return;
  }
  if (
    targetAssessment.contextWindow !== null
    && estimatedInputTokens > targetAssessment.contextWindow
  ) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        message: `Model ${routedModel} cannot accept this request: context window is ${targetAssessment.contextWindow} tokens`,
        code: 'context_window_exceeded',
        reason: 'Context window too small',
      },
    }));
    return;
  }


  const provider = getProvider(providerId);
  if (!provider) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Unknown provider for the requested model' } }));
    return;
  }

  const nonSystemMessages = (rawBody.messages ?? []).filter((m: any) => m.role !== 'system');
  const rawSystemContent = rawSystemContentFromBody(rawBody);

  // Build canonical request
  let canonical: CanonicalRequest = {
    model: routedModel,
    messages: nonSystemMessages,
    system_prompt: canonicalSystemPromptFromContent(rawSystemContent),
    max_output_tokens: routingDecision.max_output_tokens
      ?? (rawBody.max_tokens ?? rawBody.max_completion_tokens),
    temperature: rawBody.temperature,
    tools: rawBody.tools,
    tool_choice: rawBody.tool_choice,
    response_format: rawBody.response_format,
    stream: rawBody.stream ?? false,
    provider_params: collectProviderParams(rawBody),
    reasoning_effort: routingDecision.reasoning_effort ?? rawBody.reasoning_effort,
    thinking_level: rawBody.thinking_level,
    thinking_budget_tokens: routingDecision.thinking_budget_tokens ?? rawBody.thinking_budget_tokens,
  };
  // Quality-cascade admission must use the request's declared output ceiling,
  // not the generic 4096-token fallback. This is refreshed after plugins too.
  retryBudget = {
    ...retryBudget,
    estimatedMaxOutputTokens: canonical.max_output_tokens ?? 4096,
  };

  // LAY-328: per-request fingerprint for the Optimize engine. Computed
  // once here and stamped on every logRequest call below so the
  // oversized-system-prompt and duplicate-requests rules have what they
  // need without re-reading the request body.
  let systemPromptTokens = estimateSystemPromptTokens(canonical.system_prompt);
  let messageHash = computeMessageHash(canonical);

  // Derive a session id once per request (LAY-314). Honors the explicit
  // x-routeshift-session-id / x-conversation-id headers; otherwise
  // sha256(team|key|first-message|30-min-bucket) so the same conversation
  // gets a stable id without server-side state.
  const sessionId = deriveSessionId({
    headers: req.headers as Record<string, string | undefined>,
    messages: nonSystemMessages,
    teamId,
    apiKeyId: keyInfo?.id ?? null,
    timestamp: startTime,
  });
  const layerIdentityId = layerIdentityFromMetadata(keyInfo?.metadata);

  // ─── RSH-134 §3.2 — QUALITY-GATE PRE-DISPATCH ADMISSION ──────────────────
  //
  // A gated request may dispatch SEVERAL PAID attempts. Anything the cascade
  // cannot serve safely is REFUSED here with its exact reason — never silently
  // downgraded to the ungated path, because that would serve an unverified
  // response to a customer who explicitly asked for verification.
  //
  // This runs before credit reservation and before the cache check so a refused
  // request never reserves credits and never takes a cache path.
  const configuredQualityGate = routingDecision.quality_gate;
  let qualityGate: QualityGateConfig | undefined;

  if (configuredQualityGate) {
    const refuseGate = (statusCode: number, code: string, message: string): void => {
      logTerminalFailureRequest({
        traceparent,
        requestId,
        startTime,
        teamId,
        apiKeyId: keyInfo?.id ?? null,
        layerIdentityId,
        providerId: routingDecision.provider,
        routedModel: routingDecision.model,
        requestedModel: rawBody.model,
        statusCode,
        canonical,
        sessionId,
        systemPromptTokens,
        messageHash,
        rateLimited: false,
        errorType: code,
        actualCostKnown: true,
      });
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message, code } }));
    };

    // Read-side ack gate. validateQualityGateConfig runs only on write, and
    // evaluator.ts passes stored rule actions straight through, so a gate
    // persisted before multi_attempt_billing_ack existed arrives here without
    // it. The TypeScript literal does not constrain persisted JSON.
    if (!hasMultiAttemptBillingAck(configuredQualityGate)) {
      refuseGate(
        400,
        'quality_gate_billing_ack_required',
        'This route\'s quality_gate predates the multi-attempt billing acknowledgement and cannot run. Re-save the routing rule with quality_gate.multi_attempt_billing_ack set to true to confirm that a gated request may dispatch several billable provider attempts.',
      );
      return;
    }

    if (canonical.stream) {
      // Refuse UNLESS the customer explicitly opted out with 'bypass'. Testing
      // for === 'reject' instead would fail OPEN: the write validator requires
      // on_stream, but it runs only on write, and a gate persisted before the
      // field existed arrives here with it undefined — which would then be
      // served unverified. That is the silent downgrade §3.2 forbids, and it is
      // the same stored-JSON-is-not-typed hazard the ack check above exists for.
      if (configuredQualityGate.on_stream !== 'bypass') {
        refuseGate(
          400,
          'quality_gate_streaming_unsupported',
          'This route has a quality_gate and cannot serve a streaming request: a cascade cannot replace bytes already sent. Retry with stream=false, or set quality_gate.on_stream="bypass" to serve streaming responses unverified.',
        );
        return;
      }
      // on_stream === 'bypass' — an explicit configured opt-out, not a silent
      // downgrade. Leave qualityGate undefined so the ungated path relays it.
    } else {
      // Credit-funded traffic is admitted with worst-case reservation (§4.2)
      // and atomic multi-attempt settlement (§4.3). The billing ack above
      // already communicated the multi-attempt cost consequence at config time.
      qualityGate = configuredQualityGate;
    }
  }

  let pluginWarnings: PluginWarning[] = [];
  let pluginOutcomes: PluginRunOutcome[] = [];
  let pluginSurchargeMicrocents = 0;
  let creditReservation: CreditReservationState | null = null;
  // RSH-138: the request's budget reservation. `budgetReservationRowsExist`
  // is false when no caps are configured anywhere (reserveBudget inserts no
  // rows), which gates adjust/mark calls that would otherwise 503 on zero rows.
  let budgetReservation: BudgetReservation | null = null;
  let budgetReservationRowsExist = false;

  // Credits must reserve the configured maximum plugin fee before the plugin
  // backend can make a paid call. A second admission after augmentation below
  // reconciles this conservative estimate with the measured plugin outcome and
  // expanded canonical prompt before upstream dispatch.
  const estimatedPluginSurchargeMicrocents = estimatePluginSurchargeMicrocents(pluginSpecs.plugins);
  if (billingMode === 'credits') {
    const messageChars = JSON.stringify({
      messages: canonical.messages,
      system: canonical.system_prompt ?? '',
      tools: canonical.tools ?? [],
    }).length;
    const preflight = await preFlightCreditCheck(
      teamId,
      routedModel,
      providerId,
      messageChars,
      routingDecision.max_output_tokens ?? (rawBody.max_tokens ?? rawBody.max_completion_tokens),
      planLimits.creditsMarkupPercent,
      estimatedPluginSurchargeMicrocents,
    );
    if (!preflight.allowed) {
      if (preflight.reason === 'missing_pricing') {
        logTerminalFailureRequest({
          traceparent,
          requestId,
          startTime,
          teamId,
          apiKeyId: keyInfo?.id ?? null,
          layerIdentityId,
          providerId,
          routedModel,
          requestedModel: rawBody.model,
          statusCode: 503,
          canonical,
          sessionId,
          systemPromptTokens,
          messageHash,
          rateLimited: false,
          errorType: 'missing_model_pricing',
          actualCostKnown: true,
        });
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            message: missingCreditPricingMessage(providerId, routedModel),
            code: 'missing_model_pricing',
          },
        }));
        return;
      }
      await checkAutoTopUpNeeded(teamId, preflight.balance).catch((err) => {
        console.error(`[auto-topup] preflight re-enqueue failed for team ${teamId}:`, err);
      });
      res.writeHead(402, {
        'Content-Type': 'application/json',
        'X-RouteShift-Credits-Remaining': String(preflight.balance),
        'X-RouteShift-Estimated-Cost': String(preflight.estimatedCost),
      });
      res.end(JSON.stringify({ error: { message: 'Insufficient credits' } }));
      return;
    }
    // RSH-134 §4.2: worst-case reservation for quality-gated credit traffic.
    // Reserve for EVERY candidate the cascade could dispatch, not just the
    // primary — a cascade that rejects the primary and serves a fallback
    // dispatches two paid attempts. Settling a single-attempt reservation
    // against a multi-attempt actual would either over-refund (RouteShift
    // eats the difference) or under-collect (customer billed for one attempt
    // while the provider charged for two).
    let creditReservationAmount = preflight.estimatedCost;
    if (qualityGate) {
      const projection = await projectQualityCascadeReservation(
        { provider: providerId, model: routedModel },
        routingDecision.fallback_chain,
        canonical,
        retryBudget,
      );
      if (projection.missingPricing) {
        const c = projection.missingPricing;
          logTerminalFailureRequest({
            traceparent, requestId, startTime, teamId,
            apiKeyId: keyInfo?.id ?? null, layerIdentityId,
            providerId: c.provider, routedModel: c.model,
            requestedModel: rawBody.model, statusCode: 503,
            canonical, sessionId, systemPromptTokens, messageHash,
            rateLimited: false, errorType: 'quality_gate_unpriced_candidate', actualCostKnown: true,
          });
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: {
              message: `Quality-gated routing requires known pricing for every eligible candidate, but ${c.provider}/${c.model} has no pricing data.`,
              code: 'quality_gate_unpriced_candidate',
            },
          }));
          return;
      }
      const worstCaseMarkedUp = applyMarkupMicrocents(
        projection.costMicrocents + estimatedPluginSurchargeMicrocents,
        planLimits.creditsMarkupPercent,
      );
      // Never replace a larger primary preflight estimate with a smaller
      // cascade projection: both are conservative estimates of paid work.
      const requiredReservationAmount = Math.max(preflight.estimatedCost, worstCaseMarkedUp);
      if (preflight.balance < requiredReservationAmount) {
        await checkAutoTopUpNeeded(teamId, preflight.balance).catch((err) => {
          console.error(`[auto-topup] worst-case re-enqueue failed for team ${teamId}:`, err);
        });
        res.writeHead(402, {
          'Content-Type': 'application/json',
          'X-Routeshift-Credits-Remaining': String(preflight.balance),
          'X-Routeshift-Estimated-Cost': String(requiredReservationAmount),
        });
        res.end(JSON.stringify({
          error: {
            message: 'Insufficient credits for worst-case quality-gated routing (all eligible candidates)',
            code: 'quality_gate_worst_case_insufficient',
          },
        }));
        return;
      }
      creditReservationAmount = requiredReservationAmount;
    }
    const reservation = await reserveCredits(
      teamId,
      creditReservationAmount,
      requestId,
      qualityGate
        ? `${routedModel} quality-gated worst-case (${routingDecision.fallback_chain.length + 1} candidates)`
        : `${routedModel} preflight`,
      planLimits.creditsMarkupPercent,
    );
    if (!reservation.success) {
      await checkAutoTopUpNeeded(teamId, reservation.newBalance).catch((err) => {
        console.error(`[auto-topup] reservation re-enqueue failed for team ${teamId}:`, err);
      });
      logTerminalFailureRequest({
        traceparent,
        requestId,
        startTime,
        teamId,
        apiKeyId: keyInfo?.id ?? null,
        layerIdentityId,
        providerId,
        routedModel,
        requestedModel: rawBody.model,
        statusCode: 402,
        canonical,
        sessionId,
        systemPromptTokens,
        messageHash,
        rateLimited: false,
        errorType: 'credit_reservation_failed',
        actualCostKnown: true,
      });
      res.writeHead(402, {
        'Content-Type': 'application/json',
        'X-RouteShift-Credits-Remaining': String(reservation.newBalance),
        'X-RouteShift-Estimated-Cost': String(Math.ceil(preflight.estimatedCost)),
      });
      res.end(JSON.stringify({ error: { message: 'Insufficient credits', code: 'credit_reservation_failed' } }));
      return;
    }
    creditReservation = { amountDeducted: reservation.amountDeducted, resolved: false };
  }

  try {
  // --- RSH-138: PRE-PLUGIN BUDGET RESERVATION ---
  // Conservative estimate over the entire dispatchable path — the primary plus
  // every fallback the retry policy can reach plus the configured maximum
  // plugin surcharge. Hard caps fail closed on missing pricing
  // (`budget_estimate_unavailable`); alert-only caps admit with a warning and
  // a zero estimate reservation. Reservation failures keep the existing 503
  // 'Budget service unavailable' contract, and a budget rejection here leaves
  // the independent credits reservation to the outer cleanup.
  try {
    const budgetEstimate = await estimateChatBudget({
      originalModel: rawBody.model,
      originalProvider,
      provider: providerId,
      model: routedModel,
      canonical,
      fallbackChain: routingDecision.fallback_chain,
      retryBudget,
      pluginSurchargeMicrocents: estimatedPluginSurchargeMicrocents,
    });
    const admission = await reserveBudget({
      requestId,
      teamId,
      apiKeyId: keyInfo?.id ?? null,
      identityId: isValidIdentityId(layerIdentityId) ? layerIdentityId : null,
      estimate: budgetEstimate,
    });
    if (!admission.allowed) {
      void recordAuditEvent({
        team_id: teamId,
        api_key_id: keyInfo?.id ?? null,
        key_prefix: null,
        event_type: 'budget_exceeded',
        details: admission.kind === 'exceeded'
          ? { scope: admission.scope, action: admission.action, window: admission.window, request_kind: 'chat' }
          : admission.kind === 'estimate_unavailable'
            ? { action: 'estimate_unavailable', window: admission.window, request_kind: 'chat' }
            : { action: 'unavailable', request_kind: 'chat' },
      });
      writeBudgetRejection(res, admission);
      return;
    }
    budgetReservation = admission.reservation;
    budgetReservationRowsExist = !admission.warnings.includes('no_budget_caps_configured');
  } catch (err) {
    console.error('Budget reservation failed:', err);
    void recordAuditEvent({
      team_id: teamId,
      api_key_id: keyInfo?.id ?? null,
      key_prefix: null,
      event_type: 'budget_exceeded',
      details: { action: 'unavailable', request_kind: 'chat' },
    });
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Budget service unavailable' } }));
    return;
  }

  if (hasPlugins) {
    // RSH-138: paid plugin execution is the first paid call of this request.
    // Fence it with the atomic lease check BEFORE any plugin backend call; a
    // failed mark aborts with 503 and no external call.
    if (budgetReservation && budgetReservationRowsExist && estimatedPluginSurchargeMicrocents > 0) {
      try {
        const marked = await markBudgetReservationDispatched(budgetReservation);
        if (!marked.marked) {
          logTerminalFailureRequest({
            traceparent,
            requestId,
            startTime,
            teamId,
            apiKeyId: keyInfo?.id ?? null,
            layerIdentityId,
            providerId,
            routedModel,
            requestedModel: rawBody.model,
            statusCode: 503,
            canonical,
            sessionId,
            systemPromptTokens,
            messageHash,
            rateLimited: false,
            errorType: 'budget_dispatch_mark_failed',
            actualCostKnown: true,
          });
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Budget service unavailable' } }));
          return;
        }
        budgetReservation.dispatched = true;
      } catch (err) {
        console.error('Budget dispatch mark failed:', err);
        logTerminalFailureRequest({
          traceparent,
          requestId,
          startTime,
          teamId,
          apiKeyId: keyInfo?.id ?? null,
          layerIdentityId,
          providerId,
          routedModel,
          requestedModel: rawBody.model,
          statusCode: 503,
          canonical,
          sessionId,
          systemPromptTokens,
          messageHash,
          rateLimited: false,
          errorType: 'budget_dispatch_mark_failed',
          actualCostKnown: true,
        });
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Budget service unavailable' } }));
        return;
      }
    }
    try {
      const pluginResult = await runPlugins(canonical, pluginSpecs.plugins, {
        providerId,
        routedModel,
        fallbackCandidates: routingDecision.fallback_chain,
        forceFileExtraction: pluginSpecs.fileParserExplicit,
      });
      canonical = pluginResult.canonical;
      pluginWarnings = pluginResult.warnings;
      pluginOutcomes = pluginResult.outcomes;
      pluginSurchargeMicrocents = pluginResult.surchargeMicrocents;
      logPluginWarnings(pluginWarnings);
    } catch (err) {
      if (err instanceof PluginRequiredError) {
        // Earlier plugins in a request may have succeeded and incurred a
        // deterministic fee before this required plugin failed. Preserve the
        // measured outcomes for the terminal log and make the outer credit
        // settlement retain that fee while releasing only provider spend.
        pluginWarnings = err.warnings;
        pluginOutcomes = err.outcomes;
        pluginSurchargeMicrocents = err.surchargeMicrocents;
        const requiredWarning: LoggedPluginWarning = {
          plugin: err.plugin,
          code: err.code,
          reason: err.reason,
          message: err.message,
        };
        // runPlugins carries warnings from plugins that ran before the required
        // failure. Preserve that sanitized context in the terminal request log;
        // it contains stable codes only, never file bodies or URLs.
        const requiredPluginWarnings: LoggedPluginWarning[] = [...err.warnings, requiredWarning];
        logPluginWarnings(err.warnings);
        console.warn(JSON.stringify({
          event: 'routeshift_plugin_required_failed',
          plugin: err.plugin,
          code: err.code,
          reason: err.reason,
          message: err.message,
        }));
        logPluginFailureRequest({
      traceparent,
      requestId,
          startTime,
          teamId,
          apiKeyId: keyInfo?.id ?? null,
          layerIdentityId,
          providerId,
          routedModel,
          requestedModel: rawBody.model,
          statusCode: 502,
          canonical,
          sessionId,
          systemPromptTokens,
          messageHash,
          rateLimited: false,
          pluginWarnings: requiredPluginWarnings,
          pluginRuns: err.outcomes,
          errorType: err.code,
        });
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            message: err.message,
            code: err.code,
            plugin: err.plugin,
            reason: err.reason,
          },
        }));
        // RSH-138: required-plugin failure settles the measured plugin fee only;
        // the unspent provider remainder is freed by settling the exact amount.
        budgetReservation = await settleBudgetExact(budgetReservation, pluginSurchargeMicrocents, 'plugin_only_failure');
        return;
      }
      if (err instanceof PluginUnavailableError) {
        const pluginWarningsForLog: LoggedPluginWarning[] = [{
          plugin: err.plugin,
          code: err.code,
          reason: err.reason,
          message: err.message,
        }];
        console.warn(JSON.stringify({
          event: 'routeshift_plugin_unavailable',
          plugin: err.plugin,
          code: err.code,
          reason: err.reason,
          message: err.message,
        }));
        logPluginFailureRequest({
      traceparent,
      requestId,
          startTime,
          teamId,
          apiKeyId: keyInfo?.id ?? null,
          layerIdentityId,
          providerId,
          routedModel,
          requestedModel: rawBody.model,
          statusCode: 501,
          canonical,
          sessionId,
          systemPromptTokens,
          messageHash,
          rateLimited: false,
          pluginWarnings: pluginWarningsForLog,
          pluginRuns: [],
          errorType: err.code,
        });
        res.writeHead(501, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            message: err.message,
            code: err.code,
            plugin: err.plugin,
            reason: err.reason,
          },
        }));
        // RSH-138: no plugin ran and no provider was called; free the capacity.
        budgetReservation = await settleBudgetExact(budgetReservation, 0, 'no_dispatch');
        return;
      }
      throw err;
    }
  }

  // Plugins may add system context or replace a compact file part with parsed
  // text. Recompute request observability from the actual canonical payload,
  // never the stale pre-plugin body.
  systemPromptTokens = estimateSystemPromptTokens(canonical.system_prompt);
  messageHash = computeMessageHash(canonical);

  // File parsing can turn a short URL or compressed PDF into substantial text.
  // Replace the provisional raw-body TPM estimate with the bounded canonical
  // request before any provider dispatch; retaining the same records preserves
  // later reconciliation to actual upstream usage without double-counting.
  const canonicalTpmEstimate = estimateMessageTokens(canonical.messages)
    + estimateContentTokens(canonical.system_prompt);
  // Fallback cost/context safeguards must see the same canonical input as the
  // TPM gate. Otherwise a short file URL could look free/small on a retry even
  // after its bounded extraction produced a large payload.
  retryBudget = {
    ...retryBudget,
    estimatedInputTokens: canonicalTpmEstimate,
    estimatedMaxOutputTokens: canonical.max_output_tokens ?? 4096,
  };
  if (canonicalTpmEstimate !== tpmEstimate) {
    const keyTpmUpdate = rateLimiter.updateTpmEstimate(
      tpmResult.recordId,
      canonicalTpmEstimate,
      keyInfo?.rateLimitOverride?.tokens_per_minute,
    );
    if (!keyTpmUpdate.allowed) {
      void recordAuditEvent({
        team_id: teamId,
        api_key_id: keyInfo?.id ?? null,
        key_prefix: null,
        event_type: 'rate_limited',
        details: { kind: 'tpm_post_plugin', reset_ms: keyTpmUpdate.resetMs },
      });
      logTerminalFailureRequest({
        traceparent,
        requestId,
        startTime,
        teamId,
        apiKeyId: keyInfo?.id ?? null,
        layerIdentityId,
        providerId,
        routedModel,
        requestedModel: rawBody.model,
        statusCode: 429,
        canonical,
        sessionId,
        systemPromptTokens,
        messageHash,
        rateLimited: true,
        errorType: 'post_plugin_tpm_exceeded',
        actualCostKnown: true,
        pluginWarnings,
        pluginRuns: pluginOutcomes,
      });
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': String(Math.ceil(keyTpmUpdate.resetMs / 1000)),
        'X-RateLimit-Tokens-Remaining': String(keyTpmUpdate.remaining),
        'X-RateLimit-Tokens-Reset': String(Math.ceil((Date.now() + keyTpmUpdate.resetMs) / 1000)),
        'X-RouteShift-Reason': 'post_plugin_tpm_exceeded',
      });
      res.end(JSON.stringify({ error: { message: 'Token-per-minute limit exceeded' } }));
      // RSH-138: the plugin already ran (measured fee is real spend); the
      // provider remainder is freed by exact settlement.
      budgetReservation = await settleBudgetExact(budgetReservation, pluginSurchargeMicrocents, 'no_dispatch');
      return;
    }

    const teamTpmUpdate = rateLimiter.updateTpmEstimate(
      teamTpmResult.recordId,
      canonicalTpmEstimate,
      teamTpmLimit ?? undefined,
    );
    if (!teamTpmUpdate.allowed) {
      // The key-level record may already have moved. Restore its original
      // reservation before rejecting so no request that never dispatched
      // consumes a phantom amount in the key window.
      rateLimiter.updateTpmEstimate(
        tpmResult.recordId,
        tpmEstimate,
        keyInfo?.rateLimitOverride?.tokens_per_minute,
      );
      void recordAuditEvent({
        team_id: teamId,
        api_key_id: keyInfo?.id ?? null,
        key_prefix: null,
        event_type: 'rate_limited',
        details: { kind: 'team_tpm_post_plugin', reset_ms: teamTpmUpdate.resetMs },
      });
      logTerminalFailureRequest({
        traceparent,
        requestId,
        startTime,
        teamId,
        apiKeyId: keyInfo?.id ?? null,
        layerIdentityId,
        providerId,
        routedModel,
        requestedModel: rawBody.model,
        statusCode: 429,
        canonical,
        sessionId,
        systemPromptTokens,
        messageHash,
        rateLimited: true,
        errorType: 'post_plugin_tpm_exceeded',
        actualCostKnown: true,
        pluginWarnings,
        pluginRuns: pluginOutcomes,
      });
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': String(Math.ceil(teamTpmUpdate.resetMs / 1000)),
        'X-RateLimit-Tokens-Remaining': String(teamTpmUpdate.remaining),
        'X-RateLimit-Tokens-Reset': String(Math.ceil((Date.now() + teamTpmUpdate.resetMs) / 1000)),
        'X-RouteShift-Reason': 'post_plugin_tpm_exceeded',
      });
      res.end(JSON.stringify({ error: { message: 'Workspace token-per-minute limit exceeded' } }));
      // RSH-138: the plugin already ran (measured fee is real spend); the
      // provider remainder is freed by exact settlement.
      budgetReservation = await settleBudgetExact(budgetReservation, pluginSurchargeMicrocents, 'no_dispatch');
      return;
    }
  }

  const unsupportedParams = unsupportedProviderParams(providerId, canonical.provider_params);
  if (unsupportedParams.length > 0) {
    logTerminalFailureRequest({
      traceparent,
      requestId,
      startTime,
      teamId,
      apiKeyId: keyInfo?.id ?? null,
      layerIdentityId,
      providerId,
      routedModel,
      requestedModel: rawBody.model,
      statusCode: 400,
      canonical,
      sessionId,
      systemPromptTokens,
      messageHash,
      rateLimited: false,
      errorType: 'unsupported_provider_params',
      actualCostKnown: true,
      pluginWarnings,
      pluginRuns: pluginOutcomes,
    });
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        message: `Unsupported request parameter(s) for ${providerId}: ${unsupportedParams.join(', ')}`,
        code: 'unsupported_provider_params',
        unsupported_params: unsupportedParams,
      },
    }));
    // RSH-138: post-plugin pre-dispatch failure; keep the measured plugin fee.
    budgetReservation = await settleBudgetExact(budgetReservation, pluginSurchargeMicrocents, 'no_dispatch');
    return;
  }

  // NOTE: Gemini's adapter (providers/gemini.ts) now honors response_format —
  // tools/tool_choice, inbound functionCall/functionResponse turns, AND structured
  // output (responseMimeType + responseJsonSchema). It is no longer rejected here.
  // Do not re-add a google response_format capability guard.

  // --- RSH-138: POST-PLUGIN BUDGET ADJUSTMENT ---
  // Plugins may expand the canonical request and measure a real surcharge.
  // Recompute the conservative estimate and adjust the held reservation
  // before any cache lookup or provider dispatch. On rejection, settle the
  // measured plugin cost exactly once and return the rejection — never a
  // release, and no provider call may occur. A cache hit is still subject to
  // this reservation and settles its measured served-path cost below.
  if (budgetReservation && budgetReservationRowsExist && hasPlugins) {
    try {
      const postEstimate = await estimateChatBudget({
        originalModel: rawBody.model,
        originalProvider,
        provider: providerId,
        model: routedModel,
        canonical,
        fallbackChain: routingDecision.fallback_chain,
        retryBudget,
        pluginSurchargeMicrocents,
      });
      const adjustment = await adjustBudgetReservation({
        reservation: budgetReservation,
        estimate: postEstimate,
      });
      if (!adjustment.allowed) {
        void recordAuditEvent({
          team_id: teamId,
          api_key_id: keyInfo?.id ?? null,
          key_prefix: null,
          event_type: 'budget_exceeded',
          details: adjustment.kind === 'exceeded'
            ? { scope: adjustment.scope, action: adjustment.action, window: adjustment.window, request_kind: 'chat', plugin_surcharge_microcents: pluginSurchargeMicrocents }
            : adjustment.kind === 'estimate_unavailable'
              ? { action: 'estimate_unavailable', window: adjustment.window, request_kind: 'chat' }
              : { action: 'unavailable', request_kind: 'chat' },
        });
        budgetReservation = await settleBudgetExact(budgetReservation, pluginSurchargeMicrocents, 'adjustment_reject');
        // The plugin already ran and incurred a measured fee — record the
        // terminal request row so the spend is attributed (analytics + cost).
        logTerminalFailureRequest({
          traceparent,
          requestId,
          startTime,
          teamId,
          apiKeyId: keyInfo?.id ?? null,
          layerIdentityId,
          providerId,
          routedModel,
          requestedModel: rawBody.model,
          statusCode: adjustment.statusCode,
          canonical,
          sessionId,
          systemPromptTokens,
          messageHash,
          rateLimited: false,
          errorType: 'plugin_budget_exceeded',
          actualCostKnown: true,
          // Provider cost is zero (no dispatch); the measured plugin fee is
          // carried once via plugin_runs -> plugin_cost_microcents. Passing it
          // here too would double-count it in seeding (actual + plugin).
          actualCostMicrocents: 0,
          pluginWarnings,
          pluginRuns: pluginOutcomes,
        });
        writeBudgetRejection(res, adjustment);
        return;
      }
      budgetReservation = adjustment.reservation;
    } catch (err) {
      console.error('Budget adjustment failed:', err);
      void recordAuditEvent({
        team_id: teamId,
        api_key_id: keyInfo?.id ?? null,
        key_prefix: null,
        event_type: 'budget_exceeded',
        details: { action: 'unavailable', request_kind: 'chat' },
      });
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Budget service unavailable' } }));
      return;
    }
  }

  // A plugin can expand a compact file/URL into real canonical text. Recheck
  // the already-held reservation against the post-plugin estimate and reserve
  // only its incremental amount before any provider dispatch.
  if (billingMode === 'credits' && hasPlugins) {
    const msgChars = JSON.stringify({
      messages: canonical.messages,
      system: canonical.system_prompt ?? '',
      tools: canonical.tools ?? [],
    }).length;
    const preflight = await preFlightCreditCheck(
      teamId,
      routedModel,
      providerId,
      msgChars,
      routingDecision.max_output_tokens ?? (rawBody.max_tokens ?? rawBody.max_completion_tokens),
      planLimits.creditsMarkupPercent,
      pluginSurchargeMicrocents,
      creditReservation?.amountDeducted ?? 0,
    );
    let projectedReservationCost = preflight.estimatedCost;
    let projectionMissingPricing: { provider: string; model: string } | undefined;
    if (qualityGate) {
      const projection = await projectQualityCascadeReservation(
        { provider: providerId, model: routedModel },
        routingDecision.fallback_chain,
        canonical,
        retryBudget,
      );
      const projectedCascadeReservationCost = applyMarkupMicrocents(
        projection.costMicrocents + pluginSurchargeMicrocents,
        planLimits.creditsMarkupPercent,
      );
      // A plugin may change tokenization/pricing independently of the
      // fallback projection. Retain the larger preflight bound.
      projectedReservationCost = Math.max(preflight.estimatedCost, projectedCascadeReservationCost);
      projectionMissingPricing = projection.missingPricing;
    }
    const postPluginAllowed = !projectionMissingPricing
      && preflight.balance + (creditReservation?.amountDeducted ?? 0) >= projectedReservationCost;
    if (!preflight.allowed || !postPluginAllowed) {
      if (preflight.reason === 'missing_pricing' || projectionMissingPricing) {
        const missingPricingCandidate = projectionMissingPricing
          ?? { provider: providerId, model: routedModel };
        const missingPricingCode = projectionMissingPricing
          ? 'quality_gate_unpriced_candidate'
          : 'missing_model_pricing';
        logTerminalFailureRequest({
          traceparent,
          requestId,
          startTime,
          teamId,
          apiKeyId: keyInfo?.id ?? null,
          layerIdentityId,
          providerId: missingPricingCandidate.provider,
          routedModel: missingPricingCandidate.model,
          requestedModel: rawBody.model,
          statusCode: 503,
          canonical,
          sessionId,
          systemPromptTokens,
          messageHash,
          rateLimited: false,
          errorType: missingPricingCode,
          actualCostKnown: true,
          pluginWarnings,
          pluginRuns: pluginOutcomes,
        });
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            message: missingCreditPricingMessage(
              missingPricingCandidate.provider,
              missingPricingCandidate.model,
            ),
            code: missingPricingCode,
          },
        }));
        // RSH-138: post-plugin pre-dispatch failure; keep the measured plugin fee.
        budgetReservation = await settleBudgetExact(budgetReservation, pluginSurchargeMicrocents, 'no_dispatch');
        return;
      }
      await checkAutoTopUpNeeded(teamId, preflight.balance).catch((err) => {
        console.error(`[auto-topup] post-plugin preflight re-enqueue failed for team ${teamId}:`, err);
      });
      logTerminalFailureRequest({
        traceparent,
        requestId,
        startTime,
        teamId,
        apiKeyId: keyInfo?.id ?? null,
        layerIdentityId,
        providerId,
        routedModel,
        requestedModel: rawBody.model,
        statusCode: 402,
        canonical,
        sessionId,
        systemPromptTokens,
        messageHash,
        rateLimited: false,
        errorType: 'plugin_credit_preflight_failed',
        actualCostKnown: true,
        pluginWarnings,
        pluginRuns: pluginOutcomes,
      });
      res.writeHead(402, {
        'Content-Type': 'application/json',
        'X-RouteShift-Credits-Remaining': String(preflight.balance),
        'X-RouteShift-Estimated-Cost': String(Math.ceil(projectedReservationCost)),
      });
      res.end(JSON.stringify({ error: { message: 'Insufficient credits' } }));
      // RSH-138: post-plugin pre-dispatch failure; keep the measured plugin fee.
      budgetReservation = await settleBudgetExact(budgetReservation, pluginSurchargeMicrocents, 'no_dispatch');
      return;
    }

    const reserved = creditReservation?.amountDeducted ?? 0;
    const additionalReservation = Math.max(0, Math.ceil(projectedReservationCost) - reserved);
    if (additionalReservation > 0) {
      const reservation = await reserveCredits(
        teamId,
        additionalReservation,
        requestId,
        `${routedModel} post-plugin preflight`,
        planLimits.creditsMarkupPercent,
      );
      if (!reservation.success) {
        await checkAutoTopUpNeeded(teamId, reservation.newBalance).catch((err) => {
          console.error(`[auto-topup] post-plugin reservation re-enqueue failed for team ${teamId}:`, err);
        });
        logTerminalFailureRequest({
          traceparent,
          requestId,
          startTime,
          teamId,
          apiKeyId: keyInfo?.id ?? null,
          layerIdentityId,
          providerId,
          routedModel,
          requestedModel: rawBody.model,
          statusCode: 402,
          canonical,
          sessionId,
          systemPromptTokens,
          messageHash,
          rateLimited: false,
          errorType: 'plugin_credit_reservation_failed',
          actualCostKnown: true,
          pluginWarnings,
          pluginRuns: pluginOutcomes,
        });
        res.writeHead(402, {
          'Content-Type': 'application/json',
          'X-RouteShift-Credits-Remaining': String(reservation.newBalance),
          'X-RouteShift-Estimated-Cost': String(Math.ceil(projectedReservationCost)),
        });
        res.end(JSON.stringify({ error: { message: 'Insufficient credits', code: 'credit_reservation_failed' } }));
        // RSH-138: post-plugin pre-dispatch failure; keep the measured plugin fee.
        budgetReservation = await settleBudgetExact(budgetReservation, pluginSurchargeMicrocents, 'no_dispatch');
        return;
      }
      if (creditReservation) creditReservation.amountDeducted += reservation.amountDeducted;
    }
  }

  // --- CACHE CHECK ---
  // Derive the cache key once and reuse it on both the get (here) and
  // the set (after the upstream call) — buildKey hashes the full
  // messages array so doing it twice was a measurable hot-path tax.
  // RSH-134 §3.3: a gated request bypasses BOTH cache lookup and cache fill.
  // The cache key does not include any verifier semantics, so a cached entry
  // could otherwise be served without verification, or a verdict produced under
  // one gate could leak to a request configured with a different one. Revisiting
  // this requires putting a gate fingerprint in the key.
  const isCacheable = !hasPlugins && !qualityGate && responseCache.isCacheable(canonical);
  const cacheKey = isCacheable ? responseCache.buildKey(teamId, canonical, providerId) : null;
  if (cacheKey) {
    const cached = responseCache.get(cacheKey);
    if (cached) {
      const cost = await computeRequestCost(rawBody.model, originalProvider, cached.model, cached.provider, { ...cached.usage, cache_write_ttl: cacheWriteTtl });

      // LAY-330: reconcile TPM estimate with the cached request's actual
      // input_token count — keeps the window honest when the request had
      // no upstream call to learn from.
      rateLimiter.reconcileActualTokens(tpmRecordIds, cached.usage.input_tokens);

      if (billingMode === 'credits') {
        if (!(await getCreditPricing(cached.provider, cached.model))) {
          logTerminalFailureRequest({
      traceparent,
      requestId,
            startTime,
            teamId,
            apiKeyId: keyInfo?.id ?? null,
            layerIdentityId,
            providerId: cached.provider,
            routedModel: cached.model,
            requestedModel: rawBody.model,
            statusCode: 503,
            canonical,
            sessionId,
            systemPromptTokens,
            messageHash,
            rateLimited: false,
            errorType: 'missing_model_pricing',
            actualCostKnown: true,
          });
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: {
              message: missingCreditPricingMessage(cached.provider, cached.model),
              code: 'missing_model_pricing',
            },
          }));
          return;
        }
        const result = await settleReservedCredits(
          teamId,
          creditReservation?.amountDeducted ?? 0,
          cost.actual_cost_microcents,
          planLimits.creditsMarkupPercent,
          requestId,
          `cache hit: ${cached.model}`,
        );
        // Only mark resolved on success: settleReservedCredits' two failure
        // branches (missing balance row / already-at-floor) write NOTHING to
        // the DB, so the original reservation decrement is still held. Leaving
        // resolved=false lets the outer finally attempt a release instead of
        // stranding that reservation forever behind a 402 the customer never
        // benefits from.
        if (creditReservation && result.success) creditReservation.resolved = true;
        if (!result.success) {
          logTerminalFailureRequest({
      traceparent,
      requestId,
            startTime,
            teamId,
            apiKeyId: keyInfo?.id ?? null,
            layerIdentityId,
            providerId: cached.provider,
            routedModel: cached.model,
            requestedModel: rawBody.model,
            statusCode: 402,
            canonical,
            sessionId,
            systemPromptTokens,
            messageHash,
            rateLimited: false,
            errorType: 'credit_deduction_failed',
            actualCostKnown: true,
          });
          res.writeHead(402, {
            'Content-Type': 'application/json',
            'X-RouteShift-Credits-Remaining': String(result.newBalance),
          });
          res.end(JSON.stringify({ error: { message: 'Insufficient credits', code: 'credit_deduction_failed' } }));
          return;
        }
        // Best-effort side effect: a failed auto top-up check must not turn an
        // already-successful (credits deducted) response into a 500.
        await checkAutoTopUpNeeded(teamId, result.newBalance).catch((err) => {
          console.error('Auto top-up check failed (cache hit):', err);
        });
      }

      // RSH-138: a cache hit is still subject to the reservation; settle the
      // measured served-path cost of the current request.
      budgetReservation = await settleBudgetExact(budgetReservation, cost.actual_cost_microcents, 'cache_hit');

      res.setHeader('X-RouteShift-Request-Id', requestId);
      res.setHeader('X-RouteShift-Model', cached.model);
      res.setHeader('X-RouteShift-Provider', cached.provider);
      res.setHeader('X-RouteShift-Cache', 'HIT');
      res.setHeader('X-RateLimit-Remaining', String(rateResult.remaining));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(cached.body));

      logRequest({
        id: requestId,
        timestamp: new Date().toISOString(),
        team_id: teamId,
        billing_mode: billingMode,
        api_key_id: keyInfo?.id ?? null,
        layer_identity_id: layerIdentityId,
        traceparent,
        provider: cached.provider,
        model_requested: rawBody.model,
        model_resolved: cached.model,
        input_tokens: cached.usage.input_tokens,
        output_tokens: cached.usage.output_tokens,
        reasoning_tokens: cached.usage.reasoning_tokens,
        cache_read_tokens: cached.usage.cache_read_tokens,
        cache_write_tokens: cached.usage.cache_write_tokens,
        total_tokens: cached.usage.total_tokens,
        ...cost,
        total_latency_ms: Date.now() - startTime,
        ttft_ms: null,
        is_streaming: false,
        is_fallback: false,
        status_code: 200,
        cache_hit: true,
        // Cache eligibility excludes tool-using requests (response-cache.ts:34),
        // so categorize sees no tool_calls here — only message-side signals.
        activity_category: categorize({ messages: canonical.messages, toolCalls: [] }),
        session_id: sessionId,
        edited_paths: [],
        had_bash: false,
        system_prompt_tokens: systemPromptTokens,
        message_hash: messageHash,
      });

      return;
    }
  }

  // Get upstream API key + metadata
  let upstream: import('./billing/provider-key-crypto.js').ProviderKeyConfig | undefined;
  try {
    upstream = await resolveUpstreamConfig(providerId, teamId, billingMode);
  } catch (err) {
    if (err instanceof ProviderKeyDecryptError) {
      // PROVIDER_KEY_SECRET likely rotated without re-saving the keys. Make
      // the action distinct from "no key configured" so the dashboard can
      // surface a "re-save your key" prompt.
      logTerminalFailureRequest({
      traceparent,
      requestId,
        startTime,
        teamId,
        apiKeyId: keyInfo?.id ?? null,
        layerIdentityId,
        providerId,
        routedModel,
        requestedModel: rawBody.model,
        statusCode: 503,
        canonical,
        sessionId,
        systemPromptTokens,
        messageHash,
        rateLimited: false,
        errorType: 'provider_key_decrypt_failed',
        actualCostKnown: true,
        pluginWarnings,
        pluginRuns: pluginOutcomes,
      });
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: `Provider key for ${providerId} could not be decrypted. The encryption secret may have rotated — re-save the key in the dashboard's Provider Keys page.`,
          code: 'provider_key_decrypt_failed',
        },
      }));
      // RSH-138: no dispatch occurred; free the reservation.
      budgetReservation = await settleBudgetExact(budgetReservation, pluginSurchargeMicrocents, 'no_dispatch');
      return;
    }
    throw err;
  }
  if (!upstream) {
    // Configuration error, not a server fault — 503 (service-not-yet-configured)
    // with a hint pointing the user at where to fix it.
    const needsTeamCreds = billingMode === 'subscription';
    const message = needsTeamCreds
      ? `${providerId} requires a team-configured provider key. Save one via the dashboard's Provider Keys page.`
      : `No API key configured for ${providerId}`;
    logTerminalFailureRequest({
      traceparent,
      requestId,
      startTime,
      teamId,
      apiKeyId: keyInfo?.id ?? null,
      layerIdentityId,
      providerId,
      routedModel,
      requestedModel: rawBody.model,
      statusCode: 503,
      canonical,
      sessionId,
      systemPromptTokens,
      messageHash,
      rateLimited: false,
      errorType: 'upstream_config_missing',
      actualCostKnown: true,
      pluginWarnings,
      pluginRuns: pluginOutcomes,
    });
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message } }));
    // RSH-138: no dispatch occurred; free the reservation.
    budgetReservation = await settleBudgetExact(budgetReservation, pluginSurchargeMicrocents, 'no_dispatch');
    return;
  }
  const apiKey = upstream.key;
  const upstreamMetadata = upstream.metadata;
  const upstreamLabel = upstream.label ?? null;
  // Ungated traffic dispatches this pre-resolved credential below. Gated
  // traffic must wait for the cascade's actual dispatch callback instead.
  let rateLimited = !qualityGate && upstream.selected_after_cooldown_skip === true;

  // ─── RSH-134 §3.1 — QUALITY-GATED CASCADE ────────────────────────────────
  //
  // Branch on the gate here, where `executeFallbackChain` would otherwise be
  // reached, so both paths see the identically filtered chain (key allow-list,
  // provider preferences, endpoint fanout have all already been applied).
  //
  // The cascade owns its own circuit checks, credential resolution, budget
  // ceilings and fallback iteration, so it replaces the whole ungated dispatch
  // flow below rather than layering on it. Requests with no gate never enter
  // this branch and are byte-identical to before.
  if (qualityGate) {
    // RSH-138: fence the first cascade dispatch with the atomic lease check.
    // A failed mark aborts before any provider call.
    if (budgetReservation && budgetReservationRowsExist && !budgetReservation.dispatched) {
      try {
        const marked = await markBudgetReservationDispatched(budgetReservation);
        if (!marked.marked) {
          logTerminalFailureRequest({
            traceparent,
            requestId,
            startTime,
            teamId,
            apiKeyId: keyInfo?.id ?? null,
            layerIdentityId,
            providerId,
            routedModel,
            requestedModel: rawBody.model,
            statusCode: 503,
            canonical,
            sessionId,
            systemPromptTokens,
            messageHash,
            rateLimited: false,
            errorType: 'budget_dispatch_mark_failed',
            actualCostKnown: true,
          });
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Budget service unavailable' } }));
          return;
        }
        budgetReservation.dispatched = true;
      } catch (err) {
        console.error('Budget dispatch mark failed:', err);
        logTerminalFailureRequest({
          traceparent,
          requestId,
          startTime,
          teamId,
          apiKeyId: keyInfo?.id ?? null,
          layerIdentityId,
          providerId,
          routedModel,
          requestedModel: rawBody.model,
          statusCode: 503,
          canonical,
          sessionId,
          systemPromptTokens,
          messageHash,
          rateLimited: false,
          errorType: 'budget_dispatch_mark_failed',
          actualCostKnown: true,
        });
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Budget service unavailable' } }));
        return;
      }
    }
    const cascadeResult = await executeQualityCascade({
      canonical,
      gate: qualityGate,
      primary: { provider: providerId, model: routedModel },
      primaryConfig: {
        key: upstream.key,
        metadata: upstream.metadata,
        label: upstream.label,
        selected_after_cooldown_skip: upstream.selected_after_cooldown_skip,
      },
      fallbackChain: routingDecision.fallback_chain,
      effectiveModels: EFFECTIVE_DISPATCHABLE_CHAT_MODELS,
      getProvider,
      getProviderConfig: async (provider: string) => {
        const config = await resolveUpstreamConfig(provider, teamId, billingMode);
        // Existing provider keys may not have a usable label. They remain
        // dispatchable; credential-specific observability below simply skips
        // them, matching the ungated path.
        if (!config) return undefined;
        return {
          key: config.key,
          metadata: config.metadata,
          label: config.label,
          selected_after_cooldown_skip: config.selected_after_cooldown_skip,
        };
      },
      onAttemptStart: ({ provider, credentialLabel, selectedAfterCooldownSkip }) => {
        rateLimited ||= selectedAfterCooldownSkip === true;
        if (credentialLabel) incrementInFlight(teamId, provider, credentialLabel);
      },
      onAttemptFinish: ({ provider, credentialLabel }) => {
        if (credentialLabel) decrementInFlight(teamId, provider, credentialLabel);
      },
      onAttemptRateLimited: ({ provider, credentialLabel }) => {
        if (credentialLabel) markCooldown(teamId, provider, credentialLabel);
      },
      // Per-attempt ACTUAL cost from real usage, priced for that attempt's own
      // provider/model — not the routed one, since a fallback may differ.
      computeCost: async (attemptProvider, attemptModel, usage) => {
        const cost = await computeRequestCost(rawBody.model, originalProvider, attemptModel, attemptProvider, usage);
        return {
          actualCostMicrocents: cost.actual_cost_microcents,
          actualCostKnown: cost.actual_cost_known !== false,
          reasoningCostMicrocents: cost.reasoning_cost_microcents,
        };
      },
      budget: retryBudget,
    });
    // RSH-136: persist the cascade's sanitized verdicts. Deliberately NOT
    // awaited — the response is still in flight and a slow DB must not
    // extend the request's latency; insertQualityVerdicts never throws (the
    // whole body is guarded), so the fire-and-forget cannot produce an
    // unhandled rejection. Rows feed the rolling quality derank.
    void insertQualityVerdicts(requestId, cascadeResult.audit);
    // Preserve the request-level rate-limit signal when any dispatched cascade
    // attempt saw an upstream 429, even if a later candidate served the request.
    // The audit retains each attempt's exact status/reason for diagnostics.
    rateLimited ||= cascadeResult.audit.some((row) => row.status_code === 429);

    // Dispatched attempts that did not serve the response, PLUS candidates the
    // cascade skipped before dispatch — each with its exact reason preserved. A
    // quality rejection, a provider failure and an eligibility skip all land
    // here but stay distinguishable by their own strings
    // ('quality_gate_empty_content' vs 'HTTP 503' vs 'Circuit breaker open')
    // rather than collapsing into one bucket. Dropping `skips` would leave an
    // operator unable to tell "no fallback configured" from "fallback skipped:
    // circuit open".
    // Excludes the served attempt by POSITION in the audit array. Pass -1 (the
    // failure path) to exclude nothing. Position, not `attempt_index` value:
    // see the servedPos derivation below for why the value comparison was a
    // money-path liability.
    const attemptsBefore = (servedPos: number) => [
      ...cascadeResult.audit
        .filter((_, i) => i !== servedPos)
        .map((row) => ({
          provider: row.provider,
          model: row.model,
          error: row.reason_code ?? row.outcome,
          actual_cost_known: row.actual_cost_known,
        })),
      ...cascadeResult.skips.map((skip) => ({
        provider: skip.provider,
        model: skip.model,
        error: skip.reason,
      })),
    ];

    if (cascadeResult.ok) {
      // Identify the served attempt by its own outcome, and hold onto its
      // POSITION. `ok: true` is produced in exactly one place — the 'verified'
      // case of the cascade loop, which pushes that row and returns immediately
      // — so an ok:true audit contains exactly one 'verified' row and this is
      // exact.
      //
      // Position rather than `attempt_index` value, because every consumer below
      // is money-critical and a value comparison silently inherits an invariant
      // that lives in another file. `filter(row => row.attempt_index !== served)`
      // drops EVERY row sharing the served index (under-counting prior spend if
      // indices were ever duplicated) and, if `attempt_index` were ever absent,
      // matches the served row too — folding the served attempt into prior spend
      // while handleSuccessResponse prices it again from real usage, billing it
      // twice. Both are unreachable today (`attempt_index: i` is the
      // candidate-loop counter, unique and always set) but nothing here enforced
      // that, and all four review lanes independently reached for this filter.
      // Positional matching makes the arithmetic true by construction instead.
      const servedPos = cascadeResult.audit.findIndex((row) => row.outcome === 'verified');
      const servedRow = servedPos >= 0 ? cascadeResult.audit[servedPos] : undefined;

      // Spend the provider already billed for attempts that were dispatched and
      // rejected before this one. handleSuccessResponse prices only the served
      // attempt, so without threading this through, a cascade that rejected a
      // primary and served a fallback would report — and meter savings share
      // against — a cost the customer did not actually incur.
      const priorAttempts = cascadeResult.audit.filter((_, i) => i !== servedPos);
      const priorCost = priorAttempts.reduce((sum, row) => sum + row.actual_cost_microcents, 0);
      const priorCostKnown = priorAttempts.every((row) => row.actual_cost_known !== false);
      const priorInput = priorAttempts.reduce((sum, row) => sum + row.input_tokens, 0);
      const priorOutput = priorAttempts.reduce((sum, row) => sum + row.output_tokens, 0);
      const priorReasoningTelemetry = aggregateReasoningTelemetry(priorAttempts);

      // handleSuccessResponse touches its Response argument in exactly two
      // places: relayStream (unreachable — streaming is refused above) and
      // `await upstreamRes.json()`. A JSON round-trip is value-preserving, so
      // this is equivalent FOR THOSE TWO USES, and avoids refactoring a
      // money-path function. It is not a general-purpose clone: upstream
      // headers (provider request ids, upstream rate-limit headers) are not
      // carried on the cascade's AttemptOutcome and are therefore absent. That
      // matches today's behaviour — handleSuccessResponse builds its own
      // response headers and never forwards upstream ones — but if it ever
      // starts forwarding them, this call site has to carry them too.
      const servedResponse = new Response(JSON.stringify(cascadeResult.outcome.rawBody), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

      res.setHeader('X-RateLimit-Remaining', String(rateResult.remaining));
      res.setHeader('X-RateLimit-Reset', String(Math.ceil((Date.now() + rateResult.resetMs) / 1000)));
      res.setHeader('X-RouteShift-Quality-Gate', 'PASS');
      res.setHeader('X-RouteShift-Quality-Attempts', String(cascadeResult.audit.length));
      await handleSuccessResponse(
        servedResponse,
        cascadeResult.provider,
        cascadeResult.providerId,
        cascadeResult.model,
        res,
        canonical,
        rawBody,
        originalProvider,
        requestId,
        startTime,
        // Provisional answer to RSH-134 §6 Q3: is_fallback means "the primary
        // did not serve this". This one IS a statement about the candidate the
        // cascade chose, so it reads `attempt_index` rather than a position:
        // the executor sets `attempt_index: i` from the candidate loop and
        // treats `i === 0` as the primary, so index 0 means the primary served.
        // A candidate skipped pre-dispatch still consumes its index, so a
        // skipped primary correctly yields a non-zero served index here.
        // `undefined !== 0` is true, so a (structurally impossible) missing
        // served row reports a fallback rather than silently claiming the
        // primary served. The exact per-attempt reason codes ride along in
        // fallback_attempts, so an operator can still tell a quality rejection
        // from a provider failure. Q3 remains the owner's to settle;
        // `request_logs.is_fallback` is read by the dashboard fallback surfaces.
        servedRow?.attempt_index !== 0,
        teamId,
        keyInfo?.id ?? null,
        billingMode,
        planLimits,
        // §3.3: no cache fill for a gated response.
        null,
        sessionId,
        rateLimited,
        tpmRecordIds,
        layerIdentityId,
        attemptsBefore(servedPos),
        pluginWarnings,
        creditReservation,
        budgetReservation,
        traceparent,
        cacheWriteTtl,
        pluginOutcomes,
        pluginSurchargeMicrocents,
        priorCost,
        priorInput,
        priorOutput,
        servedRow?.reasoning_tokens !== undefined
          ? servedRow.reasoning_tokens
          : cascadeResult.outcome.usage.reasoning_tokens,
        servedRow?.reasoning_cost_microcents !== undefined
          ? servedRow.reasoning_cost_microcents
          : cascadeResult.outcome.reasoningCostMicrocents,
        priorReasoningTelemetry.tokens,
        priorReasoningTelemetry.cost,
        priorCostKnown,
        priorAttempts.length,
      );
      return;
    }

    // Failed cascade. Attempts that reached a provider ARE real spend, so the
    // single request_logs row carries the aggregate rather than 0 (§3.4).
    const failureCode =
      cascadeResult.reason === 'terminal'
        ? cascadeResult.terminalReasonCode ?? 'quality_gate_verifier_error'
        : 'quality_gate_exhausted';
    // A non-retryable upstream status ends the cascade; surface it the way the
    // ungated path does — pass it through, but map 401/403 to 502 so an
    // upstream credential fault is never mistaken for the caller's own key
    // being rejected.
    const upstreamStatus = cascadeResult.terminalStatusCode;
    const statusCode =
      failureCode === 'quality_gate_billing_ack_required'
        ? 400
        : failureCode === 'missing_model_pricing'
          ? 503
        : upstreamStatus !== undefined
          ? (upstreamStatus === 401 || upstreamStatus === 403 ? 502 : upstreamStatus)
          : 502;
    const totals = cascadeResult.audit.reduce(
      (acc, row) => ({ input: acc.input + row.input_tokens, output: acc.output + row.output_tokens }),
      { input: 0, output: 0 },
    );
    const reasoningTelemetry = aggregateReasoningTelemetry(cascadeResult.audit);

    // A failed cascade still burned real upstream tokens. The res.once('finish')
    // hook releases every tpmRecordId on completion, which is right for failures
    // that never reached a provider — but releasing here would hand back
    // capacity that was actually consumed, letting a team bypass its TPM cap by
    // failing gates. Reconcile to the real total first (removeRecord is then a
    // no-op on an already-reconciled id), mirroring the success path's
    // reconcile-before-respond ordering.
    if (totals.input > 0) rateLimiter.reconcileActualTokens(tpmRecordIds, totals.input);

    logTerminalFailureRequest({
      traceparent,
      requestId,
      startTime,
      teamId,
      apiKeyId: keyInfo?.id ?? null,
      layerIdentityId,
      providerId,
      routedModel,
      requestedModel: rawBody.model,
      statusCode,
      canonical,
      sessionId,
      systemPromptTokens,
      messageHash,
      rateLimited,
      errorType: failureCode,
      fallbackAttempts: attemptsBefore(-1),
      pluginWarnings,
      pluginRuns: pluginOutcomes,
      actualCostMicrocents: cascadeResult.aggregateCostMicrocents,
      actualCostKnown: cascadeResult.aggregateUnknownCostAttempts === 0,
      inputTokens: totals.input,
      outputTokens: totals.output,
      reasoningTokens: reasoningTelemetry.tokens,
      reasoningCostMicrocents: reasoningTelemetry.cost,
    });
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        message: `No candidate passed the configured quality gate for ${routedModel}`,
        code: failureCode,
        quality_attempts: cascadeResult.audit.length,
        fallback_attempts: attemptsBefore(-1),
      },
    }));
    // RSH-134 §4.3: settle the aggregate ACTUAL cost of dispatched attempts
    // against the worst-case reservation. Without this, the finally block
    // refunds the entire reservation and RouteShift absorbs the cascade's
    // real provider spend. A rejected-but-dispatched attempt IS real spend.
    if (creditReservation && !creditReservation.resolved && cascadeResult.aggregateUnknownCostAttempts === 0) {
      try {
        // These attempts already reached providers and their aggregate cost is
        // exact. From this point a failed settlement must retain the original
        // reservation: falling through to finally would "release" it at zero
        // and refund real provider spend.
        creditReservation.resolved = true;
        await settleReservedCredits(
          teamId,
          creditReservation.amountDeducted,
          cascadeResult.aggregateCostMicrocents + pluginSurchargeMicrocents,
          planLimits.creditsMarkupPercent,
          requestId,
          `${routedModel} quality cascade failed (${cascadeResult.audit.length} attempts, aggregate settlement)`,
        );
      } catch (err) {
        console.error(JSON.stringify({
          event: 'routeshift_cascade_credit_settlement_failed',
          request_id: requestId,
          team_id: teamId,
          aggregate_cost_microcents: cascadeResult.aggregateCostMicrocents,
          reserved_microcents: creditReservation.amountDeducted,
          error: err instanceof Error ? err.message : String(err),
        }));
        captureException(err, {
          tags: { source: 'cascade_credit_settlement', handler: 'chat_proxy' },
        });
      }
    } else if (creditReservation && !creditReservation.resolved) {
      await settleUnknownCostReservation({
        reservation: creditReservation,
        teamId,
        requestId,
        knownActualCostMicrocents:
          cascadeResult.aggregateCostMicrocents + pluginSurchargeMicrocents,
        attempts: cascadeResult.audit.map((row) => ({
          provider: row.provider,
          model: row.model,
          actual_cost_known: row.actual_cost_known,
          observed_cost_microcents: row.actual_cost_microcents,
        })),
        canonical,
        markupPercent: planLimits.creditsMarkupPercent,
        reasonCode: failureCode,
        description: `${routedModel} quality cascade unknown-cost hold`,
      });
    }
    // RSH-138: dispatched cascade attempts are real spend. Settle the exact
    // aggregate (known) or hold the unresolved remainder at the known lower
    // bound (unknown); never release after dispatch.
    budgetReservation = cascadeResult.aggregateUnknownCostAttempts === 0
      ? await settleBudgetExact(budgetReservation, cascadeResult.aggregateCostMicrocents + pluginSurchargeMicrocents, 'no_dispatch')
      : await settleBudgetUnknown(budgetReservation, cascadeResult.aggregateCostMicrocents + pluginSurchargeMicrocents, 'upstream_unknown');
    return;
  }

  // --- CIRCUIT BREAKER CHECK ---
  if (circuitBreaker.isOpen(providerId, routedModel)) {
    if (routingDecision.fallback_chain.length > 0) {
      // RSH-138: the fallback chain is the first dispatch here; fence it.
      if (budgetReservation && budgetReservationRowsExist && !budgetReservation.dispatched) {
        try {
          const marked = await markBudgetReservationDispatched(budgetReservation);
          if (!marked.marked) {
            logTerminalFailureRequest({
              traceparent,
              requestId,
              startTime,
              teamId,
              apiKeyId: keyInfo?.id ?? null,
              layerIdentityId,
              providerId,
              routedModel,
              requestedModel: rawBody.model,
              statusCode: 503,
              canonical,
              sessionId,
              systemPromptTokens,
              messageHash,
              rateLimited: false,
              errorType: 'budget_dispatch_mark_failed',
              actualCostKnown: true,
            });
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Budget service unavailable' } }));
            return;
          }
          budgetReservation.dispatched = true;
        } catch (err) {
          console.error('Budget dispatch mark failed:', err);
          logTerminalFailureRequest({
            traceparent,
            requestId,
            startTime,
            teamId,
            apiKeyId: keyInfo?.id ?? null,
            layerIdentityId,
            providerId,
            routedModel,
            requestedModel: rawBody.model,
            statusCode: 503,
            canonical,
            sessionId,
            systemPromptTokens,
            messageHash,
            rateLimited: false,
            errorType: 'budget_dispatch_mark_failed',
            actualCostKnown: true,
          });
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Budget service unavailable' } }));
          return;
        }
      }
      const fallbackResult = await executeFallbackChain(
        routingDecision.fallback_chain,
        canonical,
        (provider: string) => resolveUpstreamConfig(provider, teamId, billingMode),
        { provider: providerId, model: routedModel, error: 'Circuit breaker open' },
        retryBudget,
      );
      if (fallbackResult.ok) {
        const fallbackAccounting = fallbackSuccessAccounting(fallbackResult);
        res.setHeader('X-RateLimit-Remaining', String(rateResult.remaining));
        res.setHeader('X-RateLimit-Reset', String(Math.ceil((Date.now() + rateResult.resetMs) / 1000)));
        await handleSuccessResponse(
          fallbackResult.response,
          fallbackResult.provider,
          fallbackResult.providerId,
          fallbackResult.model,
          res,
          canonical,
          rawBody,
          originalProvider,
          requestId,
          startTime,
          true,
          teamId,
          keyInfo?.id ?? null,
          billingMode,
          planLimits,
          cacheKey,
          sessionId,
          rateLimited,
          tpmRecordIds,
          layerIdentityId,
          fallbackResult.attempts,
          pluginWarnings,
          creditReservation,
          budgetReservation,
          traceparent,
          cacheWriteTtl,
          pluginOutcomes,
          pluginSurchargeMicrocents,
          fallbackAccounting.costMicrocents,
          fallbackAccounting.inputTokens,
          fallbackAccounting.outputTokens,
          undefined,
          undefined,
          undefined,
          undefined,
          fallbackAccounting.costKnown,
          fallbackAccounting.priorAttemptCount,
        );
        return;
      }
      const fallbackCost = fallbackLowerBoundState(fallbackResult.attempts);
      logTerminalFailureRequest({
      traceparent,
      requestId,
        startTime,
        teamId,
        apiKeyId: keyInfo?.id ?? null,
        layerIdentityId,
        providerId,
        routedModel,
        requestedModel: rawBody.model,
        statusCode: 503,
        canonical,
        sessionId,
        systemPromptTokens,
        messageHash,
        rateLimited,
        errorType: 'fallback_exhausted',
        fallbackAttempts: fallbackResult.attempts,
        pluginWarnings,
        pluginRuns: pluginOutcomes,
        actualCostKnown: fallbackCost.actualCostKnown,
        actualCostMicrocents: fallbackCost.actualCostMicrocents,
        inputTokens: fallbackCost.inputTokens,
        outputTokens: fallbackCost.outputTokens,
      });
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: `Service temporarily unavailable for ${routedModel}`,
          code: 'fallback_exhausted',
          fallback_attempts: fallbackResult.attempts,
        },
      }));
      if (!fallbackCost.actualCostKnown) {
        await settleUnknownCostReservation({
          reservation: creditReservation,
          teamId,
          requestId,
          knownActualCostMicrocents: pluginSurchargeMicrocents,
          attempts: fallbackResult.attempts,
          canonical,
          markupPercent: planLimits.creditsMarkupPercent,
          reasonCode: 'fallback_exhausted',
          description: `${routedModel} circuit-open fallback unknown-cost hold`,
        });
      }
      // RSH-138: dispatched fallback attempts either cost exactly (all known)
      // or leave an unresolved remainder at the known lower bound.
      budgetReservation = fallbackCost.actualCostKnown
        ? await settleBudgetExact(budgetReservation, pluginSurchargeMicrocents, 'no_dispatch')
        : await settleBudgetUnknown(budgetReservation, pluginSurchargeMicrocents, 'upstream_unknown');
      return;
    }
    logTerminalFailureRequest({
      traceparent,
      requestId,
      startTime,
      teamId,
      apiKeyId: keyInfo?.id ?? null,
      layerIdentityId,
      providerId,
      routedModel,
      requestedModel: rawBody.model,
      statusCode: 503,
      canonical,
      sessionId,
      systemPromptTokens,
      messageHash,
      rateLimited,
      errorType: 'circuit_breaker_open',
      actualCostKnown: true,
      pluginWarnings,
      pluginRuns: pluginOutcomes,
    });
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Service temporarily unavailable for ${routedModel}` } }));
    // RSH-138: no dispatch occurred; free the reservation.
    budgetReservation = await settleBudgetExact(budgetReservation, pluginSurchargeMicrocents, 'no_dispatch');
    return;
  }

  // Build provider request. Some providers throw with actionable messages when
  // config is wrong (e.g. Azure missing resource_name, Bedrock with stream:true).
  // Ordinary config errors are 400s; provider errors retain their status.
  let providerReq: ProviderRequest;
  try {
    providerReq = provider.buildRequest(canonical, apiKey, upstreamMetadata);
  } catch (err) {
    const statusCode = err instanceof ProxyError ? err.statusCode : 400;
    logTerminalFailureRequest({
      traceparent,
      requestId,
      startTime,
      teamId,
      apiKeyId: keyInfo?.id ?? null,
      layerIdentityId,
      providerId,
      routedModel,
      requestedModel: rawBody.model,
      statusCode,
      canonical,
      sessionId,
      systemPromptTokens,
      messageHash,
      rateLimited,
      errorType: 'provider_request_build_failed',
      actualCostKnown: true,
      pluginWarnings,
      pluginRuns: pluginOutcomes,
    });
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: (err as Error).message } }));
    // RSH-138: no dispatch occurred; free the reservation.
    budgetReservation = await settleBudgetExact(budgetReservation, pluginSurchargeMicrocents, 'pre_dispatch_build');
    return;
  }

  // Set response headers
  res.setHeader('X-RouteShift-Request-Id', requestId);
  res.setHeader('X-RouteShift-Model', canonical.model);
  res.setHeader('X-RouteShift-Provider', providerId);

  // LAY-327: track in-flight for least-busy selection + latency on completion.
  if (upstreamLabel) incrementInFlight(teamId, providerId, upstreamLabel);
  // RSH-138: fence the first provider fetch with the atomic lease check.
  if (budgetReservation && budgetReservationRowsExist && !budgetReservation.dispatched) {
    try {
      const marked = await markBudgetReservationDispatched(budgetReservation);
      if (!marked.marked) {
        if (upstreamLabel) decrementInFlight(teamId, providerId, upstreamLabel);
        logTerminalFailureRequest({
          traceparent,
          requestId,
          startTime,
          teamId,
          apiKeyId: keyInfo?.id ?? null,
          layerIdentityId,
          providerId,
          routedModel,
          requestedModel: rawBody.model,
          statusCode: 503,
          canonical,
          sessionId,
          systemPromptTokens,
          messageHash,
          rateLimited: false,
          errorType: 'budget_dispatch_mark_failed',
          actualCostKnown: true,
        });
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Budget service unavailable' } }));
        return;
      }
      budgetReservation.dispatched = true;
    } catch (err) {
      console.error('Budget dispatch mark failed:', err);
      if (upstreamLabel) decrementInFlight(teamId, providerId, upstreamLabel);
      logTerminalFailureRequest({
        traceparent,
        requestId,
        startTime,
        teamId,
        apiKeyId: keyInfo?.id ?? null,
        layerIdentityId,
        providerId,
        routedModel,
        requestedModel: rawBody.model,
        statusCode: 503,
        canonical,
        sessionId,
        systemPromptTokens,
        messageHash,
        rateLimited: false,
        errorType: 'budget_dispatch_mark_failed',
        actualCostKnown: true,
      });
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Budget service unavailable' } }));
      return;
    }
  }
  const upstreamStart = Date.now();
  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(providerReq.url, {
      method: providerReq.method,
      headers: providerReq.headers,
      body: providerReq.body,
    });
  } catch (err) {
    // A failed fetch (DNS, connection reset, TLS) is an upstream fault, not a
    // handler crash. Clean up the in-flight gauge, record the primary failure,
    // and try configured fallbacks just like retryable HTTP failures.
    if (upstreamLabel) decrementInFlight(teamId, providerId, upstreamLabel);
    circuitBreaker.recordFailure(providerId, routedModel);
    if (upstreamLabel) markCooldown(teamId, providerId, upstreamLabel);
    console.error('Upstream request failed:', err);
    if (routingDecision.fallback_chain.length > 0) {
      const fallbackResult = await executeFallbackChain(
        routingDecision.fallback_chain,
        canonical,
        (provider: string) => resolveUpstreamConfig(provider, teamId, billingMode),
        {
          provider: providerId,
          model: routedModel,
          error: `Network error: ${(err as Error).message ?? String(err)}`,
          // A fetch rejection can occur after upstream acceptance. Its zero
          // observable usage/cost is a lower bound, never a free attempt.
          actual_cost_known: false,
        },
        retryBudget,
      );

      if (fallbackResult.ok) {
        const fallbackAccounting = fallbackSuccessAccounting(fallbackResult);
        res.setHeader('X-RateLimit-Remaining', String(rateResult.remaining));
        res.setHeader('X-RateLimit-Reset', String(Math.ceil((Date.now() + rateResult.resetMs) / 1000)));
        await handleSuccessResponse(
          fallbackResult.response,
          fallbackResult.provider,
          fallbackResult.providerId,
          fallbackResult.model,
          res,
          canonical,
          rawBody,
          originalProvider,
          requestId,
          startTime,
          true,
          teamId,
          keyInfo?.id ?? null,
          billingMode,
          planLimits,
          cacheKey,
          sessionId,
          rateLimited,
          tpmRecordIds,
          layerIdentityId,
          fallbackResult.attempts,
          pluginWarnings,
          creditReservation,
          budgetReservation,
          traceparent,
          cacheWriteTtl,
          pluginOutcomes,
          pluginSurchargeMicrocents,
          fallbackAccounting.costMicrocents,
          fallbackAccounting.inputTokens,
          fallbackAccounting.outputTokens,
          undefined,
          undefined,
          undefined,
          undefined,
          fallbackAccounting.costKnown,
          fallbackAccounting.priorAttemptCount,
        );
        return;
      }
      logTerminalFailureRequest({
      traceparent,
      requestId,
        startTime,
        teamId,
        apiKeyId: keyInfo?.id ?? null,
        layerIdentityId,
        providerId,
        routedModel,
        requestedModel: rawBody.model,
        statusCode: 502,
        canonical,
        sessionId,
        systemPromptTokens,
        messageHash,
        rateLimited,
        errorType: 'fallback_exhausted',
        fallbackAttempts: fallbackResult.attempts,
        pluginWarnings,
        pluginRuns: pluginOutcomes,
        actualCostKnown: fallbackResult.attempts.every((attempt) => attempt.actual_cost_known !== false),
      });
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: 'Upstream request failed',
          code: 'fallback_exhausted',
          fallback_attempts: fallbackResult.attempts,
        },
      }));
      await settleUnknownCostReservation({
        reservation: creditReservation,
        teamId,
        requestId,
        knownActualCostMicrocents: pluginSurchargeMicrocents,
        attempts: fallbackResult.attempts,
        canonical,
        markupPercent: planLimits.creditsMarkupPercent,
        reasonCode: 'fallback_exhausted',
        description: `${routedModel} fetch-rejection fallback unknown-cost hold`,
      });
      // RSH-138: dispatched attempts either cost exactly or leave an
      // unresolved remainder at the known lower bound.
      const networkFallbackCostKnown = fallbackResult.attempts.every((attempt) => attempt.actual_cost_known !== false);
      budgetReservation = networkFallbackCostKnown
        ? await settleBudgetExact(budgetReservation, pluginSurchargeMicrocents, 'no_dispatch')
        : await settleBudgetUnknown(budgetReservation, pluginSurchargeMicrocents, 'upstream_unknown');
      return;
    }

    if (!res.headersSent) {
      logTerminalFailureRequest({
      traceparent,
      requestId,
        startTime,
        teamId,
        apiKeyId: keyInfo?.id ?? null,
        layerIdentityId,
        providerId,
        routedModel,
        requestedModel: rawBody.model,
        statusCode: 502,
        canonical,
        sessionId,
        systemPromptTokens,
        messageHash,
        rateLimited,
        errorType: 'upstream_network_error',
        pluginWarnings,
        pluginRuns: pluginOutcomes,
        actualCostKnown: false,
      });
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Upstream request failed' } }));
    }
    await settleUnknownCostReservation({
      reservation: creditReservation,
      teamId,
      requestId,
      knownActualCostMicrocents: pluginSurchargeMicrocents,
      attempts: [{
        provider: providerId,
        model: routedModel,
        actual_cost_known: false,
      }],
      canonical,
      markupPercent: planLimits.creditsMarkupPercent,
      reasonCode: 'upstream_network_error',
      description: `${routedModel} fetch-rejection unknown-cost hold`,
    });
    // RSH-138: the upstream may have billed despite the network failure; hold
    // the unresolved remainder at the known lower bound.
    budgetReservation = await settleBudgetUnknown(budgetReservation, pluginSurchargeMicrocents, 'upstream_unknown');
    return;
  }
  if (upstreamLabel) {
    recordLatency(teamId, providerId, upstreamLabel, Date.now() - upstreamStart);
    decrementInFlight(teamId, providerId, upstreamLabel);
  }

  try {
    if (!upstreamRes.ok) {
      const retryable = upstreamRes.status >= 500 || upstreamRes.status === 429;

      if (retryable) {
        circuitBreaker.recordFailure(providerId, routedModel);
      }

      // LAY-320 (429) + LAY-327 (5xx): cool down this credential for 30s
      // on either signal so selectKey() routes around it on the next
      // request. 429 also sets rate_limited=true on the log.
      if (upstreamRes.status === 429 && upstreamLabel) {
        markCooldown(teamId, providerId, upstreamLabel);
        rateLimited = true;
      } else if (upstreamRes.status >= 500 && upstreamLabel) {
        markCooldown(teamId, providerId, upstreamLabel);
      }

      if (retryable && routingDecision.fallback_chain.length > 0) {
        const fallbackResult = await executeFallbackChain(
          routingDecision.fallback_chain,
          canonical,
          (provider: string) => resolveUpstreamConfig(provider, teamId, billingMode),
          {
            provider: providerId,
            model: routedModel,
            error: `HTTP ${upstreamRes.status}`,
            actual_cost_known: upstreamRes.status < 500,
          },
          retryBudget,
        );

        if (fallbackResult.ok) {
          const fallbackAccounting = fallbackSuccessAccounting(fallbackResult);
          res.setHeader('X-RateLimit-Remaining', String(rateResult.remaining));
          res.setHeader('X-RateLimit-Reset', String(Math.ceil((Date.now() + rateResult.resetMs) / 1000)));
          await handleSuccessResponse(
            fallbackResult.response,
            fallbackResult.provider,
            fallbackResult.providerId,
            fallbackResult.model,
            res,
            canonical,
            rawBody,
            originalProvider,
            requestId,
            startTime,
            true,
            teamId,
            keyInfo?.id ?? null,
            billingMode,
            planLimits,
            cacheKey,
            sessionId,
            rateLimited,
            tpmRecordIds,
            layerIdentityId,
            fallbackResult.attempts,
            pluginWarnings,
            creditReservation,
            budgetReservation,
          traceparent,
          cacheWriteTtl,
          pluginOutcomes,
          pluginSurchargeMicrocents,
          fallbackAccounting.costMicrocents,
          fallbackAccounting.inputTokens,
          fallbackAccounting.outputTokens,
          undefined,
          undefined,
          undefined,
          undefined,
          fallbackAccounting.costKnown,
          fallbackAccounting.priorAttemptCount,
          );
          return;
        }
        const mappedStatus = (upstreamRes.status === 401 || upstreamRes.status === 403) ? 502 : upstreamRes.status;
        const fallbackCost = fallbackLowerBoundState(fallbackResult.attempts);
        logTerminalFailureRequest({
      traceparent,
      requestId,
          startTime,
          teamId,
          apiKeyId: keyInfo?.id ?? null,
          layerIdentityId,
          providerId,
          routedModel,
          requestedModel: rawBody.model,
          statusCode: mappedStatus,
          canonical,
          sessionId,
          systemPromptTokens,
          messageHash,
          rateLimited,
          errorType: 'fallback_exhausted',
          fallbackAttempts: fallbackResult.attempts,
          pluginWarnings,
          pluginRuns: pluginOutcomes,
          actualCostKnown: fallbackCost.actualCostKnown,
          actualCostMicrocents: fallbackCost.actualCostMicrocents,
          inputTokens: fallbackCost.inputTokens,
          outputTokens: fallbackCost.outputTokens,
        });
        res.writeHead(mappedStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            message: 'Fallback chain exhausted after upstream retryable error',
            code: 'fallback_exhausted',
            fallback_attempts: fallbackResult.attempts,
          },
        }));
        if (!fallbackCost.actualCostKnown) {
          await settleUnknownCostReservation({
            reservation: creditReservation,
            teamId,
            requestId,
            knownActualCostMicrocents: pluginSurchargeMicrocents,
            attempts: fallbackResult.attempts,
            canonical,
            markupPercent: planLimits.creditsMarkupPercent,
            reasonCode: 'fallback_exhausted',
            description: `${routedModel} retryable fallback unknown-cost hold`,
          });
        }
        // RSH-138: dispatched attempts either cost exactly or leave an
        // unresolved remainder at the known lower bound.
        budgetReservation = fallbackCost.actualCostKnown
          ? await settleBudgetExact(budgetReservation, pluginSurchargeMicrocents, 'no_dispatch')
          : await settleBudgetUnknown(budgetReservation, pluginSurchargeMicrocents, 'upstream_unknown');
        return;
      }

      const errorBody = await upstreamRes.text();
      let parsed: unknown;
      try { parsed = JSON.parse(errorBody); } catch { parsed = { message: errorBody }; }
      const proxyErr = provider.normalizeError(upstreamRes.status, parsed);
      const mappedStatus = (upstreamRes.status === 401 || upstreamRes.status === 403) ? 502 : upstreamRes.status;
      logTerminalFailureRequest({
      traceparent,
      requestId,
        startTime,
        teamId,
        apiKeyId: keyInfo?.id ?? null,
        layerIdentityId,
        providerId,
        routedModel,
        requestedModel: rawBody.model,
        statusCode: mappedStatus,
        canonical,
        sessionId,
        systemPromptTokens,
        messageHash,
        rateLimited,
        errorType: 'upstream_http_error',
        pluginWarnings,
        pluginRuns: pluginOutcomes,
        actualCostKnown: upstreamRes.status < 500,
      });
      res.writeHead(mappedStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: proxyErr.message } }));
      if (upstreamRes.status >= 500) {
        await settleUnknownCostReservation({
          reservation: creditReservation,
          teamId,
          requestId,
          knownActualCostMicrocents: pluginSurchargeMicrocents,
          attempts: [{
            provider: providerId,
            model: routedModel,
            actual_cost_known: false,
          }],
          canonical,
          markupPercent: planLimits.creditsMarkupPercent,
          reasonCode: 'upstream_http_5xx',
          description: `${routedModel} upstream-5xx unknown-cost hold`,
        });
        // RSH-138: a 5xx may have been billed; hold the unresolved remainder.
        budgetReservation = await settleBudgetUnknown(budgetReservation, pluginSurchargeMicrocents, 'upstream_unknown');
      } else {
        // RSH-138: a 4xx is known zero provider spend; free the reservation
        // (the measured plugin fee is kept).
        budgetReservation = await settleBudgetExact(budgetReservation, pluginSurchargeMicrocents, 'no_dispatch');
      }
      return;
    }

    circuitBreaker.recordSuccess(providerId, routedModel);
    res.setHeader('X-RateLimit-Remaining', String(rateResult.remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil((Date.now() + rateResult.resetMs) / 1000)));
    await handleSuccessResponse(
      upstreamRes,
      provider,
      providerId,
      routedModel,
      res,
      canonical,
      rawBody,
      originalProvider,
      requestId,
      startTime,
      false,
      teamId,
      keyInfo?.id ?? null,
      billingMode,
      planLimits,
      cacheKey,
      sessionId,
      rateLimited,
      tpmRecordIds,
      layerIdentityId,
      [],
      pluginWarnings,
      creditReservation,
      budgetReservation,
          traceparent,
          cacheWriteTtl,
      pluginOutcomes,
      pluginSurchargeMicrocents,
    );
  } catch (err) {
    console.error('Upstream response handling failed:', err);
    // Do NOT reconcile the TPM estimate to 0 here. Latency was already recorded
    // above, so by this point the upstream HAS returned a response — a throw
    // here is a post-response processing failure (body parse / pricing lookup /
    // settlement) for a request that already consumed upstream tokens. The
    // success path reconciles actual tokens before any throwable step, so the
    // records are already settled; zeroing them would release real consumed
    // tokens from the rolling window and let a pricing/accounting outage bypass
    // per-key and team TPM caps. Genuine no-token failures (the upstream never
    // responded) are handled by the dispatch catch above, where the estimate
    // simply ages out of the 60s window.
    // handleSuccessResponse classifies its own 2xx processing failures once it
    // knows whether provider cost was established. This outer catch is now
    // principally for non-2xx body/adapter failures: only a provider 5xx is an
    // ambiguous billed dispatch; 4xx/429 remain exact zero-spend outcomes.
    const costUnknown = upstreamRes.status >= 500;
    if (costUnknown) {
      await settleUnknownCostReservation({
        reservation: creditReservation,
        teamId,
        requestId,
        knownActualCostMicrocents: pluginSurchargeMicrocents,
        attempts: [{
          provider: providerId,
          model: routedModel,
          actual_cost_known: false,
        }],
        canonical,
        markupPercent: planLimits.creditsMarkupPercent,
        reasonCode: 'upstream_http_response_error',
        description: `${routedModel} HTTP-response unknown-cost hold`,
      });
      // RSH-138: the upstream may have billed; hold the unresolved remainder.
      budgetReservation = await settleBudgetUnknown(budgetReservation, pluginSurchargeMicrocents, 'upstream_unknown');
    }
    if (!res.headersSent) {
      logTerminalFailureRequest({
      traceparent,
      requestId,
        startTime,
        teamId,
        apiKeyId: keyInfo?.id ?? null,
        layerIdentityId,
        providerId,
        routedModel,
        requestedModel: rawBody.model,
        statusCode: 502,
        canonical,
        sessionId,
        systemPromptTokens,
        messageHash,
        rateLimited,
        errorType: costUnknown ? 'upstream_response_cost_unknown' : 'upstream_response_error',
        pluginWarnings,
        pluginRuns: pluginOutcomes,
        actualCostKnown: !costUnknown,
      });
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Upstream request failed' } }));
    }
  }
  } finally {
    if (creditReservation && !creditReservation.resolved) {
      try {
        const releaseResult = await settleReservedCredits(
          teamId,
          creditReservation.amountDeducted,
          pluginSurchargeMicrocents,
          planLimits.creditsMarkupPercent,
          requestId,
          pluginSurchargeMicrocents > 0
            ? `${routedModel} (provider reservation released; plugin surcharge settled)`
            : `${routedModel} (reservation released)`,
        );
        if (!releaseResult.success) {
          const err = new Error('Credit reservation release returned success=false');
          console.error(JSON.stringify({
            event: 'routeshift_credit_reservation_release_failed',
            request_id: requestId,
            team_id: teamId,
            provider: providerId,
            model: routedModel,
            reserved_microcents: creditReservation.amountDeducted,
            balance_microcents: releaseResult.newBalance,
          }));
          captureException(err, {
            tags: { source: 'credit_reservation_release', handler: 'chat_proxy' },
            extra: {
              request_id: requestId,
              team_id: teamId,
              provider: providerId,
              model: routedModel,
              reserved_microcents: creditReservation.amountDeducted,
              balance_microcents: releaseResult.newBalance,
            },
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(JSON.stringify({
          event: 'routeshift_credit_reservation_release_failed',
          request_id: requestId,
          team_id: teamId,
          provider: providerId,
          model: routedModel,
          reserved_microcents: creditReservation.amountDeducted,
          error: message,
        }));
        captureException(err, {
          tags: { source: 'credit_reservation_release', handler: 'chat_proxy' },
          extra: {
            request_id: requestId,
            team_id: teamId,
            provider: providerId,
            model: routedModel,
            reserved_microcents: creditReservation.amountDeducted,
          },
        });
      }
    }
    // RSH-138: safety net for pre-dispatch returns that never settled. A
    // dispatched or already-terminal reservation is never released here — a
    // dispatched row without an explicit terminal transition is left for lease
    // reclamation into unknown-held, never refunded.
    if (budgetReservation && !budgetReservation.terminal && !budgetReservation.dispatched) {
      try {
        await releaseBudgetReservation(budgetReservation, 'no_dispatch');
      } catch (err) {
        reportBudgetLedgerFailure(budgetReservation, 'no_dispatch', err);
      }
    }
  }
}
type PostHogToolCall = {
  id?: string;
  function: {
    name: string;
    arguments: string;
  };
};

function capturePostHogGeneration(args: {
  teamId: string;
  layerIdentityId: string | null;
  requestId: string;
  sessionId: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  startTime: number;
  totalCostMicrocents?: number;
  stream: boolean;
  timeToFirstTokenMs?: number | null;
  priorAttemptCount?: number;
  stopReason?: string;
  isError?: boolean;
  error?: string;
  toolCalls?: readonly PostHogToolCall[];
}): void {
  const distinctId = resolveDistinctId({
    layerIdentityId: args.layerIdentityId,
    teamId: args.teamId,
  });
  const userId = args.layerIdentityId
    ? pseudonymizeIdentity(args.layerIdentityId)
    : undefined;
  const sessionId = pseudonymizeIdentity(args.sessionId) ?? undefined;

  captureAiGeneration({
    distinctId,
    userId,
    traceId: args.requestId,
    sessionId,
    model: args.model,
    provider: args.provider,
    inputTokens: args.inputTokens,
    outputTokens: args.outputTokens,
    latencySeconds: Math.max(0, (Date.now() - args.startTime) / 1000),
    totalCostMicrocents: args.totalCostMicrocents,
    stream: args.stream,
    timeToFirstTokenSeconds: args.timeToFirstTokenMs == null
      ? undefined
      : args.timeToFirstTokenMs / 1000,
    stopReason: args.stopReason,
    isError: args.isError,
    error: args.error,
    toolCalls: args.toolCalls,
    priorAttemptCount: args.priorAttemptCount ?? 0,
  });
}

async function handleSuccessResponse(
  upstreamRes: Response,
  provider: import('./providers/types.js').LLMProvider,
  activeProviderId: string,
  activeModel: string,
  res: ServerResponse,
  canonical: CanonicalRequest,
  rawBody: any,
  originalProvider: string,
  requestId: string,
  startTime: number,
  is_fallback: boolean,
  teamId: string,
  apiKeyId: string | null,
  billingMode: 'subscription' | 'credits',
  planLimits: import('./billing/plan-limits.js').PlanLimits,
  cacheKey: string | null,
  sessionId: string,
  rateLimited: boolean = false,
  tpmRecordIds: Array<string | null> = [],
  layerIdentityId: string | null = null,
  fallbackAttempts: FallbackAttempt[] = [],
  pluginWarnings: PluginWarning[] = [],
  creditReservation: CreditReservationState | null = null,
  budgetReservation: BudgetReservation | null = null,
  traceparent: string | null = null,
  cacheWriteTtl: '5m' | '1h' | undefined = undefined,
  pluginRuns: PluginRunOutcome[] = [],
  pluginSurchargeMicrocents: number = 0,
  // RSH-134: spend and tokens from quality-cascade attempts that were
  // dispatched and billed BEFORE the one being served. Default 0, so every
  // existing caller is unchanged. Not folded into pluginSurchargeMicrocents —
  // that is a separately metered surcharge, and mixing them would double-count
  // in plugin_cost_microcents.
  priorAttemptCostMicrocents: number = 0,
  priorAttemptInputTokens: number = 0,
  priorAttemptOutputTokens: number = 0,
  servedReasoningTokens: ReasoningTelemetryValue = undefined,
  servedReasoningCostMicrocents: ReasoningTelemetryValue = undefined,
  priorAttemptReasoningTokens: ReasoningTelemetryValue = undefined,
  priorAttemptReasoningCostMicrocents: ReasoningTelemetryValue = undefined,
  priorAttemptCostKnown: boolean = true,
  priorAttemptCount: number = 0,
): Promise<void> {
  const logTerminalFailureRequest = (
    args: Omit<Parameters<typeof writeTerminalFailureRequest>[0], 'billingMode'>,
  ) => writeTerminalFailureRequest({ ...args, billingMode });
  // LAY-328: recompute the request fingerprint here rather than threading
  // it through this already-long parameter list. Both helpers are cheap
  // (chars/4 + sha256 trunc 16) and `canonical` is the same object the
  // outer scope used.
  const systemPromptTokens = estimateSystemPromptTokens(canonical.system_prompt);
  const messageHash = computeMessageHash(canonical);
  setPluginWarningHeaders(res, pluginWarnings);
  let knownProviderCostMicrocents: number | null = null;
  let observedInputTokens = priorAttemptInputTokens;
  let observedOutputTokens = priorAttemptOutputTokens;

  try {
  if (billingMode === 'credits' && !(await getCreditPricing(activeProviderId, activeModel))) {
    await settleUnknownCostReservation({
      reservation: creditReservation,
      teamId,
      requestId,
      knownActualCostMicrocents: pluginSurchargeMicrocents + priorAttemptCostMicrocents,
      attempts: [
        ...fallbackAttempts.filter((attempt) => attempt.actual_cost_known === false),
        { provider: activeProviderId, model: activeModel, actual_cost_known: false },
      ],
      canonical,
      markupPercent: planLimits.creditsMarkupPercent,
      reasonCode: 'missing_model_pricing_after_dispatch',
      description: `${activeModel} post-dispatch pricing-gap unknown-cost hold`,
    });
    // RSH-138: the served attempt's cost is unpriceable; hold the unresolved
    // remainder at the known lower bound (plugin fee + prior attempts).
    budgetReservation = await settleBudgetUnknown(
      budgetReservation,
      pluginSurchargeMicrocents + priorAttemptCostMicrocents,
      'upstream_unknown',
    );
    logTerminalFailureRequest({
      traceparent,
      requestId,
      startTime,
      teamId,
      apiKeyId,
      layerIdentityId,
      providerId: activeProviderId,
      routedModel: activeModel,
      requestedModel: rawBody.model,
      statusCode: 503,
      canonical,
      sessionId,
      systemPromptTokens,
      messageHash,
      rateLimited,
      errorType: 'missing_model_pricing',
      fallbackAttempts,
      pluginWarnings,
      pluginRuns,
      actualCostKnown: false,
      inputTokens: observedInputTokens,
      outputTokens: observedOutputTokens,
    });
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        message: missingCreditPricingMessage(activeProviderId, activeModel),
        code: 'missing_model_pricing',
      },
    }));
    return;
  }

  if (canonical.stream) {
    const creditLeaseActive = billingMode === 'credits' && creditReservation && !creditReservation.resolved;
    const budgetLeaseActive = budgetReservation != null && !budgetReservation.terminal;
    const result = await relayStream(
      upstreamRes,
      res,
      provider,
      creditLeaseActive || budgetLeaseActive
        ? {
          intervalMs: 5 * 60 * 1000,
          refresh: async () => {
            if (creditLeaseActive) await heartbeatCreditReservation(teamId, requestId);
            if (budgetLeaseActive && budgetReservation) {
              const lease = await refreshBudgetReservationLease(budgetReservation);
              if (!lease.refreshed) {
                // The watchdog may have reclaimed the reservation while bytes
                // were in flight. Throw the relay's heartbeat sentinel so the
                // stream is recorded as an unknown outcome rather than exact —
                // a generic error would leave streamCostKnown true and exact-
                // settle an ambiguously delivered stream.
                throw new Error('Credit reservation heartbeat failed');
              }
            }
          },
        }
        : undefined,
    );
    let usage = provider.extractUsage(result.chunks);
    // Providers without streaming usage reporting (Groq, Qwen — see
    // OpenAICompatProvider streaming_usage:false) never emit a usage chunk, so
    // extractUsage cannot report input tokens and returns input_tokens=0.
    // Billing the input at zero under-charges and skews usage analytics, so
    // fall back to the same char/4 estimate used for the TPM and
    // context-window checks (system prompt + string message content).
    if (usage.input_tokens === 0 && usage.output_tokens > 0) {
      const estimatedInput = systemPromptTokens + estimateMessageTokens(canonical.messages);
      if (estimatedInput > 0) {
        usage = {
          ...usage,
          input_tokens: estimatedInput,
          total_tokens: estimatedInput + usage.output_tokens,
        };
      }
    }
    // LAY-330: replace the pre-flight estimate with the upstream-reported
    // input_tokens count.
    rateLimiter.reconcileActualTokens(tpmRecordIds, usage.input_tokens + priorAttemptInputTokens);
    // RSH-81: stamp the detected cache-write TTL tier so calculateCostMicrocents
    // applies the correct multiplier (1.25× for 5m, 2.0× for 1h).
    if (cacheWriteTtl) usage = { ...usage, cache_write_ttl: cacheWriteTtl };
    const cost = await computeRequestCost(rawBody.model, originalProvider, activeModel, activeProviderId, usage);
    const aggregateStreamReasoningTokens = combineReasoningTelemetry(
      usage.reasoning_tokens,
      priorAttemptReasoningTokens,
      priorAttemptCount > 0,
    );
    const aggregateStreamReasoningCost = combineReasoningTelemetry(
      cost.reasoning_cost_microcents,
      priorAttemptReasoningCostMicrocents,
      priorAttemptCount > 0,
    );
    const servedStreamCostKnown = cost.actual_cost_known !== false && usage.total_tokens > 0;
    // A failed lease renewal means the watchdog may have taken ownership of
    // this reservation while bytes were in flight. Even if usage happened to
    // arrive before the failure, retain a durable unknown-cost hold instead of
    // exact-settling or releasing an ambiguously delivered stream.
    const creditReservationHeartbeatFailed = result.streamError === 'credit_reservation_heartbeat_failed';
    const streamCostKnown = !creditReservationHeartbeatFailed && servedStreamCostKnown && priorAttemptCostKnown;
    if (streamCostKnown) {
      knownProviderCostMicrocents = cost.actual_cost_microcents + priorAttemptCostMicrocents;
    }
    const streamToolCalls = extractToolCallsFromChunks(result.chunks);
    let streamCreditDeductionFailed = false;

    if (billingMode === 'credits' && streamCostKnown) {
      // relayStream() already delivered the response. Mark the reservation
      // non-releasable before settlement so a thrown database error cannot
      // fall through to finally and refund provider spend.
      if (creditReservation) creditReservation.resolved = true;
      // Unlike the cache-hit/non-stream settle points above, relayStream()
      // already sent the full response body to the client before this call —
      // there is no way to withhold content on a failed settle. Always mark
      // resolved (regardless of success) so the outer finally never re-releases
      // (refunds) a reservation for content the customer already received; a
      // failed settle is loudly alerted instead, not silently written off via
      // release.
      try {
        const settlementResult = await settleReservedCredits(
          teamId,
          creditReservation?.amountDeducted ?? 0,
          cost.actual_cost_microcents + pluginSurchargeMicrocents,
          planLimits.creditsMarkupPercent,
          requestId,
          `${activeModel} (${usage.total_tokens} tokens)`,
        );
        if (settlementResult.success) {
          await checkAutoTopUpNeeded(teamId, settlementResult.newBalance).catch((err) => {
            console.error('Auto top-up check failed (stream settle):', err);
          });
        } else {
          streamCreditDeductionFailed = true;
          console.error(JSON.stringify({
            event: 'routeshift_credit_deduction_failed',
            request_id: requestId,
            team_id: teamId,
            provider: activeProviderId,
            model: activeModel,
            balance_microcents: settlementResult.newBalance,
          }));
          captureException(new Error('Streaming credit settlement failed after response delivered'), {
            tags: { source: 'credit_settlement', handler: 'stream' },
            extra: {
              request_id: requestId,
              team_id: teamId,
              provider: activeProviderId,
              model: activeModel,
              reserved_microcents: creditReservation?.amountDeducted ?? 0,
              actual_cost_microcents: cost.actual_cost_microcents,
              balance_microcents: settlementResult.newBalance,
            },
          });
        }
      } catch (err) {
        streamCreditDeductionFailed = true;
        console.error(JSON.stringify({
          event: 'routeshift_credit_settlement_failed',
          request_id: requestId,
          team_id: teamId,
          provider: activeProviderId,
          model: activeModel,
          error: err instanceof Error ? err.message : String(err),
        }));
        captureException(err, {
          tags: { source: 'credit_settlement', handler: 'stream' },
          extra: {
            request_id: requestId,
            team_id: teamId,
            provider: activeProviderId,
            model: activeModel,
            reserved_microcents: creditReservation?.amountDeducted ?? 0,
            actual_cost_microcents: cost.actual_cost_microcents,
          },
        });
      }
    } else if (billingMode === 'credits') {
      const unknownAttempts: UnknownCostAttempt[] = fallbackAttempts
        .filter((attempt) => attempt.actual_cost_known === false);
      if (!servedStreamCostKnown || creditReservationHeartbeatFailed) {
        unknownAttempts.push({
          provider: activeProviderId,
          model: activeModel,
          actual_cost_known: false,
        });
      }
      await settleUnknownCostReservation({
        reservation: creditReservation,
        teamId,
        requestId,
        knownActualCostMicrocents:
          priorAttemptCostMicrocents
          + (servedStreamCostKnown ? cost.actual_cost_microcents : 0)
          + pluginSurchargeMicrocents,
        attempts: unknownAttempts,
        canonical,
        markupPercent: planLimits.creditsMarkupPercent,
        reasonCode: creditReservationHeartbeatFailed
          ? 'credit_reservation_heartbeat_failed'
          : 'stream_usage_unknown',
        description: `${activeModel} streaming unknown-cost hold`,
      });
    }

    // RSH-138: streaming outcome. Exact cost settles the served aggregate; a
    // heartbeat failure or unpriceable usage holds the unresolved remainder.
    if (budgetReservation && !budgetReservation.terminal) {
      budgetReservation = streamCostKnown
        ? await settleBudgetExact(budgetReservation, cost.actual_cost_microcents + priorAttemptCostMicrocents + pluginSurchargeMicrocents, 'no_dispatch')
        : await settleBudgetUnknown(
            budgetReservation,
            priorAttemptCostMicrocents + (servedStreamCostKnown ? cost.actual_cost_microcents : 0) + pluginSurchargeMicrocents,
            creditReservationHeartbeatFailed ? 'stream_heartbeat_failure' : 'upstream_unknown',
          );
    }

    // Log the status the relay actually emitted (502 when the upstream had no
    // body) instead of hard-coding 200, and surface a mid-stream client abort —
    // both were previously computed by relayStream but dropped on the floor.
    let streamErrorType: string | undefined;
    if (creditReservationHeartbeatFailed) {
      streamErrorType = 'credit_reservation_heartbeat_failed';
    } else if (!streamCostKnown) {
      streamErrorType = 'stream_usage_unknown';
    } else if (streamCreditDeductionFailed) {
      streamErrorType = 'credit_deduction_failed';
    } else if (result.statusCode !== 200) {
      streamErrorType = 'upstream_no_body';
    } else if (result.streamError) {
      streamErrorType = result.streamError;
    } else if (result.clientAborted) {
      streamErrorType = 'client_aborted';
    }

    logRequest({
      id: requestId,
      timestamp: new Date().toISOString(),
      team_id: teamId,
      billing_mode: billingMode,
      api_key_id: apiKeyId,
      layer_identity_id: layerIdentityId,
      traceparent,
      provider: activeProviderId,
      model_requested: rawBody.model,
      model_resolved: activeModel,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      reasoning_tokens: aggregateStreamReasoningTokens,
      cache_read_tokens: usage.cache_read_tokens,
      cache_write_tokens: usage.cache_write_tokens,
      total_tokens: usage.total_tokens,
      ...cost,
      reasoning_cost_microcents: aggregateStreamReasoningCost,
      // Zero observed stream usage is not evidence that provider pricing was
      // known. Keep the top-level audit aligned with the reservation decision.
      actual_cost_known: streamCostKnown,
      // A lower-bound actual cost cannot support an exact savings delta. Keep
      // unknown streaming spend out of savings-share and analytics consumers.
      savings_microcents: streamCostKnown ? cost.savings_microcents : 0,
      plugin_cost_microcents: pluginSurchargeMicrocents,
      total_latency_ms: Date.now() - startTime,
      ttft_ms: result.ttft_ms,
      is_streaming: true,
      is_fallback,
      status_code: result.statusCode,
      error_type: streamErrorType,
      activity_category: categorize({
        messages: canonical.messages,
        toolCalls: streamToolCalls,
      }),
      session_id: sessionId,
      edited_paths: extractEditedPaths(streamToolCalls),
      had_bash: hasBashCall(streamToolCalls),
      rate_limited: rateLimited,
      system_prompt_tokens: systemPromptTokens,
      message_hash: messageHash,
      fallback_attempts: fallbackAttempts,
      plugin_warnings: pluginWarnings.length > 0 ? serializePluginWarnings(pluginWarnings) : undefined,
      plugin_runs: pluginRuns.length > 0 ? pluginRuns : undefined,
    });
    const isStreamEmptyError = (result.statusCode && result.statusCode >= 500) && result.chunks.length === 0;
    if (!isStreamEmptyError) {
      // Differentiate actual upstream/relay generation failures from internal billing warnings
      // (e.g. stream_usage_unknown or credit_deduction_failed still successfully delivered the generation).
      const isGenerationError = Boolean(
        result.streamError
        || result.clientAborted
        || creditReservationHeartbeatFailed
        || (result.statusCode && result.statusCode >= 400),
      );
      const generationError = result.streamError
        || (result.clientAborted ? 'client_aborted' : undefined)
        || (creditReservationHeartbeatFailed ? 'credit_reservation_heartbeat_failed' : undefined)
        || (result.statusCode && result.statusCode >= 400 ? `http_${result.statusCode}` : undefined);

      capturePostHogGeneration({
        teamId,
        layerIdentityId,
        requestId,
        sessionId,
        model: activeModel,
        provider: activeProviderId,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        startTime,
        totalCostMicrocents: streamCostKnown && priorAttemptCount === 0
          ? cost.actual_cost_microcents
          : undefined,
        priorAttemptCount,
        stream: true,
        timeToFirstTokenMs: result.ttft_ms,
        stopReason: [...result.chunks].reverse().find((chunk) => chunk.stop_reason)?.stop_reason,
        isError: isGenerationError,
        error: generationError,
        toolCalls: streamToolCalls,
      });
    }

  } else {
    const body = await upstreamRes.json();
    const canonicalRes = provider.parseResponse(body);
    observedInputTokens = canonicalRes.usage.input_tokens + priorAttemptInputTokens;
    observedOutputTokens = canonicalRes.usage.output_tokens + priorAttemptOutputTokens;
    // LAY-330: replace the pre-flight TPM estimate with the upstream-reported
    // input_tokens. Do this BEFORE cost computation (mirroring the streaming
    // path above): once we hold a parsed 200 with real usage, the request has
    // consumed those tokens, so a later throw (e.g. pricing-DB outage in
    // computeRequestCost) must not leave the record unsettled — otherwise the
    // outer catch could release actually-consumed tokens and let an accounting
    // outage bypass per-key/team TPM caps.
    rateLimiter.reconcileActualTokens(tpmRecordIds, canonicalRes.usage.input_tokens + priorAttemptInputTokens);
    const usageWithTtl = cacheWriteTtl ? { ...canonicalRes.usage, cache_write_ttl: cacheWriteTtl } : canonicalRes.usage;
    const {
      original_cost_known: originalCostKnown,
      ...servedCost
    } = await computeRequestCostDetailed(
      rawBody.model,
      originalProvider,
      activeModel,
      activeProviderId,
      usageWithTtl,
    );
    // RSH-134: a quality cascade may have dispatched and PAID FOR attempts
    // before this one. computeRequestCost prices only the served attempt, so
    // without this the rejected attempts' spend would vanish from
    // request_logs, from savings, and from the savings-share meter — while the
    // provider still billed for them. `savings` is original − actual, so
    // folding the prior spend into actual correctly shrinks reported savings
    // rather than inflating them (RSH-134 §4.4).
    //
    // The savings adjustment is guarded. computeRequestCost DELIBERATELY forces
    // savings to 0 when either side lacks pricing ("a missing price is unknown,
    // not free"), and an unpriced side also reports cost 0. Subtracting prior
    // spend from that forced 0 would manufacture a phantom negative saving out
    // of an unknown — the exact thing that rule exists to prevent. So only
    // adjust savings when both sides were really priced; actual cost still
    // aggregates either way, because the spend happened regardless.
    const costKnown = servedCost.actual_cost_known !== false && priorAttemptCostKnown;
    const bothSidesPriced = originalCostKnown && costKnown;
    const servedReasoningTokensValue = servedReasoningTokens !== undefined
      ? servedReasoningTokens
      : canonicalRes.usage.reasoning_tokens;
    const aggregateReasoningTokens = combineReasoningTelemetry(
      servedReasoningTokensValue,
      priorAttemptReasoningTokens,
      priorAttemptCount > 0,
    );
    const servedReasoningCost = servedCost.reasoning_cost_microcents !== undefined
      ? servedCost.reasoning_cost_microcents
      : servedReasoningCostMicrocents;
    const aggregateReasoningCost = combineReasoningTelemetry(
      servedReasoningCost,
      priorAttemptReasoningCostMicrocents,
      priorAttemptCount > 0,
    );
    const cost = priorAttemptCostMicrocents > 0
      || aggregateReasoningCost !== undefined
      || !costKnown
      ? {
          ...servedCost,
          ...(aggregateReasoningCost !== undefined ? { reasoning_cost_microcents: aggregateReasoningCost } : {}),
          actual_cost_microcents: servedCost.actual_cost_microcents + priorAttemptCostMicrocents,
          actual_cost_known: costKnown,
          savings_microcents: bothSidesPriced
            ? servedCost.savings_microcents - priorAttemptCostMicrocents
            : 0,
        }
      : servedCost;
    if (costKnown) knownProviderCostMicrocents = cost.actual_cost_microcents;
    let creditDeductionBalance: number | null = null;

    if (billingMode === 'credits' && cost.actual_cost_known !== false) {
      // A parsed response with known cost proves this request dispatched paid
      // provider work. Retain its reservation if exact settlement reports a
      // failure or throws; the outer finally is only for no-dispatch paths.
      if (creditReservation) creditReservation.resolved = true;
      let settlementResult;
      try {
        settlementResult = await settleReservedCredits(
          teamId,
          creditReservation?.amountDeducted ?? 0,
          cost.actual_cost_microcents + pluginSurchargeMicrocents,
          planLimits.creditsMarkupPercent,
          requestId,
          `${activeModel} (${canonicalRes.usage.total_tokens} tokens)`,
        );
      } catch (err) {
        captureException(err, {
          tags: { source: 'credit_settlement', handler: 'known_response_cost_failure' },
          extra: {
            request_id: requestId,
            team_id: teamId,
            actual_cost_microcents: knownProviderCostMicrocents,
          },
        });
        throw err;
      }
      if (!settlementResult.success) {
        logTerminalFailureRequest({
          traceparent,
          requestId,
          startTime,
          teamId,
          apiKeyId,
          layerIdentityId,
          providerId: activeProviderId,
          routedModel: activeModel,
          requestedModel: rawBody.model,
          statusCode: 402,
          canonical,
          sessionId,
          systemPromptTokens,
          messageHash,
          rateLimited,
          errorType: 'credit_deduction_failed',
          actualCostKnown: true,
          actualCostMicrocents: cost.actual_cost_microcents,
          inputTokens: observedInputTokens,
          outputTokens: observedOutputTokens,
          fallbackAttempts,
          pluginWarnings,
          pluginRuns,
        });
        res.writeHead(402, {
          'Content-Type': 'application/json',
          'X-RouteShift-Credits-Remaining': String(settlementResult.newBalance),
        });
        res.end(JSON.stringify({ error: { message: 'Insufficient credits', code: 'credit_deduction_failed' } }));
        return;
      }
      creditDeductionBalance = settlementResult.newBalance;
    } else if (billingMode === 'credits') {
      const unknownAttempts: UnknownCostAttempt[] = fallbackAttempts
        .filter((attempt) => attempt.actual_cost_known === false);
      if (servedCost.actual_cost_known === false) {
        unknownAttempts.push({
          provider: activeProviderId,
          model: activeModel,
          actual_cost_known: false,
          observed_cost_microcents: servedCost.actual_cost_microcents,
        });
      }
      await settleUnknownCostReservation({
        reservation: creditReservation,
        teamId,
        requestId,
        knownActualCostMicrocents:
          priorAttemptCostMicrocents
          + (servedCost.actual_cost_known !== false ? servedCost.actual_cost_microcents : 0)
          + pluginSurchargeMicrocents,
        attempts: unknownAttempts,
        canonical,
        markupPercent: planLimits.creditsMarkupPercent,
        reasonCode: 'served_response_cost_lower_bound',
        description: `${activeModel} served-response unknown-cost hold`,
      });
    }

    // RSH-138: non-streaming outcome. Exact cost settles the served aggregate;
    // unpriceable usage holds the unresolved remainder at the known lower bound.
    if (budgetReservation && !budgetReservation.terminal) {
      budgetReservation = cost.actual_cost_known !== false
        ? await settleBudgetExact(budgetReservation, cost.actual_cost_microcents + pluginSurchargeMicrocents, 'no_dispatch')
        : await settleBudgetUnknown(
            budgetReservation,
            priorAttemptCostMicrocents
              + (servedCost.actual_cost_known !== false ? servedCost.actual_cost_microcents : 0)
              + pluginSurchargeMicrocents,
            'upstream_unknown',
          );
    }

    // Present one stable response contract regardless of which provider routing
    // picked: OpenAI-native bodies pass through untouched; foreign shapes
    // (Anthropic/Gemini/Bedrock) are normalized to OpenAI chat-completion shape
    // with the raw upstream body attached. The cache stores the OUTGOING body so
    // a cache HIT replays the same shape a MISS produced.
    const responseBody = isOpenAIShapedBody(body)
      ? body
      : toOpenAIChatCompletion(canonicalRes, activeModel, body);
    const outgoingBody = attachPluginWarnings(responseBody, pluginWarnings);

    // Store in cache if cacheable — reuse the key computed at the start.
    if (cacheKey) {
      // Never cache a FALLBACK response: cacheKey is built from the PRIMARY
      // provider/model, so storing the fallback's output under it would replay
      // that degraded result for later healthy primary requests (cache
      // poisoning). Skipping the store lets the next request re-attempt the
      // recovered primary and cache THAT. The MISS header still applies (this
      // response was not served from cache either way).
      if (!is_fallback) {
        responseCache.set(cacheKey, {
          body: responseBody,
          usage: canonicalRes.usage,
          teamId,
          provider: activeProviderId,
          model: activeModel,
        });
      }
      res.setHeader('X-RouteShift-Cache', 'MISS');
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(outgoingBody));

    logRequest({
      id: requestId,
      timestamp: new Date().toISOString(),
      team_id: teamId,
      billing_mode: billingMode,
      api_key_id: apiKeyId,
      layer_identity_id: layerIdentityId,
      traceparent,
      provider: activeProviderId,
      model_requested: rawBody.model,
      model_resolved: activeModel,
      input_tokens: canonicalRes.usage.input_tokens + priorAttemptInputTokens,
      output_tokens: canonicalRes.usage.output_tokens + priorAttemptOutputTokens,
      reasoning_tokens: aggregateReasoningTokens,
      cache_read_tokens: canonicalRes.usage.cache_read_tokens,
      cache_write_tokens: canonicalRes.usage.cache_write_tokens,
      total_tokens:
        canonicalRes.usage.total_tokens
        + priorAttemptInputTokens
        + priorAttemptOutputTokens,
      ...cost,
      plugin_cost_microcents: pluginSurchargeMicrocents,
      total_latency_ms: Date.now() - startTime,
      ttft_ms: null,
      is_streaming: false,
      is_fallback,
      status_code: 200,
      activity_category: categorize({
        messages: canonical.messages,
        toolCalls: canonicalRes.tool_calls ?? [],
      }),
      session_id: sessionId,
      edited_paths: extractEditedPaths(canonicalRes.tool_calls ?? []),
      had_bash: hasBashCall(canonicalRes.tool_calls ?? []),
      rate_limited: rateLimited,
      system_prompt_tokens: systemPromptTokens,
      message_hash: messageHash,
      fallback_attempts: fallbackAttempts,
      plugin_warnings: pluginWarnings.length > 0 ? serializePluginWarnings(pluginWarnings) : undefined,
      plugin_runs: pluginRuns.length > 0 ? pluginRuns : undefined,
    });
    capturePostHogGeneration({
      teamId,
      layerIdentityId,
      requestId,
      sessionId,
      model: activeModel,
      provider: activeProviderId,
      inputTokens: canonicalRes.usage.input_tokens,
      outputTokens: canonicalRes.usage.output_tokens,
      startTime,
      totalCostMicrocents: costKnown && priorAttemptCount === 0
        ? cost.actual_cost_microcents
        : undefined,
      priorAttemptCount,
      stream: false,
      stopReason: canonicalRes.stop_reason,
      toolCalls: canonicalRes.tool_calls,
    });


    if (billingMode === 'credits' && creditDeductionBalance !== null) {
      await checkAutoTopUpNeeded(teamId, creditDeductionBalance).catch((err) => {
        console.error('Auto top-up check failed (non-stream settle):', err);
      });
    }

    // RSH-135: async classification (fire-and-forget, zero latency impact)
    setImmediate(() => {
      runAsyncClassification(teamId, requestId, canonical.messages).catch((err) => {
        console.error(`[classifier] async classification failed for request=${requestId}:`, err);
      });
    });
  }
  } catch (err) {
    const costUnknown = knownProviderCostMicrocents === null;
    if (costUnknown) {
      await settleUnknownCostReservation({
        reservation: creditReservation,
        teamId,
        requestId,
        knownActualCostMicrocents: priorAttemptCostMicrocents + pluginSurchargeMicrocents,
        attempts: [
          ...fallbackAttempts.filter((attempt) => attempt.actual_cost_known === false),
          { provider: activeProviderId, model: activeModel, actual_cost_known: false },
        ],
        canonical,
        markupPercent: planLimits.creditsMarkupPercent,
        reasonCode: 'upstream_response_cost_unknown',
        description: `${activeModel} response-processing unknown-cost hold`,
      });
      // RSH-138: the served attempt's cost is unpriceable after dispatch; hold
      // the unresolved remainder at the known lower bound.
      budgetReservation = await settleBudgetUnknown(
        budgetReservation,
        priorAttemptCostMicrocents + pluginSurchargeMicrocents,
        'upstream_unknown',
      );
    } else if (creditReservation && !creditReservation.resolved) {
      // The exact provider cost is already known, but a later response or
      // settlement step failed. Retain the existing reservation and report an
      // accounting incident; do not relabel exact spend as unknown.
      creditReservation.resolved = true;
      captureException(err, {
        tags: { source: 'credit_settlement', handler: 'known_response_cost_failure' },
        extra: {
          request_id: requestId,
          team_id: teamId,
          actual_cost_microcents: knownProviderCostMicrocents,
        },
      });
    }

    console.error('Upstream response handling failed:', err);
    if (!res.headersSent) {
      logTerminalFailureRequest({
        traceparent,
        requestId,
        startTime,
        teamId,
        apiKeyId,
        layerIdentityId,
        providerId: activeProviderId,
        routedModel: activeModel,
        requestedModel: rawBody.model,
        statusCode: 502,
        canonical,
        sessionId,
        systemPromptTokens,
        messageHash,
        rateLimited,
        errorType: costUnknown ? 'upstream_response_cost_unknown' : 'upstream_response_error',
        fallbackAttempts,
        pluginWarnings,
        pluginRuns,
        actualCostKnown: !costUnknown,
        actualCostMicrocents: knownProviderCostMicrocents ?? priorAttemptCostMicrocents,
        inputTokens: observedInputTokens,
        outputTokens: observedOutputTokens,
      });
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Upstream response handling failed' } }));
    }
  }
}

function modelEndpointsForRouting(
  model: string,
  effectiveModels: readonly EffectiveCatalogDefinition[] = EFFECTIVE_DISPATCHABLE_CHAT_MODELS,
): ModelProviderEndpoint[] {
  const endpoints = getModelEndpoints(model);
  const seen = new Set(endpoints.map((endpoint) => `${endpoint.provider}:${endpoint.model}`));
  const models = effectiveModels ?? [];
  for (const definition of models) {
    if (definition.canonical_name !== model && definition.api_model_id !== model) continue;
    const key = `${definition.provider}:${definition.api_model_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    endpoints.push({
      provider: definition.provider as Provider,
      model: definition.api_model_id,
      zdr: PROVIDER_DATA_POLICY[definition.provider as Provider]?.zdr ?? false,
    });
  }
  return endpoints;
}
type RoutingPreferenceFailureReason =
  | 'no_eligible_provider'
  | 'no_eligible_provider_residency'
  | 'unsupported_provider_sort'
  | 'selected_provider_missing_credentials';

function providerPreferencesFromBody(
  rawBody: Record<string, unknown>,
  suffixPrefs: ProviderPreferences | null,
  presetPrefs: unknown,
):
  | {
      ok: true;
      value: ProviderPreferences | null;
      presetDefaults: ProviderPreferences | null;
      requestOverrides: ProviderPreferences | null;
    }
  | { ok: false; reason: 'invalid_provider_prefs' } {
  const parsedPreset = parseProviderPreferences(presetPrefs);
  if (!parsedPreset.ok) return parsedPreset;
  const candidate = rawBody.provider ?? rawBody.provider_preferences;
  const parsed = parseProviderPreferences(candidate);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    value: mergeProviderPreferences(
      mergeProviderPreferences(parsedPreset.value, suffixPrefs),
      parsed.value,
    ),
    presetDefaults: parsedPreset.value,
    requestOverrides: parsed.value,
  };
}



function mergeProviderPreferences(
  defaults: ProviderPreferences | null,
  overrides: ProviderPreferences | null,
): ProviderPreferences | null {
  const merged = { ...(defaults ?? {}), ...(overrides ?? {}) };
  return Object.keys(merged).length > 0 ? merged : null;
}

async function applyRoutingProviderPreferences(
  routingDecision: RoutingDecision,
  prefs: ProviderPreferences,
  teamId: string,
  billingMode: 'subscription' | 'credits',
  effectiveModels: readonly EffectiveCatalogDefinition[] = EFFECTIVE_DISPATCHABLE_CHAT_MODELS,
): Promise<{ ok: true } | { ok: false; reason: RoutingPreferenceFailureReason }> {
  const providerFilters = Boolean(
    (prefs.order && prefs.order.length > 0) ||
      (prefs.allow && prefs.allow.length > 0) ||
      (prefs.deny && prefs.deny.length > 0) ||
      prefs.data_collection === 'deny' ||
      (prefs.data_residency?.length ?? 0) > 0,
  );
  const endpointFanout = modelEndpointsForRouting(routingDecision.model, effectiveModels);
  const currentEndpoint = endpointForProvider(
    endpointFanout,
    routingDecision.provider,
    routingDecision.model,
  );
  const candidates = [currentEndpoint, ...endpointFanout];
  const uniqueCandidates = candidates.filter((candidate, index, all) => (
    all.findIndex((other) => other.provider === candidate.provider && other.model === candidate.model) === index
  ));

  const providerPrefsAllowFallbacks = prefs.allow_fallbacks;
  const eligibleCandidates = await filterDispatchEligibleEndpoints(uniqueCandidates, teamId, billingMode);
  if (eligibleCandidates.length === 0) return { ok: false, reason: 'selected_provider_missing_credentials' };

  const result = applyProviderPreferences(eligibleCandidates, prefs);
  if (!result.ok) return result;

  const primary = result.endpoints[0];
  routingDecision.provider = primary.provider;
  if (providerPrefsAllowFallbacks === false) {
    routingDecision.fallback_chain = [];
  } else if (providerFilters) {
    const allowedFallbackProviders = new Set<string>(result.endpoints.map((endpoint: ModelProviderEndpoint) => endpoint.provider));
    routingDecision.fallback_chain = routingDecision.fallback_chain.filter((entry) => allowedFallbackProviders.has(entry.provider));
  }
  return { ok: true };
}
async function buildExplicitModelFallbackChain(
  models: RequestedModel[],
  presetDefaults: ProviderPreferences | null,
  requestOverrides: ProviderPreferences | null,
  teamId: string,
  billingMode: 'subscription' | 'credits',
  effectiveModels: readonly EffectiveCatalogDefinition[] = EFFECTIVE_DISPATCHABLE_CHAT_MODELS,
): Promise<{ ok: true; fallback_chain: Array<{ provider: string; model: string }> } | { ok: false; reason: RoutingPreferenceFailureReason }> {
  const fallback_chain: Array<{ provider: string; model: string }> = [];
  for (const entry of models) {
    // Every fallback gets its own model suffix between the shared preset
    // defaults and the raw request override. Re-merging a fully resolved
    // primary preference object here would let a fallback suffix overwrite
    // the caller's explicit provider fields.
    const effectivePrefs = mergeProviderPreferences(
      mergeProviderPreferences(presetDefaults, entry.providerPreferences),
      requestOverrides,
    );
    const selected = await selectProviderForModel(entry.model, effectivePrefs, teamId, billingMode, effectiveModels);
    if (!selected.ok) return selected;
    fallback_chain.push({ provider: selected.provider, model: entry.model });
  }
  return { ok: true, fallback_chain };
}

async function selectProviderForModel(
  model: string,
  prefs: ProviderPreferences | null,
  teamId: string,
  billingMode: 'subscription' | 'credits',
  effectiveModels: readonly EffectiveCatalogDefinition[] = EFFECTIVE_DISPATCHABLE_CHAT_MODELS,
): Promise<{ ok: true; provider: string } | { ok: false; reason: RoutingPreferenceFailureReason }> {
  const defaultProvider = resolveProvider(model, effectiveModels);
  const endpointFanout = modelEndpointsForRouting(model, effectiveModels);
  const currentEndpoint = endpointForProvider(endpointFanout, defaultProvider, model);
  const candidates = [currentEndpoint, ...endpointFanout].filter((candidate, index, all) => (
    candidate.provider.length > 0 &&
    all.findIndex((other) => other.provider === candidate.provider && other.model === candidate.model) === index
  ));
  const eligibleCandidates = await filterDispatchEligibleEndpoints(candidates, teamId, billingMode);
  if (eligibleCandidates.length === 0) return { ok: false, reason: 'selected_provider_missing_credentials' };
  const result = applyProviderPreferences(eligibleCandidates, prefs ?? {});
  if (!result.ok) return result;
  return { ok: true, provider: result.endpoints[0].provider };
}

async function filterDispatchEligibleEndpoints(
  endpoints: ModelProviderEndpoint[],
  teamId: string,
  billingMode: 'subscription' | 'credits',
): Promise<ModelProviderEndpoint[]> {
  const checks = await Promise.all(
    endpoints.map(async (endpoint) => ({
      endpoint,
      eligible: await providerHasDispatchConfig(endpoint.provider, teamId, billingMode),
    })),
  );
  return checks.filter((check) => check.eligible).map((check) => check.endpoint);
}

async function providerHasDispatchConfig(
  provider: string,
  teamId: string,
  billingMode: 'subscription' | 'credits',
): Promise<boolean> {
  if (billingMode === 'subscription') return hasEnabledProviderKey(teamId, provider);
  return Boolean(getPlatformKey(provider, billingMode));
}

function endpointForProvider(
  endpoints: ModelProviderEndpoint[],
  provider: string,
  model: string,
): ModelProviderEndpoint {
  return endpoints.find((endpoint) => endpoint.provider === provider) ?? {
    provider: provider as Provider,
    model,
    zdr: PROVIDER_DATA_POLICY[provider as Provider]?.zdr ?? false,
  };
}

function routingPreferenceErrorMessage(reason: RoutingPreferenceFailureReason, prefs: ProviderPreferences | null): string {
  if (reason === 'unsupported_provider_sort') {
    const sort = prefs?.sort ?? 'requested';
    return `Provider sort '${sort}' is not supported for the eligible endpoints because RouteShift lacks deterministic ranking data`;
  }
  if (reason === 'no_eligible_provider_residency') {
    return 'No eligible provider has verified endpoint jurisdiction evidence for requested data residency';
  }
  if (reason === 'selected_provider_missing_credentials') {
    return 'No credential-configured provider is available for requested provider preferences';
  }
  return 'No eligible provider for requested provider preferences';
}

function logAutoRouteMetadata(
  requestId: string,
  teamId: string,
  strategy: 'cheapest' | 'fastest' | 'balanced',
  decision: RoutingDecision,
): void {
  const metadata = decision.auto_route;
  if (!metadata) return;

  if (metadata.provider_skips.length > 0) {
    console.info(JSON.stringify({
      event: 'auto_route_provider_skips',
      request_id: requestId,
      team_id: teamId,
      strategy,
      selected_provider: decision.provider,
      selected_model: decision.model,
      provider_skips: metadata.provider_skips,
    }));
  }

  if (metadata.latency_mode && metadata.latency_mode !== 'not_applicable') {
    console.info(JSON.stringify({
      event: 'auto_route_latency_mode',
      request_id: requestId,
      team_id: teamId,
      strategy,
      latency_mode: metadata.latency_mode,
    }));
  }

  if (metadata.capability_axis) {
    console.info(JSON.stringify({
      event: 'auto_route_capability_axis',
      request_id: requestId,
      team_id: teamId,
      strategy,
      capability_axis: metadata.capability_axis,
      routed_provider: decision.provider,
      routed_model: decision.model,
    }));
  }

  if (metadata.quality_derank && metadata.quality_derank.length > 0) {
    console.info(JSON.stringify({
      event: 'auto_route_quality_derank',
      request_id: requestId,
      team_id: teamId,
      strategy,
      quality_derank: metadata.quality_derank,
      // the DECISION's routing (not necessarily the finally-served model —
      // a later cascade or failure path can change that)
      routed_provider: decision.provider,
      routed_model: decision.model,
    }));
  }
}

export function resolveProvider(
  model: string,
  effectiveModels: readonly EffectiveCatalogDefinition[] = EFFECTIVE_DISPATCHABLE_CHAT_MODELS,
): string {
  // GPT-5.6 Cyber is Responses-only and approval-gated; do not let the broad
  // gpt-* fallback turn it into a dispatchable Chat Completions model.
  if (model === 'gpt-5.6-cyber') return '';
  if (GOOGLE_PREVIEW_QUARANTINE_IDS.has(model.toLowerCase())) return '';
  const exact = MODEL_REGISTRY.find((entry) => entry.canonical_name === model || entry.api_model_id === model);
  // Parked/historical models are retained for planning/history but are not
  // dispatchable. Fail cleanly instead of guessing a hosted provider whose
  // endpoint may be retired or unpriced.
  if (exact) return exact.public === false ? '' : exact.provider;

  // Preserve first-party passthrough semantics before consulting generated
  // alternate-provider rows. A generated Azure `gpt-*` row must never
  // silently remap a bare OpenAI model request.
  if (model.startsWith('gpt-') || model === 'o3' || model.startsWith('o3-') || model === 'o4' || model.startsWith('o4-')) return 'openai';
  if (model.startsWith('claude-')) return 'anthropic';
  if (model.startsWith('gemini-')) return 'google';

  const generated = (effectiveModels ?? []).find((entry) => (
    'source' in entry
    && entry.source === 'generated'
    && (entry.canonical_name === model || entry.api_model_id === model)
  ));
  if (generated) return generated.provider;
  return ''; // unknown — will be caught by the "Unknown provider" check
}

/**
 * Sentinel thrown when an encrypted provider key cannot be decrypted
 * (typically: PROVIDER_KEY_SECRET rotated without re-saving the keys).
 * Distinguished from "no key configured" so we can return a different
 * status code + actionable hint.
 */
export class ProviderKeyDecryptError extends Error {
  constructor(public provider: string, public cause: unknown) {
    super(`Failed to decrypt provider key for ${provider}`);
    this.name = 'ProviderKeyDecryptError';
  }
}

async function resolveUpstreamConfig(
  provider: string,
  teamId: string,
  billingMode: 'subscription' | 'credits',
): Promise<import('./billing/provider-key-crypto.js').ProviderKeyConfig | undefined> {
  if (billingMode === 'subscription') {
    let teamConfig: import('./billing/provider-key-crypto.js').ProviderKeyConfig | null;
    try {
      teamConfig = await getDecryptedProviderKey(teamId, provider);
    } catch (err) {
      throw new ProviderKeyDecryptError(provider, err);
    }
    // Subscription is the BYOK mode: never let a missing customer key fall
    // through to a RouteShift-funded platform credential. Credits mode below
    // is the only path allowed to use platform keys.
    return teamConfig ?? undefined;
  }
  const platformKey = getPlatformKey(provider, billingMode);
  const platformMetadata = provider === 'cloudflare-workers-ai'
    ? { account_id: process.env.CLOUDFLARE_ACCOUNT_ID }
    : {};
  return platformKey ? { key: platformKey, metadata: platformMetadata, label: 'platform' } : undefined;
}

/**
 * Server-side hard ceiling on retries/fallback hops for a single request.
 * The client opt-in budget can only ever lower this — never raise it — so a
 * request (or an absent/unbounded client budget) can't walk an unbounded
 * number of upstream attempts and amplify cost across the fallback chain.
 */
const MAX_SERVER_RETRIES = 8;

/**
 * LAY-321: parse retry-budget intent from headers (preferred) or body
 * fallback. Header values take precedence so a body-encoded budget can't
 * silently override an SDK-set header. Anything unparseable falls back to
 * "no cap" — the budget guard is opt-in.
 */
function parseRetryBudget(
  headers: IncomingMessage['headers'],
  rawBody: { routeshift?: { max_retries?: unknown; max_cost_microcents?: unknown } },
  estimatedInputTokens: number,
): RetryBudget {
  const headerRetries = headers['x-routeshift-max-retries'];
  const headerCost = headers['x-routeshift-max-cost-microcents'];
  const bodyRetries = rawBody.routeshift?.max_retries;
  const bodyCost = rawBody.routeshift?.max_cost_microcents;

  const parsedOrInfinity = parseNonNegInt(headerRetries) ?? parseNonNegInt(bodyRetries) ?? Infinity;
  // Clamp to the server ceiling: a lower client opt-in still wins, but
  // nothing can exceed MAX_SERVER_RETRIES.
  const maxRetries = Math.min(parsedOrInfinity, MAX_SERVER_RETRIES);
  const maxCostMicrocents = parseNonNegInt(headerCost) ?? parseNonNegInt(bodyCost);

  return {
    maxRetries,
    maxCostMicrocents,
    estimatedInputTokens,
  };
}

function parseNonNegInt(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.floor(v);
  if (typeof v === 'string') {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return undefined;
}

async function runAsyncClassification(
  teamId: string,
  requestId: string,
  messages: import('@routeshift/shared').CanonicalMessage[],
): Promise<void> {
  const config = await getClassifierConfig(teamId);
  if (!config) return;
  if (!shouldSample(teamId, requestId, config.sampleRateBps)) return;
  const result = await executeClassification(config, messages, requestId);
  if (!result) return;
  const pool = (await import('./db/pool.js')).getPool();
  await pool.query(
    `INSERT INTO classification_results (id, request_id, team_id, dimensions, cost_microcents, latency_ms, classified_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO NOTHING`,
    [
      `cr_${requestId}`,
      requestId,
      teamId,
      JSON.stringify(result.dimensions),
      result.costMicrocents,
      result.latencyMs,
      result.classifiedAt,
    ],
  );
  await pool.query(
    `UPDATE request_logs SET plugin_cost_microcents = COALESCE(plugin_cost_microcents, 0) + $1 WHERE id = $2`,
    [result.costMicrocents, requestId],
  );
}
