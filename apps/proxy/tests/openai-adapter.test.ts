import { describe, it, expect } from 'vitest';
import { OpenAIProvider } from '../src/providers/openai.js';

describe('OpenAIProvider', () => {
  const provider = new OpenAIProvider('https://api.openai.com');

  it('builds a valid request', () => {
    const req = provider.buildRequest(
      {
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      },
      'sk-test-key',
    );
    expect(req.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(req.headers['Authorization']).toBe('Bearer sk-test-key');
    const body = JSON.parse(req.body);
    expect(body.model).toBe('gpt-4.1');
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('moves system_prompt into messages', () => {
    const req = provider.buildRequest(
      {
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'Hi' }],
        system_prompt: 'You are helpful.',
        stream: false,
      },
      'sk-test',
    );
    const body = JSON.parse(req.body);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You are helpful.' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'Hi' });
  });

  it('preserves assistant tool_calls and tool-result tool_call_id for multi-turn tool use', () => {
    const req = provider.buildRequest(
      {
        model: 'gpt-4.1',
        messages: [
          { role: 'user', content: 'weather in SF?' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } },
            ],
          },
          { role: 'tool', content: 'sunny', tool_call_id: 'call_1' },
        ],
        stream: false,
      },
      'sk-test',
    );
    const body = JSON.parse(req.body);
    // The assistant tool-call turn keeps its tool_calls (loses its context otherwise).
    expect(body.messages[1].tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } },
    ]);
    // The tool result keeps the linking id — OpenAI rejects a tool message without it.
    expect(body.messages[2]).toMatchObject({ role: 'tool', content: 'sunny', tool_call_id: 'call_1' });
    // A plain user message gains no spurious tool fields.
    expect(body.messages[0]).toEqual({ role: 'user', content: 'weather in SF?' });
  });

  it('strips Google extra_content from OpenAI upstream tool calls', () => {
    const toolCall = {
      id: 'call_1',
      type: 'function' as const,
      function: { name: 'get_weather', arguments: '{"city":"SF"}' },
      extra_content: { google: { thought_signature: 'signed-context' } },
    };
    const req = provider.buildRequest(
      {
        model: 'gpt-4.1',
        messages: [{ role: 'assistant', content: '', tool_calls: [toolCall] }],
        stream: false,
      },
      'sk-test',
    );

    // The canonical call remains intact for RouteShift/Gemini replay.
    expect(toolCall.extra_content).toEqual({ google: { thought_signature: 'signed-context' } });
    // The OpenAI wire payload contains only standard fields.
    expect(JSON.parse(req.body).messages[0].tool_calls).toEqual([{
      id: 'call_1',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city":"SF"}' },
    }]);
  });

  it('preserves non-streaming tool calls in the canonical response', () => {
    const response = provider.parseResponse({
      id: 'chatcmpl_1',
      model: 'gpt-4.1',
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"SF"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    expect(response.tool_calls).toEqual([{
      id: 'call_1',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city":"SF"}' },
    }]);
    expect(response.stop_reason).toBe('tool_use');
  });
  it('preserves OpenAI reasoning tokens in non-streaming and usage-only responses', () => {
    const response = provider.parseResponse({
      id: 'chatcmpl_reasoning',
      model: 'o1-mini',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 16,
        total_tokens: 26,
        completion_tokens_details: { reasoning_tokens: 11 },
      },
    });
    expect(response.usage).toMatchObject({
      input_tokens: 10,
      output_tokens: 16,
      total_tokens: 26,
      reasoning_tokens: 11,
    });

    const chunk = provider.parseStreamChunk({
      data: JSON.stringify({
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 16,
          total_tokens: 26,
          completion_tokens_details: { reasoning_tokens: 11 },
        },
      }),
    });
    expect(chunk).toEqual({
      type: 'usage',
      usage: {
        input_tokens: 10,
        output_tokens: 16,
        total_tokens: 26,
        cache_read_tokens: 0,
        reasoning_tokens: 11,
      },
    });
  });

  it('omits malformed OpenAI reasoning token values', () => {
    for (const reasoning_tokens of [-1, 1.5, Infinity, '11']) {
      const response = provider.parseResponse({
        id: 'chatcmpl_invalid_reasoning',
        model: 'o1-mini',
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 16,
          total_tokens: 26,
          completion_tokens_details: { reasoning_tokens },
        },
      });
      expect(response.usage).not.toHaveProperty('reasoning_tokens');
      expect(response.usage).toMatchObject({ input_tokens: 10, output_tokens: 16, total_tokens: 26 });
    }
  });


  it('parses a streaming content delta', () => {
    const chunk = provider.parseStreamChunk({
      data: JSON.stringify({
        choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
      }),
    });
    expect(chunk).toEqual({ type: 'content_delta', content: 'Hello' });
  });

  it('returns null for [DONE]', () => {
    const chunk = provider.parseStreamChunk({ data: '[DONE]' });
    expect(chunk).toBeNull();
  });

  it('returns null for invalid JSON stream chunks', () => {
    const chunk = provider.parseStreamChunk({ data: '{' });
    expect(chunk).toBeNull();
  });

  it('returns null when stream chunk has no choices', () => {
    const chunk = provider.parseStreamChunk({ data: JSON.stringify({}) });
    expect(chunk).toBeNull();
  });

  it('parses usage from final chunk', () => {
    const chunk = provider.parseStreamChunk({
      data: JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    });
    expect(chunk).toEqual({
      type: 'done',
      stop_reason: 'end',
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, cache_read_tokens: 0 },
    });
  });

  it('parses cache-read tokens from a streaming usage chunk', () => {
    const chunk = provider.parseStreamChunk({
      data: JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          prompt_tokens_details: { cached_tokens: 6 },
        },
      }),
    });
    expect(chunk).toEqual({
      type: 'done',
      stop_reason: 'end',
      // prompt_tokens (10) already includes cached_tokens (6) per OpenAI's API --
      // input_tokens is the non-cached remainder so cost isn't double-counted.
      usage: { input_tokens: 4, output_tokens: 5, total_tokens: 15, cache_read_tokens: 6 },
    });
  });

  it('subtracts cached and cache-write tokens from streaming ordinary input', () => {
    const chunk = provider.parseStreamChunk({
      data: JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 30,
          completion_tokens: 5,
          total_tokens: 35,
          prompt_tokens_details: { cached_tokens: 6, cache_write_tokens: 4 },
        },
      }),
    });
    expect(chunk).toEqual({
      type: 'done',
      stop_reason: 'end',
      usage: {
        input_tokens: 20,
        output_tokens: 5,
        total_tokens: 35,
        cache_read_tokens: 6,
        cache_write_tokens: 4,
      },
    });
  });

  it('captures the trailing usage-only chunk emitted with include_usage', () => {
    // Real OpenAI/Azure include_usage shape: the finish_reason chunk carries
    // usage:null, then a SEPARATE final chunk has choices:[] with usage set.
    const chunk = provider.parseStreamChunk({
      data: JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 18, completion_tokens: 2, total_tokens: 20 },
      }),
    });
    expect(chunk).toEqual({
      type: 'usage',
      usage: { input_tokens: 18, output_tokens: 2, total_tokens: 20, cache_read_tokens: 0 },
    });
  });

  it('parses cache-read tokens from a trailing usage-only chunk', () => {
    const chunk = provider.parseStreamChunk({
      data: JSON.stringify({
        choices: [],
        usage: {
          prompt_tokens: 18,
          completion_tokens: 2,
          total_tokens: 20,
          prompt_tokens_details: { cached_tokens: 12 },
        },
      }),
    });
    expect(chunk).toEqual({
      type: 'usage',
      // prompt_tokens (18) already includes cached_tokens (12) per OpenAI's API.
      usage: { input_tokens: 6, output_tokens: 2, total_tokens: 20, cache_read_tokens: 12 },
    });
    if (!chunk || Array.isArray(chunk)) throw new Error('expected a single usage chunk');
    expect(provider.extractUsage([chunk])).toEqual({
      input_tokens: 6,
      output_tokens: 2,
      total_tokens: 20,
      cache_read_tokens: 12,
    });
  });

  it('extracts provider-reported usage from the real include_usage stream sequence', () => {
    // content deltas -> finish_reason chunk (usage:null) -> usage-only chunk -> [DONE]
    const events = [
      { data: JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hello world' }, finish_reason: null }] }) },
      { data: JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: null }) },
      { data: JSON.stringify({ choices: [], usage: { prompt_tokens: 18, completion_tokens: 2, total_tokens: 20 } }) },
      { data: '[DONE]' },
    ];
    const chunks = events
      .map((e) => provider.parseStreamChunk(e))
      .filter((c): c is NonNullable<typeof c> => c !== null);
    // Provider-reported usage must win over the char/4 fallback (which would
    // have produced input_tokens=0 and output≈ceil(11/4)=3).
    expect(provider.extractUsage(chunks)).toEqual({
      input_tokens: 18,
      output_tokens: 2,
      total_tokens: 20,
      cache_read_tokens: 0,
    });
  });

  it('maps max_output_tokens to max_completion_tokens', () => {
    const req = provider.buildRequest(
      {
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'Hi' }],
        max_output_tokens: 1000,
        stream: false,
      },
      'sk-test',
    );
    const body = JSON.parse(req.body);
    expect(body.max_completion_tokens).toBe(1000);
    expect(body.max_tokens).toBeUndefined();
  });

  it('extracts usage from chunk array', () => {
    const chunks = [
      { type: 'content_delta' as const, content: 'Hi' },
      { type: 'done' as const, stop_reason: 'end' as const, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
    ];
    const usage = provider.extractUsage(chunks);
    expect(usage).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });
  });

  it('normalizes errors with retryability', () => {
    const err429 = provider.normalizeError(429, { error: { message: 'Rate limited' } });
    expect(err429.retryable).toBe(true);
    expect(err429.statusCode).toBe(429);

    const err400 = provider.normalizeError(400, { error: { message: 'Bad request' } });
    expect(err400.retryable).toBe(false);
  });

  it('parses a non-streaming response', () => {
    const response = provider.parseResponse({
      id: 'chatcmpl-abc123',
      model: 'gpt-4.1',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Hello there!' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    });
    expect(response.id).toBe('chatcmpl-abc123');
    expect(response.model).toBe('gpt-4.1');
    expect(response.content).toBe('Hello there!');
    expect(response.stop_reason).toBe('end');
    expect(response.usage).toEqual({ input_tokens: 8, output_tokens: 4, total_tokens: 12, cache_read_tokens: 0 });
  });

  it('parses cache-read tokens from a non-streaming response', () => {
    const response = provider.parseResponse({
      id: 'chatcmpl-cached',
      model: 'gpt-4.1',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Cached hello' },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 40,
        completion_tokens: 4,
        total_tokens: 44,
        prompt_tokens_details: { cached_tokens: 32 },
      },
    });
    // prompt_tokens (40) already includes cached_tokens (32) per OpenAI's API.
    expect(response.usage).toEqual({ input_tokens: 8, output_tokens: 4, total_tokens: 44, cache_read_tokens: 32 });
    expect(response.usage.cache_write_tokens).toBeUndefined();
  });

  it('parses cache-write tokens from a non-streaming response', () => {
    const response = provider.parseResponse({
      id: 'chatcmpl-cache-write',
      model: 'gpt-5.6-sol',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Cached hello' },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 40,
        completion_tokens: 4,
        total_tokens: 44,
        prompt_tokens_details: { cached_tokens: 32, cache_write_tokens: 4 },
      },
    });
    expect(response.usage).toEqual({
      input_tokens: 4,
      output_tokens: 4,
      total_tokens: 44,
      cache_read_tokens: 32,
      cache_write_tokens: 4,
    });
  });

  it('parses tool_call streaming delta with its index', () => {
    const chunk = provider.parseStreamChunk({
      data: JSON.stringify({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_abc',
              function: { name: 'get_weather', arguments: '{"loc' },
            }],
          },
          finish_reason: null,
        }],
      }),
    });
    expect(chunk).toEqual({
      type: 'tool_call_delta',
      tool_call: {
        id: 'call_abc',
        name: 'get_weather',
        arguments_delta: '{"loc',
        index: 0,
      },
    });
  });

  it('emits one chunk per parallel tool call in a single delta', () => {
    const chunks = provider.parseStreamChunk({
      data: JSON.stringify({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: 'call_a', function: { name: 'f0', arguments: '{}' } },
              { index: 1, id: 'call_b', function: { name: 'f1', arguments: '{}' } },
            ],
          },
          finish_reason: null,
        }],
      }),
    });
    expect(chunks).toEqual([
      { type: 'tool_call_delta', tool_call: { id: 'call_a', name: 'f0', arguments_delta: '{}', index: 0 } },
      { type: 'tool_call_delta', tool_call: { id: 'call_b', name: 'f1', arguments_delta: '{}', index: 1 } },
    ]);
  });

  it('carries the index on a continuation delta that omits id/name', () => {
    const chunk = provider.parseStreamChunk({
      data: JSON.stringify({
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'ation":"NYC"}' } }] }, finish_reason: null }],
      }),
    });
    expect(chunk).toEqual({
      type: 'tool_call_delta',
      tool_call: { id: '', name: '', arguments_delta: 'ation":"NYC"}', index: 0 },
    });
  });

  it('maps finish_reason "length" to "max_tokens"', () => {
    const response = provider.parseResponse({
      id: 'chatcmpl-xyz',
      model: 'gpt-4.1',
      choices: [{ index: 0, message: { content: 'partial' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 5, completion_tokens: 100, total_tokens: 105 },
    });
    expect(response.stop_reason).toBe('max_tokens');
  });

  it('maps finish_reason "tool_calls" to "tool_use"', () => {
    const chunk = provider.parseStreamChunk({
      data: JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      }),
    });
    expect(chunk).toEqual({ type: 'done', stop_reason: 'tool_use' });
  });

  it('maps finish_reason "content_filter" and unknown values', () => {
    const filtered = provider.parseStreamChunk({
      data: JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'content_filter' }] }),
    });
    expect(filtered).toEqual({ type: 'done', stop_reason: 'safety' });

    const unknown = provider.parseStreamChunk({
      data: JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'other_reason' }] }),
    });
    expect(unknown).toEqual({ type: 'done', stop_reason: 'end' });
  });

  it('returns null for stream chunks with no content/tool_calls/finish', () => {
    const chunk = provider.parseStreamChunk({
      data: JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: null }] }),
    });
    expect(chunk).toBeNull();
  });

  it('estimates output tokens from content when no usage chunk is present', () => {
    // Providers with streaming_usage:false (Groq, Qwen) never emit a usage
    // chunk; falling back to zero would under-bill, so output is estimated at
    // ~4 chars/token. 'Hi' -> ceil(2/4) = 1.
    expect(provider.extractUsage([{ type: 'content_delta' as const, content: 'Hi' }]))
      .toEqual({ input_tokens: 0, output_tokens: 1, total_tokens: 1 });
  });

  it('returns zero usage when there is no usage chunk and no content', () => {
    expect(provider.extractUsage([{ type: 'done' as const, stop_reason: 'end' }]))
      .toEqual({ input_tokens: 0, output_tokens: 0, total_tokens: 0 });
  });

  it('normalizes 5xx errors as retryable', () => {
    const err500 = provider.normalizeError(500, { error: { message: 'Internal server error' } });
    expect(err500.retryable).toBe(true);
    expect(err500.statusCode).toBe(500);

    const err503 = provider.normalizeError(503, { error: { message: 'Service unavailable' } });
    expect(err503.retryable).toBe(true);
  });

  it('handles unknown error body gracefully', () => {
    const err = provider.normalizeError(422, null);
    expect(err.retryable).toBe(false);
    expect(err.message).toBe('Unknown OpenAI error');
    expect(err.provider).toBe('openai');
  });

  it('passes through temperature when specified', () => {
    const req = provider.buildRequest(
      {
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'Hi' }],
        temperature: 0.7,
        stream: false,
      },
      'sk-test',
    );
    const body = JSON.parse(req.body);
    expect(body.temperature).toBe(0.7);
  });

  it('passes through tools and tool_choice', () => {
    const req = provider.buildRequest(
      {
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'What is the weather?' }],
        tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
        tool_choice: 'auto',
        stream: false,
      },
      'sk-test',
    );
    const body = JSON.parse(req.body);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].function.name).toBe('get_weather');
    expect(body.tool_choice).toBe('auto');
  });

  it('passes through response_format', () => {
    const req = provider.buildRequest(
      {
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'Hi' }],
        response_format: { type: 'json' },
        stream: false,
      },
      'sk-test',
    );
    const body = JSON.parse(req.body);
    expect(body.response_format).toEqual({ type: 'json' });
  });

  it('passes through OpenAI-compatible provider params', () => {
    const req = provider.buildRequest(
      {
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: false,
        provider_params: {
          top_p: 0.8,
          frequency_penalty: 0.2,
          presence_penalty: 0.1,
          stop: ['END'],
          seed: 123,
          user: 'user_1',
          logit_bias: { '42': -10 },
          logprobs: true,
          top_logprobs: 2,
          n: 1,
        },
      },
      'sk-test',
    );
    const body = JSON.parse(req.body);
    expect(body).toMatchObject({
      top_p: 0.8,
      frequency_penalty: 0.2,
      presence_penalty: 0.1,
      stop: ['END'],
      seed: 123,
      user: 'user_1',
      logit_bias: { '42': -10 },
      logprobs: true,
      top_logprobs: 2,
      n: 1,
    });
  });

  it('forwards a string stop sequence', () => {
    const req = provider.buildRequest(
      {
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: false,
        provider_params: { stop: '\n\nHuman:' },
      },
      'sk-test',
    );
    expect(JSON.parse(req.body).stop).toBe('\n\nHuman:');
  });

  it('drops a malformed stop (non-string/array), matching Anthropic/Gemini', () => {
    const req = provider.buildRequest(
      {
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: false,
        // A client could send junk that bypassed typing (stop is parsed from JSON).
        provider_params: { stop: 42 as unknown as string, top_p: 0.5 },
      },
      'sk-test',
    );
    const body = JSON.parse(req.body);
    expect(body.stop).toBeUndefined();
    expect(body.top_p).toBe(0.5); // sibling params still forwarded
  });

  it('drops a stop array containing non-strings', () => {
    const req = provider.buildRequest(
      {
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: false,
        provider_params: { stop: ['ok', 5] as unknown as string[] },
      },
      'sk-test',
    );
    expect(JSON.parse(req.body).stop).toBeUndefined();
  });

  it('uses default base URL when none provided', () => {
    const defaultProvider = new OpenAIProvider();
    const req = defaultProvider.buildRequest(
      { model: 'gpt-4.1', messages: [{ role: 'user', content: 'Hi' }], stream: false },
      'sk-test',
    );
    expect(req.url).toBe('https://api.openai.com/v1/chat/completions');
  });
});
