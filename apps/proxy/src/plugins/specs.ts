import { parseModelSuffixes } from '@routeshift/shared';

export type PluginId = 'web' | 'file-parser';

export interface PluginSpec {
  id: PluginId;
  required?: boolean;
  max_results?: number;
  search_prompt?: string;
}

export interface PluginSpecError {
  code: 'invalid_plugin';
  message: string;
}

export interface CollectedPluginSpecs {
  model: string | undefined;
  plugins: PluginSpec[];
  errors: PluginSpecError[];
  /** Internal-only provenance used by the runtime's native-PDF gate. */
  fileParserExplicit: boolean;
}

export function collectPluginSpecs(
  body: { model?: unknown; plugins?: unknown; messages?: unknown; system_prompt?: unknown; system?: unknown },
  options: { online?: boolean } = {},
): CollectedPluginSpecs {
  const originalModel = typeof body.model === 'string' ? body.model : undefined;
  const parsedModel = originalModel ? parseModelSuffixes(originalModel) : null;
  const hasOnlineSuffix = options.online === true || (parsedModel?.ok === true && parsedModel.online);
  const model = parsedModel?.ok === true ? parsedModel.model : originalModel;
  const specs: PluginSpec[] = [];
  const errors: PluginSpecError[] = [];
  let fileParserExplicit = false;

  if (hasOnlineSuffix) specs.push({ id: 'web' });

  if (body.plugins !== undefined && !Array.isArray(body.plugins)) {
    errors.push({ code: 'invalid_plugin', message: 'plugins must be an array' });
    return { model, plugins: specs, errors, fileParserExplicit };
  }

  if (Array.isArray(body.plugins)) {
    for (const raw of body.plugins) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        errors.push({ code: 'invalid_plugin', message: 'Plugin entries must be objects' });
        continue;
      }
      const candidate = raw as Record<string, unknown>;
      const id = candidate.id;
      if (id !== 'web' && id !== 'file-parser') {
        errors.push({ code: 'invalid_plugin', message: `Unsupported plugin id: ${String(id)}` });
        continue;
      }
      const spec: PluginSpec = { id };
      if (id === 'file-parser') fileParserExplicit = true;
      if (typeof candidate.required === 'boolean') spec.required = candidate.required;
      if (typeof candidate.max_results === 'number' && Number.isInteger(candidate.max_results) && candidate.max_results > 0) {
        spec.max_results = candidate.max_results;
      }
      if (typeof candidate.search_prompt === 'string' && candidate.search_prompt.length > 0) {
        spec.search_prompt = candidate.search_prompt;
      }
      upsertPluginSpec(specs, spec);
    }
  }

  if (hasFileContentPart(body.messages) || hasFileContent(body.system_prompt) || hasFileContent(body.system)) {
    upsertPluginSpec(specs, { id: 'file-parser' });
  }

  return { model, plugins: specs, errors, fileParserExplicit };
}

function upsertPluginSpec(specs: PluginSpec[], incoming: PluginSpec): void {
  const index = specs.findIndex((spec) => spec.id === incoming.id);
  if (index === -1) {
    specs.push(incoming);
    return;
  }
  specs[index] = { ...specs[index], ...incoming };
}

function hasFileContentPart(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some((message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
    return hasFileContent((message as { content?: unknown }).content);
  });
}

function hasFileContent(content: unknown): boolean {
  return Array.isArray(content) && content.some((part) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return false;
    const type = (part as { type?: unknown }).type;
    return type === 'file' || type === 'input_file';
  });
}
