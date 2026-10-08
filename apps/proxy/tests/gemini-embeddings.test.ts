import { describe, expect, it } from 'vitest';
import { GeminiProvider } from '../src/providers/gemini.js';
const p = new GeminiProvider();
describe('Gemini embeddings', () => {
  it('builds a single-input embedContent request', () => {
    const r = p.buildEmbeddingRequest!('hello', 'text-embedding-004', 'k');
    expect(r.url).toContain('/models/text-embedding-004:embedContent');
    expect(r.url).not.toContain('key=');
    expect(r.headers['x-goog-api-key']).toBe('k');
    expect(JSON.parse(r.body)).toEqual({ content: { parts: [{ text: 'hello' }] } });
  });
  it('builds a batch request for arrays', () => {
    const r = p.buildEmbeddingRequest!(['a', 'b'], 'text-embedding-004', 'k');
    expect(r.url).toContain(':batchEmbedContents');
    expect(r.url).not.toContain('key=');
    expect(r.headers['x-goog-api-key']).toBe('k');
    expect(JSON.parse(r.body).requests).toHaveLength(2);
  });
  it('rejects unsupported embedding options', () => {
    expect(() => p.buildEmbeddingRequest!('hello', 'text-embedding-004', 'k', { dimensions: 256 })).toThrow('encoding_format/dimensions/user are not supported for this model');
    expect(() => p.buildEmbeddingRequest!('hello', 'text-embedding-004', 'k', { encoding_format: 'base64' })).toThrow('encoding_format/dimensions/user are not supported for this model');
  });
  it('parses single + batch responses', () => {
    expect(p.parseEmbeddingResponse!({ embedding: { values: [0.1] } }).embeddings).toEqual([[0.1]]);
    expect(p.parseEmbeddingResponse!({ embeddings: [{ values: [0.1] }, { values: [0.2] }] }).embeddings).toEqual([[0.1], [0.2]]);
  });
});
