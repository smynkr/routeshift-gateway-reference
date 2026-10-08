import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Tool, ToolContext, ToolPlan } from './types';
import { readJsonFile, stringifyJson, type Json } from '../json-file';
import { writeFileSafe } from '../fs-util';

const configFile = (home: string) => join(home, '.continue', 'config.json');

// Continue / Cline (VS Code) store models as an array in ~/.continue/config.json.
// We upsert a single entry identified by title, leaving every other model the
// user has configured intact.
const MODEL_TITLE = 'RouteShift';
const MANAGED_KEY = `models[title=${MODEL_TITLE}]`;

function buildModel(ctx: ToolContext): Json {
  return {
    title: MODEL_TITLE,
    provider: 'openai',
    model: 'gpt-4o-mini',
    apiBase: `${ctx.baseUrl}/v1`,
    apiKey: ctx.token,
  };
}

function readModels(config: Json): Json[] {
  return Array.isArray(config.models) ? (config.models as Json[]) : [];
}

// Upsert the single RouteShift model entry into `config.models`: replace the
// first existing RouteShift entry in place, drop any duplicates, and append if
// absent — leaving every other model the user configured intact. Order-stable
// for the common single-entry case. Used by both plan() (to render the diff)
// and apply() (to re-apply onto the freshly-read file).
function upsertModel(config: Json, model: Json): Json {
  const beforeModels = readModels(config);
  let replaced = false;
  const afterModels: Json[] = [];
  for (const m of beforeModels) {
    if (m && m.title === MODEL_TITLE) {
      if (!replaced) {
        afterModels.push(model);
        replaced = true;
      }
      // drop any further RouteShift duplicates
    } else {
      afterModels.push(m);
    }
  }
  if (!replaced) afterModels.push(model);
  return { ...config, models: afterModels };
}

export const continueDev: Tool = {
  id: 'continue',
  displayName: 'Continue / Cline (VS Code)',
  protocol: 'openai',
  detect: (home) => existsSync(join(home, '.continue')),
  plan: (ctx: ToolContext): ToolPlan => {
    const file = configFile(ctx.home);
    const before = readJsonFile(file);
    const beforeModels = readModels(before);
    const model = buildModel(ctx);

    const existing = beforeModels.filter((m) => m && m.title === MODEL_TITLE);

    // Idempotency is judged on the managed slice only — a single existing entry
    // that already equals `model` — so re-running doesn't rewrite the secret
    // just because unrelated keys serialize in a different order.
    const beforeEntry = existing.length === 1 ? (existing[0] as Json) : undefined;
    const unchanged = beforeEntry !== undefined && stringifyJson(beforeEntry) === stringifyJson(model);

    return {
      toolId: 'continue',
      file,
      managedKeys: [MANAGED_KEY],
      beforeText: beforeEntry ? stringifyJson(beforeEntry) : '',
      afterText: stringifyJson(model),
      containsSecret: true,
      unchanged,
      apply() {
        // Re-read at apply time and re-run the upsert onto the CURRENT file, so a
        // concurrent edit between the diff and confirmation is preserved rather
        // than clobbered by a plan-time snapshot.
        writeFileSafe(file, stringifyJson(upsertModel(readJsonFile(file), model)), { secret: true });
      },
    };
  },
  remove: (_home, file) => {
    const before = readJsonFile(file);
    const models = readModels(before);
    const filtered = models.filter((m) => !(m && m.title === MODEL_TITLE));
    if (filtered.length === models.length) return;
    const after: Json = { ...before, models: filtered };
    writeFileSafe(file, stringifyJson(after), { secret: false });
  },
};
