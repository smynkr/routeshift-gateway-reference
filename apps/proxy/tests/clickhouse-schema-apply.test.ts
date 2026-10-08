import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();

import { ensureClickHousePluginCostColumn, ensureClickHouseRequestLogColumns } from '../src/db/clickhouse-schema-apply.js';

describe('ensureClickHousePluginCostColumn', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('applies an idempotent static ALTER before plugin-aware logging starts', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 200 }));

    await ensureClickHousePluginCostColumn('https://clickhouse.example?database=routeshift');

    const [url, init] = fetchMock.mock.calls[0]!;
    const parsed = new URL(String(url));
    expect(parsed.searchParams.get('database')).toBe('routeshift');
    expect(parsed.searchParams.get('query')).toContain(
      'ADD COLUMN IF NOT EXISTS plugin_cost_microcents Int64 DEFAULT 0',
    );
    expect(init).toEqual({ method: 'POST' });
  });

  it('throws a stable error without propagating an error body from ClickHouse', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fetchMock.mockResolvedValue(new Response('credential-like diagnostic', { status: 500 }));

    await expect(ensureClickHousePluginCostColumn('https://user:secret@clickhouse.example'))
      .rejects.toThrow('ClickHouse request_logs schema rejected plugin billing logging');
    expect(errorSpy).toHaveBeenCalledWith(JSON.stringify({
      event: 'routeshift_clickhouse_schema_apply_failed',
      operation: 'add_plugin_cost_microcents',
      status: 500,
    }));
  });
});

describe('ensureClickHouseRequestLogColumns', () => {
  it('adds actual_cost_known before an unknown-cost log can be ingested', async () => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue(new Response('', { status: 200 }));

    await ensureClickHouseRequestLogColumns('https://clickhouse.example');

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const queries = fetchMock.mock.calls.map((call) => (
      new URL(String(call[0])).searchParams.get('query') ?? ''
    ));
    expect(queries).toEqual(expect.arrayContaining([
      expect.stringContaining('ADD COLUMN IF NOT EXISTS actual_cost_known UInt8 DEFAULT 1'),
      expect.stringContaining('ADD COLUMN IF NOT EXISTS reasoning_tokens Nullable(UInt32) DEFAULT NULL'),
      expect.stringContaining('ADD COLUMN IF NOT EXISTS reasoning_cost_microcents Nullable(Int64) DEFAULT NULL'),
    ]));
  });
});
