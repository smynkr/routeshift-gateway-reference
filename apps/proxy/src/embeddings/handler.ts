// apps/proxy/src/embeddings/handler.ts
//
// OpenAI-compatible POST /v1/embeddings.
//
// Reuses the chat proxy's pre-flight stack (auth, rate-limit, monthly budget,
// credit pre-flight) but resolves the model via the EMBEDDINGS catalog rather
// than the chat router, and dispatches to the provider's embedding methods
// (Task 5). The budget/rate guards MUST run before any upstream call so an
// embeddings request can never bypass a team's spend or rate caps
// (cost-bypass contract).
//
// RouteShift-only fields (provider/plugins/preset/routeshift/etc.) are never
// forwarded upstream — the outgoing body contains ONLY what
// provider.buildEmbeddingRequest emits ({ model, input } plus
// provider-supported embedding options).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { TokenUsage } from '@routeshift/shared';
import { EMBEDDING_MODELS, resolveEmbeddingModel } from '@routeshift/shared';
import type { EmbeddingOptions, ProviderRequest } from './../providers/types.js';
import { getProvider } from './../providers/registry.js';
import { computeRequestCost } from './../cost/calculator.js';
import { logRequest } from './../logging/logger.js';
import { validateApiKey } from './../auth/api-key.js';
import { layerIdentityFromMetadata } from './../auth/layer-identity.js';
import { isValidIdentityId } from './../admin/identity-budgets.js';
import { keyHasInferenceScope } from './../auth/scope.js';
import { rateLimiter } from './../rate-limit/limiter.js';
import { getTeamTpmLimit } from './../rate-limit/team-tpm.js';
import { config } from './../config.js';
import { getTeamPlan, getPlanLimits, getTeamBillingMode } from './../billing/plan-limits.js';
import { estimateEmbeddingBudget, utf8TokenUpperBound } from './../billing/budget-estimate.js';
import { settleBudgetExact, settleBudgetUnknown, writeBudgetRejection } from './../billing/budget-lifecycle.js';
import {
  markBudgetReservationDispatched,
  releaseBudgetReservation,
  reserveBudget,
  type BudgetReservation,
} from './../billing/budget-reservations.js';
import { resolveAlias } from './../routing/model-aliases.js';
import {
  preFlightCreditCheck,
  reserveCredits,
  settleReservedCredits,
  settleReservedCreditsWithUnknownCostHold,
  getCreditPricing,
  checkAutoTopUpNeeded,
} from './../billing/credits.js';
import { getDecryptedProviderKey } from './../billing/provider-key-crypto.js';
import { getPlatformKey } from './../providers/platform-keys.js';
import { markCooldown } from './../billing/rate-limit-cooldown.js';
import {
  decrementInFlight,
  incrementInFlight,
  recordLatency,
} from './../billing/key-stats.js';
import { recordAuditEvent } from './../auth/audit-events.js';
import { captureException } from './../observability/sentry.js';

const MAX_EMBEDDING_BATCH_SIZE = 2048;

type CreditReservationState = {
  amountDeducted: number;
  resolved: boolean;
};

/**
 * A dispatched embedding request can incur provider spend even when RouteShift
 * cannot establish its exact cost. Keep the reservation (and, where possible,
 * write a bounded reconciliation record) rather than allowing finally to
 * manufacture a zero-cost refund.
 */
async function settleUnknownEmbeddingCostHold(args: {
  reservation: CreditReservationState | null;
  teamId: string;
  requestId: string;
  markupPercent: number;
  model: string;
  reasonCode: string;
}): Promise<void> {
  const { reservation, teamId, requestId, markupPercent, model, reasonCode } = args;
  if (!reservation || reservation.resolved) return;

  try {
    const result = await settleReservedCreditsWithUnknownCostHold(
      teamId,
      reservation.amountDeducted,
      0,
      null,
      markupPercent,
      requestId,
      `${model} embedding unknown-cost hold`,
      reasonCode,
      1,
    );
    // The pre-dispatch debit remains conservative even if the tracking update
    // failed. Do not let finally refund potential provider spend.
    reservation.resolved = true;
    if (result.success) {
      await checkAutoTopUpNeeded(teamId, result.newBalance).catch((err) => {
        console.error('Embedding auto top-up check failed (unknown-cost hold):', err);
      });
      return;
    }
    captureException(new Error('Embedding unknown-cost hold settlement returned success=false'), {
      tags: { source: 'unknown_cost_hold', handler: 'embeddings', reason_code: reasonCode },
      extra: { request_id: requestId, team_id: teamId },
    });
  } catch (err) {
    reservation.resolved = true;
    captureException(err, {
      tags: { source: 'unknown_cost_hold', handler: 'embeddings', reason_code: reasonCode },
      extra: { request_id: requestId, team_id: teamId },
    });
  }
}

export async function handleEmbeddingsRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const requestId = randomUUID();
  const startTime = Date.now();

  // --- READ BODY (bounded) ---
  const bodyChunks: Buffer[] = [];
  let bodySize = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string | Uint8Array);
    bodySize += buf.length;
    if (bodySize > config.maxRequestBodyBytes) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Request body too large' } }));
      return;
    }
    bodyChunks.push(buf);
  }
  let rawBody: any;
  try {
    rawBody = JSON.parse(Buffer.concat(bodyChunks).toString());
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid JSON in request body' } }));
    return;
  }
  if (rawBody === null || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid request body' } }));
    return;
  }

  // --- AUTH ---
  const authHeader = req.headers['authorization'];
  const apiKeyStr = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!apiKeyStr || !apiKeyStr.startsWith('sk-proxy-')) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'API key required. Use Authorization: Bearer sk-proxy-...' } }));
    return;
  }
  const keyInfo = await validateApiKey(apiKeyStr);
  if (!keyInfo) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
    return;
  }
  // RSH-146: a key-bound preset is org policy for CHAT inference (model pin,
  // params, system prompt — enforced in proxy-handler). The binding has no
  // meaning on the embeddings surface, so a bound key cannot use it: fail
  // closed rather than silently serve billable traffic outside the org
  // policy (mirrors the chat path's 400/403 conflict posture).
  if (keyInfo.presetSlug != null) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        message: `This API key is bound to a preset (${keyInfo.presetSlug}); the embeddings endpoint is not covered by the binding`,
        code: 'key_preset_embeddings_denied',
      },
    }));
    return;
  }
  const teamId = keyInfo.teamId;

  // Device-flow key scope enforcement (RSH-69). Embeddings dispatch to a paid
  // provider just like chat, so a key scoped without `inference` must be
  // rejected here too — otherwise a non-inference-scoped key could still incur
  // billable embedding spend that the chat path already blocks.
  if (!keyHasInferenceScope(keyInfo.metadata)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'insufficient_scope: missing inference scope', code: 'insufficient_scope' } }));
    return;
  }

  // --- INPUT VALIDATION ---
  if (!rawBody.model || typeof rawBody.model !== 'string') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'model field is required and must be a string' } }));
    return;
  }
  if (rawBody.input === undefined || rawBody.input === null) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'input field is required' } }));
    return;
  }
  if (typeof rawBody.input === 'string') {
    if (rawBody.input.trim().length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'input must be a non-empty string or an array of non-empty strings' } }));
      return;
    }
  } else if (Array.isArray(rawBody.input)) {
    if (rawBody.input.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'input must be a non-empty string or an array of non-empty strings' } }));
      return;
    }
    if (rawBody.input.length > MAX_EMBEDDING_BATCH_SIZE) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `input array exceeds maximum batch size of ${MAX_EMBEDDING_BATCH_SIZE}` } }));
      return;
    }
    if (!rawBody.input.every((value: unknown) => typeof value === 'string' && value.trim().length > 0)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'input must be a non-empty string or an array of non-empty strings' } }));
      return;
    }
  } else {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'input must be a string or an array of strings' } }));
    return;
  }
  const embeddingOptions: EmbeddingOptions = {};
  if (rawBody.encoding_format !== undefined) {
    if (rawBody.encoding_format !== 'float' && rawBody.encoding_format !== 'base64') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'encoding_format must be one of: float, base64' } }));
      return;
    }
    embeddingOptions.encoding_format = rawBody.encoding_format;
  }
  if (rawBody.dimensions !== undefined) {
    if (!Number.isInteger(rawBody.dimensions) || rawBody.dimensions <= 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'dimensions must be a positive integer' } }));
      return;
    }
    embeddingOptions.dimensions = rawBody.dimensions;
  }
  if (rawBody.user !== undefined) {
    if (typeof rawBody.user !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'user must be a string' } }));
      return;
    }
    embeddingOptions.user = rawBody.user;
  }

  // Resolve team-level aliases BEFORE the allowlist check (mirrors proxy-handler).
  rawBody.model = await resolveAlias(teamId, rawBody.model);
  const model: string = rawBody.model;
  const input: string | string[] = rawBody.input;

  // --- API-KEY MODEL ALLOWLIST ---
  if (keyInfo.allowedModels && keyInfo.allowedModels.length > 0 && !keyInfo.allowedModels.includes(model)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Model is not permitted for this API key' } }));
    return;
  }

  // Fan out the per-request billing lookups (none depend on each other).
  const [billingMode, teamPlan] = await Promise.all([
    getTeamBillingMode(teamId),
    getTeamPlan(teamId),
  ]);
  const planLimits = getPlanLimits(teamPlan);

  // --- RATE LIMIT (RPM) ---
  // Mirror proxy-handler: a key with an RPM override gets its own bucket so it
  // can't starve sibling keys; otherwise share the team bucket.
  const rpmBucketId = keyInfo.rateLimitOverride?.requests_per_minute
    ? `${teamId}:${keyInfo.id}`
    : teamId;
  const rateResult = rateLimiter.check(rpmBucketId, keyInfo.rateLimitOverride?.requests_per_minute);
  if (!rateResult.allowed) {
    void recordAuditEvent({
      team_id: teamId,
      api_key_id: keyInfo.id ?? null,
      key_prefix: null,
      event_type: 'rate_limited',
      details: { kind: 'rpm', reset_ms: rateResult.resetMs, request_kind: 'embedding' },
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

  // --- RATE LIMIT (TPM) ---
  // Estimate input tokens from the embedding input (char/4 — same heuristic the
  // chat path uses). Pass-through when the key has no TPM override.
  const inputChars = typeof input === 'string'
    ? input.length
    : input.reduce((sum, s) => sum + (typeof s === 'string' ? s.length : 0), 0);
  const tpmEstimate = Math.ceil(inputChars / 4);
  const tpmBucketId = keyInfo.rateLimitOverride?.tokens_per_minute
    ? `${teamId}:${keyInfo.id}`
    : teamId;
  const tpmResult = rateLimiter.checkTpm(
    tpmBucketId,
    tpmEstimate,
    keyInfo.rateLimitOverride?.tokens_per_minute,
  );
  if (!tpmResult.allowed) {
    void recordAuditEvent({
      team_id: teamId,
      api_key_id: keyInfo.id ?? null,
      key_prefix: null,
      event_type: 'rate_limited',
      details: { kind: 'tpm', reset_ms: tpmResult.resetMs, request_kind: 'embedding' },
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
  // LAY-348: workspace-level TPM cap. Embeddings intentionally mirrors the
  // chat path here so key-scoped overrides and team caps reconcile together.
  let teamTpmLimit: number | null;
  try {
    teamTpmLimit = await getTeamTpmLimit(teamId);
  } catch (err) {
    // RSH-60 (error-path variant): the per-key estimate was already booked above
    // and the finish-handler that releases it is not registered until after this
    // await. If getTeamTpmLimit rejects, release the per-key record before the
    // error propagates — otherwise a phantom estimate lingers in the 60s window
    // and falsely throttles the next request on this key. Mirrors the chat path.
    rateLimiter.removeRecord(tpmResult.recordId);
    throw err;
  }
  const teamTpmResult = rateLimiter.checkTpm(teamId, tpmEstimate, teamTpmLimit ?? undefined);
  if (!teamTpmResult.allowed) {
    // RSH-60: the per-key check above already booked its estimate; release it so
    // the per-key window doesn't over-count a request that never went upstream
    // (mirrors the chat path — proxy-handler.ts). No-op when recordId is null.
    rateLimiter.removeRecord(tpmResult.recordId);
    void recordAuditEvent({
      team_id: teamId,
      api_key_id: keyInfo.id ?? null,
      key_prefix: null,
      event_type: 'rate_limited',
      details: { kind: 'team_tpm', reset_ms: teamTpmResult.resetMs, request_kind: 'embedding' },
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
  // RSH-60 (generalized): release the reserved TPM estimates on any path that does
  // not reach the upstream provider. The success path reconciles to actual usage
  // (reconcileActualTokens, which deletes the record) before res.end(), so this is
  // a no-op there; budget/unsupported-model/missing-key/preflight rejections would
  // otherwise leave a phantom estimate in the 60s window. Mirrors the chat handler.
  res.once('finish', () => {
    for (const id of tpmRecordIds) rateLimiter.removeRecord(id);
  });

  // --- RESOLVE EMBEDDINGS PROVIDER (catalog, NOT chat routing) ---
  const providerId = resolveEmbeddingModel(model);
  const provider = providerId ? getProvider(providerId) : undefined;
  if (
    !providerId ||
    !provider ||
    !provider.supportsEmbeddings ||
    typeof provider.buildEmbeddingRequest !== 'function' ||
    typeof provider.parseEmbeddingResponse !== 'function'
  ) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        code: 'embeddings_unsupported',
        message: `Model ${model} is not a supported embeddings model`,
      },
    }));
    return;
  }

  // --- UPSTREAM KEY ---
  // Subscription is BYOK-only; credits is platform-key-only. Never subsidize
  // a missing subscription credential with a RouteShift-funded platform key.
  let upstream: { key: string; label?: string; selected_after_cooldown_skip?: boolean } | undefined;
  if (billingMode === 'subscription') {
    try {
      const teamConfig = await getDecryptedProviderKey(teamId, providerId);
      upstream = teamConfig ?? undefined;
    } catch (err) {
      console.error('Provider key decrypt failed for embeddings:', err);
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: `Provider key for ${providerId} could not be decrypted. The encryption secret may have rotated — re-save the key in the dashboard's Provider Keys page.`,
          code: 'provider_key_decrypt_failed',
        },
      }));
      return;
    }
  } else {
    const platformKey = getPlatformKey(providerId, billingMode);
    upstream = platformKey ? { key: platformKey } : undefined;
  }
  if (!upstream?.key) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    const message = billingMode === 'subscription'
      ? `${providerId} requires a team-configured provider key. Save one via the dashboard's Provider Keys page.`
      : `No API key configured for ${providerId}`;
    res.end(JSON.stringify({ error: { message } }));
    return;
  }
  const apiKey = upstream.key;
  const upstreamLabel = upstream.label ?? null;
  let rateLimited = upstream.selected_after_cooldown_skip === true;

  // --- CREDIT PRE-FLIGHT (credits mode only) ---
  let creditReservation: CreditReservationState | null = null;
  if (billingMode === 'credits') {
    // Reuse the raw input character count from the TPM estimate above; this
    // keeps the pre-flight estimate consistent with the final charge and
    // avoids JSON.stringify punctuation inflation on batch-array inputs.
    // Embeddings have no output generation — pass maxOutputTokens=0 so the
    // estimate reflects input cost only.
    const preflight = await preFlightCreditCheck(
      teamId,
      model,
      providerId,
      inputChars,
      0,
      planLimits.creditsMarkupPercent,
    );
    if (!preflight.allowed) {
      if (preflight.reason === 'missing_pricing') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            message: `Credits billing is unavailable for ${providerId}:${model} because pricing is not configured`,
            code: 'missing_model_pricing',
          },
        }));
        return;
      }
      // Re-arm auto-topup before rejecting (see proxy-handler): a team actively
      // hitting 402 keeps re-enqueueing so the worker retries even after a
      // transient charge failure drained its queue row. Idempotent + best-effort.
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
    const reservation = await reserveCredits(
      teamId,
      preflight.estimatedCost,
      requestId,
      `${model} embedding preflight`,
      planLimits.creditsMarkupPercent,
    );
    if (!reservation.success) {
      await checkAutoTopUpNeeded(teamId, reservation.newBalance).catch((err) => {
        console.error(`[auto-topup] embedding reservation re-enqueue failed for team ${teamId}:`, err);
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

  let knownProviderCostMicrocents: number | null = null;
  let providerWorkDispatched = false;
  let processedInputTokens = 0;
  let responseFailureReason = 'upstream_response_cost_unknown';
  let terminalLogWritten = false;
  const logEmbeddingTerminalRequest = (args: {
    statusCode: number;
    errorType?: string;
    actualCostMicrocents?: number;
    actualCostKnown?: boolean;
    originalCostMicrocents?: number;
    savingsMicrocents?: number;
    inputTokens?: number;
  }): void => {
    if (terminalLogWritten) return;
    terminalLogWritten = true;
    const inputTokens = args.inputTokens ?? processedInputTokens;
    logRequest({
      id: requestId,
      timestamp: new Date().toISOString(),
      team_id: teamId,
      api_key_id: keyInfo.id ?? null,
      // AXI-8: snapshot the identity at request time like the chat path —
      // embedding spend is billed money and must be equally immutable.
      layer_identity_id: layerIdentityFromMetadata(keyInfo?.metadata),
      provider: providerId,
      model_requested: model,
      model_resolved: model,
      input_tokens: inputTokens,
      output_tokens: 0,
      total_tokens: inputTokens,
      original_cost_microcents: args.originalCostMicrocents ?? 0,
      actual_cost_microcents: args.actualCostMicrocents ?? 0,
      actual_cost_known: args.actualCostKnown ?? false,
      savings_microcents: args.savingsMicrocents ?? 0,
      total_latency_ms: Date.now() - startTime,
      ttft_ms: null,
      is_streaming: false,
      is_fallback: false,
      status_code: args.statusCode,
      error_type: args.errorType,
      billing_mode: billingMode,
      activity_category: 'embedding',
      request_kind: 'embedding',
      rate_limited: rateLimited,
    });
  };
  let knownZeroUpstreamErrorStatus: number | null = null;
  // RSH-138: the request's budget reservation. budgetReservationRowsExist is
  // false when no caps are configured (reserveBudget inserts no rows), which
  // gates the dispatch mark that would otherwise 503 on zero rows.
  let budgetReservation: BudgetReservation | null = null;
  let budgetReservationRowsExist = false;

  try {
  // --- RSH-138: PRE-DISPATCH BUDGET RESERVATION ---
  // Input-only estimate using the UTF-8 byte upper bound (never the char/4
  // heuristic, which under-counts CJK/emoji). Hard caps fail closed on
  // missing pricing; reservation failures keep the 503 contract. A rejection
  // here leaves the independent credits reservation to the outer cleanup.
  try {
    const budgetEstimate = await estimateEmbeddingBudget({
      provider: providerId,
      model,
      inputTokens: utf8TokenUpperBound(typeof input === 'string' ? [input] : input),
    });
    const rawIdentity = layerIdentityFromMetadata(keyInfo.metadata);
    const admission = await reserveBudget({
      requestId,
      teamId,
      apiKeyId: keyInfo.id ?? null,
      identityId: isValidIdentityId(rawIdentity) ? rawIdentity : null,
      estimate: budgetEstimate,
    });
    if (!admission.allowed) {
      void recordAuditEvent({
        team_id: teamId,
        api_key_id: keyInfo.id ?? null,
        key_prefix: null,
        event_type: 'budget_exceeded',
        details: admission.kind === 'exceeded'
          ? { scope: admission.scope, action: admission.action, window: admission.window, request_kind: 'embedding' }
          : admission.kind === 'estimate_unavailable'
            ? { action: 'estimate_unavailable', window: admission.window, request_kind: 'embedding' }
            : { action: 'unavailable', request_kind: 'embedding' },
      });
      writeBudgetRejection(res, admission);
      return;
    }
    budgetReservation = admission.reservation;
    budgetReservationRowsExist = !admission.warnings.includes('no_budget_caps_configured');
  } catch (err) {
    console.error('Embedding budget reservation failed:', err);
    void recordAuditEvent({
      team_id: teamId,
      api_key_id: keyInfo.id ?? null,
      key_prefix: null,
      event_type: 'budget_exceeded',
      details: { action: 'unavailable', request_kind: 'embedding' },
    });
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Budget service unavailable' } }));
    return;
  }

  // --- BUILD + DISPATCH UPSTREAM ---
  // buildEmbeddingRequest emits ONLY provider-supported embedding fields — no
  // RouteShift-only fields ever reach upstream.
  const apiModelId = EMBEDDING_MODELS[model].api_model_id;
  let providerReq: ProviderRequest;
  try {
    providerReq = provider.buildEmbeddingRequest(input, apiModelId, apiKey, embeddingOptions);
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: (err as Error).message } }));
    // RSH-138: no dispatch occurred; free the reservation.
    budgetReservation = await settleBudgetExact(budgetReservation, 0, 'pre_dispatch_build');
    return;
  }

  let upstreamRes: Response;
  if (upstreamLabel) incrementInFlight(teamId, providerId, upstreamLabel);
  // RSH-138: fence the first provider fetch with the atomic lease check. A
  // failed mark aborts before any upstream call.
  if (budgetReservation && budgetReservationRowsExist && !budgetReservation.dispatched) {
    try {
      const marked = await markBudgetReservationDispatched(budgetReservation);
      if (!marked.marked) {
        if (upstreamLabel) decrementInFlight(teamId, providerId, upstreamLabel);
        logEmbeddingTerminalRequest({ statusCode: 503, errorType: 'budget_dispatch_mark_failed' });
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Budget service unavailable' } }));
        return;
      }
      budgetReservation.dispatched = true;
    } catch (err) {
      console.error('Budget dispatch mark failed:', err);
      if (upstreamLabel) decrementInFlight(teamId, providerId, upstreamLabel);
      logEmbeddingTerminalRequest({ statusCode: 503, errorType: 'budget_dispatch_mark_failed' });
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Budget service unavailable' } }));
      return;
    }
  }
  const upstreamStart = Date.now();
  try {
    providerWorkDispatched = true;
    upstreamRes = await fetch(providerReq.url, {
      method: providerReq.method,
      headers: providerReq.headers,
      body: providerReq.body,
    });
  } catch (err) {
    if (upstreamLabel) {
      decrementInFlight(teamId, providerId, upstreamLabel);
      markCooldown(teamId, providerId, upstreamLabel);
    }
    console.error('Upstream embeddings request failed:', err);
    await settleUnknownEmbeddingCostHold({
      reservation: creditReservation,
      teamId,
      requestId,
      markupPercent: planLimits.creditsMarkupPercent,
      model,
      reasonCode: 'upstream_network_error',
    });
    logEmbeddingTerminalRequest({ statusCode: 502, errorType: 'upstream_network_error' });
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Upstream request failed' } }));
    // RSH-138: the upstream may have billed despite the network failure; hold
    // the unresolved remainder at the known lower bound.
    budgetReservation = await settleBudgetUnknown(budgetReservation, 0, 'upstream_unknown');
    return;
  }
  if (upstreamLabel) {
    recordLatency(teamId, providerId, upstreamLabel, Date.now() - upstreamStart);
    decrementInFlight(teamId, providerId, upstreamLabel);
  }

  if (!upstreamRes.ok) {
    if (upstreamLabel) {
      if (upstreamRes.status === 429) {
        markCooldown(teamId, providerId, upstreamLabel);
        rateLimited = true;
      } else if (upstreamRes.status >= 500) {
        markCooldown(teamId, providerId, upstreamLabel);
      }
    }
    const errorBody = await upstreamRes.text();
    let parsed: unknown;
    try { parsed = JSON.parse(errorBody); } catch { parsed = { message: errorBody }; }
    const proxyErr = provider.normalizeError(upstreamRes.status, parsed);
    if (upstreamRes.status >= 500) {
      await settleUnknownEmbeddingCostHold({
        reservation: creditReservation,
        teamId,
        requestId,
        markupPercent: planLimits.creditsMarkupPercent,
        model,
        reasonCode: 'upstream_http_5xx',
      });
      logEmbeddingTerminalRequest({ statusCode: upstreamRes.status, errorType: 'upstream_http_5xx' });
      // RSH-138: a 5xx may have been billed; hold the unresolved remainder.
      budgetReservation = await settleBudgetUnknown(budgetReservation, 0, 'upstream_unknown');
    } else {
      // Preserve known-zero upstream failures in request_logs for parity with
      // chat. Defer until finally releases any credits reservation.
      knownZeroUpstreamErrorStatus = upstreamRes.status;
      // RSH-138: a 4xx is known zero provider spend; free the reservation.
      budgetReservation = await settleBudgetExact(budgetReservation, 0, 'no_dispatch');
    }
    res.writeHead(upstreamRes.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: proxyErr.message } }));
    return;
  }

  // Pricing can be removed after pre-flight while the request is in flight.
  // The provider has already accepted work, so this must remain a durable
  // unknown-cost hold instead of falling through to a zero release.
  responseFailureReason = 'post_dispatch_pricing_lookup_failed';
  if (billingMode === 'credits' && !(await getCreditPricing(providerId, model))) {
    await settleUnknownEmbeddingCostHold({
      reservation: creditReservation,
      teamId,
      requestId,
      markupPercent: planLimits.creditsMarkupPercent,
      model,
      reasonCode: 'missing_model_pricing_after_dispatch',
    });
    logEmbeddingTerminalRequest({ statusCode: 503, errorType: 'missing_model_pricing_after_dispatch' });
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        message: `Credits billing is unavailable for ${providerId}:${model} because pricing is not configured`,
        code: 'missing_model_pricing',
      },
    }));
    // RSH-138: the served attempt's cost is unpriceable; hold the remainder.
    budgetReservation = await settleBudgetUnknown(budgetReservation, 0, 'upstream_unknown');
    return;
  }

  responseFailureReason = 'upstream_json_parse_error';
  const upstreamBody = await upstreamRes.json();
  responseFailureReason = 'upstream_embedding_response_invalid';
  const { embeddings, usage } = provider.parseEmbeddingResponse(upstreamBody);

  // Embeddings produce no output tokens. Prefer the upstream-reported input
  // count; fall back to the char/4 estimate when the provider omits usage
  // (e.g. Gemini). Use the raw input character count (same as the TPM
  // estimate above) — JSON.stringify would add quotes/commas/brackets and
  // systematically over-charge batch-array inputs.
  const inputTokens = usage.input_tokens > 0
    ? usage.input_tokens
    : Math.ceil(inputChars / 4);
  const finalUsage: TokenUsage = {
    input_tokens: inputTokens,
    output_tokens: 0,
    total_tokens: inputTokens,
  };
  processedInputTokens = inputTokens;

  // Reconcile the TPM pre-flight estimate with the actual input-token count.
  rateLimiter.reconcileActualTokens(tpmRecordIds, inputTokens);

  responseFailureReason = 'upstream_cost_calculation_failed';
  const cost = await computeRequestCost(model, providerId, model, providerId, finalUsage);
  if (cost.actual_cost_known === false) {
    if (billingMode === 'credits') {
      await settleUnknownEmbeddingCostHold({
        reservation: creditReservation,
        teamId,
        requestId,
        markupPercent: planLimits.creditsMarkupPercent,
        model,
        reasonCode: 'missing_model_pricing_after_dispatch',
      });
      logEmbeddingTerminalRequest({
        statusCode: 503,
        errorType: 'missing_model_pricing_after_dispatch',
        inputTokens,
      });
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: `Credits billing is unavailable for ${providerId}:${model} because pricing is not configured`,
          code: 'missing_model_pricing',
        },
      }));
      // RSH-138: the served attempt's cost is unpriceable; hold the remainder.
      budgetReservation = await settleBudgetUnknown(budgetReservation, 0, 'upstream_unknown');
      return;
    }
  }
  if (cost.actual_cost_known !== false) knownProviderCostMicrocents = cost.actual_cost_microcents;

  // --- OPENAI-SHAPED RESPONSE ---
  const responseBody = {
    object: 'list',
    data: embeddings.map((embedding, index) => ({
      object: 'embedding',
      index,
      embedding,
    })),
    model,
    usage: {
      prompt_tokens: inputTokens,
      total_tokens: inputTokens,
    },
  };

  // RSH-138: the budget ledger settles as soon as the exact cost is known —
  // BEFORE the credit deduction, so a credit-ledger failure can never strand
  // the independent budget reservation (it would otherwise idle into a
  // full-estimate unknown hold with a zero lower bound).
  budgetReservation = cost.actual_cost_known !== false
    ? await settleBudgetExact(budgetReservation, cost.actual_cost_microcents, 'no_dispatch')
    : await settleBudgetUnknown(budgetReservation, 0, 'upstream_unknown');

  // --- CREDITS DEDUCTION (credits mode only) ---
  if (billingMode === 'credits') {
    try {
      const settlementResult = await settleReservedCredits(
        teamId,
        creditReservation?.amountDeducted ?? 0,
        cost.actual_cost_microcents,
        planLimits.creditsMarkupPercent,
        requestId,
        `${model} embedding (${inputTokens} tokens)`,
      );
      if (creditReservation) creditReservation.resolved = true;
      if (settlementResult.success) {
        await checkAutoTopUpNeeded(teamId, settlementResult.newBalance).catch((err) => {
          console.error('Embedding auto top-up check failed:', err);
        });
      } else {
        console.error('Embedding credit deduction failed:', settlementResult);
        logEmbeddingTerminalRequest({
          statusCode: 402,
          errorType: 'credit_deduction_failed',
          actualCostMicrocents: cost.actual_cost_microcents,
          actualCostKnown: true,
          originalCostMicrocents: cost.original_cost_microcents,
          savingsMicrocents: cost.savings_microcents,
          inputTokens,
        });
        res.writeHead(402, {
          'Content-Type': 'application/json',
          'X-RouteShift-Credits-Remaining': String(settlementResult.newBalance),
        });
        res.end(JSON.stringify({ error: { message: 'Insufficient credits', code: 'credit_deduction_failed' } }));
        return;
      }
    } catch (err) {
      console.error('Embedding credit deduction failed:', err);
      // Provider work has completed and its exact cost is known. Keep the
      // durable reservation: finally must not turn this accounting outage into
      // a zero-cost refund.
      if (creditReservation) creditReservation.resolved = true;
      logEmbeddingTerminalRequest({
        statusCode: 503,
        errorType: 'credit_deduction_unavailable',
        actualCostMicrocents: cost.actual_cost_microcents,
        actualCostKnown: true,
        originalCostMicrocents: cost.original_cost_microcents,
        savingsMicrocents: cost.savings_microcents,
        inputTokens,
      });
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Credit deduction unavailable', code: 'credit_deduction_unavailable' } }));
      return;
    }
  }

  res.setHeader('X-RouteShift-Request-Id', requestId);
  res.setHeader('X-RouteShift-Model', model);
  res.setHeader('X-RouteShift-Provider', providerId);
  res.setHeader('X-RateLimit-Remaining', String(rateResult.remaining));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(responseBody));

  logEmbeddingTerminalRequest({
    statusCode: 200,
    actualCostMicrocents: cost.actual_cost_microcents,
    actualCostKnown: cost.actual_cost_known !== false,
    originalCostMicrocents: cost.original_cost_microcents,
    savingsMicrocents: cost.savings_microcents,
    inputTokens,
  });
  } catch (err) {
    if (providerWorkDispatched && knownProviderCostMicrocents === null) {
      await settleUnknownEmbeddingCostHold({
        reservation: creditReservation,
        teamId,
        requestId,
        markupPercent: planLimits.creditsMarkupPercent,
        model,
        reasonCode: responseFailureReason,
      });
      // RSH-138: the upstream may have billed; hold the unresolved remainder.
      budgetReservation = await settleBudgetUnknown(budgetReservation, 0, 'upstream_unknown');
    } else if (creditReservation && !creditReservation.resolved) {
      // Provider work was completed and priced, but accounting/response work
      // failed. Keep the durable reservation for reconciliation; a refund
      // would erase known spend.
      creditReservation.resolved = true;
      captureException(err, {
        tags: { source: 'credit_settlement', handler: 'embeddings' },
        extra: { request_id: requestId, team_id: teamId, actual_cost_microcents: knownProviderCostMicrocents },
      });
    }
    console.error('Upstream embedding response handling failed:', err);
    if (!res.headersSent) {
      logEmbeddingTerminalRequest({
        statusCode: 502,
        errorType: knownProviderCostMicrocents === null
          ? responseFailureReason
          : 'embedding_response_handling_failed',
        actualCostMicrocents: knownProviderCostMicrocents ?? 0,
        actualCostKnown: knownProviderCostMicrocents !== null,
      });
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Upstream response handling failed' } }));
    }
  } finally {
    if (creditReservation && !creditReservation.resolved) {
      try {
        const releaseResult = await settleReservedCredits(
          teamId,
          creditReservation.amountDeducted,
          0,
          planLimits.creditsMarkupPercent,
          requestId,
          `${model} embedding (reservation released)`,
        );
        if (!releaseResult.success) {
          const err = new Error('Embedding credit reservation release returned success=false');
          console.error(JSON.stringify({
            event: 'routeshift_embedding_credit_reservation_release_failed',
            request_id: requestId,
            team_id: teamId,
            provider: providerId,
            model,
            reserved_microcents: creditReservation.amountDeducted,
            balance_microcents: releaseResult.newBalance,
          }));
          captureException(err, {
            tags: { source: 'credit_reservation_release', handler: 'embeddings' },
            extra: {
              request_id: requestId,
              team_id: teamId,
              provider: providerId,
              model,
              reserved_microcents: creditReservation.amountDeducted,
              balance_microcents: releaseResult.newBalance,
            },
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(JSON.stringify({
          event: 'routeshift_embedding_credit_reservation_release_failed',
          request_id: requestId,
          team_id: teamId,
          provider: providerId,
          model,
          reserved_microcents: creditReservation.amountDeducted,
          error: message,
        }));
        captureException(err, {
          tags: { source: 'credit_reservation_release', handler: 'embeddings' },
          extra: {
            request_id: requestId,
            team_id: teamId,
            provider: providerId,
            model,
            reserved_microcents: creditReservation.amountDeducted,
          },
        });
      }
    }
    if (knownZeroUpstreamErrorStatus !== null) {
      logEmbeddingTerminalRequest({
        statusCode: knownZeroUpstreamErrorStatus,
        errorType: 'upstream_http_error',
        actualCostMicrocents: 0,
        actualCostKnown: true,
        savingsMicrocents: 0,
      });
    }
    // RSH-138: safety net for pre-dispatch returns that never settled. A
    // dispatched or already-terminal reservation is never released here — a
    // dispatched row without an explicit terminal transition is left for lease
    // reclamation into unknown-held, never refunded.
    if (budgetReservation && !budgetReservation.terminal && !budgetReservation.dispatched) {
      try {
        await releaseBudgetReservation(budgetReservation, 'no_dispatch');
      } catch (err) {
        console.error(JSON.stringify({
          event: 'routeshift_budget_ledger_failure',
          request_id: requestId,
          team_id: teamId,
          reason_code: 'no_dispatch',
          error: err instanceof Error ? err.message : String(err),
        }));
        captureException(err, {
          tags: { source: 'budget_ledger', handler: 'embeddings', reason_code: 'no_dispatch' },
          extra: { request_id: requestId, team_id: teamId },
        });
      }
    }
  }
}
