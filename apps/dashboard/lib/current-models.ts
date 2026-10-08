import {
  CURRENT_MODEL_FIXTURE,
  CURRENT_MODEL_ROLES,
  type CurrentModelFixture,
  type CurrentModelFixtureSet,
} from '@routeshift/shared/current-models.generated';
export { CURRENT_MODEL_ROLES };

export type CurrentModelRole = (typeof CURRENT_MODEL_ROLES)[number];
export type CurrentModels = Record<CurrentModelRole, string>;

/** Copy the generated role fixture into the dashboard's string-ID view. */
export function selectCurrentModels(
  fixture: CurrentModelFixtureSet = CURRENT_MODEL_FIXTURE,
): CurrentModels {
  const currentModels = {
    default: fixture.default.canonical_name,
    economy: fixture.economy.canonical_name,
    coding: fixture.coding.canonical_name,
    reasoning: fixture.reasoning.canonical_name,
  };
  if (new Set(Object.values(currentModels)).size < CURRENT_MODEL_ROLES.length) {
    throw new Error('effective public catalog has fewer than four distinct priced models');
  }
  return currentModels;
}
export interface ClassifierDefaults {
  classifier_provider: CurrentModelFixture['provider'];
  classifier_model: string;
}

/** Pure: keep the classifier's provider/model pair aligned with economy. */
export function selectClassifierDefaults(
  fixture: CurrentModelFixtureSet = CURRENT_MODEL_FIXTURE,
): ClassifierDefaults {
  const economy = fixture.economy;
  return {
    classifier_provider: economy.provider,
    classifier_model: economy.canonical_name,
  };
}

export const CURRENT_MODELS: CurrentModels = selectCurrentModels();

export function requireCurrentModel(role: CurrentModelRole): CurrentModelFixture {
  return CURRENT_MODEL_FIXTURE[role];
}
