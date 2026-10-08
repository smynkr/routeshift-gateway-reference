/**
 * Demo mode: a per-browser toggle that swaps the six token-analysis pages'
 * data reads to a pre-seeded demo team, so RouteShift can be shown fully
 * populated without real traffic and without logging in/out.
 *
 * Safety: demo mode is ENV-GATED. A stray `rs_demo` cookie can never surface
 * seeded data in production unless DEMO_MODE_ENABLED is explicitly set. See
 * tests/demo-mode.test.ts for the no-bypass contract.
 *
 * The demo team id is a stable UUID-looking literal on purpose. Team ids are
 * stored and queried as TEXT, but keeping the seeded demo id unchanged
 * preserves existing demo rows, cookies, health checks, and external sample
 * links. Keep this in sync with scripts/seed-demo.ts.
 */
import { cookies } from 'next/headers';

export {
  DEMO_TEAM_ID,
  DEMO_USER_ID,
  DEMO_USER_EMAIL,
  DEMO_COOKIE,
} from './demo-constants';
import { DEMO_COOKIE, DEMO_TEAM_ID } from './demo-constants';

/**
 * Whether demo mode is permitted in this environment at all. Explicit
 * DEMO_MODE_ENABLED wins (1/true → on, 0/false → off); otherwise it defaults
 * on outside production so local/staging demos work without extra config,
 * and off in production so fake data never leaks.
 */
export function isDemoModeEnabled(): boolean {
  const flag = process.env.DEMO_MODE_ENABLED;
  if (flag === '1' || flag === 'true') return true;
  if (flag === '0' || flag === 'false') return false;
  return process.env.NODE_ENV !== 'production';
}

/** True only when demo mode is env-enabled AND the user has the cookie set. */
export async function isDemoActive(): Promise<boolean> {
  if (!isDemoModeEnabled()) return false;
  const store = await cookies();
  return store.get(DEMO_COOKIE)?.value === '1';
}

export type DemoProvenance =
  | { active: false }
  | {
      active: true;
      label: 'Sample data';
      teamId: typeof DEMO_TEAM_ID;
      generatedAt: string;
      description: string;
    };

export const DEMO_DATA_GENERATED_AT = process.env.DEMO_DATA_GENERATED_AT ?? new Date().toISOString();
export const DEMO_WRITE_BLOCKED_MESSAGE =
  'Demo mode is read-only. Turn off sample data to change live workspace settings.';

/**
 * Human-facing provenance for demo metrics. Returns active metadata only when
 * demo reads are actually active (env gate + httpOnly cookie), so UI labels do
 * not trust raw browser state.
 */
export async function getDemoProvenance(): Promise<DemoProvenance> {
  if (!(await isDemoActive())) return { active: false };
  return {
    active: true,
    label: 'Sample data',
    teamId: DEMO_TEAM_ID,
    generatedAt: DEMO_DATA_GENERATED_AT,
    description:
      'Showing generated RouteShift demo reads from the seeded demo team only; not live spend, usage, or real activity. Writes and payments remain permission-gated to your workspace.',
  };
}

/**
 * The team id a server read should use: the demo team when demo mode is
 * active, otherwise the caller's real team. Pass the session's real teamId.
 */
export async function getEffectiveTeamId(
  realTeamId: string | null | undefined,
): Promise<string | null> {
  if (await isDemoActive()) return DEMO_TEAM_ID;
  return realTeamId ?? null;
}
