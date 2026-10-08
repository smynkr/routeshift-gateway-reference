// JSON config helpers that never clobber unrelated keys. We only ever set or
// unset the specific dot-paths RouteShift manages; everything else in a user's
// config file is read, preserved verbatim, and written back.

import { readFileSync, existsSync } from 'node:fs';

export type Json = Record<string, unknown>;

export function readJsonFile(file: string): Json {
  if (!existsSync(file)) return {};
  try {
    const text = readFileSync(file, 'utf8').trim();
    if (!text) return {};
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Json) : {};
  } catch {
    // A malformed config is not ours to silently overwrite. Callers should
    // treat a throw here as "refuse to touch this file".
    throw new Error(`Cannot parse JSON config at ${file} — fix or remove it, then retry.`);
  }
}

// Reject path segments that would walk into an object's prototype chain.
// deepSet writes through `cursor[key]`, so a `__proto__` segment resolves to
// Object.prototype and `cursor[next] = value` pollutes it globally (verified:
// deepSet({}, '__proto__.x', 1) sets Object.prototype.x). Every managed path
// today is a hardcoded constant so this can't fire — but these are exported,
// reusable helpers, so guard the primitive rather than trust every caller.
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function assertSafePath(dotPath: string): void {
  for (const key of dotPath.split('.')) {
    if (FORBIDDEN_SEGMENTS.has(key)) {
      throw new Error(`Refusing to use unsafe config path segment "${key}" in "${dotPath}"`);
    }
  }
}

export function deepGet(obj: Json, dotPath: string): unknown {
  return dotPath.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && !Array.isArray(acc)) {
      return (acc as Json)[key];
    }
    return undefined;
  }, obj);
}

/** Returns a deep-cloned copy with `dotPath` set to `value`. */
export function deepSet(obj: Json, dotPath: string, value: unknown): Json {
  assertSafePath(dotPath);
  const clone = structuredClone(obj);
  const keys = dotPath.split('.');
  let cursor: Json = clone;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    const next = cursor[key];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Json;
  }
  cursor[keys[keys.length - 1]] = value;
  return clone;
}

/** Returns a deep-cloned copy with `dotPath` removed and now-empty parents pruned. */
export function deepUnset(obj: Json, dotPath: string): Json {
  assertSafePath(dotPath);
  const clone = structuredClone(obj);
  const keys = dotPath.split('.');
  const stack: Json[] = [clone];
  let cursor: Json = clone;
  for (let i = 0; i < keys.length - 1; i++) {
    const next = cursor[keys[i]];
    if (!next || typeof next !== 'object' || Array.isArray(next)) return clone; // nothing to remove
    cursor = next as Json;
    stack.push(cursor);
  }
  delete cursor[keys[keys.length - 1]];

  // Prune parents that became empty objects, so a disconnect leaves no orphan
  // `{ "env": {} }` husks behind.
  for (let i = stack.length - 1; i > 0; i--) {
    const node = stack[i];
    const parentKey = keys[i - 1];
    if (Object.keys(node).length === 0) {
      delete stack[i - 1][parentKey];
    } else {
      break;
    }
  }
  return clone;
}

export function stringifyJson(obj: Json): string {
  return `${JSON.stringify(obj, null, 2)}\n`;
}
