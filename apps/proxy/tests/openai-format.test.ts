import { describe, it, expect } from 'vitest';
import { isOpenAIShapedBody, toOpenAIChatCompletion } from '../src/providers/openai-format.js';
import type { CanonicalResponse } from '@routeshift/shared';

describe('isOpenAIShapedBody', () => {
  it('is true for bodies with a choices array', () => {
    expect(isOpenAIShapedBody({ choices: [{ message: { content: 'hi' } }] })).toBe(true);
    expect(isOpenAIShapedBody({ choices: [] })).toBe(true);
  });
  it('is false for foreign shapes (Anthropic content[], Gemini candidates) and junk', () => {
    expect(isOpenAIShapedBody({ content: [{ type: 'text', text: 'hi' }] })).toBe(false);
    expect(isOpenAIShapedBody({ candidates: [] })).toBe(false);
    expect(isOpenAIShapedBody(null)).toBe(false);
    expect(isOpenAIShapedBody('str')).toBe(false);
    expect(isOpenAIShapedBody({ choices: 'not-array' })).toBe(false);
  });
});

describe('toOpenAIChatCompletion', () => {
  const base: CanonicalResponse = {
    id: 'msg_123',
    model: 'src-model',
    content: 'hello world',
    stop_reason: 'end',
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };

  it('maps a text response to OpenAI shape with raw passthrough', () => {
    const raw = { id: 'msg_123', content: [{ type: 'text', text: 'hello world' }] };
    const out = toOpenAIChatCompletion(base, 'gpt-x', raw, 1_700_000_000_000);
    expect(out).toEqual({
      id: 'msg_123',
      object: 'chat.completion',
      created: 1_700_000_000,
      model: 'gpt-x',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'hello world' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      raw,
    });
  });

  it('maps stop reasons to OpenAI finish_reason', () => {
    expect(toOpenAIChatCompletion({ ...base, stop_reason: 'max_tokens' }, 'm', {}).choices[0].finish_reason).toBe('length');
    expect(toOpenAIChatCompletion({ ...base, stop_reason: 'tool_use' }, 'm', {}).choices[0].finish_reason).toBe('tool_calls');
    expect(toOpenAIChatCompletion({ ...base, stop_reason: 'safety' }, 'm', {}).choices[0].finish_reason).toBe('content_filter');
  });

  it('surfaces reasoning-token telemetry in OpenAI-compatible usage details', () => {
    const out = toOpenAIChatCompletion({
      ...base,
      usage: { input_tokens: 10, output_tokens: 16, reasoning_tokens: 11, total_tokens: 26 },
    }, 'm', {});
    expect(out.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 16,
      total_tokens: 26,
      completion_tokens_details: { reasoning_tokens: 11 },
    });
  });

  it('emits content:null and tool_calls when the turn is purely tool calls', () => {
    const withTools: CanonicalResponse = {
      ...base,
      content: '',
      stop_reason: 'tool_use',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } }],
    };
    const out = toOpenAIChatCompletion(withTools, 'm', {});
    expect(out.choices[0].message.content).toBeNull();
    expect(out.choices[0].message.tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } },
    ]);
    expect(out.choices[0].finish_reason).toBe('tool_calls');
  });

  it('preserves provider tool-call history metadata in the OpenAI-compatible response', () => {
    const providerMetadata = { google: { thought_signature: 'signed-context' } };
    const out = toOpenAIChatCompletion({
      ...base,
      content: '',
      stop_reason: 'tool_use',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{}' },
        extra_content: providerMetadata,
      }],
    }, 'gemini-3-flash', {});

    expect(out.choices[0].message.tool_calls?.[0].extra_content).toEqual(providerMetadata);
  });

  it('synthesizes an id when the canonical response has none', () => {
    const out = toOpenAIChatCompletion({ ...base, id: '' }, 'm', {});
    expect(out.id).toMatch(/^chatcmpl-/);
  });
});
