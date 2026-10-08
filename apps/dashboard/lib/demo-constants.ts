/**
 * Demo-mode constants with NO runtime dependencies, so they can be imported
 * both by the Next.js runtime (lib/demo.ts) and by the standalone seed script
 * (scripts/seed-demo.ts) run under tsx/node — which must not pull in
 * next/headers.
 *
 * DEMO_TEAM_ID is a stable UUID-looking literal on purpose: all team_id reads
 * use TEXT now, but keeping the seeded demo id unchanged preserves existing
 * demo rows, cookies, health checks, and external sample links.
 */
export const DEMO_TEAM_ID = 'd0000000-0000-4000-8000-000000000001';
export const DEMO_USER_ID = 'd0000000-0000-4000-8000-000000000002';
export const DEMO_USER_EMAIL = 'demo@routeshift.local';
export const DEMO_COOKIE = 'rs_demo';
