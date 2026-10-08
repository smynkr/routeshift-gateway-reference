import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeCode } from '../src/tools/claude-code';
import { opencode } from '../src/tools/opencode';
import { continueDev } from '../src/tools/continue';
import { openaiEnv } from '../src/tools/openai-env';
import { redact } from '../src/redact';
import { renderDiff } from '../src/diff';
import type { Tool, ToolContext } from '../src/tools/types';

let home: string;
const ctx = (): ToolContext => ({
  home,
  baseUrl: 'https://api.routeshift.io',
  token: 'sk-proxy-live_team_SECRETTAIL',
  keyPrefix: 'sk-proxy-live_team',
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'rsc-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function perms(file: string): number {
  return statSync(file).mode & 0o777;
}

describe.each([
  ['claude-code', claudeCode],
  ['opencode', opencode],
  ['continue', continueDev],
  ['openai-env', openaiEnv],
] as Array<[string, Tool]>)('writer: %s', (_id, tool) => {
  it('writes the secret to a 0600 file and is idempotent', () => {
    const plan = tool.plan(ctx());
    expect(plan.unchanged).toBe(false);
    plan.apply();

    expect(existsSync(plan.file)).toBe(true);
    expect(readFileSync(plan.file, 'utf8')).toContain('SECRETTAIL');
    expect(perms(plan.file)).toBe(0o600);

    // Second plan over the now-configured state is a no-op.
    const replan = tool.plan(ctx());
    expect(replan.unchanged).toBe(true);
  });

  it('the redacted diff the CLI prints never contains the full secret', () => {
    const plan = tool.plan(ctx());
    expect(plan.containsSecret).toBe(true);
    // This is exactly what cli.ts renders to the user.
    const shown = redact(renderDiff(plan.beforeText, plan.afterText), ctx().token);
    expect(shown).not.toContain('SECRETTAIL');
    expect(shown).toContain('sk-proxy-live_team_••••••••');
  });

  it('disconnect removes our config', () => {
    const plan = tool.plan(ctx());
    plan.apply();
    tool.remove(home, plan.file, plan.managedKeys);
    if (existsSync(plan.file)) {
      expect(readFileSync(plan.file, 'utf8')).not.toContain('SECRETTAIL');
    }
  });
});

describe('no-clobber: preserves unrelated user config', () => {
  it('claude-code keeps existing env + other settings', () => {
    const file = join(home, '.claude', 'settings.json');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ theme: 'dark', env: { MY_VAR: 'keep-me' }, permissions: { allow: ['Bash'] } }, null, 2),
    );

    const plan = claudeCode.plan(ctx());
    plan.apply();

    const after = JSON.parse(readFileSync(file, 'utf8'));
    expect(after.theme).toBe('dark');
    expect(after.permissions).toEqual({ allow: ['Bash'] });
    expect(after.env.MY_VAR).toBe('keep-me');
    expect(after.env.ANTHROPIC_BASE_URL).toBe('https://api.routeshift.io');

    // Disconnect strips only our two keys, leaving the user's env var.
    claudeCode.remove(home, file, plan.managedKeys);
    const cleaned = JSON.parse(readFileSync(file, 'utf8'));
    expect(cleaned.env).toEqual({ MY_VAR: 'keep-me' });
    expect(cleaned.theme).toBe('dark');
  });

  it('opencode keeps the user’s other providers', () => {
    const file = join(home, '.config', 'opencode', 'opencode.json');
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    writeFileSync(file, JSON.stringify({ provider: { anthropic: { name: 'Anthropic' } }, theme: 'tokyonight' }, null, 2));

    const plan = opencode.plan(ctx());
    plan.apply();
    const after = JSON.parse(readFileSync(file, 'utf8'));
    expect(after.provider.anthropic).toEqual({ name: 'Anthropic' });
    expect(after.provider.routeshift.options.baseURL).toBe('https://api.routeshift.io/v1');
    expect(after.theme).toBe('tokyonight');

    opencode.remove(home, file, plan.managedKeys);
    const cleaned = JSON.parse(readFileSync(file, 'utf8'));
    expect(cleaned.provider.anthropic).toEqual({ name: 'Anthropic' });
    expect(cleaned.provider.routeshift).toBeUndefined();
  });

  it('continue upserts a single model by title without duplicating', () => {
    const file = join(home, '.continue', 'config.json');
    mkdirSync(join(home, '.continue'), { recursive: true });
    writeFileSync(file, JSON.stringify({ models: [{ title: 'GPT-4o', provider: 'openai' }] }, null, 2));

    continueDev.plan(ctx()).apply();
    continueDev.plan(ctx()).apply(); // run twice — must not duplicate

    const after = JSON.parse(readFileSync(file, 'utf8'));
    const routeshiftModels = after.models.filter((m: { title: string }) => m.title === 'RouteShift');
    expect(routeshiftModels).toHaveLength(1);
    expect(after.models.find((m: { title: string }) => m.title === 'GPT-4o')).toBeTruthy();
  });

  it('json-object apply() preserves an edit made AFTER plan() (re-reads at write time)', () => {
    const file = join(home, '.claude', 'settings.json');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(file, JSON.stringify({ theme: 'dark' }, null, 2));

    const plan = claudeCode.plan(ctx()); // diff captured from this state
    // The user's editor autosaves an unrelated key between the diff and confirm.
    const concurrent = JSON.parse(readFileSync(file, 'utf8'));
    concurrent.addedLater = 'must-survive';
    writeFileSync(file, JSON.stringify(concurrent, null, 2));

    plan.apply(); // must re-read + merge, not write the stale plan-time snapshot

    const after = JSON.parse(readFileSync(file, 'utf8'));
    expect(after.addedLater).toBe('must-survive'); // concurrent edit preserved
    expect(after.theme).toBe('dark');
    expect(after.env.ANTHROPIC_BASE_URL).toBe('https://api.routeshift.io'); // managed key applied
  });

  it('continue apply() preserves a model added concurrently after plan()', () => {
    const file = join(home, '.continue', 'config.json');
    mkdirSync(join(home, '.continue'), { recursive: true });
    writeFileSync(file, JSON.stringify({ models: [{ title: 'GPT-4o', provider: 'openai' }] }, null, 2));

    const plan = continueDev.plan(ctx());
    const concurrent = JSON.parse(readFileSync(file, 'utf8'));
    concurrent.models.push({ title: 'Claude', provider: 'anthropic' });
    writeFileSync(file, JSON.stringify(concurrent, null, 2));

    plan.apply();

    const after = JSON.parse(readFileSync(file, 'utf8'));
    const titles = after.models.map((m: { title: string }) => m.title);
    expect(titles).toContain('GPT-4o');
    expect(titles).toContain('Claude'); // concurrent addition preserved
    expect(after.models.filter((m: { title: string }) => m.title === 'RouteShift')).toHaveLength(1);
  });
});

describe('continue: stale-entry + idempotency hardening', () => {
  const continueFile = () => join(home, '.continue', 'config.json');
  function writeConfig(models: unknown[]) {
    mkdirSync(join(home, '.continue'), { recursive: true });
    writeFileSync(continueFile(), JSON.stringify({ models }, null, 2));
  }

  it('collapses pre-existing duplicate RouteShift entries (no stale OLD key left behind)', () => {
    writeConfig([
      { title: 'RouteShift', provider: 'openai', apiKey: 'OLD_KEY_1' },
      { title: 'GPT-4o', provider: 'openai' },
      { title: 'RouteShift', provider: 'openai', apiKey: 'OLD_KEY_2' },
    ]);
    continueDev.plan(ctx()).apply();

    const after = JSON.parse(readFileSync(continueFile(), 'utf8'));
    const rs = after.models.filter((m: { title: string }) => m.title === 'RouteShift');
    expect(rs).toHaveLength(1);
    const blob = readFileSync(continueFile(), 'utf8');
    expect(blob).not.toContain('OLD_KEY_1');
    expect(blob).not.toContain('OLD_KEY_2'); // the stale duplicate's key is gone
    expect(after.models.some((m: { title: string }) => m.title === 'GPT-4o')).toBe(true);
  });

  it('reports unchanged when the existing entry already matches (no needless secret rewrite)', () => {
    continueDev.plan(ctx()).apply(); // first write
    const replan = continueDev.plan(ctx());
    expect(replan.unchanged).toBe(true);
  });
});

describe('malformed config is never clobbered', () => {
  it('plan() throws and leaves the corrupt file byte-for-byte unchanged', () => {
    const file = join(home, '.claude', 'settings.json');
    mkdirSync(join(home, '.claude'), { recursive: true });
    const corrupt = '{ not valid json ';
    writeFileSync(file, corrupt);

    expect(() => claudeCode.plan(ctx())).toThrow();
    expect(readFileSync(file, 'utf8')).toBe(corrupt);
  });
});

describe('detection', () => {
  it('claude-code detects ~/.claude', () => {
    expect(claudeCode.detect(home)).toBe(false);
    mkdirSync(join(home, '.claude'), { recursive: true });
    expect(claudeCode.detect(home)).toBe(true);
  });
});
