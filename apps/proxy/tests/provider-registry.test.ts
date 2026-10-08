import { describe, it, expect } from 'vitest';
import { getProvider, registerProvider } from '../src/providers/registry.js';

describe('Provider Registry', () => {
  it('has openai registered by default', () => {
    const provider = getProvider('openai');
    expect(provider).toBeDefined();
    expect(provider!.id).toBe('openai');
  });

  it('builds the account-scoped Cloudflare provider request and rejects missing account config', () => {
    const provider = getProvider('cloudflare-workers-ai');
    expect(provider).toBeDefined();

    const previousAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    try {
      const request = provider!.buildRequest(
        { model: '@cf/zai-org/glm-5.3-flash', messages: [{ role: 'user', content: 'Hi' }], stream: true },
        'cloudflare-test-key',
      );
      expect(request).toMatchObject({
        url: 'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1/chat/completions',
        method: 'POST',
        headers: {
          Authorization: 'Bearer cloudflare-test-key',
          'Content-Type': 'application/json',
        },
      });
      expect(JSON.parse(request.body)).toMatchObject({
        model: '@cf/zai-org/glm-5.3-flash',
        stream: true,
        stream_options: { include_usage: true },
      });

      delete process.env.CLOUDFLARE_ACCOUNT_ID;
      expect(() => provider!.buildRequest(
        { model: '@cf/zai-org/glm-5.3-flash', messages: [], stream: false },
        'cloudflare-test-key',
      )).toThrowError(expect.objectContaining({
        message: expect.stringContaining('CLOUDFLARE_ACCOUNT_ID'),
        statusCode: 503,
        retryable: false,
        provider: 'cloudflare-workers-ai',
      }));
    } finally {
      if (previousAccount === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
      else process.env.CLOUDFLARE_ACCOUNT_ID = previousAccount;
    }
  });

  it('uses per-key Cloudflare account metadata instead of the process account', () => {
    const provider = getProvider('cloudflare-workers-ai');
    expect(provider).toBeDefined();

    const previousAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    try {
      const request = provider!.buildRequest(
        { model: '@cf/zai-org/glm-5.3-flash', messages: [], stream: false },
        'cloudflare-test-key',
        { account_id: 'abcdef0123456789abcdef0123456789' },
      );
      expect(request.url).toBe(
        'https://api.cloudflare.com/client/v4/accounts/abcdef0123456789abcdef0123456789/ai/v1/chat/completions',
      );
      expect(() => provider!.buildRequest(
        { model: '@cf/zai-org/glm-5.3-flash', messages: [], stream: false },
        'cloudflare-test-key',
        {},
      )).toThrow(/metadata\.account_id/);
    } finally {
      if (previousAccount === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
      else process.env.CLOUDFLARE_ACCOUNT_ID = previousAccount;
    }
  });

  it('keeps the legacy NeuralWatt GLM-5.2 route identity unchanged', () => {
    const provider = getProvider('neuralwatt');
    expect(provider).toBeDefined();
    const request = provider!.buildRequest(
      { model: 'glm-5.2', messages: [{ role: 'user', content: 'Hi' }], stream: false },
      'legacy-test-key',
    );
    expect(request).toMatchObject({
      url: 'https://api.neuralwatt.com/v1/chat/completions',
      method: 'POST',
    });
    expect(JSON.parse(request.body)).toMatchObject({
      model: 'glm-5.2',
      stream: false,
    });
  });
  it('returns undefined for unknown provider', () => {
    const provider = getProvider('nonexistent');
    expect(provider).toBeUndefined();
  });

  it('allows registering a custom provider', () => {
    const mockProvider = {
      id: 'custom',
      buildRequest: () => ({ url: '', method: 'POST', headers: {}, body: '' }),
      parseResponse: () => ({ id: '', model: '', content: '', stop_reason: 'end' as const, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }),
      parseStreamChunk: () => null,
      extractUsage: () => ({ input_tokens: 0, output_tokens: 0, total_tokens: 0 }),
      normalizeError: () => { throw new Error('not implemented'); },
    };
    registerProvider(mockProvider as any);
    expect(getProvider('custom')).toBe(mockProvider);
  });
});
