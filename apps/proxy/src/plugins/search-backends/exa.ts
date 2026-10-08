import type { SearchBackend, SearchOptions, SearchResult } from './types.js';

const EXA_ENDPOINT = 'https://api.exa.ai/search';

export class ExaSearchBackend implements SearchBackend {
  constructor(private readonly apiKey: string) {}

  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await fetch(EXA_ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
        },
        body: JSON.stringify({
          query,
          numResults: options.maxResults,
          contents: { highlights: { maxCharacters: 1_500 } },
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`search backend returned ${response.status}`);
      const body = await response.json() as { results?: unknown };
      if (!Array.isArray(body.results)) return [];
      return body.results.slice(0, options.maxResults).flatMap((raw): SearchResult[] => {
        if (!raw || typeof raw !== 'object') return [];
        const result = raw as Record<string, unknown>;
        const title = typeof result.title === 'string' ? result.title : '';
        const url = typeof result.url === 'string' ? result.url : '';
        const highlights = Array.isArray(result.highlights)
          ? result.highlights.filter((value): value is string => typeof value === 'string')
          : [];
        const snippet = highlights.join(' ').trim()
          || (typeof result.text === 'string' ? result.text.slice(0, 1_500) : '');
        if (!title || !url) return [];
        return [{ title, url, snippet }];
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
