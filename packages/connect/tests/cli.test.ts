import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, parseArgs, derivePrefix, type CliDeps } from '../src/cli';
import { manifestPath } from '../src/manifest';
import { memoryKeychain, type KeychainStore } from '../src/keychain';

let home: string;
let logs: string[];
let keychain: KeychainStore;

const TOKEN = 'sk-proxy-live_team_SECRETTAIL';

function makeDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    home,
    env: {},
    log: (m = '') => logs.push(m),
    errorLog: (m = '') => logs.push(m),
    nowIso: () => '2026-05-30T00:00:00.000Z',
    keychain,
    deviceLoginFn: vi.fn(async () => ({ accessToken: TOKEN, keyPrefix: 'sk-proxy-live_team', scope: 'inference read' })) as unknown as CliDeps['deviceLoginFn'],
    openBrowser: () => {},
    ...overrides,
  };
}

function makeTrackingKeychain(seed: Record<string, string> = {}) {
  const backing = memoryKeychain(seed);
  const setFn = vi.fn((account: string, secret: string) => backing.set(account, secret));
  const deleteFn = vi.fn((account: string) => backing.delete(account));
  const store: KeychainStore = {
    get: (account) => backing.get(account),
    set: setFn,
    delete: deleteFn,
  };
  return { backing, deleteFn, setFn, store };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'rsc-cli-'));
  logs = [];
  keychain = memoryKeychain();
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('parseArgs', () => {
  it('parses command, flags, and repeated --tool', () => {
    const a = parseArgs(['connect', '--yes', '--tool', 'opencode', '--tool', 'claude-code', '--base-url', 'http://x']);
    expect(a).toMatchObject({ command: 'connect', yes: true, tools: ['opencode', 'claude-code'], baseUrl: 'http://x' });
  });
  it('maps --status to the status command', () => {
    expect(parseArgs(['--status']).command).toBe('status');
  });
  it('does not swallow a following flag as an option value', () => {
    // `--tool --yes` must NOT treat "--yes" as a tool name; --yes still applies.
    const a = parseArgs(['--tool', '--yes']);
    expect(a.tools).toEqual([]);
    expect(a.yes).toBe(true);
  });

  it('parses --no-keychain for environments that must avoid OS keychain writes', () => {
    const a = parseArgs(['connect', '--no-keychain']);
    expect(a.noKeychain).toBe(true);
  });
});

describe('derivePrefix', () => {
  it('extracts the non-secret prefix', () => {
    expect(derivePrefix('sk-proxy-live_team_abc')).toBe('sk-proxy-live_team');
  });
});

describe('connect → status → disconnect', () => {
  it('configures forced tools via the device flow and never prints the secret', async () => {
    const deps = makeDeps();
    const code = await run(
      ['--yes', '--tool', 'opencode', '--tool', 'openai-env', '--base-url', 'https://api.routeshift.io'],
      deps,
    );
    expect(code).toBe(0);
    expect(deps.deviceLoginFn).toHaveBeenCalledOnce();
    expect(deps.deviceLoginFn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ scope: 'inference read' }),
      expect.any(Object),
    );

    // Files written.
    expect(existsSync(join(home, '.config', 'opencode', 'opencode.json'))).toBe(true);
    expect(existsSync(join(home, '.routeshift', 'env.sh'))).toBe(true);

    // Secret on disk but NEVER in stdout.
    const envFile = readFileSync(join(home, '.routeshift', 'env.sh'), 'utf8');
    expect(envFile).toContain('SECRETTAIL');
    expect(logs.join('\n')).not.toContain('SECRETTAIL');

    // Manifest records exactly the two tools.
    const manifest = JSON.parse(readFileSync(manifestPath(home), 'utf8'));
    expect(manifest.tools.map((t: { id: string }) => t.id).sort()).toEqual(['openai-env', 'opencode']);
    expect(manifest.keyPrefix).toBe('sk-proxy-live_team');

    // status reflects the configured tools.
    logs = [];
    await run(['--status'], deps);
    const statusOut = logs.join('\n');
    expect(statusOut).toContain('Connected to https://api.routeshift.io');
    expect(statusOut).toContain('opencode');
    expect(statusOut).not.toContain('SECRETTAIL');

    // disconnect removes config + manifest.
    logs = [];
    await run(['disconnect', '--yes'], deps);
    expect(existsSync(manifestPath(home))).toBe(false);
    expect(existsSync(join(home, '.routeshift', 'env.sh'))).toBe(false);
    const cleanedOpencode = readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8');
    expect(cleanedOpencode).not.toContain('SECRETTAIL');
  });

  it('accepts a pasted key without invoking the device flow (v1 fallback)', async () => {
    const deviceLoginFn = vi.fn();
    const deps = makeDeps({ deviceLoginFn: deviceLoginFn as unknown as CliDeps['deviceLoginFn'] });
    const code = await run(['--yes', '--token', TOKEN, '--tool', 'openai-env', '--base-url', 'https://api.routeshift.io'], deps);
    expect(code).toBe(0);
    expect(deviceLoginFn).not.toHaveBeenCalled();
    expect(existsSync(join(home, '.routeshift', 'env.sh'))).toBe(true);
  });

  it('reports cleanly when nothing is connected', async () => {
    const deps = makeDeps();
    await run(['--status'], deps);
    expect(logs.join('\n')).toContain('not connected');
  });

  it('errors on an unknown forced tool', async () => {
    const deps = makeDeps();
    const code = await run(['--yes', '--token', TOKEN, '--tool', 'nope'], deps);
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain("Unknown tool 'nope'");
  });

  it('rolls back the keychain entry when a forced tool is unknown', async () => {
    const tracked = makeTrackingKeychain();
    const deps = makeDeps({ keychain: tracked.store });
    const code = await run(['--yes', '--token', TOKEN, '--tool', 'nope', '--base-url', 'https://api.routeshift.io'], deps);

    expect(code).toBe(1);
    expect(tracked.setFn).toHaveBeenCalledWith('https://api.routeshift.io', TOKEN);
    expect(tracked.deleteFn).toHaveBeenCalledWith('https://api.routeshift.io');
    expect(tracked.backing.get('https://api.routeshift.io')).toBeNull();
    expect(logs.join('\n')).not.toContain(TOKEN);
    expect(logs.join('\n')).not.toContain('SECRETTAIL');
  });

  it('rejects explicit claude-code and rolls back the keychain without touching settings', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    const settingsFile = join(home, '.claude', 'settings.json');
    const originalSettings = '{\n  "existing": true\n}\n';
    writeFileSync(settingsFile, originalSettings);

    const tracked = makeTrackingKeychain();
    const deps = makeDeps({ keychain: tracked.store });
    const code = await run(['--yes', '--token', TOKEN, '--tool', 'claude-code', '--base-url', 'https://api.routeshift.io'], deps);

    expect(code).toBe(1);
    expect(tracked.setFn).toHaveBeenCalledWith('https://api.routeshift.io', TOKEN);
    expect(tracked.deleteFn).toHaveBeenCalledWith('https://api.routeshift.io');
    expect(tracked.backing.get('https://api.routeshift.io')).toBeNull();
    expect(logs.join('\n')).toContain('requires RouteShift Anthropic /v1/messages');
    expect(logs.join('\n')).toContain('Not configuring --tool claude-code');
    expect(readFileSync(settingsFile, 'utf8')).toBe(originalSettings);
    expect(existsSync(manifestPath(home))).toBe(false);
    expect(logs.join('\n')).not.toContain(TOKEN);
    expect(logs.join('\n')).not.toContain('SECRETTAIL');
  });

  it('rolls back the keychain entry when no tools are configured', async () => {
    const tracked = makeTrackingKeychain();
    const deps = makeDeps({ keychain: tracked.store });
    const code = await run(['--yes', '--token', TOKEN, '--base-url', 'https://api.routeshift.io'], deps);

    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('No supported tools detected');
    expect(tracked.deleteFn).toHaveBeenCalledWith('https://api.routeshift.io');
    expect(tracked.backing.get('https://api.routeshift.io')).toBeNull();
    expect(logs.join('\n')).not.toContain(TOKEN);
    expect(logs.join('\n')).not.toContain('SECRETTAIL');
  });

  it('skips detected claude-code on auto-detect because Anthropic messages is unavailable', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true });

    const tracked = makeTrackingKeychain();
    const deps = makeDeps({ keychain: tracked.store });
    const code = await run(['--yes', '--token', TOKEN, '--base-url', 'https://api.routeshift.io'], deps);

    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('Claude Code support requires RouteShift Anthropic /v1/messages; skipping auto-configuration.');
    expect(logs.join('\n')).toContain('No supported tools detected');
    expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(false);
    expect(tracked.setFn).toHaveBeenCalledWith('https://api.routeshift.io', TOKEN);
    expect(tracked.deleteFn).toHaveBeenCalledWith('https://api.routeshift.io');
    expect(tracked.backing.get('https://api.routeshift.io')).toBeNull();
    expect(logs.join('\n')).not.toContain(TOKEN);
    expect(logs.join('\n')).not.toContain('SECRETTAIL');
  });

  it('one tool with a corrupt config does not abort configuring the others', async () => {
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    writeFileSync(join(home, '.config', 'opencode', 'opencode.json'), '{ not valid json ');

    const deps = makeDeps();
    const code = await run(
      ['--yes', '--token', TOKEN, '--tool', 'opencode', '--tool', 'openai-env', '--base-url', 'https://api.routeshift.io'],
      deps,
    );
    expect(code).toBe(0);
    // opencode failed (logged), but openai-env was still configured.
    expect(logs.join('\n')).toContain('could not configure opencode');
    expect(existsSync(join(home, '.routeshift', 'env.sh'))).toBe(true);
    // The corrupt file was left untouched.
    expect(readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8')).toBe('{ not valid json ');
  });
});

describe('keychain integration', () => {
  it('connect stores the token in the keychain under the baseUrl, never on stdout', async () => {
    const deps = makeDeps();
    await run(['--yes', '--tool', 'openai-env', '--base-url', 'https://api.routeshift.io'], deps);
    expect(keychain.get('https://api.routeshift.io')).toBe(TOKEN);
    expect(logs.join('\n')).not.toContain('SECRETTAIL');
  });

  it('--no-keychain skips keychain writes and warns about bounded plaintext tool config exposure', async () => {
    const tracked = makeTrackingKeychain();
    const deps = makeDeps({ keychain: tracked.store });

    const code = await run(['--yes', '--no-keychain', '--token', TOKEN, '--tool', 'openai-env', '--base-url', 'https://api.routeshift.io'], deps);

    expect(code).toBe(0);
    expect(tracked.setFn).not.toHaveBeenCalled();
    expect(tracked.deleteFn).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('OS keychain storage disabled');
    expect(logs.join('\n')).toContain('plaintext tool config');
    expect(logs.join('\n')).not.toContain(TOKEN);
    expect(logs.join('\n')).not.toContain('SECRETTAIL');
    const manifest = JSON.parse(readFileSync(manifestPath(home), 'utf8'));
    expect(manifest.keychainDisabled).toBe(true);
  });

  it('disconnect still removes plaintext tool configs when connected with --no-keychain', async () => {
    const tracked = makeTrackingKeychain();
    const deps = makeDeps({ keychain: tracked.store });

    await run(['--yes', '--no-keychain', '--token', TOKEN, '--tool', 'openai-env', '--base-url', 'https://api.routeshift.io'], deps);
    expect(readFileSync(join(home, '.routeshift', 'env.sh'), 'utf8')).toContain('SECRETTAIL');

    const code = await run(['disconnect', '--yes'], deps);

    expect(code).toBe(0);
    expect(existsSync(join(home, '.routeshift', 'env.sh'))).toBe(false);
    expect(tracked.deleteFn).not.toHaveBeenCalled();
  });

  it('removes an existing keychain entry when reconnecting with --no-keychain', async () => {
    const tracked = makeTrackingKeychain();
    const deps = makeDeps({ keychain: tracked.store });

    await run(['--yes', '--token', TOKEN, '--tool', 'openai-env', '--base-url', 'https://api.routeshift.io'], deps);
    expect(tracked.backing.get('https://api.routeshift.io')).toBe(TOKEN);

    logs = [];
    const code = await run(['--yes', '--no-keychain', '--token', TOKEN, '--tool', 'openai-env', '--base-url', 'https://api.routeshift.io'], deps);

    expect(code).toBe(0);
    expect(tracked.deleteFn).toHaveBeenCalledWith('https://api.routeshift.io');
    expect(tracked.backing.get('https://api.routeshift.io')).toBeNull();
    expect(logs.join('\n')).not.toContain(TOKEN);
    expect(logs.join('\n')).not.toContain('SECRETTAIL');
  });

  it('disconnect removes the token from the keychain', async () => {
    const deps = makeDeps();
    await run(['--yes', '--tool', 'openai-env', '--base-url', 'https://api.routeshift.io'], deps);
    expect(keychain.get('https://api.routeshift.io')).toBe(TOKEN);
    await run(['disconnect', '--yes'], deps);
    expect(keychain.get('https://api.routeshift.io')).toBeNull();
  });

  it('disconnect warns and exits non-zero when the keychain delete fails', async () => {
    const backing = memoryKeychain();
    const failingDelete = vi.fn(() => 'error' as const);
    keychain = {
      get: (account) => backing.get(account),
      set: (account, secret) => backing.set(account, secret),
      delete: failingDelete,
    };
    const deps = makeDeps();
    await run(['--yes', '--token', TOKEN, '--tool', 'openai-env', '--base-url', 'https://api.routeshift.io'], deps);

    logs = [];
    const code = await run(['disconnect', '--yes'], deps);

    expect(code).toBe(1);
    expect(failingDelete).toHaveBeenCalledWith('https://api.routeshift.io');
    expect(logs.join('\n')).toContain('warning: could not remove the RouteShift key');
    expect(logs.join('\n')).toContain('may still be stored');
    expect(logs.join('\n')).not.toContain(TOKEN);
    expect(logs.join('\n')).not.toContain('SECRETTAIL');
  });

  it('does not leak the token when keychain store errors mention it', async () => {
    keychain = {
      get: () => null,
      set: () => {
        throw new Error(`failed to store ${TOKEN}`);
      },
      delete: vi.fn(() => 'absent' as const),
    };
    const deps = makeDeps();
    const code = await run(['--yes', '--token', TOKEN, '--tool', 'openai-env', '--base-url', 'https://api.routeshift.io'], deps);

    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('could not store the key');
    expect(logs.join('\n')).not.toContain(TOKEN);
    expect(logs.join('\n')).not.toContain('SECRETTAIL');
  });

  it('deletes the prior baseUrl keychain entry after a successful baseUrl change', async () => {
    const deps = makeDeps();
    await run(['--yes', '--token', TOKEN, '--tool', 'openai-env', '--base-url', 'https://old.routeshift.io'], deps);
    expect(keychain.get('https://old.routeshift.io')).toBe(TOKEN);

    logs = [];
    const code = await run(['--yes', '--token', TOKEN, '--tool', 'openai-env', '--base-url', 'https://api.routeshift.io'], deps);

    expect(code).toBe(0);
    expect(keychain.get('https://old.routeshift.io')).toBeNull();
    expect(keychain.get('https://api.routeshift.io')).toBe(TOKEN);
    expect(logs.join('\n')).not.toContain(TOKEN);
    expect(logs.join('\n')).not.toContain('SECRETTAIL');
  });
});

describe('usage command routing', () => {
  it('parseArgs recognizes the `usage` positional', () => {
    expect(parseArgs(['usage']).command).toBe('usage');
    expect(parseArgs(['usage', '--week', '--json']).command).toBe('usage');
  });

  it('run dispatches `usage` to runUsage and prints --json without Ink', async () => {
    const SUMMARY = {
      range: { since: 'a', until: 'b', bucket: 'day' },
      summary: { requests: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, spend_microcents: 0, savings_microcents: 0, credit_balance_microcents: null },
      by_model: [], by_key: [], series: [], contributions: [],
    };
    const deps = makeDeps({
      env: { ROUTESHIFT_TOKEN: 'sk-proxy-live_x', ROUTESHIFT_URL: 'https://api.routeshift.io' },
      fetchImpl: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: SUMMARY }) })) as unknown as CliDeps['fetchImpl'],
    });
    const code = await run(['usage', '--json'], deps);
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('"spend_microcents": 0');
  });
});
