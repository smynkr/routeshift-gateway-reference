// LAY-328 rule: a single (messages, system, tools) shape recurring 50+
// times in 24h is almost always a missed response-cache opportunity —
// the same exact request being re-sent because the caller didn't memoize
// or because retries from the upstream agent aren't deduped. We flag the
// highest-volume duplicate and point the user at the response-cache
// settings page.

import type { Rule } from '../types.js';

// 1 USD = 100,000,000 microcents (canonical; see packages/shared/src/constants.ts
// and the billing guards). Declared locally to match the proxy's convention.
const MICROCENTS_TO_USD = 100_000_000;

const DUP_FLOOR = 50;
const DUP_HIGH = 200;
const LOOKBACK_HOURS = 24;

export const duplicateRequestsRule: Rule = {
  id: 'duplicate-requests',
  async detect({ pool, teamId }) {
    // Group by message_hash within the recent window. We use 24h here
    // (overriding the engine's 7-day default) because cache opportunities
    // are about *recent* duplicates, not week-old ones — a hash that
    // recurred in March doesn't tell us anything actionable about today.
    const { rows } = await pool.query<{
      message_hash: string;
      dup_count: string;
      avg_cost_microcents: string;
      total_cost_microcents: string;
    }>(
      `
      SELECT
        message_hash,
        COUNT(*)::bigint AS dup_count,
        COALESCE(AVG(actual_cost_microcents), 0)::bigint AS avg_cost_microcents,
        COALESCE(SUM(actual_cost_microcents), 0)::bigint AS total_cost_microcents
      FROM request_logs
      WHERE team_id = $1
        AND timestamp >= NOW() - make_interval(hours => $2)
        AND message_hash IS NOT NULL
        AND COALESCE(cache_hit, false) = false
      GROUP BY message_hash
      HAVING COUNT(*) >= $3
      ORDER BY COUNT(*) DESC
      LIMIT 1
      `,
      [teamId, LOOKBACK_HOURS, DUP_FLOOR],
    );

    const row = rows[0];
    if (!row) return null;

    const dupCount = Number(row.dup_count);
    const avgCost = BigInt(row.avg_cost_microcents);

    const severity = dupCount > DUP_HIGH ? 'high' : 'medium';

    // Savings: we save ~all the cost on every duplicate after the first
    // (cached responses cost effectively 0). Project the 24-hour rate to
    // a 30-day month: dupCount * 30 days. The first hit per window still
    // costs full price, but it's negligible at this volume.
    const monthlyMultiplier = 30n;
    const savings = avgCost * BigInt(Math.max(0, dupCount - 1)) * monthlyMultiplier;

    const body =
      `One request shape was sent **${dupCount.toLocaleString()} times** in the last ` +
      `${LOOKBACK_HOURS} hours with no response-cache hits. At ~$${(Number(avgCost) / MICROCENTS_TO_USD).toFixed(6)} ` +
      `per request, that's wasted spend on identical work. Enabling response caching for this team ` +
      `would short-circuit duplicates after the first request.`;

    const fix =
      'Enable response caching in **/settings → Response Cache**. RouteShift hashes ' +
      '(messages, system, tools) and returns the cached response for identical follow-ups ' +
      'within the configured TTL — no upstream call, no cost.\n\n' +
      'If duplicates are coming from upstream-agent retries, check the agent\'s retry config ' +
      'first — caching masks the retry but doesn\'t fix the underlying loop.';

    return {
      rule_id: duplicateRequestsRule.id,
      severity,
      estimated_savings_microcents: savings,
      body_md: body,
      fix_md: fix,
    };
  },
};
