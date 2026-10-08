import { confirm as defaultConfirm } from './prompt';
import { deviceLogin as defaultDeviceLogin, DeviceFlowError } from './device-flow';
import { renderDiff } from './diff';
import { redact, redactDiff, maskSecret } from './redact';
import {
  TOOLS,
  getTool,
  detectInstalledTools,
  cursorGuidance,
  type Tool,
} from './tools';
import {
  loadManifest,
  upsertManifestTool,
  removeManifestTool,
} from './manifest';
import { osKeychain, type KeychainDeleteResult, type KeychainStore } from './keychain';
import { runUsage } from './usage/command';
import { DEFAULT_AUTH_URL, DEFAULT_PROXY_BASE_URL } from './constants';

export interface CliDeps {
  home: string;
  env: Record<string, string | undefined>;
  log: (msg?: string) => void;
  errorLog: (msg?: string) => void;
  nowIso: () => string;
  confirmFn?: typeof defaultConfirm;
  deviceLoginFn?: typeof defaultDeviceLogin;
  openBrowser?: (url: string) => void;
  /** OS keychain for the minted token; defaults to the real store in index.ts. */
  keychain?: KeychainStore;
  /** Injectable fetch for the `usage` command's HTTP client (tests stub it). */
  fetchImpl?: typeof fetch;
}

interface ParsedArgs {
  command: 'connect' | 'status' | 'disconnect' | 'help' | 'usage';
  yes: boolean;
  authUrl?: string;
  baseUrl?: string;
  token?: string;
  noKeychain: boolean;
  tools: string[];
}

const CLIENT_ID = 'routeshift-connect';
const CLIENT_NAME = 'RouteShift Connect CLI';

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { command: 'connect', yes: false, noKeychain: false, tools: [] };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // Consume the next argv item as this option's value — but only if it isn't
    // itself a flag, so `--tool --yes` doesn't swallow `--yes` as a tool name.
    const takeValue = (): string | undefined => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) return undefined;
      i++;
      return next;
    };
    switch (arg) {
      case '--status':
        out.command = 'status';
        break;
      case '-y':
      case '--yes':
        out.yes = true;
        break;
      case '--auth-url':
        out.authUrl = takeValue();
        break;
      case '--base-url':
        out.baseUrl = takeValue();
        break;
      case '--token':
        out.token = takeValue();
        break;
      case '--no-keychain':
        out.noKeychain = true;
        break;
      case '--tool': {
        const tool = takeValue();
        if (tool) out.tools.push(tool);
        break;
      }
      case '-h':
      case '--help':
        out.command = 'help';
        break;
      default:
        if (!arg.startsWith('-')) positionals.push(arg);
    }
  }
  const cmd = positionals[0];
  if (cmd === 'status' || cmd === 'disconnect' || cmd === 'help' || cmd === 'usage') out.command = cmd;
  else if (cmd === 'login' || cmd === 'connect') out.command = 'connect';
  return out;
}

/** sk-proxy-<env>_<team>_<random> → sk-proxy-<env>_<team> (non-secret prefix). */
export function derivePrefix(token: string): string {
  if (token.startsWith('sk-proxy-')) {
    const parts = token.split('_');
    if (parts.length >= 3) return `${parts[0]}_${parts[1]}`;
  }
  return token.slice(0, 8);
}

export async function run(argv: string[], deps: CliDeps): Promise<number> {
  const args = parseArgs(argv);
  switch (args.command) {
    case 'help':
      printHelp(deps.log);
      return 0;
    case 'status':
      return runStatus(deps);
    case 'disconnect':
      return runDisconnect(args, deps);
    case 'usage':
      return runUsage(argv, deps);
    case 'connect':
      return runConnect(args, deps);
  }
}

async function runConnect(args: ParsedArgs, deps: CliDeps): Promise<number> {
  const { log, errorLog } = deps;
  const authUrl = args.authUrl ?? deps.env.ROUTESHIFT_AUTH_URL ?? DEFAULT_AUTH_URL;
  const baseUrl = (args.baseUrl ?? deps.env.ROUTESHIFT_URL ?? DEFAULT_PROXY_BASE_URL).replace(/\/+$/, '');
  const keychain = deps.keychain ?? osKeychain;
  const previousManifest = loadManifest(deps.home);
  const previousKeychainToken = readKeychainEntry(keychain, baseUrl);

  // Obtain a token: device flow by default, or a manually-pasted key (v1
  // fallback for instances where the device flow isn't deployed yet).
  let token: string;
  let keyPrefix: string;
  if (args.token) {
    token = args.token.trim();
    if (!token) {
      errorLog('--token was empty.');
      return 1;
    }
    keyPrefix = derivePrefix(token);
    log(`Using the key you provided (${keyPrefix}…).`);
  } else {
    const deviceLogin = deps.deviceLoginFn ?? defaultDeviceLogin;
    try {
      const result = await deviceLogin(
        authUrl,
        // `routeshift usage` reuses this key and the reporting endpoint
        // requires `read`; request both capabilities explicitly so the user
        // sees and approves the complete grant.
        { clientId: CLIENT_ID, clientName: CLIENT_NAME, scope: 'inference read' },
        {
          openBrowser: deps.openBrowser,
          onUserCode: (info) => {
            log('');
            log('  To authorize this device, visit:');
            log(`    ${info.verification_uri_complete}`);
            log('');
            log(`  and confirm this code:  ${info.user_code}`);
            log('');
            log('  Waiting for approval…');
          },
        },
      );
      token = result.accessToken;
      keyPrefix = result.keyPrefix ?? derivePrefix(token);
    } catch (err) {
      if (err instanceof DeviceFlowError) {
        errorLog(`Sign-in failed: ${err.message}`);
      } else {
        errorLog(`Sign-in failed: ${(err as Error).message}`);
      }
      return 1;
    }
  }

  const ctx = { home: deps.home, baseUrl, token, keyPrefix };

  // Persist the token to the OS keychain so `routeshift usage` can authenticate
  // without re-running connect. Best-effort: a missing/locked keychain must not
  // fail the connect (tool configs still get written; usage has a ROUTESHIFT_TOKEN
  // env fallback). Never logged.
  let storedTokenInKeychain = false;
  if (args.noKeychain) {
    if (previousKeychainToken) {
      const deleteResult = deleteKeychainEntry(keychain, baseUrl);
      if (deleteResult === 'error') warnKeychainDeleteFailure(deps, baseUrl);
    }
    deps.errorLog('  note: OS keychain storage disabled by --no-keychain; any configured tools that require a file-based token will keep a bounded plaintext tool config copy until `routeshift disconnect` removes it.');
  } else {
    try {
      keychain.set(baseUrl, token);
      storedTokenInKeychain = true;
    } catch (err) {
      deps.errorLog(`  note: could not store the key in your OS keychain (${redactedErrorMessage(err, token)}). \`routeshift usage\` will need ROUTESHIFT_TOKEN set.`);
    }
  }

  // Which tools to configure.
  let tools: Tool[];
  if (args.tools.length > 0) {
    tools = [];
    for (const id of args.tools) {
      const tool = getTool(id);
      if (!tool) {
        rollbackKeychainWrite(keychain, baseUrl, deps, storedTokenInKeychain, previousKeychainToken);
        errorLog(`Unknown tool '${id}'. Known: ${TOOLS.map((t) => t.id).join(', ')}`);
        return 1;
      }
      // The auto-detect path already skips anthropic-protocol tools (below)
      // because the proxy has no Anthropic /v1/messages surface — writing
      // ANTHROPIC_BASE_URL at the proxy would silently break the tool's next
      // request. An explicit --tool must fail the same way, not bypass it.
      if (tool.protocol === 'anthropic') {
        rollbackKeychainWrite(keychain, baseUrl, deps, storedTokenInKeychain, previousKeychainToken);
        errorLog(`${tool.displayName} support requires RouteShift Anthropic /v1/messages, which is not yet enabled. Not configuring --tool ${tool.id}.`);
        return 1;
      }
      tools.push(tool);
    }
  } else {
    tools = detectInstalledTools(deps.home).filter((tool) => tool.protocol !== 'anthropic');
    if (detectInstalledTools(deps.home).some((tool) => tool.protocol === 'anthropic')) {
      log('Claude Code support requires RouteShift Anthropic /v1/messages; skipping auto-configuration. Re-run with --tool claude-code when that surface is enabled.');
    }
  }

  if (tools.length === 0) {
    rollbackKeychainWrite(keychain, baseUrl, deps, storedTokenInKeychain, previousKeychainToken);
    log('No supported tools detected on this machine.');
    log(`Re-run with --tool <id> to force one. Known: ${TOOLS.map((t) => t.id).join(', ')}`);
    log('');
    cursorGuidance(ctx).forEach((line) => log(line));
    return 0;
  }

  const confirmFn = deps.confirmFn ?? defaultConfirm;
  let configured = 0;
  for (const tool of tools) {
   try {
    const plan = tool.plan(ctx);
    if (plan.unchanged) {
      log(`✓ ${tool.displayName} — already configured (${plan.file})`);
      upsertManifestTool(
        deps.home,
        { baseUrl, keyPrefix, keychainDisabled: args.noKeychain },
        { id: tool.id, file: plan.file, managedKeys: plan.managedKeys },
        deps.nowIso(),
      );
      configured++;
      continue;
    }

    log('');
    log(`${tool.displayName} → ${plan.file}`);
    // Redact BOTH the new token and the prior keychain key, plus any other
    // RouteShift-format key in the diff. On a re-connect, plan.beforeText holds
    // the OLD key on a removed line; masking only the new token leaked it (RSH-58).
    const safeDiff = redactDiff(renderDiff(plan.beforeText, plan.afterText), [
      token,
      previousKeychainToken,
    ]);
    safeDiff.split('\n').forEach((line) => log(`  ${line}`));

    const ok = await confirmFn(`Apply changes to ${tool.displayName}?`, { assumeYes: args.yes });
    if (!ok) {
      log(`  skipped ${tool.displayName}`);
      continue;
    }
    plan.apply();
    upsertManifestTool(
      deps.home,
      { baseUrl, keyPrefix, keychainDisabled: args.noKeychain },
      { id: tool.id, file: plan.file, managedKeys: plan.managedKeys },
      deps.nowIso(),
    );
    configured++;
    log(`  ✓ configured ${tool.displayName}`);
   } catch (err) {
     // One tool's broken config (e.g. unparseable JSON, which readJsonFile
     // refuses to overwrite) must not abort configuring the others.
     deps.errorLog(`  could not configure ${tool.displayName}: ${redactedErrorMessage(err, token)}`);
   }
  }

  if (configured === 0) {
    rollbackKeychainWrite(keychain, baseUrl, deps, storedTokenInKeychain, previousKeychainToken);
    errorLog('No tools were configured. Claude Code support requires RouteShift Anthropic /v1/messages; choose an OpenAI-compatible tool for now.');
    return 1;
  } else if (previousManifest?.baseUrl && previousManifest.baseUrl !== baseUrl) {
    const deleteResult = deleteKeychainEntry(keychain, previousManifest.baseUrl);
    if (deleteResult === 'error') warnKeychainDeleteFailure(deps, previousManifest.baseUrl);
  }

  log('');
  cursorGuidance(ctx).forEach((line) => log(line));
  log('');
  log(`Done. Your key (${maskSecret(token)}) was written only to the files above with 0600`);
  log('permissions and never printed in full.');
  return 0;
}

function runStatus(deps: CliDeps): number {
  const { log } = deps;
  const manifest = loadManifest(deps.home);
  if (!manifest || manifest.tools.length === 0) {
    log('RouteShift is not connected. Run `routeshift connect` to set it up.');
    return 0;
  }
  log(`Connected to ${manifest.baseUrl}`);
  log(`Key: ${manifest.keyPrefix}…`);
  log('');
  log('Configured tools:');
  for (const t of manifest.tools) {
    const tool = getTool(t.id);
    log(`  ✓ ${tool?.displayName ?? t.id}  →  ${t.file}`);
  }
  return 0;
}

async function runDisconnect(args: ParsedArgs, deps: CliDeps): Promise<number> {
  const { log } = deps;
  const manifest = loadManifest(deps.home);
  if (!manifest || manifest.tools.length === 0) {
    log('Nothing to disconnect.');
    return 0;
  }

  log('This will remove RouteShift config from:');
  for (const t of manifest.tools) {
    log(`  • ${getTool(t.id)?.displayName ?? t.id}  (${t.file})`);
  }
  const confirmFn = deps.confirmFn ?? defaultConfirm;
  const ok = await confirmFn('Remove RouteShift config from these tools?', { assumeYes: args.yes });
  if (!ok) {
    log('Cancelled.');
    return 0;
  }

  for (const t of manifest.tools) {
    const tool = getTool(t.id);
    if (tool) {
      try {
        tool.remove(deps.home, t.file, t.managedKeys);
      } catch (err) {
        deps.errorLog(`  could not clean ${t.id}: ${(err as Error).message}`);
      }
    }
    removeManifestTool(deps.home, t.id);
    log(`  removed ${tool?.displayName ?? t.id}`);
  }
  if (manifest.keychainDisabled) {
    log('Disconnected.');
    return 0;
  }
  const deleteResult = deleteKeychainEntry(deps.keychain ?? osKeychain, manifest.baseUrl);
  if (deleteResult === 'error') {
    warnKeychainDeleteFailure(deps, manifest.baseUrl);
    log('Disconnected from tool configs, but the key may still be stored in your OS keychain.');
    return 1;
  }
  log('Disconnected.');
  return 0;
}

function rollbackKeychainWrite(
  keychain: KeychainStore,
  account: string,
  deps: CliDeps,
  stored: boolean,
  previousToken: string | null,
): void {
  if (!stored) return;
  if (previousToken) {
    try {
      keychain.set(account, previousToken);
    } catch {
      warnKeychainRestoreFailure(deps, account);
    }
    return;
  }
  const deleteResult = deleteKeychainEntry(keychain, account);
  if (deleteResult === 'error') warnKeychainDeleteFailure(deps, account);
}

function readKeychainEntry(keychain: KeychainStore, account: string): string | null {
  try {
    return keychain.get(account);
  } catch {
    return null;
  }
}

function deleteKeychainEntry(keychain: KeychainStore, account: string): KeychainDeleteResult {
  try {
    return keychain.delete(account);
  } catch {
    return 'error';
  }
}

function warnKeychainDeleteFailure(deps: CliDeps, account: string): void {
  deps.errorLog(`  warning: could not remove the RouteShift key for ${account} from your OS keychain; it may remain stored.`);
}

function warnKeychainRestoreFailure(deps: CliDeps, account: string): void {
  deps.errorLog(`  warning: could not restore the previous RouteShift key for ${account} in your OS keychain.`);
}

function redactedErrorMessage(err: unknown, token: string): string {
  const message = err instanceof Error ? err.message : String(err);
  return redact(message, token);
}

function printHelp(log: (msg?: string) => void): void {
  log('routeshift connect — point your AI tools at RouteShift');
  log('');
  log('Usage:');
  log('  node packages/connect/dist/index.js [connect] Configure detected tools');
  log('  node packages/connect/dist/index.js --status       Show what is configured');
  log('  node packages/connect/dist/index.js disconnect     Remove RouteShift config');
  log('  node packages/connect/dist/index.js usage          Show your usage / spend / savings TUI');
  log('');
  log('Options:');
  log('  --tool <id>       Configure a specific tool (repeatable)');
  log('  --base-url <url>  Gateway inference URL (ROUTESHIFT_URL; default http://localhost:4000)');
  log('  --auth-url <url>  Dashboard OAuth URL (ROUTESHIFT_AUTH_URL; default http://localhost:3000)');
  log('  --token <key>     Use a pasted key instead of the device-flow sign-in');
  log('  --no-keychain     Do not store the key in the OS keychain (plaintext tool configs only)');
  log('  -y, --yes         Apply changes without confirmation');
  log('  -h, --help        Show this help');
  log('');
  log('Usage options:');
  log('  --today | --week | --month   Time window (default last 30 days)');
  log('  --since <iso|7d|30d|ytd>     Custom window start');
  log('  --bucket <hour|day>          Series granularity (default day)');
  log('  --graph <2d|3d>              Contribution graph style (default 2d)');
  log('  --watch[=secs]               Live-refresh view (default 5s)');
  log('  --json                       Print raw JSON (scriptable; no TUI)');
  log('');
  log(`Tools: ${TOOLS.map((t) => t.id).join(', ')}`);
}
