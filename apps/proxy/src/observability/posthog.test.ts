import { beforeEach, describe, expect, it, vi } from 'vitest';

const posthogCapture = vi.fn();
const PostHog = vi.fn().mockImplementation(() => ({
  capture: posthogCapture,
}));

vi.mock('posthog-node', () => ({ PostHog }));

describe('PostHog AI observability', () => {
  // Exception: test cases intentionally exercise module environment loading boundaries after vi.resetModules()
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.POSTHOG_API_KEY;
    delete process.env.POSTHOG_HOST;
    delete process.env.POSTHOG_IDENTITY_SALT;
  });

  it('pseudonymizes identities via HMAC-SHA256 and fails closed without salt', async () => {
    const { pseudonymizeIdentity, resolveDistinctId } = await import('./posthog.js');

    // Without salt, fail-closed: returns undefined and anonymous non-identifying constant
    expect(pseudonymizeIdentity('raw_user_123')).toBeUndefined();
    const unseeded = resolveDistinctId({ teamId: 'team_xyz', layerIdentityId: 'raw_user_123' });
    expect(unseeded).toBe('anon_unidentified');
    expect(unseeded).not.toContain('team');
    expect(unseeded).not.toContain('xyz');
    expect(unseeded).not.toContain('user');
    expect(unseeded).not.toContain('123');
    process.env.POSTHOG_IDENTITY_SALT = 'secret_salt_456';
    const userPseudo = pseudonymizeIdentity('raw_user_123');
    expect(userPseudo).toBeDefined();
    expect(userPseudo).toHaveLength(64); // 256-bit hex
    expect(userPseudo).not.toContain('raw_user_123');

    const distinctUser = resolveDistinctId({ teamId: 'team_xyz', layerIdentityId: 'raw_user_123' });
    expect(distinctUser.startsWith('user_')).toBe(true);
    expect(distinctUser).not.toContain('raw_user_123');

    const distinctTeam = resolveDistinctId({ teamId: 'team_xyz' });
    expect(distinctTeam.startsWith('team_')).toBe(true);
    expect(distinctTeam).not.toContain('team_xyz');
  });

  it('does not initialize or capture when the API key is absent', async () => {
    const { captureAiGeneration, initPostHog } = await import('./posthog.js');

    initPostHog();
    captureAiGeneration({
      distinctId: 'anon_test',
      traceId: 'req_123',
      model: 'claude-3-5-sonnet',
      provider: 'anthropic',
      inputTokens: 10,
      outputTokens: 20,
      latencySeconds: 0.5,
    });

    expect(PostHog).not.toHaveBeenCalled();
    expect(posthogCapture).not.toHaveBeenCalled();
  });

  it('does not initialize when the host is absent', async () => {
    process.env.POSTHOG_API_KEY = 'phc_test';
    const { initPostHog } = await import('./posthog.js');

    initPostHog();

    expect(PostHog).not.toHaveBeenCalled();
  });

  it('captures documented generation properties and tool metadata with error handling', async () => {
    process.env.POSTHOG_API_KEY = 'phc_test';
    process.env.POSTHOG_HOST = 'https://us.i.posthog.com';
    process.env.POSTHOG_IDENTITY_SALT = 'test_salt';
    const { captureAiGeneration, initPostHog } = await import('./posthog.js');

    initPostHog();
    captureAiGeneration({
      distinctId: 'user_pseudo123',
      userId: 'pseudo_user_1',
      traceId: 'req_123',
      sessionId: 'pseudo_session_1',
      model: 'gpt-4o',
      provider: 'openai',
      inputTokens: 100,
      outputTokens: 50,
      latencySeconds: 1.25,
      totalCostMicrocents: 150_000,
      stream: true,
      timeToFirstTokenSeconds: 0.35,
      stopReason: 'tool_use',
      isError: true,
      error: 'stream_timeout',
      toolCalls: [
        {
          id: 'call_1',
          function: {
            name: 'get_weather',
            arguments: '{"location":"San Francisco"}',
          },
        },
      ],
    });

    expect(PostHog).toHaveBeenCalledWith('phc_test', { host: 'https://us.i.posthog.com' });
    expect(posthogCapture).toHaveBeenNthCalledWith(1, {
      distinctId: 'user_pseudo123',
      event: '$ai_generation',
      properties: {
        user_id: 'pseudo_user_1',
        $ai_trace_id: 'req_123',
        $ai_session_id: 'pseudo_session_1',
        $ai_span_id: 'req_123:generation',
        $ai_model: 'gpt-4o',
        $ai_provider: 'openai',
        $ai_input_tokens: 100,
        $ai_output_tokens: 50,
        $ai_latency: 1.25,
        $ai_total_cost_usd: 0.0015,
        $ai_stream: true,
        $ai_time_to_first_token: 0.35,
        $ai_stop_reason: 'tool_use',
        $ai_is_error: true,
        $ai_error: 'stream_timeout',
      },
    });

    expect(posthogCapture).toHaveBeenNthCalledWith(2, {
      distinctId: 'user_pseudo123',
      event: '$ai_span',
      properties: {
        user_id: 'pseudo_user_1',
        $ai_trace_id: 'req_123',
        $ai_session_id: 'pseudo_session_1',
        $ai_span_id: 'req_123:tool:0',
        $ai_parent_id: 'req_123:generation',
        $ai_span_name: 'tool_call',
        toolCount: 1,
        toolIndex: 0,
      },
    });
  });
  it('does not flag successful generations as error when isError is false or omitted', async () => {
    const { buildAiGenerationProperties } = await import('./posthog.js');
    const properties = buildAiGenerationProperties({
      distinctId: 'anon_test',
      traceId: 'req_success',
      model: 'gpt-4o',
      provider: 'openai',
      inputTokens: 100,
      outputTokens: 50,
      latencySeconds: 0.8,
      stream: true,
      isError: false,
    });

    expect(properties.$ai_is_error).toBeUndefined();
    expect(properties.$ai_error).toBeUndefined();
  });

  it('does not include prompt, completion, or tool-argument content in generation properties', async () => {
    const { buildAiGenerationProperties } = await import('./posthog.js');
    const prompt = 'representative prompt that must never be captured';
    const completion = 'representative completion that must never be captured';
    const toolArguments = '{"secret":"representative tool argument"}';
    const properties = buildAiGenerationProperties({
      distinctId: 'anon_test',
      traceId: 'req_123',
      model: 'gpt-4o',
      provider: 'openai',
      inputTokens: 100,
      outputTokens: 50,
      latencySeconds: 1.25,
      // @ts-expect-error extra fields should not leak
      prompt,
      completion,
      toolArguments,
    });

    const serializedProperties = JSON.stringify(properties);
    expect(serializedProperties).not.toContain(prompt);
    expect(serializedProperties).not.toContain(completion);
    expect(serializedProperties).not.toContain(toolArguments);
  });

});
