import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { Tool, ToolContext, ToolPlan } from './types';
import { writeFileSafe, removeFileIfExists } from '../fs-util';

const envFile = (home: string) => join(home, '.routeshift', 'env.sh');

// A RouteShift-owned shell snippet exporting the OpenAI-compatible env vars.
// aider, the OpenAI SDK, and any tool that reads OPENAI_BASE_URL / OPENAI_API_KEY
// pick this up once the user sources it (`source ~/.routeshift/env.sh`, or add
// that line to their shell rc). We own the whole file, so idempotency and
// removal are trivial and there is nothing of the user's to clobber.
// Single-quoted shell literal. Single quotes disable ALL shell metacharacters,
// so an embedded quote, `$(...)`, or backtick in the value can't execute when the
// file is sourced. The only escape needed is a literal single quote → '\'' .
const shq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

function render(ctx: ToolContext): string {
  return [
    '# Managed by `routeshift connect` — do not edit by hand.',
    '# Source this file (e.g. add `source ~/.routeshift/env.sh` to your shell rc)',
    '# to route OpenAI-compatible tools (aider, openai SDK, …) through RouteShift.',
    `export OPENAI_BASE_URL=${shq(`${ctx.baseUrl}/v1`)}`,
    `export OPENAI_API_KEY=${shq(ctx.token)}`,
    '',
  ].join('\n');
}

export const openaiEnv: Tool = {
  id: 'openai-env',
  displayName: 'aider / OpenAI-compatible (shell env)',
  protocol: 'openai',
  detect: (home) => existsSync(join(home, '.aider.conf.yml')) || existsSync(envFile(home)),
  plan: (ctx: ToolContext): ToolPlan => {
    const file = envFile(ctx.home);
    const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const after = render(ctx);
    return {
      toolId: 'openai-env',
      file,
      managedKeys: ['*'],
      beforeText: before,
      afterText: after,
      containsSecret: true,
      unchanged: before === after,
      apply() {
        writeFileSafe(file, after, { secret: true });
      },
    };
  },
  remove: (_home, file) => removeFileIfExists(file),
};
