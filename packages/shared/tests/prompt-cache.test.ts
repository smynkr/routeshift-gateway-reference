import { describe, expect, it } from 'vitest';
import {
  PROMPT_CACHE_CAPABILITY_VERSION,
  planPromptCache,
  type PromptCacheCapability,
  type PromptCachePolicy,
} from '../src/prompt-cache';
import type { CanonicalRequest } from '../src/types';

const request: CanonicalRequest = {
  model: 'claude-sonnet-4-6',
  messages: [{ role: 'user', content: 'Dynamic suffix' }],
  system_prompt: 'Stable system prefix',
  temperature: 0,
  stream: false,
};

const policy: PromptCachePolicy = {
  enabled: true,
  mode: 'gateway_managed',
  authorizedBy: 'team_admin',
  version: 1,
  provider: 'anthropic',
  modelFamilies: ['claude-sonnet'],
  selector: 'system_end',
  retention: '5m',
  namespaceVersion: 1,
};

const capability: PromptCacheCapability = {
  version: PROMPT_CACHE_CAPABILITY_VERSION,
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  minimumPrefixTokens: 4,
  supportedRetentions: ['5m', '1h'],
  supportsSystemEndBreakpoint: true,
};

function plan(overrides: Partial<Parameters<typeof planPromptCache>[0]> = {}) {
  return planPromptCache({
    request,
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    billingMode: 'subscription',
    credentialScope: 'team_byok',
    policy,
    capability,
    systemPromptTokens: 8,
    pluginMutated: false,
    ...overrides,
  });
}

describe('planPromptCache', () => {
  it('is disabled by default and leaves the canonical request untouched', () => {
    const before = structuredClone(request);
    const result = plan({ policy: undefined });

    expect(result).toMatchObject({
      disposition: 'skipped',
      reason: 'prompt_cache_disabled',
      provider: 'anthropic',
      modelFamily: 'claude-sonnet',
      telemetry: {
        prompt_cache_action: 'skipped',
        prompt_cache_reason: 'prompt_cache_disabled',
        prompt_cache_policy_version: null,
        prompt_cache_credential_scope: 'team_byok',
      },
    });
    expect(request).toEqual(before);
  });

  it('produces a deterministic Anthropic system-end plan without prompt or tenant data', () => {
    const first = plan();
    const second = plan();

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      disposition: 'proposed',
      reason: 'prompt_cache_proposed_anthropic_system_breakpoint',
      provider: 'anthropic',
      modelFamily: 'claude-sonnet',
      selector: 'system_end',
      retention: '5m',
      policyVersion: 1,
      namespaceVersion: 1,
      capabilityVersion: 1,
      overlay: {
        provider: 'anthropic',
        cacheControl: { type: 'ephemeral' },
      },
      telemetry: {
        prompt_cache_action: 'proposed',
        prompt_cache_reason: 'prompt_cache_proposed_anthropic_system_breakpoint',
        prompt_cache_policy_version: 1,
        prompt_cache_retention: '5m',
        prompt_cache_credential_scope: 'team_byok',
        prompt_cache_namespace_version: 1,
        prompt_cache_provider_request_supported: true,
        prompt_cache_capability_version: 1,
      },
      replay: {
        policyVersion: 1,
        namespaceVersion: 1,
        capabilityVersion: 1,
      },
    });
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain('Stable system prefix');
    expect(serialized).not.toContain('team-');
    expect(serialized).not.toContain('sk-ant');
  });

  it('keeps replay facts deterministic without deriving them from prompt content', () => {
    const first = plan();
    const second = plan({
      request: {
        ...request,
        system_prompt: 'Entirely different private prefix',
        messages: [{ role: 'user', content: 'Entirely different private suffix' }],
      },
    });

    expect(first.replay).toEqual({
      policyVersion: 1,
      namespaceVersion: 1,
      capabilityVersion: 1,
    });
    expect(second.replay).toEqual(first.replay);
    expect(first.replay).not.toHaveProperty('inputFingerprint');
  });

  it('fails closed for shared platform credentials with the exact policy reason', () => {
    expect(plan({ billingMode: 'credits', credentialScope: 'shared_platform' })).toMatchObject({
      disposition: 'skipped',
      reason: 'prompt_cache_skipped_shared_platform_scope',
    });
    expect(plan({
      billingMode: 'credits',
      credentialScope: 'shared_platform',
      policy: { ...policy, mode: 'client_managed' },
    })).toMatchObject({
      disposition: 'skipped',
      reason: 'prompt_cache_skipped_shared_platform_scope',
    });
  });

  it.each([
    [{ request: { ...request, stream: true } }, 'prompt_cache_skipped_streaming'],
    [{ request: { ...request, temperature: 0.1 } }, 'prompt_cache_skipped_nonzero_temperature'],
    [{ request: { ...request, tools: [{ type: 'function', function: { name: 'lookup' } }] } }, 'prompt_cache_skipped_tools'],
    [{ pluginMutated: true }, 'prompt_cache_skipped_plugin_mutation'],
  ] as const)('preserves cacheability gate %s', (overrides, reason) => {
    expect(plan(overrides)).toMatchObject({ disposition: 'skipped', reason });
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['zero', 0],
    ['one', 1],
    ['empty string', ''],
    ['forged false string', 'false'],
    ['object', {}],
    ['array', []],
    ['NaN', Number.NaN],
  ])('fails closed when runtime pluginMutated is %s', (_label, pluginMutated) => {
    const before = structuredClone(request);
    const result = plan({ pluginMutated } as unknown as Parameters<typeof planPromptCache>[0]);

    expect(result).toMatchObject({
      disposition: 'skipped',
      reason: 'prompt_cache_skipped_plugin_mutation',
      telemetry: {
        prompt_cache_action: 'skipped',
        prompt_cache_reason: 'prompt_cache_skipped_plugin_mutation',
      },
    });
    expect(request).toEqual(before);
  });

  it('fails closed when runtime pluginMutated is omitted', () => {
    const result = planPromptCache({
      request,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      billingMode: 'subscription',
      credentialScope: 'team_byok',
      policy,
      capability,
      systemPromptTokens: 8,
    } as unknown as Parameters<typeof planPromptCache>[0]);

    expect(result).toMatchObject({
      disposition: 'skipped',
      reason: 'prompt_cache_skipped_plugin_mutation',
      telemetry: {
        prompt_cache_action: 'skipped',
        prompt_cache_reason: 'prompt_cache_skipped_plugin_mutation',
      },
    });
  });

  it('re-evaluates provider and credential scope for each fallback attempt', () => {
    const primary = plan();
    const differentProvider = plan({
      provider: 'openai',
      model: 'gpt-5.5',
      capability: undefined,
    });
    const differentScope = plan({
      credentialScope: 'shared_platform',
      previousCredentialScope: 'team_byok',
    });

    expect(primary.reason).toBe('prompt_cache_proposed_anthropic_system_breakpoint');
    expect(differentProvider.reason).toBe('prompt_cache_skipped_model_unsupported');
    expect(differentScope.reason).toBe('prompt_cache_skipped_fallback_scope_change');
  });

  it('fails closed on an actual shared-platform fallback even when previous scope is omitted', () => {
    const before = structuredClone(request);
    const result = plan({
      billingMode: 'credits',
      credentialScope: 'shared_platform',
      previousCredentialScope: undefined,
    });

    expect(result).toMatchObject({
      disposition: 'skipped',
      reason: 'prompt_cache_skipped_shared_platform_scope',
    });
    expect(request).toEqual(before);
  });

  it('fails closed on an actual shared-platform fallback carrying stale team-byok history', () => {
    const before = structuredClone(request);
    expect(plan({
      billingMode: 'credits',
      credentialScope: 'shared_platform',
      previousCredentialScope: 'team_byok',
    })).toMatchObject({
      disposition: 'skipped',
      reason: 'prompt_cache_skipped_fallback_scope_change',
    });
    expect(request).toEqual(before);
  });

  it('fails closed when shared billing is paired with a stale team-byok scope claim', () => {
    expect(plan({ billingMode: 'credits', credentialScope: 'team_byok' })).toMatchObject({
      disposition: 'skipped',
      reason: 'prompt_cache_skipped_shared_platform_scope',
    });
  });

  it('returns a defensively copied, deeply immutable proposal', () => {
    const before = structuredClone(request);
    const runtimePolicy = { ...policy, modelFamilies: [...policy.modelFamilies] };
    const runtimeCapability = {
      ...capability,
      supportedRetentions: [...capability.supportedRetentions],
    };
    const result = plan({ policy: runtimePolicy, capability: runtimeCapability });

    expect(result.disposition).toBe('proposed');
    if (result.disposition !== 'proposed') throw new Error('expected proposed plan');

    expect(result).toMatchObject({
      disposition: 'proposed',
      reason: 'prompt_cache_proposed_anthropic_system_breakpoint',
      overlay: { provider: 'anthropic' },
      telemetry: {
        prompt_cache_action: 'proposed',
        prompt_cache_reason: 'prompt_cache_proposed_anthropic_system_breakpoint',
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.overlay)).toBe(true);
    expect(Object.isFrozen(result.overlay.cacheControl)).toBe(true);
    expect(Object.isFrozen(result.telemetry)).toBe(true);
    expect(Object.isFrozen(result.replay)).toBe(true);

    expect(Reflect.set(result, 'reason', 'prompt_cache_disabled')).toBe(false);
    expect(Reflect.set(result.overlay, 'provider', 'openai')).toBe(false);
    expect(Reflect.set(result.overlay.cacheControl, 'ttl', '1h')).toBe(false);
    expect(Reflect.set(result.telemetry, 'prompt_cache_action', 'skipped')).toBe(false);
    expect(Reflect.set(result.replay, 'policyVersion', 99)).toBe(false);
    expect(Reflect.deleteProperty(result.overlay.cacheControl, 'type')).toBe(false);
    expect(Reflect.defineProperty(result.overlay.cacheControl, 'ttl', { value: '1h' })).toBe(false);

    if (false) {
      // @ts-expect-error Prompt-cache plans are readonly at the type boundary.
      result.reason = 'prompt_cache_disabled';
      // @ts-expect-error Proposal overlays are readonly at the type boundary.
      result.overlay.provider = 'anthropic';
      // @ts-expect-error Cache-control values are readonly at the type boundary.
      result.overlay.cacheControl.ttl = '1h';
      // @ts-expect-error Telemetry nested in a plan is readonly.
      result.telemetry.prompt_cache_action = 'skipped';
      // @ts-expect-error Replay facts nested in a plan are readonly.
      result.replay.policyVersion = 2;
    }

    runtimePolicy.modelFamilies[0] = 'mutated-family';
    runtimeCapability.supportedRetentions[0] = '1h';
    expect(Object.isFrozen(runtimePolicy)).toBe(false);
    expect(Object.isFrozen(runtimePolicy.modelFamilies)).toBe(false);
    expect(Object.isFrozen(runtimeCapability)).toBe(false);
    expect(Object.isFrozen(runtimeCapability.supportedRetentions)).toBe(false);
    expect(result.modelFamily).toBe('claude-sonnet');
    expect(result.retention).toBe('5m');

    const next = plan();
    expect(next.disposition).toBe('proposed');
    if (next.disposition !== 'proposed') throw new Error('expected proposed plan');
    expect(next.overlay.cacheControl).toEqual({ type: 'ephemeral' });
    expect(next.overlay).not.toBe(result.overlay);
    expect(next.overlay.cacheControl).not.toBe(result.overlay.cacheControl);
    expect(next.telemetry).not.toBe(result.telemetry);
    expect(next.replay).not.toBe(result.replay);
    expect(request).toEqual(before);
    expect(request.system_prompt).toBe('Stable system prefix');
  });

  it.each([
    ['skipped', plan({ policy: undefined })],
    ['passthrough', plan({ policy: { ...policy, mode: 'client_managed' } })],
  ])('deeply freezes a %s plan', (_label, result) => {
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.telemetry)).toBe(true);
    expect(Object.isFrozen(result.replay)).toBe(true);
    expect(Reflect.set(result, 'reason', 'prompt_cache_proposed_anthropic_system_breakpoint')).toBe(false);
    expect(Reflect.set(result.telemetry, 'prompt_cache_action', 'proposed')).toBe(false);
    expect(Reflect.set(result.replay, 'capabilityVersion', 999)).toBe(false);
  });

  it.each([
    ['omitted', undefined],
    ['forged member role', 'team_member'],
    ['forged truthy value', true],
    ['forged object', { role: 'team_admin' }],
  ])('fails closed when runtime policy authorization is %s', (_label, authorizedBy) => {
    const before = structuredClone(request);
    const runtimePolicy = { ...policy, authorizedBy } as unknown as PromptCachePolicy;
    const result = plan({ policy: runtimePolicy });

    expect(result).toMatchObject({
      disposition: 'skipped',
      reason: 'prompt_cache_skipped_policy_unauthorized',
      telemetry: {
        prompt_cache_action: 'skipped',
        prompt_cache_reason: 'prompt_cache_skipped_policy_unauthorized',
        prompt_cache_provider_request_supported: false,
      },
    });
    expect(request).toEqual(before);
  });

  it.each([
    ['non-boolean enabled flag', { enabled: 'true' }],
    ['unknown mode', { mode: 'automatic' }],
    ['invalid policy version', { version: Number.NaN }],
    ['invalid namespace version', { namespaceVersion: -1 }],
    ['unknown selector', { selector: 'message_end' }],
    ['empty provider', { provider: '' }],
    ['empty model family list', { modelFamilies: [] }],
    ['non-string model family', { modelFamilies: ['claude-sonnet', 1] }],
    ['duplicate model family', { modelFamilies: ['claude-sonnet', 'claude-sonnet'] }],
  ])('fails closed for a runtime policy with %s', (_label, patch) => {
    const runtimePolicy = { ...policy, ...patch } as unknown as PromptCachePolicy;
    expect(plan({ policy: runtimePolicy })).toMatchObject({
      disposition: 'skipped',
      reason: 'prompt_cache_skipped_policy_contract',
      telemetry: {
        prompt_cache_action: 'skipped',
        prompt_cache_reason: 'prompt_cache_skipped_policy_contract',
        prompt_cache_provider_request_supported: false,
      },
    });
  });

  it.each([
    ['unknown current scope', { credentialScope: 'provider_shared' }],
    ['omitted current scope', { credentialScope: undefined }],
    ['unknown previous scope', { previousCredentialScope: 'provider_shared' }],
  ])('fails closed for an %s', (_label, overrides) => {
    expect(plan(overrides as Parameters<typeof planPromptCache>[0])).toMatchObject({
      disposition: 'skipped',
      reason: 'prompt_cache_skipped_credential_scope',
      telemetry: {
        prompt_cache_action: 'skipped',
        prompt_cache_reason: 'prompt_cache_skipped_credential_scope',
      },
    });
  });

  it('keeps client-managed caching as explicit passthrough without mutating controls', () => {
    const controlled: CanonicalRequest = {
      ...request,
      system_prompt: [{
        type: 'text',
        text: 'Caller prefix',
        cache_control: { type: 'ephemeral' },
      }],
    };
    const before = structuredClone(controlled);
    expect(plan({
      request: controlled,
      policy: { ...policy, mode: 'client_managed' },
    })).toMatchObject({
      disposition: 'passthrough',
      reason: 'prompt_cache_passthrough_client_managed',
    });
    expect(controlled).toEqual(before);
  });

  it('does not mix gateway controls with caller-managed controls', () => {
    const clientManagedRequest: CanonicalRequest = {
      ...request,
      system_prompt: [{
        type: 'text',
        text: 'Caller prefix',
        cache_control: { type: 'ephemeral' },
      }],
    };

    const before = structuredClone(clientManagedRequest);
    expect(plan({ request: clientManagedRequest })).toMatchObject({
      disposition: 'skipped',
      reason: 'prompt_cache_skipped_existing_client_control',
    });
    expect(clientManagedRequest).toEqual(before);
  });

  it('rejects client attempts to supply a provider cache namespace', () => {
    expect(plan({
      request: {
        ...request,
        provider_params: { prompt_cache_key: 'client-namespace' },
      },
    })).toMatchObject({
      disposition: 'skipped',
      reason: 'prompt_cache_skipped_existing_client_control',
    });
  });

  it('recursively rejects provider cache controls hidden in nested provider params', () => {
    expect(plan({
      request: {
        ...request,
        provider_params: { vendor: { options: [{ prompt_cache_retention: '1h' }] } },
      },
    })).toMatchObject({
      disposition: 'skipped',
      reason: 'prompt_cache_skipped_existing_client_control',
    });
  });

  it('recursively rejects cache controls hidden in message content', () => {
    expect(plan({
      request: {
        ...request,
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }],
        }],
      },
    })).toMatchObject({
      disposition: 'skipped',
      reason: 'prompt_cache_skipped_existing_client_control',
    });
  });

  it('does not mistake unrelated response-schema property names for provider cache controls', () => {
    expect(plan({
      request: {
        ...request,
        response_format: {
          type: 'json_schema',
          json_schema: {
            schema: {
              type: 'object',
              properties: { cache_control: { type: 'string' } },
            },
          },
        },
      },
    }).reason).toBe('prompt_cache_proposed_anthropic_system_breakpoint');
  });

  it('gates provider capabilities, minimum tokens, and retention', () => {
    expect(plan({ capability: undefined }).reason).toBe('prompt_cache_skipped_model_unsupported');
    expect(plan({ systemPromptTokens: 3 }).reason).toBe('prompt_cache_skipped_below_min_tokens');
    expect(plan({
      policy: { ...policy, retention: '1h' },
      capability: { ...capability, supportedRetentions: ['5m'] },
    }).reason).toBe('prompt_cache_skipped_retention_policy');
  });

  it.each([
    ['forged 24h', '24h'],
    ['omitted', undefined],
    ['null', null],
    ['numeric', 5],
    ['object', { value: '5m' }],
  ])('fails closed when runtime policy retention is %s', (_label, retention) => {
    const runtimePolicy = { ...policy, retention } as unknown as PromptCachePolicy;
    expect(plan({ policy: runtimePolicy })).toMatchObject({
      disposition: 'skipped',
      reason: 'prompt_cache_skipped_retention_policy',
      telemetry: {
        prompt_cache_action: 'skipped',
        prompt_cache_reason: 'prompt_cache_skipped_retention_policy',
        prompt_cache_retention: null,
        prompt_cache_provider_request_supported: false,
      },
    });
  });

  it.each([
    ['omitted', undefined],
    ['null', null],
    ['string', '5m'],
    ['empty', []],
    ['forged 24h', ['24h']],
    ['mixed forged value', ['5m', '24h']],
    ['mixed malformed type', ['5m', 1]],
    ['duplicate', ['5m', '5m']],
  ])('fails closed when runtime supported retentions are %s', (_label, supportedRetentions) => {
    const runtimeCapability = {
      ...capability,
      supportedRetentions,
    } as unknown as PromptCacheCapability;
    expect(plan({ capability: runtimeCapability })).toMatchObject({
      disposition: 'skipped',
      reason: 'prompt_cache_skipped_retention_policy',
      telemetry: {
        prompt_cache_action: 'skipped',
        prompt_cache_reason: 'prompt_cache_skipped_retention_policy',
        prompt_cache_provider_request_supported: false,
      },
    });
  });

  it.each([
    ['leading hole', (() => {
      const value = Array<PromptCacheRetention>(2);
      value[1] = '5m';
      return value;
    })()],
    ['middle hole', ['5m', , '1h']],
    ['trailing hole', (() => {
      const value: PromptCacheRetention[] = ['5m'];
      value.length = 2;
      return value;
    })()],
    ['inherited numeric value', (() => {
      const value = Array<PromptCacheRetention>(1);
      const prototype = Object.create(Array.prototype) as Record<number, PromptCacheRetention>;
      prototype[0] = '5m';
      Object.setPrototypeOf(value, prototype);
      return value;
    })()],
  ])('fails closed for a runtime supported-retention array with a %s', (
    _label,
    supportedRetentions,
  ) => {
    const runtimeCapability = { ...capability, supportedRetentions } as PromptCacheCapability;
    expect(plan({ capability: runtimeCapability })).toMatchObject({
      disposition: 'skipped',
      reason: 'prompt_cache_skipped_retention_policy',
      telemetry: {
        prompt_cache_action: 'skipped',
        prompt_cache_reason: 'prompt_cache_skipped_retention_policy',
        prompt_cache_provider_request_supported: false,
      },
    });
  });

  it.each([
    ['5m', ['5m']],
    ['1h', ['1h']],
    ['5m', ['5m', '1h']],
    ['1h', ['5m', '1h']],
  ] as const)('accepts valid dense %s capability retention in %j', (
    retention,
    supportedRetentions,
  ) => {
    expect(plan({
      policy: { ...policy, retention },
      capability: { ...capability, supportedRetentions: [...supportedRetentions] },
    })).toMatchObject({
      disposition: 'proposed',
      retention,
      telemetry: { prompt_cache_provider_request_supported: true },
    });
  });

  it.each([
    ['5m', { type: 'ephemeral' }],
    ['1h', { type: 'ephemeral', ttl: '1h' }],
  ] as const)('maps valid %s retention consistently across proposal, telemetry, and overlay', (
    retention,
    cacheControl,
  ) => {
    expect(plan({ policy: { ...policy, retention } })).toMatchObject({
      disposition: 'proposed',
      retention,
      overlay: { provider: 'anthropic', cacheControl },
      telemetry: {
        prompt_cache_action: 'proposed',
        prompt_cache_retention: retention,
      },
    });
  });

  it.each([
    ['omitted', undefined],
    ['zero', 0],
    ['future unsupported', PROMPT_CACHE_CAPABILITY_VERSION + 1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['forged string', String(PROMPT_CACHE_CAPABILITY_VERSION)],
  ])('fails closed when runtime capability version is %s', (_label, version) => {
    const before = structuredClone(request);
    const runtimeCapability = { ...capability, version } as unknown as PromptCacheCapability;
    const result = plan({ capability: runtimeCapability });

    expect(result).toMatchObject({
      disposition: 'skipped',
      reason: 'prompt_cache_skipped_capability_version',
      telemetry: {
        prompt_cache_action: 'skipped',
        prompt_cache_reason: 'prompt_cache_skipped_capability_version',
        prompt_cache_provider_request_supported: false,
      },
    });
    expect(request).toEqual(before);
  });

  it.each([
    ['omitted', undefined],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['negative Infinity', Number.NEGATIVE_INFINITY],
    ['negative', -1],
    ['fractional', 4.5],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
  ])('fails closed when runtime capability threshold is %s', (_label, minimumPrefixTokens) => {
    const before = structuredClone(request);
    const runtimeCapability = {
      ...capability,
      minimumPrefixTokens,
    } as unknown as PromptCacheCapability;
    const result = plan({ capability: runtimeCapability });

    expect(result).toMatchObject({
      disposition: 'skipped',
      reason: 'prompt_cache_skipped_capability_threshold',
      telemetry: {
        prompt_cache_action: 'skipped',
        prompt_cache_reason: 'prompt_cache_skipped_capability_threshold',
        prompt_cache_provider_request_supported: false,
      },
    });
    expect(request).toEqual(before);
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['negative Infinity', Number.NEGATIVE_INFINITY],
    ['fractional', 4.5],
    ['negative', -1],
    ['runtime undefined', undefined],
  ])('fails closed for %s system prompt tokens', (_label, systemPromptTokens) => {
    expect(plan({ systemPromptTokens: systemPromptTokens as number })).toMatchObject({
      disposition: 'skipped',
      reason: 'prompt_cache_skipped_invalid_token_count',
    });
  });

  it('rejects integers outside the safe runtime token range', () => {
    expect(plan({ systemPromptTokens: Number.MAX_SAFE_INTEGER + 1 })).toMatchObject({
      disposition: 'skipped',
      reason: 'prompt_cache_skipped_invalid_token_count',
    });
  });
});
