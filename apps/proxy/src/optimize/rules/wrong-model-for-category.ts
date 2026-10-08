// LAY-315 rule: coding workloads on the smallest tier are usually a
// false economy — one-shot rate cratering means the team pays for retries.
// Trigger when activity_category='coding' AND >70% of traffic is on a
// known-small model. Soft dep on LAY-310 (activity_category column).

import type { Rule } from '../types.js';

const CODING_SMALL_MODEL_NAMES = new Set([
  'gpt-4.1-nano',
  'gpt-4.1-mini',
  'claude-haiku-4-5',
  'gemini-2.5-flash',
  'glm-4.5-air',
]);

const CATEGORY_FLOOR = 100;
const SMALL_MODEL_FRACTION = 0.70;

export const wrongModelForCategoryRule: Rule = {
  id: 'wrong-model-for-category',
  async detect({ pool, teamId, lookbackDays }) {
    const { rows } = await pool.query<{
      total: string;
      small: string;
      total_cost_microcents: string;
    }>(
      `
      SELECT
        COUNT(*)::bigint AS total,
        COUNT(*) FILTER (WHERE model_resolved = ANY($3::text[]))::bigint AS small,
        COALESCE(SUM(actual_cost_microcents), 0)::bigint AS total_cost_microcents
      FROM request_logs
      WHERE team_id = $1
        AND activity_category = 'coding'
        AND timestamp >= NOW() - make_interval(days => $2)
      `,
      [teamId, lookbackDays, Array.from(CODING_SMALL_MODEL_NAMES)],
    );

    const row = rows[0];
    if (!row) return null;

    const total = Number(row.total);
    const small = Number(row.small);
    if (total < CATEGORY_FLOOR) return null;

    const fraction = total > 0 ? small / total : 0;
    if (fraction < SMALL_MODEL_FRACTION) return null;

    // Conservative: if half the small-model coding traffic should have used
    // a frontier model, the *retry savings* alone outweigh the price delta.
    // Estimate: retry cycle costs 1.5x base call; cutting retry rate from
    // (assumed) 40% to 15% on half of small-model traffic = 12.5% savings.
    const totalCost = BigInt(row.total_cost_microcents);
    const monthlyMultiplier = 30n;
    const savings = (totalCost * 125n * monthlyMultiplier) / (1000n * BigInt(lookbackDays));

    return {
      rule_id: wrongModelForCategoryRule.id,
      severity: total >= 500 ? 'high' : 'medium',
      estimated_savings_microcents: savings,
      body_md:
        `${Math.round(fraction * 100)}% of your coding traffic over the last ` +
        `${lookbackDays} days is on a small/fast model (${total.toLocaleString()} ` +
        `requests). Coding is the workload where retry cycles cost the most — ` +
        `one-shot rate is what dominates total spend, not per-call price.`,
      fix_md:
        '1. Open `/analytics` and check the "One-shot rate by model" table.\n' +
        '2. If your small-model one-shot rate is < 70%, add a routing rule:\n' +
        '```\nWhen activity = "coding"\nUse claude-sonnet-4-6 (or gpt-5)\n```\n' +
        '3. Keep the small model as a fallback for non-coding categories.',
    };
  },
};
