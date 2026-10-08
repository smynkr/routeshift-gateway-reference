import { describe, it, expect } from 'vitest';
import { OpenAICompatProvider } from '../src/providers/openai-compat.js';

describe('OpenAICompatProvider', () => {
  it('uses custom base URL', () => {
    const provider = new OpenAICompatProvider('together', 'https://api.together.xyz');
    const req = provider.buildRequest(
      { model: 'llama-3.1-70b', messages: [{ role: 'user', content: 'Hi' }], stream: false },
      'key-123',
    );
    expect(req.url).toBe('https://api.together.xyz/v1/chat/completions');
  });

  it('applies model name mapping', () => {
    const provider = new OpenAICompatProvider('together', 'https://api.together.xyz', {
      'llama-70b': 'meta-llama/Llama-3.1-70B-Instruct',
    });
    const req = provider.buildRequest(
      { model: 'llama-70b', messages: [{ role: 'user', content: 'Hi' }], stream: false },
      'key',
    );
    const body = JSON.parse(req.body);
    expect(body.model).toBe('meta-llama/Llama-3.1-70B-Instruct');
  });

  it('forwards the verified Qwen3.8-Max model ID unchanged', () => {
    const provider = new OpenAICompatProvider('qwen', 'https://dashscope-intl.aliyuncs.com/compatible-mode');
    const req = provider.buildRequest(
      { model: 'qwen3.8-max', messages: [{ role: 'user', content: 'Hi' }], stream: false },
      'key',
    );
    expect(JSON.parse(req.body).model).toBe('qwen3.8-max');
  });

  it('strips stream_options when not supported', () => {
    const provider = new OpenAICompatProvider('ollama', 'http://localhost:11434', {}, {
      streaming_usage: false, tool_use: true, json_mode: true,
    });
    const req = provider.buildRequest(
      { model: 'llama3', messages: [{ role: 'user', content: 'Hi' }], stream: true },
      '',
    );
    const body = JSON.parse(req.body);
    expect(body.stream_options).toBeUndefined();
    expect(body.stream).toBe(true);
  });

  it('strips tools when not supported', () => {
    const provider = new OpenAICompatProvider('basic', 'http://localhost:8000', {}, {
      streaming_usage: false, tool_use: false, json_mode: false,
    });
    const req = provider.buildRequest(
      {
        model: 'test',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: false,
        tools: [{ type: 'function', function: { name: 'test', parameters: {} } }],
        response_format: { type: 'json' },
      },
      '',
    );
    const body = JSON.parse(req.body);
    expect(body.tools).toBeUndefined();
    expect(body.response_format).toBeUndefined();
  });

  it('has correct provider id', () => {
    const provider = new OpenAICompatProvider('groq', 'https://api.groq.com/openai');
    expect(provider.id).toBe('groq');
  });

  it('inherits OpenAI cache-read usage parsing', () => {
    const provider = new OpenAICompatProvider('qwen', 'https://dashscope-intl.aliyuncs.com/compatible-mode');
    const response = provider.parseResponse({
      id: 'chatcmpl-compat',
      model: 'Qwen3-Coder-480B-A35B-Instruct',
      choices: [{ index: 0, message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 50,
        completion_tokens: 5,
        total_tokens: 55,
        prompt_tokens_details: { cached_tokens: 44 },
      },
    });
    // prompt_tokens (50) already includes cached_tokens (44) per OpenAI's API.
    expect(response.usage).toEqual({ input_tokens: 6, output_tokens: 5, total_tokens: 55, cache_read_tokens: 44 });
    expect(response.usage.cache_write_tokens).toBeUndefined();
  });
});
