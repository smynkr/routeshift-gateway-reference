#!/usr/bin/env node
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { run } from './cli';
import { osKeychain } from './keychain';

function openBrowser(url: string): void {
  // Best-effort; never throw if no GUI is available (CI, SSH session).
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* ignore */
  }
}

run(process.argv.slice(2), {
  home: homedir(),
  env: process.env,
  log: (msg = '') => console.log(msg),
  errorLog: (msg = '') => console.error(msg),
  nowIso: () => new Date().toISOString(),
  openBrowser,
  keychain: osKeychain,
})
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`routeshift connect: ${err?.message ?? err}`);
    process.exit(1);
  });
