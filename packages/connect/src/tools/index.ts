import type { Tool, ToolContext } from './types';
import { claudeCode } from './claude-code';
import { opencode } from './opencode';
import { continueDev } from './continue';
import { openaiEnv } from './openai-env';

export * from './types';

// Order matters only for display. Auto-writers RouteShift can configure
// idempotently from a clobber-safe config file.
export const TOOLS: Tool[] = [claudeCode, opencode, continueDev, openaiEnv];

export function getTool(id: string): Tool | undefined {
  return TOOLS.find((t) => t.id === id);
}

export function detectInstalledTools(home: string): Tool[] {
  return TOOLS.filter((t) => t.detect(home));
}

// Cursor stores its model/API config in app-managed state, not in a
// clobber-safe config file we can edit idempotently, so we surface exact
// copy-paste values instead of writing a secret to a file Cursor may ignore.
export function cursorGuidance(ctx: Pick<ToolContext, 'baseUrl' | 'keyPrefix'>): string[] {
  return [
    'Cursor — set this manually (Settings → Models → OpenAI API):',
    `  • Override OpenAI Base URL:  ${ctx.baseUrl}/v1`,
    `  • OpenAI API Key:            ${ctx.keyPrefix}…  (the full key was just issued to you)`,
    '  Cursor keeps these in app state, so RouteShift does not write them to disk.',
  ];
}
