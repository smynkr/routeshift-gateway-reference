/**
 * RSH-157 — Plugins dashboard surface: shared types + constants for the
 * per-plugin usage/cost analytics read from Postgres `plugin_runs`
 * (migration apps/proxy/src/db/migrations/047-track-d-plugin-billing.sql).
 *
 * Money invariant: every cost leaves the API route as INTEGER microcents
 * (1 USD = 100_000_000 microcents); the server never float-divides. Display
 * formatting happens client-side via the re-exported exact-BigInt helper.
 */

export { formatMicrocentsAsUsd } from './shadow-experiments';

/**
 * The plugin ids the proxy records today (apps/proxy/src/plugins/specs.ts:
 * `PluginId = 'web' | 'file-parser'`). The usage route returns one by_plugin
 * row per id — zero-filled when a plugin has no runs in the period — and then
 * UNIONS any additional ids actually recorded in plugin_runs, because
 * migration 047 puts no CHECK constraint on plugin_id: without the union, a
 * new proxy plugin would inflate summary totals while vanishing from the
 * per-plugin breakdown.
 */
export const PLUGIN_IDS = ['web', 'file-parser'] as const;
export type PluginId = (typeof PLUGIN_IDS)[number];

/** plugin_runs.status CHECK constraint values. */
export type PluginRunStatus = 'ok' | 'warning' | 'error' | 'skipped';

/**
 * Whitelisted analytics periods -> lookback hours. The route maps the raw
 * `period` query param through this table and never interpolates it into SQL;
 * anything else falls back to DEFAULT_PLUGINS_PERIOD.
 */
export const PERIOD_HOURS = { '24h': 24, '7d': 168, '30d': 720 } as const;
export type PluginsUsagePeriod = keyof typeof PERIOD_HOURS;
export const DEFAULT_PLUGINS_PERIOD: PluginsUsagePeriod = '7d';

export function isPluginsUsagePeriod(value: string): value is PluginsUsagePeriod {
  return value === '24h' || value === '7d' || value === '30d';
}

/**
 * One per-plugin rollup row. plugin_id is an unconstrained string (see
 * PLUGIN_IDS): known ids come first in PLUGIN_IDS order, then any additional
 * recorded ids in alphabetical order.
 */
export interface PluginUsageByPlugin {
  plugin_id: string;
  runs: number;
  ok: number;
  warning: number;
  error: number;
  skipped: number;
  cost_microcents: number;
}

/**
 * A recent non-ok plugin run (warning/error/skipped), newest first.
 * The feed is deliberately all-time — it is NOT filtered by the selected
 * period (triage wants the latest failures regardless of the lookback the
 * totals use). The UI must label it accordingly.
 */
export interface PluginRecentWarning {
  plugin_id: string;
  status: Exclude<PluginRunStatus, 'ok'>;
  detail: string | null;
  cost_microcents: number;
  latency_ms: number;
  created_at: string;
}

/**
 * Response envelope for GET /api/plugins/usage. Change only in lockstep with
 * the Plugins UI. No timeseries field: no surface renders one, and a dead
 * date_trunc rollup would inherit the DB session's time zone into its bucket
 * boundaries with nothing exercising it.
 */
export interface PluginsUsageEnvelope {
  period: PluginsUsagePeriod;
  summary: {
    total_plugin_cost_microcents: number;
    total_runs: number;
    requests_with_plugins: number;
    by_plugin: PluginUsageByPlugin[];
  };
  recent_warnings: PluginRecentWarning[];
}
