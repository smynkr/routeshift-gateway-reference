import { describe, expect, it } from 'vitest';
import { EFFECTIVE_PUBLIC_MODELS } from '@routeshift/shared';
import { RULE_TEMPLATES, getRuleTemplate, getRuleTemplateEditorIssues } from '@/lib/rule-templates';

describe('routing rule templates', () => {
  it('publishes the three versioned template ids', () => {
    expect(RULE_TEMPLATES.map((template) => template.id)).toEqual([
      'cheapest-internal-tools',
      'latency-first-ux',
      'eu-only-data',
    ]);
    expect(RULE_TEMPLATES.every((template) => template.version === 1)).toBe(true);
  });

  it('uses providers and models from the shared registry', () => {
    for (const template of RULE_TEMPLATES) {
      const targets = [
        ...(template.draft.action.target_provider && template.draft.action.target_model
          ? [{ provider: template.draft.action.target_provider, model: template.draft.action.target_model }]
          : []),
        ...(template.draft.action.fallback_chain ?? []),
      ];
      for (const target of targets) {
        expect(EFFECTIVE_PUBLIC_MODELS.some((model) => (
          model.public !== false
          && model.provider === target.provider
          && (model.canonical_name === target.model || model.api_model_id === target.model)
        ))).toBe(true);
      }
    }
  });

  it('refuses templates whose full draft cannot round-trip through the editor', () => {
    expect(RULE_TEMPLATES.filter((template) => template.available).flatMap(getRuleTemplateEditorIssues)).toEqual([]);

    const residency = getRuleTemplate('eu-only-data');
    expect(residency).not.toBeNull();
    expect(getRuleTemplateEditorIssues(residency!)).toContain('condition.data_residency');
  });

  it('keeps EU-only data unavailable and carries the fail-closed residency advisory', () => {
    const template = getRuleTemplate('eu-only-data');
    expect(template?.available).toBe(false);
    expect(template?.draft.condition.data_residency).toEqual(['EU']);
  });

  it('rejects unknown template ids', () => {
    expect(getRuleTemplate(null)).toBeNull();
    expect(getRuleTemplate('does-not-exist')).toBeNull();
  });
});
