import { describe, expect, it } from 'vitest';
import type { CanonicalToolCall } from '@routeshift/shared';
import { extractEditedPaths, hasBashCall } from '../src/logging/turn-signals.js';

const call = (name: string, args: Record<string, unknown> = {}): CanonicalToolCall => ({
  id: 't_' + name,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

describe('extractEditedPaths', () => {
  it('returns the file_path from a single Edit call', () => {
    const paths = extractEditedPaths([call('Edit', { file_path: '/abs/foo.ts', old_string: 'a', new_string: 'b' })]);
    expect(paths).toEqual(['/abs/foo.ts']);
  });

  it('returns the file_path from a Write call', () => {
    const paths = extractEditedPaths([call('Write', { file_path: '/abs/bar.ts', content: 'hi' })]);
    expect(paths).toEqual(['/abs/bar.ts']);
  });

  it('aggregates paths across multiple Edit/Write calls', () => {
    const paths = extractEditedPaths([
      call('Edit', { file_path: '/a.ts' }),
      call('Write', { file_path: '/b.ts' }),
      call('Edit', { file_path: '/c.ts' }),
    ]);
    expect(paths).toEqual(['/a.ts', '/b.ts', '/c.ts']);
  });

  it('dedupes the same path within one turn', () => {
    const paths = extractEditedPaths([
      call('Edit', { file_path: '/foo.ts' }),
      call('Edit', { file_path: '/foo.ts' }),
    ]);
    expect(paths).toEqual(['/foo.ts']);
  });

  it('handles NotebookEdit (cell_id keys path)', () => {
    const paths = extractEditedPaths([
      call('NotebookEdit', { notebook_path: '/abs/notebook.ipynb', cell_id: 'cell-1', new_source: 'x' }),
    ]);
    expect(paths).toEqual(['/abs/notebook.ipynb']);
  });

  it('ignores unrelated tool calls', () => {
    const paths = extractEditedPaths([
      call('Read', { file_path: '/foo.ts' }),
      call('Bash', { command: 'ls' }),
      call('Grep', { pattern: 'x' }),
    ]);
    expect(paths).toEqual([]);
  });

  it('returns empty for an empty list', () => {
    expect(extractEditedPaths([])).toEqual([]);
  });

  it('skips Edit calls with non-string file_path or unparseable args', () => {
    const paths = extractEditedPaths([
      call('Edit', { file_path: 42 }),
      { id: 'broken', type: 'function', function: { name: 'Edit', arguments: 'not json' } },
      call('Edit', { file_path: '/ok.ts' }),
    ]);
    expect(paths).toEqual(['/ok.ts']);
  });
});

describe('hasBashCall', () => {
  it('is true when any Bash call is present', () => {
    expect(hasBashCall([call('Bash', { command: 'ls' })])).toBe(true);
  });

  it('is true even if other tools are mixed in', () => {
    expect(
      hasBashCall([
        call('Edit', { file_path: '/foo.ts' }),
        call('Bash', { command: 'pnpm test' }),
      ]),
    ).toBe(true);
  });

  it('is false when no Bash calls are present', () => {
    expect(hasBashCall([call('Edit'), call('Read'), call('Grep')])).toBe(false);
  });

  it('is false for an empty list', () => {
    expect(hasBashCall([])).toBe(false);
  });
});
