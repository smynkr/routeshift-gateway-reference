import { describe, expect, it } from 'vitest';
import {
  CURRENT_MODEL_FIXTURE,
  CURRENT_MODEL_ROLES,
  type CurrentModelFixture,
} from '@routeshift/shared/current-models.generated';
import {
  CURRENT_MODELS,
  requireCurrentModel,
  selectClassifierDefaults,
  selectCurrentModels,
  type CurrentModelRole,
} from '@/lib/current-models';

const fixtureCatalog = Object.fromEntries(
  CURRENT_MODEL_ROLES.map((role) => [role, CURRENT_MODEL_FIXTURE[role]]),
) as Record<CurrentModelRole, CurrentModelFixture>;

describe('current dashboard models', () => {
  it('exposes distinct generated role models', () => {
    expect(new Set(Object.values(CURRENT_MODELS)).size).toBe(CURRENT_MODEL_ROLES.length);
    for (const role of CURRENT_MODEL_ROLES) {
      expect(CURRENT_MODELS[role]).toBe(CURRENT_MODEL_FIXTURE[role].canonical_name);
      expect(requireCurrentModel(role)).toEqual(CURRENT_MODEL_FIXTURE[role]);
    }
  });

  it('keeps role selection aligned with the generated fixture', () => {
    expect(selectCurrentModels(fixtureCatalog)).toEqual(CURRENT_MODELS);
  });
  it('derives classifier defaults as an atomic provider/model pair from economy', () => {
    const fixture = {
      ...CURRENT_MODEL_FIXTURE,
      economy: {
        ...CURRENT_MODEL_FIXTURE.economy,
        provider: 'qwen' as const,
        canonical_name: 'qwen3.7-max',
      },
    };

    expect(selectClassifierDefaults(fixture)).toEqual({
      classifier_provider: 'qwen',
      classifier_model: 'qwen3.7-max',
    });
  });
  it('fails closed when a generated fixture reuses a role model', () => {
    const duplicateFixture = { ...fixtureCatalog, coding: fixtureCatalog.default };
    expect(() => selectCurrentModels(duplicateFixture)).toThrow(/fewer than four distinct/i);
  });
});
