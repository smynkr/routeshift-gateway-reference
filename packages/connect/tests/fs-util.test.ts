import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSafe } from '../src/fs-util';

describe('writeFileSafe (atomic write)', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('writes the content and leaves no temp file behind', () => {
    dir = mkdtempSync(join(tmpdir(), 'rs-fsutil-'));
    const file = join(dir, 'settings.json');
    writeFileSafe(file, '{"a":1}\n');
    expect(readFileSync(file, 'utf8')).toBe('{"a":1}\n');
    // The temp used for the atomic rename must be cleaned up.
    expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('applies 0600 to secret files (set on the temp before rename)', () => {
    dir = mkdtempSync(join(tmpdir(), 'rs-fsutil-'));
    const file = join(dir, 'creds.json');
    writeFileSafe(file, 'secret', { secret: true });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('fully replaces an existing world-readable file and tightens it to 0600', () => {
    dir = mkdtempSync(join(tmpdir(), 'rs-fsutil-'));
    const file = join(dir, 'settings.json');
    // Pre-existing file with the user's own (longer) content, world-readable.
    writeFileSync(file, '{"theirSetting":"a value much longer than the replacement"}\n', { mode: 0o644 });
    writeFileSafe(file, '{"new":1}\n', { secret: true });
    expect(readFileSync(file, 'utf8')).toBe('{"new":1}\n'); // fully replaced via rename
    expect(statSync(file).mode & 0o777).toBe(0o600); // re-asserted on the temp
    expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
  });
});
