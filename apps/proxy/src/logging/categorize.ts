import type { CanonicalMessage, CanonicalStreamChunk, CanonicalToolCall } from '@routeshift/shared';

export type ActivityCategory =
  | 'coding'
  | 'debugging'
  | 'feature_dev'
  | 'refactoring'
  | 'testing'
  | 'exploration'
  | 'planning'
  | 'delegation'
  | 'git_ops'
  | 'build_deploy'
  | 'brainstorming'
  | 'conversation'
  | 'general';

export interface CategorizeInput {
  messages: CanonicalMessage[];
  toolCalls?: CanonicalToolCall[];
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch']);
const PLANNING_TOOLS = new Set(['EnterPlanMode', 'TaskCreate', 'TaskUpdate']);

const DEBUG_KEYWORDS = ['error', 'fix', 'bug', 'broken', 'failing', 'crash'];
const FEATURE_KEYWORDS = ['add', 'create', 'implement', 'build'];
const REFACTOR_KEYWORDS = ['refactor', 'rename', 'simplify', 'extract'];
const BRAINSTORM_KEYWORDS = ['brainstorm', 'what if', 'design', 'how should'];

const TEST_RUNNERS = /(pytest|vitest|jest|mocha|playwright)/i;
const GIT_OPS = /\bgit\s+(push|commit|merge|rebase|pull)\b/i;
const BUILD_DEPLOY = /(npm\s+run\s+build|pnpm\s+build|yarn\s+build|docker\s+(build|push|run)|pm2|railway\s+up|vercel\s+(deploy|--prod))/i;

function lastUserMessageText(messages: CanonicalMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .filter((p) => p.type === 'text')
        .map((p) => p.text ?? '')
        .join(' ');
    }
    return '';
  }
  return '';
}

function bashCommands(toolCalls: CanonicalToolCall[]): string[] {
  return toolCalls
    .filter((c) => c.function.name === 'Bash')
    .map((c) => {
      try {
        const parsed = JSON.parse(c.function.arguments);
        return typeof parsed.command === 'string' ? parsed.command : '';
      } catch {
        return '';
      }
    });
}

function hasKeyword(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k));
}

export function categorize(input: CategorizeInput): ActivityCategory {
  const calls = input.toolCalls ?? [];
  const toolNames = new Set(calls.map((c) => c.function.name));
  const lastUser = lastUserMessageText(input.messages);

  const hasEdit = [...toolNames].some((n) => EDIT_TOOLS.has(n));
  const hasRead = [...toolNames].some((n) => READ_TOOLS.has(n));
  const hasPlanning = [...toolNames].some((n) => PLANNING_TOOLS.has(n));
  const hasAgent = toolNames.has('Agent');
  const hasBash = toolNames.has('Bash');
  const bash = hasBash ? bashCommands(calls) : [];

  const hasAnyTool = calls.length > 0;

  // Order follows the precedence table in LAY-310. coding (Edit/Write) wins
  // even when other keywords are present; intent keywords (debug/feature/
  // refactor) win over the more specific bash heuristics so a `pnpm build`
  // run while debugging lands as debugging, not build_deploy.
  if (hasEdit) return 'coding';
  if (hasAnyTool && hasKeyword(lastUser, DEBUG_KEYWORDS)) return 'debugging';
  if (hasAnyTool && hasKeyword(lastUser, FEATURE_KEYWORDS)) return 'feature_dev';
  if (hasAnyTool && hasKeyword(lastUser, REFACTOR_KEYWORDS)) return 'refactoring';

  if (hasBash && bash.some((cmd) => TEST_RUNNERS.test(cmd))) return 'testing';
  if (hasRead && !hasEdit) return 'exploration';
  if (hasPlanning) return 'planning';
  if (hasAgent) return 'delegation';
  if (hasBash && bash.some((cmd) => GIT_OPS.test(cmd))) return 'git_ops';
  if (hasBash && bash.some((cmd) => BUILD_DEPLOY.test(cmd))) return 'build_deploy';

  if (!hasAnyTool) {
    if (hasKeyword(lastUser, BRAINSTORM_KEYWORDS)) return 'brainstorming';
    return 'conversation';
  }

  return 'general';
}

export function extractToolCallsFromChunks(chunks: CanonicalStreamChunk[]): CanonicalToolCall[] {
  // Group deltas by stream `index` when present — a tool's id/name arrive only
  // on its first delta, so continuation deltas (id/name empty) must attach to
  // the same tool by index. Fall back to id for providers that repeat the id on
  // every delta. Preserve first-seen order so parallel tool calls stay ordered.
  const order: string[] = [];
  const map = new Map<string, { id: string; name: string; args: string[] }>();
  for (const chunk of chunks) {
    if (chunk.type !== 'tool_call_delta' || !chunk.tool_call) continue;
    const tc = chunk.tool_call;
    const key = tc.index !== undefined ? `idx:${tc.index}` : `id:${tc.id}`;
    let entry = map.get(key);
    if (!entry) {
      entry = { id: tc.id, name: tc.name, args: [] };
      map.set(key, entry);
      order.push(key);
    }
    // id/name may be populated only on the first delta for this tool.
    if (!entry.id && tc.id) entry.id = tc.id;
    if (!entry.name && tc.name) entry.name = tc.name;
    if (tc.arguments_delta) entry.args.push(tc.arguments_delta);
  }
  return order.map((key) => {
    const { id, name, args } = map.get(key)!;
    return { id, type: 'function' as const, function: { name, arguments: args.join('') } };
  });
}
