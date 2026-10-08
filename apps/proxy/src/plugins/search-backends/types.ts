export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchOptions {
  maxResults: number;
  timeoutMs: number;
}

export interface SearchBackend {
  search(query: string, options: SearchOptions): Promise<SearchResult[]>;
}
