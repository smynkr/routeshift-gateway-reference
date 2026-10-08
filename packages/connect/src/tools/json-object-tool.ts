// Shared engine for tools whose config is a JSON object where RouteShift owns a
// fixed set of dot-paths (Claude Code, opencode, Cursor). Reading-merging-writing
// only those paths guarantees we never clobber the user's other settings, and
// makes both idempotency and a precise disconnect fall out for free.

import {
  readJsonFile,
  deepGet,
  deepSet,
  deepUnset,
  stringifyJson,
  type Json,
} from '../json-file';
import { writeFileSafe } from '../fs-util';
import type { ToolPlan } from './types';

export interface ManagedEntry {
  path: string;
  value: unknown;
  /** True if `value` is (or contains) the secret token. */
  secret?: boolean;
}

export function planJsonObjectTool(toolId: string, file: string, entries: ManagedEntry[]): ToolPlan {
  const paths = entries.map((e) => e.path);
  const before = readJsonFile(file);
  let after = before;
  for (const entry of entries) {
    after = deepSet(after, entry.path, entry.value);
  }
  const containsSecret = entries.some((e) => e.secret);

  return {
    toolId,
    file,
    managedKeys: paths,
    beforeText: renderManagedSlice(before, paths),
    afterText: renderManagedSlice(after, paths),
    containsSecret,
    unchanged: stringifyJson(before) === stringifyJson(after),
    apply() {
      // Re-read at apply time and re-apply only the managed paths onto the
      // CURRENT file, rather than writing the plan-time `after` snapshot. The
      // diff was computed earlier from a plan-time read; an edit the user (or
      // their editor) made between the diff and confirmation would otherwise be
      // clobbered, defeating the read-merge-write invariant.
      let merged = readJsonFile(file);
      for (const entry of entries) {
        merged = deepSet(merged, entry.path, entry.value);
      }
      writeFileSafe(file, stringifyJson(merged), { secret: containsSecret });
    },
  };
}

export function removeJsonObjectTool(file: string, managedKeys: string[]): void {
  const before = readJsonFile(file);
  let after = before;
  for (const key of managedKeys) {
    after = deepUnset(after, key);
  }
  if (stringifyJson(before) === stringifyJson(after)) return;
  writeFileSafe(file, stringifyJson(after), { secret: false });
}

/** Project an object down to just the managed dot-paths, for a focused diff. */
function renderManagedSlice(obj: Json, paths: string[]): string {
  const out: Json = {};
  for (const path of paths) {
    const val = deepGet(obj, path);
    if (val === undefined) continue;
    const keys = path.split('.');
    let cursor: Json = out;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (!cursor[k] || typeof cursor[k] !== 'object' || Array.isArray(cursor[k])) cursor[k] = {};
      cursor = cursor[k] as Json;
    }
    cursor[keys[keys.length - 1]] = val;
  }
  return Object.keys(out).length === 0 ? '' : stringifyJson(out);
}
