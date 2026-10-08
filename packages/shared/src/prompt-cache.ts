import type { CanonicalRequest } from './types';

export type PromptCacheReason =
  | 'prompt_cache_disabled'
  | 'prompt_cache_passthrough_client_managed'
  | 'prompt_cache_proposed_anthropic_system_breakpoint'
  | 'prompt_cache_skipped_policy_unauthorized'
  | 'prompt_cache_skipped_policy_contract'
  | 'prompt_cache_skipped_credential_scope'
  | 'prompt_cache_skipped_capability_version'
  | 'prompt_cache_skipped_capability_threshold'
  | 'prompt_cache_skipped_shared_platform_scope'
  | 'prompt_cache_skipped_model_unsupported'
  | 'prompt_cache_skipped_below_min_tokens'
  | 'prompt_cache_skipped_no_stable_prefix'
  | 'prompt_cache_skipped_existing_client_control'
  | 'prompt_cache_skipped_plugin_mutation'
  | 'prompt_cache_skipped_retention_policy'
  | 'prompt_cache_skipped_fallback_scope_change'
  | 'prompt_cache_skipped_streaming'
  | 'prompt_cache_skipped_tools'
  | 'prompt_cache_skipped_nonzero_temperature'
  | 'prompt_cache_skipped_invalid_token_count';

export type PromptCacheCredentialScope =
  | 'team_byok'
  | 'tenant_dedicated'
  | 'shared_platform';

export type PromptCacheRetention = '5m' | '1h';

export interface PromptCachePolicy {
  readonly enabled: boolean;
  readonly mode: 'client_managed' | 'gateway_managed';
  /** Policy loaders may construct a gateway-managed policy only after team-admin authorization. */
  readonly authorizedBy: 'team_admin';
  readonly version: number;
  readonly provider: string;
  readonly modelFamilies: readonly string[];
  readonly selector: 'system_end';
  readonly retention: PromptCacheRetention;
  readonly namespaceVersion: number;
}

/** Versioned provider facts are supplied to the planner instead of inferred. */
export interface PromptCacheCapability {
  readonly version: number;
  readonly provider: string;
  readonly model: string;
  readonly minimumPrefixTokens: number;
  readonly supportedRetentions: readonly PromptCacheRetention[];
  readonly supportsSystemEndBreakpoint: boolean;
}

export const PROMPT_CACHE_CAPABILITY_VERSION = 1;

export interface AnthropicPromptCacheOverlay {
  readonly provider: 'anthropic';
  readonly cacheControl: {
    readonly type: 'ephemeral';
    readonly ttl?: '1h';
  };
}

export interface PromptCacheTelemetry {
  readonly prompt_cache_action: 'skipped' | 'passthrough' | 'proposed';
  readonly prompt_cache_reason: PromptCacheReason;
  readonly prompt_cache_policy_version: number | null;
  readonly prompt_cache_retention: PromptCacheRetention | null;
  readonly prompt_cache_credential_scope: PromptCacheCredentialScope | null;
  readonly prompt_cache_namespace_version: number | null;
  readonly prompt_cache_provider_request_supported: boolean;
  readonly prompt_cache_capability_version: number | null;
}

export interface PromptCacheReplayContext {
  /** Deterministic version facts only; never derived from prompt, credential, or tenant values. */
  readonly policyVersion: number | null;
  readonly namespaceVersion: number | null;
  readonly capabilityVersion: number | null;
}

interface PromptCachePlanBase {
  readonly reason: PromptCacheReason;
  readonly provider: string;
  readonly modelFamily: string;
  readonly telemetry: PromptCacheTelemetry;
  readonly replay: PromptCacheReplayContext;
}

export type PromptCachePlan =
  | (PromptCachePlanBase & {
      readonly disposition: 'skipped' | 'passthrough';
    })
  | (PromptCachePlanBase & {
      readonly disposition: 'proposed';
      readonly reason: 'prompt_cache_proposed_anthropic_system_breakpoint';
      readonly provider: 'anthropic';
      readonly selector: 'system_end';
      readonly retention: PromptCacheRetention;
      readonly policyVersion: number;
      readonly namespaceVersion: number;
      readonly capabilityVersion: number;
      readonly overlay: AnthropicPromptCacheOverlay;
    });

export interface PlanPromptCacheInput {
  request: CanonicalRequest;
  provider: string;
  model: string;
  billingMode: 'subscription' | 'credits';
  credentialScope: PromptCacheCredentialScope;
  previousCredentialScope?: PromptCacheCredentialScope;
  policy?: PromptCachePolicy;
  capability?: PromptCacheCapability;
  systemPromptTokens: number;
  pluginMutated: boolean;
}

export function planPromptCache(input: PlanPromptCacheInput): PromptCachePlan {
  const modelFamily = matchingModelFamily(input.policy, input.model) ?? modelFamilyOf(input.model);
  const replay = replayContext(input);
  const providerRequestSupported = supportsProviderRequest(input);
  const result = (
    disposition: 'skipped' | 'passthrough',
    reason: PromptCacheReason,
  ): PromptCachePlan => deepFreezeCopy({
    disposition,
    reason,
    provider: input.provider,
    modelFamily,
    replay,
    telemetry: telemetryFor(input, disposition, reason, providerRequestSupported),
  });
  const skipped = (reason: PromptCacheReason): PromptCachePlan => result('skipped', reason);

  if (!input.policy || input.policy.enabled === false) return skipped('prompt_cache_disabled');
  if (input.policy.enabled !== true) {
    return skipped('prompt_cache_skipped_policy_contract');
  }
  if (input.policy.authorizedBy !== 'team_admin') {
    return skipped('prompt_cache_skipped_policy_unauthorized');
  }
  const retention = retentionOrNull(input.policy.retention);
  if (retention === null) {
    return skipped('prompt_cache_skipped_retention_policy');
  }
  if (!hasValidPolicyContract(input.policy)) {
    return skipped('prompt_cache_skipped_policy_contract');
  }
  if (
    !hasValidCredentialScope(input.credentialScope)
    || (
      input.previousCredentialScope !== undefined
      && !hasValidCredentialScope(input.previousCredentialScope)
    )
  ) {
    return skipped('prompt_cache_skipped_credential_scope');
  }
  if (
    input.previousCredentialScope !== undefined
    && input.previousCredentialScope !== input.credentialScope
  ) {
    return skipped('prompt_cache_skipped_fallback_scope_change');
  }
  if (input.billingMode !== 'subscription' || input.credentialScope === 'shared_platform') {
    return skipped('prompt_cache_skipped_shared_platform_scope');
  }
  if (input.pluginMutated !== false) {
    return skipped('prompt_cache_skipped_plugin_mutation');
  }
  if (input.policy.mode === 'client_managed') {
    return result('passthrough', 'prompt_cache_passthrough_client_managed');
  }
  if (input.request.stream) return skipped('prompt_cache_skipped_streaming');
  if (input.request.temperature !== 0) return skipped('prompt_cache_skipped_nonzero_temperature');
  if ((input.request.tools?.length ?? 0) > 0) return skipped('prompt_cache_skipped_tools');
  if (hasCallerCacheControl(input.request)) {
    return skipped('prompt_cache_skipped_existing_client_control');
  }
  if (!hasStableSystemEnd(input.request)) {
    return skipped('prompt_cache_skipped_no_stable_prefix');
  }
  if (!input.capability || typeof input.capability !== 'object') {
    return skipped('prompt_cache_skipped_model_unsupported');
  }
  if (input.capability.version !== PROMPT_CACHE_CAPABILITY_VERSION) {
    return skipped('prompt_cache_skipped_capability_version');
  }
  if (
    !Number.isSafeInteger(input.capability.minimumPrefixTokens)
    || input.capability.minimumPrefixTokens < 0
  ) {
    return skipped('prompt_cache_skipped_capability_threshold');
  }
  if (
    !hasValidSupportedRetentions(input.capability.supportedRetentions)
    || !input.capability.supportedRetentions.includes(retention)
  ) {
    return skipped('prompt_cache_skipped_retention_policy');
  }
  if (!providerRequestSupported) return skipped('prompt_cache_skipped_model_unsupported');
  if (!Number.isSafeInteger(input.systemPromptTokens) || input.systemPromptTokens < 0) {
    return skipped('prompt_cache_skipped_invalid_token_count');
  }
  if (input.systemPromptTokens < input.capability!.minimumPrefixTokens) {
    return skipped('prompt_cache_skipped_below_min_tokens');
  }

  const cacheControl: AnthropicPromptCacheOverlay['cacheControl'] = retention === '1h'
    ? { type: 'ephemeral', ttl: '1h' }
    : { type: 'ephemeral' };
  const reason = 'prompt_cache_proposed_anthropic_system_breakpoint';

  return deepFreezeCopy({
    disposition: 'proposed',
    reason,
    provider: 'anthropic',
    modelFamily,
    selector: 'system_end',
    retention,
    policyVersion: input.policy.version,
    namespaceVersion: input.policy.namespaceVersion,
    capabilityVersion: input.capability!.version,
    overlay: { provider: 'anthropic', cacheControl },
    replay,
    telemetry: telemetryFor(input, 'proposed', reason, providerRequestSupported),
  });
}

/** Own and freeze planner output at the trusted boundary without freezing caller input. */
function deepFreezeCopy<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => deepFreezeCopy(entry))) as unknown as T;
  }
  const copy = Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, deepFreezeCopy(entry)]),
  );
  return Object.freeze(copy) as T;
}

function telemetryFor(
  input: PlanPromptCacheInput,
  action: PromptCacheTelemetry['prompt_cache_action'],
  reason: PromptCacheReason,
  providerRequestSupported: boolean,
): PromptCacheTelemetry {
  return {
    prompt_cache_action: action,
    prompt_cache_reason: reason,
    prompt_cache_policy_version: versionOrNull(input.policy?.version),
    prompt_cache_retention: retentionOrNull(input.policy?.retention),
    prompt_cache_credential_scope: credentialScopeOrNull(input.credentialScope),
    prompt_cache_namespace_version: versionOrNull(input.policy?.namespaceVersion),
    prompt_cache_provider_request_supported: providerRequestSupported,
    prompt_cache_capability_version: versionOrNull(input.capability?.version),
  };
}

function replayContext(input: PlanPromptCacheInput): PromptCacheReplayContext {
  return {
    policyVersion: versionOrNull(input.policy?.version),
    namespaceVersion: versionOrNull(input.policy?.namespaceVersion),
    capabilityVersion: versionOrNull(input.capability?.version),
  };
}

function versionOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function retentionOrNull(value: unknown): PromptCacheRetention | null {
  return value === '5m' || value === '1h' ? value : null;
}

function credentialScopeOrNull(value: unknown): PromptCacheCredentialScope | null {
  return hasValidCredentialScope(value) ? value : null;
}

function hasValidCredentialScope(value: unknown): value is PromptCacheCredentialScope {
  return value === 'team_byok' || value === 'tenant_dedicated' || value === 'shared_platform';
}

function hasValidPolicyContract(policy: PromptCachePolicy): boolean {
  return (policy.mode === 'client_managed' || policy.mode === 'gateway_managed')
    && versionOrNull(policy.version) !== null
    && typeof policy.provider === 'string'
    && policy.provider.length > 0
    && hasValidModelFamilies(policy.modelFamilies)
    && policy.selector === 'system_end'
    && versionOrNull(policy.namespaceVersion) !== null;
}

function hasValidModelFamilies(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
  }
  return value.every((family) => typeof family === 'string' && family.length > 0)
    && new Set(value).size === value.length;
}

function hasValidSupportedRetentions(value: unknown): value is readonly PromptCacheRetention[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
  }
  if (!value.every((retention) => retentionOrNull(retention) !== null)) return false;
  return new Set(value).size === value.length;
}

function supportsProviderRequest(input: PlanPromptCacheInput): boolean {
  const capability = input.capability;
  return input.provider === 'anthropic'
    && input.policy?.enabled === true
    && input.policy?.authorizedBy === 'team_admin'
    && hasValidPolicyContract(input.policy)
    && retentionOrNull(input.policy.retention) !== null
    && input.policy?.provider === input.provider
    && matchingModelFamily(input.policy, input.model) !== null
    && capability?.provider === input.provider
    && capability.model === input.model
    && capability.version === PROMPT_CACHE_CAPABILITY_VERSION
    && Number.isSafeInteger(capability.minimumPrefixTokens)
    && capability.minimumPrefixTokens >= 0
    && hasValidSupportedRetentions(capability.supportedRetentions)
    && capability.supportsSystemEndBreakpoint === true;
}

function matchingModelFamily(policy: PromptCachePolicy | undefined, model: string): string | null {
  if (!policy || !hasValidModelFamilies(policy.modelFamilies)) return null;
  return policy.modelFamilies.find((family) => model === family || model.startsWith(`${family}-`)) ?? null;
}

function modelFamilyOf(model: string): string {
  const parts = model.split('-');
  return parts.length >= 2 ? parts.slice(0, 2).join('-') : model;
}

function hasStableSystemEnd(request: CanonicalRequest): boolean {
  if (typeof request.system_prompt === 'string') return request.system_prompt.length > 0;
  if (!Array.isArray(request.system_prompt) || request.system_prompt.length === 0) return false;
  const finalBlock = request.system_prompt[request.system_prompt.length - 1];
  return finalBlock?.type === 'text'
    && typeof finalBlock.text === 'string'
    && finalBlock.text.length > 0;
}

function hasCallerCacheControl(request: CanonicalRequest): boolean {
  const cacheControlKeys = new Set([
    'cache_control',
    'prompt_cache_breakpoint',
    'prompt_cache_key',
    'prompt_cache_options',
    'prompt_cache_retention',
  ]);
  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(visit);
    if (value === null || typeof value !== 'object') return false;
    return Object.entries(value).some(([key, nested]) => cacheControlKeys.has(key) || visit(nested));
  };
  return visit(request.system_prompt)
    || visit(request.messages)
    || visit(request.provider_params);
}
