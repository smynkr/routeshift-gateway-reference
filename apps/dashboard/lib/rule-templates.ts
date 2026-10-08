import { requireCurrentModel } from './current-models';
import type { RuleCondition, RoutingAction } from '@routeshift/shared';

const CURRENT = {
  default: requireCurrentModel('default'),
  economy: requireCurrentModel('economy'),
  coding: requireCurrentModel('coding'),
} as const;

export type RuleTemplateId = 'cheapest-internal-tools' | 'latency-first-ux' | 'eu-only-data';
type TemplateCondition = RuleCondition & { data_residency?: string[] };

export interface RuleTemplate {
  id: RuleTemplateId;
  version: 1;
  name: string;
  description: string;
  available: boolean;
  draft: {
    name: string;
    priority: number;
    condition: TemplateCondition;
    action: RoutingAction;
  };
}

export const RULE_TEMPLATES: readonly RuleTemplate[] = [
  {
    id: 'cheapest-internal-tools',
    version: 1,
    name: 'Cheapest internal tools',
    description: 'Route internal-tool traffic to a low-cost model with a registered fallback.',
    available: true,
    draft: {
      name: 'Cheapest internal tools',
      priority: 500,
      condition: { tags: ['internal'] },
      action: {
        type: 'route',
        target_provider: CURRENT.economy.provider,
        target_model: CURRENT.economy.canonical_name,
        fallback_chain: [{ provider: CURRENT.coding.provider, model: CURRENT.coding.canonical_name }],
      },
    },
  },
  {
    id: 'latency-first-ux',
    version: 1,
    name: 'Latency-first UX',
    description: 'Prefer a fast interactive model for UX-tagged requests, then fall back safely.',
    available: true,
    draft: {
      name: 'Latency-first UX',
      priority: 400,
      condition: { tags: ['interactive'] },
      action: {
        type: 'route',
        target_provider: CURRENT.coding.provider,
        target_model: CURRENT.coding.canonical_name,
        fallback_chain: [{ provider: CURRENT.default.provider, model: CURRENT.default.canonical_name }],
      },
    },
  },
  {
    id: 'eu-only-data',
    version: 1,
    name: 'EU-only data',
    description: 'Requires current EU endpoint evidence before it can be published.',
    available: false,
    draft: {
      name: 'EU-only data',
      priority: 300,
      condition: { data_residency: ['EU'] },
      action: {
        type: 'route',
        target_provider: CURRENT.coding.provider,
        target_model: CURRENT.coding.canonical_name,
      },
    },
  },
] as const;

export function getRuleTemplate(id: string | null): RuleTemplate | null {
  if (!id) return null;
  return RULE_TEMPLATES.find((template) => template.id === id) ?? null;
}

const EDITOR_CONDITION_KEYS = new Set(['model_requested', 'tags', 'max_input_tokens']);
const EDITOR_ACTION_KEYS = new Set([
  'type',
  'target_provider',
  'target_model',
  'fallback_chain',
  'block_reason',
  'add_tags',
]);

export function getRuleTemplateEditorIssues(template: RuleTemplate): string[] {
  const issues = Object.keys(template.draft.condition)
    .filter((key) => !EDITOR_CONDITION_KEYS.has(key))
    .map((key) => `condition.${key}`);
  const actionKeys = Object.keys(template.draft.action);
  issues.push(...actionKeys.filter((key) => !EDITOR_ACTION_KEYS.has(key)).map((key) => `action.${key}`));
  if (!['route', 'block', 'tag'].includes(template.draft.action.type)) {
    issues.push(`action.type=${template.draft.action.type}`);
  }
  return issues;
}
