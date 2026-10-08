// AUTO-GENERATED — do not edit by hand.
// Regenerate with: pnpm --filter @routeshift/shared refresh-catalog
import type { Provider } from './models';

export const CURRENT_MODEL_ROLES = ['default', 'economy', 'coding', 'reasoning'] as const;
export type CurrentModelRole = (typeof CURRENT_MODEL_ROLES)[number];
export interface CurrentModelFixture {
  provider: Provider;
  canonical_name: string;
  context_window: number;
}
export type CurrentModelFixtureSet = Record<CurrentModelRole, CurrentModelFixture>;

export const CURRENT_MODEL_FIXTURE: CurrentModelFixtureSet = {
  default: { provider: "cloudflare-workers-ai", canonical_name: "@cf/zai-org/glm-5.3-flash", context_window: 1048576 },
  economy: { provider: "zai", canonical_name: "glm-4.5-air", context_window: 128000 },
  coding: { provider: "qwen", canonical_name: "Qwen3-Coder-480B-A35B-Instruct", context_window: 256000 },
  reasoning: { provider: "openai", canonical_name: "o4-mini", context_window: 200000 },
};

export default CURRENT_MODEL_FIXTURE;
