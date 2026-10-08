// LAY-315 rule: a provider returning 5xx > 5% of the time over the lookback
// window is a primary that should be demoted. We surface the worst offender,
// not all of them — the action is "promote a different provider", not
// "fix every flaky upstream".

import type { Rule } from '../types.js';

const REQUEST_FLOOR = 100;
const ERROR_RATE_THRESHOLD = 0.05;

export const alwaysFailingPrimaryRule: Rule = {
  id: 'always-failing-primary',
  async detect({ pool, teamId, lookbackDays }) {
    const { rows } = await pool.query<{
      provider: string;
      requests: string;
      errors: string;
      total_cost_microcents: string;
    }>(
      `
      SELECT provider,
             COUNT(*)::bigint AS requests,
             COUNT(*) FILTER (WHERE status_code >= 500)::bigint AS errors,
             COALESCE(SUM(actual_cost_microcents), 0)::bigint AS total_cost_microcents
      FROM request_logs
      WHERE team_id = $1
        AND timestamp >= NOW() - make_interval(days => $2)
      GROUP BY provider
      HAVING COUNT(*) >= $3
      ORDER BY (COUNT(*) FILTER (WHERE status_code >= 500))::numeric / NULLIF(COUNT(*), 0) DESC
      LIMIT 1
      `,
      [teamId, lookbackDays, REQUEST_FLOOR],
    );

    const row = rows[0];
    if (!row) return null;

    const requests = Number(row.requests);
    const errors = Number(row.errors);
    const errorRate = requests > 0 ? errors / requests : 0;
    if (errorRate < ERROR_RATE_THRESHOLD) return null;

    // Estimated waste: each failed request still consumes input tokens.
    // Approximate cost-of-failure as average cost * error count.
    const totalCost = BigInt(row.total_cost_microcents);
    const avgCost = requests > 0 ? totalCost / BigInt(requests) : 0n;
    const monthlyMultiplier = 30n;
    const savings =
      (avgCost * BigInt(errors) * monthlyMultiplier) / BigInt(Math.max(1, lookbackDays));

    return {
      rule_id: alwaysFailingPrimaryRule.id,
      severity: errorRate >= 0.15 ? 'high' : 'medium',
      estimated_savings_microcents: savings,
      body_md:
        `**${row.provider}** returned 5xx on **${(errorRate * 100).toFixed(1)}%** of ` +
        `${requests.toLocaleString()} requests over the last ${lookbackDays} days. ` +
        `That's above the 5% threshold where retries start to dominate user-visible latency.`,
      fix_md:
        `1. Open \`/routing\` and check the rule that targets \`${row.provider}\` as primary.\n` +
        '2. Promote your secondary provider above it, keeping the flaky one as a fallback.\n' +
        '3. If multiple keys to the same provider exist, weighted load-balancing (LAY-319) routes traffic away from a degraded key automatically.',
    };
  },
};
