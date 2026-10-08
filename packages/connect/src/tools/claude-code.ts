import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Tool, ToolContext, ToolPlan } from './types';
import { planJsonObjectTool, removeJsonObjectTool } from './json-object-tool';

const settingsFile = (home: string) => join(home, '.claude', 'settings.json');

// Claude Code reads provider config from the `env` block of
// ~/.claude/settings.json: ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN. We own
// exactly those two keys and leave the rest of the user's settings untouched.
export const claudeCode: Tool = {
  id: 'claude-code',
  displayName: 'Claude Code',
  protocol: 'anthropic',
  detect: (home) => existsSync(join(home, '.claude')),
  plan: (ctx: ToolContext): ToolPlan =>
    planJsonObjectTool('claude-code', settingsFile(ctx.home), [
      { path: 'env.ANTHROPIC_BASE_URL', value: ctx.baseUrl },
      { path: 'env.ANTHROPIC_AUTH_TOKEN', value: ctx.token, secret: true },
    ]),
  remove: (_home, file, keys) => removeJsonObjectTool(file, keys),
};
