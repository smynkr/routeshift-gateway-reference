import { describe, expect, it } from 'vitest';
import { OpenAIProvider } from '../src/providers/openai.js';
const p = new OpenAIProvider();
describe('OpenAI embeddings', () => {
  it('builds an embeddings request', () => {
    const r = p.buildEmbeddingRequest!('hello', 'text-embedding-3-small', 'sk-x');
    expect(r.url).toBe('https://api.openai.com/v1/embeddings');
    expect(r.method).toBe('POST');
    expect(r.headers.Authorization).toBe('Bearer sk-x');
    expect(JSON.parse(r.body)).toEqual({ model: 'text-embedding-3-small', input: 'hello' });
  });
  it('forwards supported embedding options', () => {
    const r = p.buildEmbeddingRequest!('hello', 'text-embedding-3-small', 'sk-x', {
      dimensions: 512,
      encoding_format: 'base64',
      user: 'user_1',
    });
    expect(JSON.parse(r.body)).toEqual({
      model: 'text-embedding-3-small',
      input: 'hello',
      dimensions: 512,
      encoding_format: 'base64',
      user: 'user_1',
    });
  });
  it('parses an embeddings response', () => {
    const out = p.parseEmbeddingResponse!({ data: [{ embedding: [0.1, 0.2], index: 0 }], usage: { prompt_tokens: 5, total_tokens: 5 } });
    expect(out.embeddings).toEqual([[0.1, 0.2]]);
    expect(out.usage).toEqual({ input_tokens: 5, output_tokens: 0, total_tokens: 5 });
  });
});
