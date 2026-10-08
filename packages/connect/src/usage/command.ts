import { render } from 'ink';
import React from 'react';
import { loadManifest } from '../manifest';
import { osKeychain } from '../keychain';
import { redact } from '../redact';
import { fetchUsageSummary, ReconnectNeededError, type UsageQuery } from './client';
import { UsageApp } from './app';
import type { CliDeps } from '../cli';
import { DEFAULT_PROXY_BASE_URL } from '../constants';

export interface UsageArgs {
  since?: string;
  until?: string;
  bucket?: 'hour' | 'day';
  graph: '2d' | '3d';
  watch: boolean;
  watchSeconds: number;
  json: boolean;
  baseUrl?: string;
  token?: string;
  error?: string;
}

/** Parse `usage`-specific flags. argv[0] is the 'usage' positional (skipped). */
export function parseUsageArgs(argv: string[]): UsageArgs {
  const out: UsageArgs = { graph: '2d', watch: false, watchSeconds: 5, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, attached] = splitFlag(arg);
    const value = (): string | undefined => {
      if (attached !== undefined) return attached;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) return undefined;
      i++;
      return next;
    };
    switch (flag) {
      case 'usage': break;
      case '--today': out.since = 'today'; break;
      case '--week': out.since = '7d'; break;
      case '--month': out.since = 'month'; break;
      case '--since': out.since = value(); break;
      case '--until': out.until = value(); break;
      case '--bucket': { const b = value(); if (b === 'hour' || b === 'day') out.bucket = b; break; }
      case '--graph': { const g = value(); if (g === '2d' || g === '3d') out.graph = g; break; }
      case '--watch': {
        out.watch = true;
        // accepts both --watch=10 and --watch 10 (value() handles either form)
        const secs = Number.parseInt(value() ?? '', 10);
        if (Number.isFinite(secs) && secs > 0) out.watchSeconds = secs;
        break;
      }
      case '--json': out.json = true; break;
      case '--base-url': out.baseUrl = value(); break;
      case '--token': {
        const token = value();
        if (token === undefined) out.error = '--token requires a value.';
        else out.token = token;
        break;
      }
      default: break; // unknown flags are ignored (lenient parser)
    }
  }
  return out;
}

function splitFlag(arg: string): [string, string | undefined] {
  if (arg.startsWith('--') && arg.includes('=')) {
    const eq = arg.indexOf('=');
    return [arg.slice(0, eq), arg.slice(eq + 1)];
  }
  return [arg, undefined];
}

/** Resolve baseUrl (flag → env → manifest → default) and token (flag → env → keychain). */
export function resolveCredentials(args: UsageArgs, deps: CliDeps): { baseUrl: string; token: string } | null {
  const manifest = loadManifest(deps.home);
  const baseUrl = (present(args.baseUrl) ?? present(deps.env.ROUTESHIFT_URL) ?? present(manifest?.baseUrl) ?? DEFAULT_PROXY_BASE_URL).replace(/\/+$/, '');
  const token = present(args.token) ?? present(deps.env.ROUTESHIFT_TOKEN) ?? present((deps.keychain ?? osKeychain).get(baseUrl));
  if (!token) return null;
  return { baseUrl, token };
}

export async function runUsage(argv: string[], deps: CliDeps): Promise<number> {
  const args = parseUsageArgs(argv);

  if (args.error) {
    deps.errorLog(`Error: ${args.error}`);
    return 1;
  }

  if (args.json && args.watch) {
    deps.errorLog('Error: --json cannot be combined with --watch.');
    return 1;
  }

  const creds = resolveCredentials(args, deps);
  if (!creds) {
    deps.errorLog('Not connected. Run `routeshift connect` first (or set ROUTESHIFT_TOKEN).');
    return 1;
  }

  const query: UsageQuery = { since: args.since, until: args.until, bucket: args.bucket, graph: args.graph };
  const fetchImpl = deps.fetchImpl ?? fetch;

  if (args.json) {
    try {
      const data = await fetchUsageSummary(creds.baseUrl, creds.token, query, fetchImpl);
      deps.log(JSON.stringify(data, null, 2));
      return 0;
    } catch (err) {
      return reportError(err, deps, creds.token);
    }
  }

  let initial;
  try {
    initial = await fetchUsageSummary(creds.baseUrl, creds.token, query, fetchImpl);
  } catch (err) {
    return reportError(err, deps, creds.token);
  }

  const { waitUntilExit } = render(
    React.createElement(UsageApp, {
      initial,
      baseUrl: creds.baseUrl,
      token: creds.token,
      query,
      graph: args.graph,
      watch: args.watch,
      watchSeconds: args.watchSeconds,
      fetchImpl,
    }),
  );
  await waitUntilExit();
  return 0;
}

function present(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function reportError(err: unknown, deps: CliDeps, token: string): number {
  if (err instanceof ReconnectNeededError) {
    deps.errorLog(err.message);
  } else {
    const message = err instanceof Error ? err.message : String(err);
    deps.errorLog(`RouteShift usage failed: ${redact(message, token)}`);
  }
  return 1;
}
