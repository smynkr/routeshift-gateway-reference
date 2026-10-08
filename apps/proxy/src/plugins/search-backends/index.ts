import { ExaSearchBackend } from './exa.js';
import type { SearchBackend } from './types.js';

export type { SearchBackend, SearchOptions, SearchResult } from './types.js';

export function createSearchBackend(): SearchBackend {
  const backend = (process.env.SEARCH_BACKEND ?? 'exa').trim().toLowerCase();
  if (backend !== 'exa') throw new Error(`Unsupported search backend: ${backend}`);
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) throw new Error('EXA_API_KEY is not configured');
  return new ExaSearchBackend(apiKey);
}
