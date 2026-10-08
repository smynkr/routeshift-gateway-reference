import type { CanonicalToolCall } from '@routeshift/shared';

const PATH_TOOLS_FILE_PATH = new Set(['Edit', 'Write']);
const PATH_TOOLS_NOTEBOOK = new Set(['NotebookEdit']);

// Per-turn signals consumed by the LAY-314 retry-detection aggregation.
// We persist `edited_paths` (paths an Edit/Write touched this turn) and
// `had_bash` (whether any Bash command ran), which together let a session-
// level aggregation walk turns and find the `Edit → Bash → Edit-same-file`
// retry pattern without needing the original tool_call payload.

export function extractEditedPaths(toolCalls: CanonicalToolCall[]): string[] {
  const seen = new Set<string>();
  for (const call of toolCalls) {
    const path = pathFromCall(call);
    if (path && !seen.has(path)) seen.add(path);
  }
  return Array.from(seen);
}

function pathFromCall(call: CanonicalToolCall): string | null {
  const name = call.function.name;
  if (!PATH_TOOLS_FILE_PATH.has(name) && !PATH_TOOLS_NOTEBOOK.has(name)) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(call.function.arguments);
  } catch {
    return null;
  }

  const key = PATH_TOOLS_NOTEBOOK.has(name) ? 'notebook_path' : 'file_path';
  const value = parsed[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function hasBashCall(toolCalls: CanonicalToolCall[]): boolean {
  return toolCalls.some((c) => c.function.name === 'Bash');
}
