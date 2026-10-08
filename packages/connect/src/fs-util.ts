// Filesystem helpers with a secret-safe default. Any file that may contain the
// RouteShift key is created/truncated with 0600 (owner read/write only) and we
// re-assert the mode on every write so an existing world-readable file gets
// tightened the moment we put a secret in it.

import { mkdirSync, writeFileSync, chmodSync, existsSync, rmSync, renameSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';

export interface WriteOptions {
  /** Set 0600 perms — use whenever the file content includes a secret. */
  secret?: boolean;
}

export function writeFileSafe(file: string, contents: string, opts: WriteOptions = {}): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const mode = opts.secret ? 0o600 : 0o644;
  // Write to a sibling temp file then atomically rename it over the target.
  // These files (e.g. ~/.claude/settings.json, ~/.continue/config.json) hold the
  // user's OWN settings, not just RouteShift's, so a crash mid-write must never
  // truncate them — that would lose unrelated config and defeat the whole
  // read-merge-write design. The temp lives in the same directory so the rename
  // stays on one filesystem (atomic on POSIX). On any failure the temp is
  // cleaned up and the original is left untouched.
  const tmp = join(dir, `.${basename(file)}.routeshift-${process.pid}.tmp`);
  try {
    writeFileSync(tmp, contents, { mode });
    // writeFileSync only applies `mode` on create; re-assert so the temp (and
    // thus the renamed target) is 0600 before it ever holds a secret.
    if (opts.secret) chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

export function removeFileIfExists(file: string): void {
  if (existsSync(file)) rmSync(file);
}

export { existsSync };
