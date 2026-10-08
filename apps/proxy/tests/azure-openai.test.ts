import { describe, expect, it } from 'vitest';
import { AzureOpenAIProvider } from '../src/providers/azure-openai.js';

describe('AzureOpenAIProvider', () => {
  const provider = new AzureOpenAIProvider();

  it('builds classic deployment-path requests from resource_name and api_version', () => {
    const req = provider.buildRequest(
      { model: 'gpt-5.4', messages: [{ role: 'user', content: 'Hi' }], stream: false },
      'azure-key',
      { resource_name: 'my-resource', api_version: '2024-10-21', deployment_name: 'gpt54' },
    );

    expect(req.url).toBe('https://my-resource.openai.azure.com/openai/deployments/gpt54/chat/completions?api-version=2024-10-21');
    expect(req.headers.Authorization).toBeUndefined();
    expect(req.headers['api-key']).toBe('azure-key');
    expect(JSON.parse(req.body).model).toBe('gpt54');
  });

  it('builds OpenAI-compatible /openai/v1 requests from endpoint_url', () => {
    const req = provider.buildRequest(
      { model: 'gpt-5.5', messages: [{ role: 'user', content: 'Hi' }], stream: false },
      'azure-key',
      {
        endpoint_url: 'https://smynk-mol8vpof-eastus2.cognitiveservices.azure.com/openai/v1/',
        deployment_name: 'gpt55',
      },
    );

    expect(req.url).toBe('https://smynk-mol8vpof-eastus2.cognitiveservices.azure.com/openai/v1/chat/completions');
    expect(req.headers.Authorization).toBeUndefined();
    expect(req.headers['api-key']).toBe('azure-key');
    expect(JSON.parse(req.body).model).toBe('gpt55');
  });

  it('requires endpoint_url or resource_name plus api_version', () => {
    expect(() => provider.buildRequest(
      { model: 'gpt-5.5', messages: [], stream: false },
      'azure-key',
      { resource_name: 'missing-version' },
    )).toThrow('Azure provider requires either endpoint_url or resource_name plus api_version');
  });

  it('rejects non-Azure or unsafe endpoint_url values', () => {
    const unsafe = [
      'http://example.openai.azure.com/openai/v1',
      'https://evil.example/openai/v1',
      'https://user:pass@example.openai.azure.com/openai/v1',
      'https://example.openai.azure.com/openai/v1?api-key=oops',
      'https://example.openai.azure.com/openai/deployments/foo',
    ];

    for (const endpoint_url of unsafe) {
      expect(() => provider.buildRequest(
        { model: 'gpt-5.5', messages: [], stream: false },
        'azure-key',
        { endpoint_url, deployment_name: 'gpt55' },
      )).toThrow(/Azure endpoint_url/);
    }
  });
});
