// Typed client for GET /v1/usage/summary. The server returns a { data: … }
// envelope (matching /api/v1/generation); we unwrap `.data`. A 401 means the
// key is no longer valid → ReconnectNeededError (the command prints a reconnect
// hint and exits 1).

export interface UsageSummary {
  range: { since: string; until: string; bucket: 'hour' | 'day' };
  summary: {
    requests: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    spend_microcents: number;
    savings_microcents: number;
    credit_balance_microcents: number | null;
  };
  by_model: Array<{
    model: string; provider: string; requests: number;
    input_tokens: number; output_tokens: number;
    spend_microcents: number; savings_microcents: number;
  }>;
  by_key: Array<{
    api_key_id: string; key_prefix: string; requests: number;
    spend_microcents: number; savings_microcents: number;
  }>;
  series: Array<{
    bucket_start: string; spend_microcents: number;
    input_tokens: number; output_tokens: number; requests: number;
  }>;
  contributions: Array<{ date: string; spend_microcents: number; tokens: number; level: 0 | 1 | 2 | 3 | 4 }>;
}

/** Query params accepted by the client. `graph` is client-only and not sent. */
export interface UsageQuery {
  since?: string;
  until?: string;
  bucket?: 'hour' | 'day';
  graph?: '2d' | '3d';
}

export class ReconnectNeededError extends Error {
  constructor() {
    super('Your RouteShift key is no longer valid — run `routeshift connect` to reconnect.');
    this.name = 'ReconnectNeededError';
  }
}

export async function fetchUsageSummary(
  baseUrl: string,
  token: string,
  query: UsageQuery,
  fetchImpl: typeof fetch = fetch,
): Promise<UsageSummary> {
  const url = usageSummaryUrl(baseUrl);
  if (query.since) url.searchParams.set('since', query.since);
  if (query.until) url.searchParams.set('until', query.until);
  if (query.bucket) url.searchParams.set('bucket', query.bucket);
  // `graph` is a client-side rendering choice; never sent to the server.

  const res = await fetchImpl(url.toString(), {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });

  if (res.status === 401) throw new ReconnectNeededError();
  if (!res.ok) throw new Error(`RouteShift usage request failed (HTTP ${res.status}).`);

  const body = (await res.json()) as { data: UsageSummary };
  return body.data;
}

function usageSummaryUrl(baseUrl: string): URL {
  const url = new URL(baseUrl.replace(/\/+$/, ''));
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1/usage/summary`;
  url.search = '';
  url.hash = '';
  return url;
}
