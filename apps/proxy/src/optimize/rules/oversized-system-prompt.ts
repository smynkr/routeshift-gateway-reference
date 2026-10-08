// LAY-328 rule: a system prompt that's a large fraction of every input
// is the exact case prompt caching is built for. We trigger when p95
// system_prompt_tokens > 4000 *and* it's >30% of average input on most
// requests over the lookback window. The fix points the user at provider
// caching APIs (cache_control on Anthropic, prompt_cache_key on OpenAI,
// cachedContents on Google) — same advice the low-cache-hit rule gives,
// but reaches teams that haven't crossed the cache-hit threshold yet
// because their system prompt is so large it dominates every request.

import type { Rule } from '../types.js';

const REQUEST_FLOOR = 100;
const P95_TOKENS_HIGH = 8000;
const P95_TOKENS_MEDIUM = 4000;
const SYSTEM_SHARE_THRESHOLD = 0.30;

export const oversizedSystemPromptRule: Rule = {
  id: 'oversized-system-prompt',
  async detect({ pool, teamId, lookbackDays }) {
    const { rows } = await pool.query<{
      requests: string;
      p95_system_tokens: number | null;
      avg_input_tokens: number | null;
      avg_system_tokens: number | null;
      total_cost_microcents: string;
      provider: string | null;
    }>(
      `
      SELECT
        COUNT(*)::bigint AS requests,
        percentile_disc(0.95) WITHIN GROUP (ORDER BY system_prompt_tokens) AS p95_system_tokens,
        AVG(input_tokens)::float AS avg_input_tokens,
        AVG(system_prompt_tokens)::float AS avg_system_tokens,
        COALESCE(SUM(actual_cost_microcents), 0)::bigint AS total_cost_microcents,
        MODE() WITHIN GROUP (ORDER BY provider) AS provider
      FROM request_logs
      WHERE team_id = $1
        AND timestamp >= NOW() - make_interval(days => $2)
        AND system_prompt_tokens IS NOT NULL
        AND system_prompt_tokens > 0
      `,
      [teamId, lookbackDays],
    );

    const row = rows[0];
    if (!row) return null;

    const requests = Number(row.requests);
    if (requests < REQUEST_FLOOR) return null;

    const p95 = row.p95_system_tokens ?? 0;
    const avgInput = row.avg_input_tokens ?? 0;
    const avgSystem = row.avg_system_tokens ?? 0;
    if (p95 < P95_TOKENS_MEDIUM) return null;

    // System share = fraction of average input that's system prompt. We
    // want both signals: large absolute size AND large share of the
    // payload. A 5k-token system prompt on a 50k-token RAG request isn't
    // the same problem.
    const systemShare = avgInput > 0 ? avgSystem / avgInput : 0;
    if (systemShare < SYSTEM_SHARE_THRESHOLD) return null;

    const severity = p95 >= P95_TOKENS_HIGH ? 'high' : 'medium';

    // Savings model: assume enabling provider prompt caching converts ~80%
    // of system tokens to cache hits, and cached input is ~10x cheaper.
    // Effective saved fraction of system-cost = 0.8 * 0.9 = 0.72. System
    // cost share of total ≈ avgSystem / avgInput. Project to monthly.
    const totalCost = BigInt(row.total_cost_microcents);
    const numerator = BigInt(Math.round(systemShare * 0.72 * 100));
    const monthlyMultiplier = 30n;
    const savings = (totalCost * numerator * monthlyMultiplier) / (100n * BigInt(lookbackDays));

    const provider = row.provider ?? 'anthropic';

    const body =
      `Your system prompt is **${Math.round(p95).toLocaleString()} tokens** at p95 ` +
      `and accounts for **${Math.round(systemShare * 100)}%** of average input ` +
      `over ${requests.toLocaleString()} requests in the last ${lookbackDays} days. ` +
      `Stable system instructions of this size are a textbook prompt-caching candidate — ` +
      `most providers can serve cached system tokens at ~10% of normal input cost.`;

    const fix =
      provider === 'anthropic'
        ? '```json\n' +
          '{\n  "system": [\n    {\n      "type": "text",\n      "text": "<your stable system prompt>",\n      "cache_control": { "type": "ephemeral" }\n    }\n  ]\n}\n' +
          '```\n\nMove your system prompt to a `system` block with `cache_control: { type: "ephemeral" }`. The 5-minute cache TTL covers most conversation patterns; for longer windows pass `cache_control: { type: "ephemeral", ttl: "1h" }` (beta).'
        : provider === 'openai'
          ? "OpenAI auto-caches prompts ≥1024 tokens when you set a stable `prompt_cache_key`. Hash your system prompt (or use a versioned constant) so identical prefixes share the cache."
          : provider === 'google'
            ? "Use Gemini's `cachedContents` API for system instructions ≥4096 tokens. Reference the cache via `cachedContent` on subsequent requests — the system prompt no longer needs to ride on every call."
            : `Check ${provider}'s prompt-caching docs — most providers support some form of prefix caching for stable system instructions.`;

    return {
      rule_id: oversizedSystemPromptRule.id,
      severity,
      estimated_savings_microcents: savings,
      body_md: body,
      fix_md: fix,
    };
  },
};
