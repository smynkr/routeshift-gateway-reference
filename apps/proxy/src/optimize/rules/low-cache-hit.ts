// LAY-315 rule: a high-volume model with <20% cache hit rate is leaving
// money on the table. We bias toward Anthropic in the suggested fix because
// Claude prompt caching is the most common case — but the same pattern
// applies to OpenAI's prompt caching beta and Gemini's implicit caching.

import type { Rule } from '../types.js';

const HIGH_VOLUME_REQUEST_FLOOR = 200;
const CACHE_HIT_THRESHOLD = 0.20;

export const lowCacheHitRule: Rule = {
  id: 'low-cache-hit',
  async detect({ pool, teamId, lookbackDays }) {
    const { rows } = await pool.query<{
      provider: string;
      model: string;
      requests: string;
      hits: string;
      total_cost_microcents: string;
    }>(
      `
      SELECT provider, model_resolved AS model,
             COUNT(*)::bigint AS requests,
             COUNT(*) FILTER (WHERE COALESCE(cache_hit, false))::bigint AS hits,
             COALESCE(SUM(actual_cost_microcents), 0)::bigint AS total_cost_microcents
      FROM request_logs
      WHERE team_id = $1
        AND timestamp >= NOW() - make_interval(days => $2)
      GROUP BY provider, model_resolved
      HAVING COUNT(*) >= $3
      ORDER BY COUNT(*) DESC
      LIMIT 1
      `,
      [teamId, lookbackDays, HIGH_VOLUME_REQUEST_FLOOR],
    );

    const row = rows[0];
    if (!row) return null;

    const requests = Number(row.requests);
    const hits = Number(row.hits);
    const hitRate = requests > 0 ? hits / requests : 0;
    if (hitRate >= CACHE_HIT_THRESHOLD) return null;

    // Conservative savings model: assume enabling cache hits the threshold
    // (20%) on the remaining traffic and that cached input is ~10x cheaper
    // than uncached on Anthropic. So saved = total_cost * 0.20 * 0.9 — same
    // ballpark whether we're on Anthropic or OpenAI.
    const totalCost = BigInt(row.total_cost_microcents);
    const monthlyMultiplier = 30n;
    const savings = (totalCost * 18n * monthlyMultiplier) / (100n * BigInt(lookbackDays));

    const severity = requests >= 1000 ? 'high' : 'medium';
    const provider = row.provider;
    const model = row.model;

    const body =
      `**${model}** has a **${Math.round(hitRate * 100)}%** cache hit rate ` +
      `over the last ${lookbackDays} days (${requests.toLocaleString()} requests). ` +
      `Most providers offer prompt caching that saves ~90% on cached input ` +
      `tokens — at this volume, every percentage point of hit rate matters.`;

    const fix =
      provider === 'anthropic'
        ? '```json\n' +
          '{\n  "system": [\n    {\n      "type": "text",\n      "text": "<your stable system prompt>",\n      "cache_control": { "type": "ephemeral" }\n    }\n  ]\n}\n' +
          '```\n\nAdd `cache_control: { type: "ephemeral" }` to the system block on Anthropic. Cache TTL is 5 minutes — for longer cache windows pass `cache_control: { type: "ephemeral", ttl: "1h" }` (beta).'
        : provider === 'openai'
          ? "OpenAI auto-caches prompts ≥1024 tokens with a `prompt_cache_key` set. Set the key to a stable value (e.g. system-prompt hash) so identical prefixes share the cache."
          : provider === 'google'
            ? "Use Gemini's explicit caching API (`cachedContents`) for stable system instructions ≥4096 tokens. Reference the cache via `cachedContent` on subsequent requests."
            : `Check ${provider}'s prompt-caching docs — most providers support some form of prefix caching.`;

    return {
      rule_id: lowCacheHitRule.id,
      severity,
      estimated_savings_microcents: savings,
      body_md: body,
      fix_md: fix,
    };
  },
};
