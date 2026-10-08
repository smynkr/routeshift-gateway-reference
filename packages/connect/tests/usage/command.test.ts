import { describe, expect, it, vi } from 'vitest';
import { parseUsageArgs, resolveCredentials, runUsage } from '../../src/usage/command';
import { memoryKeychain } from '../../src/keychain';
import type { CliDeps } from '../../src/cli';

const SUMMARY = {
  range: { since: '2026-05-02T00:00:00.000Z', until: '2026-06-01T00:00:00.000Z', bucket: 'day' as const },
  summary: { requests: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, spend_microcents: 0, savings_microcents: 0, credit_balance_microcents: null },
  by_model: [], by_key: [], series: [], contributions: [],
};

function deps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    home: '/tmp/does-not-matter',
    env: { ROUTESHIFT_URL: 'https://api.routeshift.io' },
    log: vi.fn(),
    errorLog: vi.fn(),
    nowIso: () => '2026-06-01T00:00:00.000Z',
    keychain: memoryKeychain({ 'https://api.routeshift.io': 'sk-proxy-live_acme_secret' }),
    fetchImpl: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: SUMMARY }) })) as unknown as typeof fetch,
    ...overrides,
  };
}

describe('parseUsageArgs', () => {
  it('maps the date shortcuts and supports = and space-separated values', () => {
    expect(parseUsageArgs(['usage', '--today']).since).toBe('today');
    expect(parseUsageArgs(['usage', '--week']).since).toBe('7d');
    expect(parseUsageArgs(['usage', '--month']).since).toBe('month');
    expect(parseUsageArgs(['usage', '--since=2026-01-01']).since).toBe('2026-01-01');
    expect(parseUsageArgs(['usage', '--bucket', 'hour']).bucket).toBe('hour');
    expect(parseUsageArgs(['usage', '--graph=3d']).graph).toBe('3d');
    expect(parseUsageArgs(['usage', '--token', 'sk-proxy-flag_token']).token).toBe('sk-proxy-flag_token');
    expect(parseUsageArgs(['usage', '--token=sk-proxy-flag_token']).token).toBe('sk-proxy-flag_token');
  });

  it('validates a missing --token value', () => {
    expect(parseUsageArgs(['usage', '--token']).error).toBe('--token requires a value.');
    expect(parseUsageArgs(['usage', '--token', '--json']).error).toBe('--token requires a value.');
  });

  it('defaults graph=2d and watch off; --watch=10 sets the interval', () => {
    const a = parseUsageArgs(['usage']);
    expect(a.graph).toBe('2d');
    expect(a.watch).toBe(false);
    const w = parseUsageArgs(['usage', '--watch=10']);
    expect(w.watch).toBe(true);
    expect(w.watchSeconds).toBe(10);
    expect(parseUsageArgs(['usage', '--watch', '10']).watchSeconds).toBe(10); // space form too
    expect(parseUsageArgs(['usage', '--watch']).watchSeconds).toBe(5);
  });
});

describe('resolveCredentials', () => {
  it('uses token precedence flag over env over keychain', () => {
    const d = deps({ env: { ROUTESHIFT_TOKEN: 'sk-proxy-env_token', ROUTESHIFT_URL: 'https://api.routeshift.io' } });

    expect(resolveCredentials(parseUsageArgs(['usage', '--token', 'sk-proxy-flag_token']), d)?.token).toBe('sk-proxy-flag_token');
    expect(resolveCredentials(parseUsageArgs(['usage']), d)?.token).toBe('sk-proxy-env_token');
    expect(resolveCredentials(parseUsageArgs(['usage']), deps({ env: { ROUTESHIFT_URL: 'https://api.routeshift.io' } }))?.token).toBe('sk-proxy-live_acme_secret');
  });

  it('treats empty env and flag credentials as absent so the keychain can be used', () => {
    const d = deps({ env: { ROUTESHIFT_TOKEN: '   ', ROUTESHIFT_URL: ' https://api.routeshift.io/ ' } });

    expect(resolveCredentials(parseUsageArgs(['usage']), d)).toEqual({
      baseUrl: 'https://api.routeshift.io',
      token: 'sk-proxy-live_acme_secret',
    });
    expect(resolveCredentials(parseUsageArgs(['usage', '--token=']), d)?.token).toBe('sk-proxy-live_acme_secret');
  });
});

describe('runUsage', () => {
  it('rejects --json with --watch (usage error, exit 1)', async () => {
    const d = deps();
    const code = await runUsage(['usage', '--json', '--watch'], d);
    expect(code).toBe(1);
    expect(vi.mocked(d.errorLog)).toHaveBeenCalledWith(expect.stringContaining('--json cannot be combined with --watch'));
  });

  it('--json prints the unwrapped payload and never starts Ink', async () => {
    const d = deps();
    const code = await runUsage(['usage', '--json'], d);
    expect(code).toBe(0);
    const printed = vi.mocked(d.log).mock.calls.map((c) => c[0]).join('\n');
    expect(JSON.parse(printed)).toMatchObject({ summary: { spend_microcents: 0 } });
  });

  it('--token is honored for the request Authorization header', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: SUMMARY }) })) as unknown as typeof fetch;
    const d = deps({ env: { ROUTESHIFT_TOKEN: 'sk-proxy-env_token', ROUTESHIFT_URL: 'https://api.routeshift.io' }, fetchImpl });

    await runUsage(['usage', '--json', '--token', 'sk-proxy-flag_token'], d);

    const init = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-proxy-flag_token');
  });

  it('reports a missing --token value as a usage error', async () => {
    const d = deps();
    const code = await runUsage(['usage', '--json', '--token'], d);

    expect(code).toBe(1);
    expect(vi.mocked(d.errorLog)).toHaveBeenCalledWith(expect.stringContaining('--token requires a value'));
  });

  it('redacts the token from generic usage failure messages', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network failed for sk-proxy-live_team_SECRETTAIL');
    }) as unknown as typeof fetch;
    const d = deps({ fetchImpl });
    const code = await runUsage(['usage', '--json', '--token', 'sk-proxy-live_team_SECRETTAIL'], d);

    expect(code).toBe(1);
    const errors = vi.mocked(d.errorLog).mock.calls.map((c) => c[0]).join('\n');
    expect(errors).toContain('RouteShift usage failed');
    expect(errors).not.toContain('sk-proxy-live_team_SECRETTAIL');
    expect(errors).not.toContain('SECRETTAIL');
  });

  it('prints not-connected and exits 1 when no token is available', async () => {
    const d = deps({ keychain: memoryKeychain(), env: {} });
    const code = await runUsage(['usage', '--json'], d);
    expect(code).toBe(1);
    expect(vi.mocked(d.errorLog)).toHaveBeenCalledWith(expect.stringContaining('Not connected'));
  });

  it('prefers ROUTESHIFT_TOKEN env over the keychain', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: SUMMARY }) })) as unknown as typeof fetch;
    const d = deps({ env: { ROUTESHIFT_TOKEN: 'sk-proxy-env_token', ROUTESHIFT_URL: 'https://api.routeshift.io' }, fetchImpl });
    await runUsage(['usage', '--json'], d);
    const init = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-proxy-env_token');
  });

  it('maps a 401 to the reconnect message and exit 1', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch;
    const d = deps({ fetchImpl });
    const code = await runUsage(['usage', '--json'], d);
    expect(code).toBe(1);
    expect(vi.mocked(d.errorLog)).toHaveBeenCalledWith(expect.stringContaining('run `routeshift connect` to reconnect'));
  });
});
