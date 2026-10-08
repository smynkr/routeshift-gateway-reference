import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Tool, ToolContext, ToolPlan } from './types';
import { planJsonObjectTool, removeJsonObjectTool } from './json-object-tool';

const configFile = (home: string) => join(home, '.config', 'opencode', 'opencode.json');

// opencode takes a custom OpenAI-compatible provider in opencode.json under
// `provider.<id>`. We own the whole `provider.routeshift` subtree (which holds
// the baseURL + apiKey) and nothing else.
export const opencode: Tool = {
  id: 'opencode',
  displayName: 'opencode',
  protocol: 'openai',
  detect: (home) =>
    existsSync(join(home, '.config', 'opencode')) || existsSync(configFile(home)),
  plan: (ctx: ToolContext): ToolPlan =>
    planJsonObjectTool('opencode', configFile(ctx.home), [
      {
        path: 'provider.routeshift',
        secret: true,
        value: {
          npm: '@ai-sdk/openai-compatible',
          name: 'RouteShift',
          options: {
            baseURL: `${ctx.baseUrl}/v1`,
            apiKey: ctx.token,
          },
        },
      },
    ]),
  remove: (_home, file, keys) => removeJsonObjectTool(file, keys),
};
