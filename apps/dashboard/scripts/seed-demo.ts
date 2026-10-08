/**
 * Seeds the RouteShift demo team with a rich, internally-consistent ~30-day
 * dataset for a TEAM OF 25 users across a spend spectrum (~$100–130k/month
 * list spend), so every dashboard page renders fully populated in demo mode.
 * Idempotent: re-running replaces the demo team's data, never touches any
 * other team.
 *
 * Run:  pnpm seed:demo            (uses DATABASE_URL)
 *       DATABASE_URL=... pnpm seed:demo
 *
 * Toggle it on in the app with the "Sample data" switch (env-gated; see
 * lib/demo.ts).
 */
import pg from 'pg';
import {
  collectDemoProviderKeyProviders,
  generateDemoDataset,
  normalizeDemoSeedProfile,
  type DemoSeedProfile,
} from '../lib/demo-data';
import { DEMO_ROUTING_RULES } from '../lib/demo-rules';
import { buildCacheGuidance } from '../lib/cache-guidance';
import { requireCurrentModel } from '../lib/current-models';
import { DEMO_TEAM_ID, DEMO_USER_ID } from '../lib/demo-constants';

const CURRENT = {
  default: requireCurrentModel('default'),
  economy: requireCurrentModel('economy'),
  coding: requireCurrentModel('coding'),
} as const;

const MICROCENTS_PER_USD = 100_000_000;

// Identifiers are interpolated (not parameterizable in SQL), so restrict them
// to a known set — defense against a future caller passing a dynamic table.
const ALLOWED_TABLES = new Set([
  'users',
  'team_members',
  'api_keys',
  'request_logs',
  'session_metrics',
  'routing_rules',
  'credit_transactions',
  'model_aliases',
  'team_provider_strategies',
  'provider_keys',
  'api_key_audit_events',
  'session_yield',
  'promo_codes',
]);

/** Chunked, fully-parameterized (values) multi-row INSERT. */
async function insertRows(
  client: pg.PoolClient,
  table: string,
  columns: string[],
  rows: Record<string, unknown>[],
  chunkSize = 500,
  onConflict?: string,
): Promise<void> {
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error(`insertRows: refusing to write to disallowed table "${table}"`);
  }
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const values: unknown[] = [];
    const tuples = chunk.map((row, r) => {
      const placeholders = columns.map((_, c) => `$${r * columns.length + c + 1}`);
      for (const col of columns) values.push(row[col]);
      return `(${placeholders.join(', ')})`;
    });
    await client.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}${onConflict ? ` ${onConflict}` : ''}`,
      values,
    );
  }
}

/** Deterministic uuid-shaped string from a label (no crypto needed for demo). */

function readProfileArg(argv: string[]): string | undefined {
  const explicit = argv.find((arg) => arg.startsWith('--profile='));
  if (explicit) return explicit.slice('--profile='.length);
  const idx = argv.indexOf('--profile');
  if (idx < 0) return undefined;
  const next = argv[idx + 1];
  return next && !next.startsWith('--') ? next : undefined;
}

function fauxUuid(prefix: number, n: number): string {
  const a = prefix.toString(16).padStart(8, '0');
  const b = n.toString(16).padStart(12, '0');
  return `${a}-0000-4000-8000-${b}`;
}

async function main(): Promise<void> {
  const connectionString =
    process.env.DATABASE_URL ?? 'postgresql://localhost:5432/prismproxy';
  const pool = new pg.Pool({ connectionString, max: 4 });
  const client = await pool.connect();

  const now = Date.now();
  const profile = normalizeDemoSeedProfile(readProfileArg(process.argv.slice(2)) ?? process.env.DEMO_SEED_PROFILE);
  const ds = generateDemoDataset({ now, days: 30, profile, includePreviousMonth: true });
  console.log(
    `Preparing demo seed profile=${profile} users=${ds.users.length} api_keys=${ds.apiKeys.length} requests=${ds.requestLogs.length.toLocaleString()} sessions=${ds.sessions.length.toLocaleString()}`,
  );

  const nowDate = new Date(now);
  const monthStart = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() + 1, 1));

  try {
    await client.query('BEGIN');

    // Demo team — upserted so re-runs are safe. Plan 'growth' matches the
    // seeded subscription below.
    await client.query(
      `INSERT INTO teams (id, name, plan) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, plan = EXCLUDED.plan`,
      [DEMO_TEAM_ID, 'RouteShift Demo', 'growth'],
    );

    // ── Clear prior demo data (children first), then re-insert. ──
    await client.query('DELETE FROM request_logs WHERE team_id = $1', [DEMO_TEAM_ID]);
    await client.query('DELETE FROM session_yield WHERE team_id = $1', [DEMO_TEAM_ID]);
    await client.query('DELETE FROM session_metrics WHERE team_id = $1', [DEMO_TEAM_ID]);
    await client.query('DELETE FROM api_key_audit_events WHERE team_id = $1', [DEMO_TEAM_ID]);
    await client.query('DELETE FROM api_keys WHERE team_id = $1', [DEMO_TEAM_ID]);
    await client.query('DELETE FROM team_members WHERE team_id = $1', [DEMO_TEAM_ID]);
    await client.query('DELETE FROM routing_rules WHERE team_id = $1', [DEMO_TEAM_ID]);
    await client.query('DELETE FROM optimize_findings WHERE team_id = $1', [DEMO_TEAM_ID]);
    await client.query('DELETE FROM team_budgets WHERE team_id = $1', [DEMO_TEAM_ID]);
    await client.query('DELETE FROM subscriptions WHERE team_id = $1', [DEMO_TEAM_ID]);
    await client.query('DELETE FROM credit_transactions WHERE team_id = $1', [DEMO_TEAM_ID]);
    await client.query('DELETE FROM auto_topup_settings WHERE team_id = $1', [DEMO_TEAM_ID]);
    await client.query('DELETE FROM credit_balances WHERE team_id = $1', [DEMO_TEAM_ID]);
    await client.query('DELETE FROM provider_keys WHERE team_id = $1', [DEMO_TEAM_ID]);
    await client.query('DELETE FROM team_provider_strategies WHERE team_id = $1', [DEMO_TEAM_ID]);
    await client.query('DELETE FROM model_aliases WHERE team_id = $1', [DEMO_TEAM_ID]);
    await client.query('DELETE FROM team_auto_route_settings WHERE team_id = $1', [DEMO_TEAM_ID]);

    // ── Users + memberships (upsert users; some demo emails may already exist). ──
    for (const u of ds.users) {
      await client.query(
        `INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name`,
        [u.id, u.email, u.name, u.password_hash],
      );
    }
    await insertRows(
      client,
      'team_members',
      ['user_id', 'team_id', 'role'],
      ds.teamMembers.map((m) => ({ ...m })),
    );

    // ── Per-user api keys + the rich request/session dataset. ──
    await insertRows(
      client,
      'api_keys',
      ['id', 'team_id', 'key_hash', 'key_prefix', 'name', 'environment', 'created_at', 'last_used'],
      ds.apiKeys.map((k) => ({ ...k })),
    );

    await insertRows(
      client,
      'request_logs',
      [
        'id', 'timestamp', 'team_id', 'provider', 'model_requested', 'model_resolved',
        'input_tokens', 'output_tokens', 'total_tokens', 'system_prompt_tokens',
        'original_cost_microcents', 'actual_cost_microcents', 'savings_microcents',
        'total_latency_ms', 'ttft_ms', 'is_streaming', 'is_fallback', 'status_code',
        'error_type', 'cache_hit', 'rate_limited',
        'activity_category', 'session_id', 'api_key_id', 'message_hash', 'edited_paths', 'had_bash',
        'fallback_attempts',
      ],
      ds.requestLogs.map((r) => ({ ...r, fallback_attempts: JSON.stringify(r.fallback_attempts ?? []) })),
    );

    await insertRows(
      client,
      'session_metrics',
      [
        'session_id', 'team_id', 'edit_turns', 'retry_turns', 'one_shot_rate',
        'primary_model', 'total_cost_microcents', 'billed_cost_microcents',
        'first_request_at', 'last_request_at',
      ],
      ds.sessions.map((s) => ({ ...s })),
    );

    // ── Routing rules: the headline savings rule + supporting policy. ──
    // Fixtures live in lib/demo-rules.ts so tests can validate the real shapes.
    await insertRows(
      client,
      'routing_rules',
      ['id', 'team_id', 'name', 'description', 'priority', 'enabled', 'condition', 'action'],
      DEMO_ROUTING_RULES.map((rule) => ({
        ...rule,
        team_id: DEMO_TEAM_ID,
        condition: JSON.stringify(rule.condition),
        action: JSON.stringify(rule.action),
      })),
    );

    // ── Budget: ~$130k monthly cap (the team's gross list spend), alert at 80%. ──
    await client.query(
      `INSERT INTO team_budgets (team_id, monthly_usd_cap, alert_at_pct, hard_cap_action)
       VALUES ($1, $2, $3, $4)`,
      [DEMO_TEAM_ID, 130_000, 80, 'alert'],
    );

    // ── Subscription: growth plan, active, current calendar period. ──
    await client.query(
      `INSERT INTO subscriptions
         (id, team_id, stripe_customer_id, plan, status, current_period_start, current_period_end)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        'sub_demo',
        DEMO_TEAM_ID,
        'cus_demo_routeshift',
        'growth',
        'active',
        monthStart,
        periodEnd,
      ],
    );

    // ── Credits: balance + a dozen transactions + auto-topup config. ──
    await client.query(
      `INSERT INTO credit_balances (team_id, balance_microcents, overdraft_limit_microcents)
       VALUES ($1, $2, $3)`,
      [DEMO_TEAM_ID, 42_500 * MICROCENTS_PER_USD, -500_000_000],
    );

    // Build a plausible running balance: monthly $50k purchases minus deductions.
    const creditTx: Record<string, unknown>[] = [];
    let bal = 0;
    const dayMs = 24 * 60 * 60 * 1000;
    for (let i = 0; i < 12; i++) {
      const createdAt = new Date(now - (12 - i) * 2 * dayMs);
      // Alternate purchases and deductions; one auto_topup near the end.
      const isPurchase = i % 3 !== 2;
      const isAutoTopup = i === 10;
      const amount = isPurchase
        ? (isAutoTopup ? 25_000 : 50_000) * MICROCENTS_PER_USD
        : -(8_000 + i * 250) * MICROCENTS_PER_USD;
      bal += amount;
      creditTx.push({
        id: `ctx_demo_${i}`,
        team_id: DEMO_TEAM_ID,
        amount_microcents: amount,
        type: isAutoTopup ? 'auto_topup' : isPurchase ? 'purchase' : 'deduction',
        reference_id: isPurchase ? `pi_demo_${i}` : `usage_demo_${i}`,
        description: isAutoTopup
          ? 'Automatic top-up (balance below threshold)'
          : isPurchase
            ? 'Credit purchase'
            : 'Usage deduction (rolling)',
        balance_after_microcents: bal,
        created_at: createdAt,
      });
    }
    await insertRows(
      client,
      'credit_transactions',
      [
        'id', 'team_id', 'amount_microcents', 'type', 'reference_id', 'description',
        'balance_after_microcents', 'created_at',
      ],
      creditTx,
    );

    await client.query(
      `INSERT INTO auto_topup_settings
         (team_id, enabled, threshold_microcents, reload_amount_cents, last_topup_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        DEMO_TEAM_ID,
        true,
        20_000 * MICROCENTS_PER_USD,
        25_000 * 100, // reload_amount_cents
        new Date(now - 2 * dayMs),
      ],
    );

    // ── Provider keys (BYOK) + per-provider selection strategy. ──
    const providerKeyRows = collectDemoProviderKeyProviders(ds, DEMO_ROUTING_RULES)
      .flatMap((provider) => {
        const primary = {
          id: `pk_demo_${provider}`,
          team_id: DEMO_TEAM_ID,
          provider,
          encrypted_key: `demo-encrypted-${provider}`,
          label: provider === 'anthropic' ? 'primary' : 'default',
          weight: provider === 'anthropic' ? 3 : 1,
          enabled: true,
        };
        return provider === 'anthropic'
          ? [
              primary,
              {
                ...primary,
                id: 'pk_demo_anthropic_secondary',
                encrypted_key: 'demo-encrypted-anthropic-secondary',
                label: 'secondary',
                weight: 1,
              },
            ]
          : [primary];
      });

    await insertRows(
      client,
      'provider_keys',
      ['id', 'team_id', 'provider', 'encrypted_key', 'label', 'weight', 'enabled'],
      providerKeyRows,
    );
    await insertRows(
      client,
      'team_provider_strategies',
      ['team_id', 'provider', 'strategy'],
      [
        { team_id: DEMO_TEAM_ID, provider: 'anthropic', strategy: 'weighted_round_robin' },
        { team_id: DEMO_TEAM_ID, provider: 'openai', strategy: 'latency_based' },
      ],
    );

    // ── Model aliases (deployment names → current canonical models). ──
    await insertRows(
      client,
      'model_aliases',
      ['team_id', 'alias', 'canonical_name', 'notes'],
      [
        { team_id: DEMO_TEAM_ID, alias: 'prod-default', canonical_name: CURRENT.default.canonical_name, notes: `${CURRENT.default.provider} production deployment` },
        { team_id: DEMO_TEAM_ID, alias: 'prod-coding', canonical_name: CURRENT.coding.canonical_name, notes: `${CURRENT.coding.provider} coding deployment` },
        { team_id: DEMO_TEAM_ID, alias: 'cheap-default', canonical_name: CURRENT.economy.canonical_name, notes: 'Default for low-stakes jobs' },
      ],
    );

    // ── Auto-route enabled (balanced). ──
    await client.query(
      `INSERT INTO team_auto_route_settings (team_id, enabled, strategy, max_fallbacks)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (team_id) DO UPDATE SET enabled = EXCLUDED.enabled, strategy = EXCLUDED.strategy`,
      [DEMO_TEAM_ID, true, 'balanced', 2],
    );

    // ── API key lifecycle audit events. api_key_id is uuid-typed and our demo
    //    key ids are text, so we correlate via key_prefix and leave api_key_id
    //    NULL (the schema explicitly allows this). ──
    const ownerKey = ds.apiKeys.find((k) => k.id === 'key_demo_u0_prod') ?? ds.apiKeys[0]!;
    const auditEvents = [
      { type: 'created', prefix: ownerKey.key_prefix, off: 28, details: {} },
      { type: 'created', prefix: ds.apiKeys[1]?.key_prefix ?? ownerKey.key_prefix, off: 27, details: {} },
      { type: 'auth_failed', prefix: 'rs_live_leaked9999', off: 6, details: { ip: '203.0.113.9', attempts: 14 } },
      { type: 'rate_limited', prefix: ownerKey.key_prefix, off: 3, details: { window: '1m', limit: 600 } },
      { type: 'budget_exceeded', prefix: ds.apiKeys[2]?.key_prefix ?? ownerKey.key_prefix, off: 2, details: { cap_usd: 50 } },
      { type: 'revoked', prefix: 'rs_test_old1234', off: 1, details: { reason: 'rotation' } },
    ].map((e, i) => ({
      id: fauxUuid(0xa0d17, i),
      team_id: DEMO_TEAM_ID,
      api_key_id: null,
      key_prefix: e.prefix,
      event_type: e.type,
      actor_user_id: DEMO_USER_ID,
      details: JSON.stringify(e.details),
      created_at: new Date(now - e.off * dayMs),
    }));
    await insertRows(
      client,
      'api_key_audit_events',
      ['id', 'team_id', 'api_key_id', 'key_prefix', 'event_type', 'actor_user_id', 'details', 'created_at'],
      auditEvents,
    );

    // ── Session yield: label a sample of seeded sessions (joins session_metrics). ──
    const labels = ['productive', 'reverted', 'abandoned'] as const;
    const sampleSessions = ds.sessions.filter((_, i) => i % 25 === 0).slice(0, 200);
    const yieldRows = sampleSessions.map((s, i) => {
      const label = labels[i % 3]!;
      const endedAt = s.last_request_at;
      return {
        session_id: s.session_id,
        team_id: DEMO_TEAM_ID,
        label,
        matched_commit_sha: label === 'productive' ? `demo${i.toString(16).padStart(8, '0')}` : null,
        matched_commit_repo: label === 'productive' ? 'routeshift/app' : null,
        matched_commit_at: label === 'productive' ? endedAt : null,
        reverted_at: label === 'reverted' ? new Date(endedAt.getTime() + 3600_000) : null,
        session_ended_at: endedAt,
      };
    });
    await insertRows(
      client,
      'session_yield',
      [
        'session_id', 'team_id', 'label', 'matched_commit_sha', 'matched_commit_repo',
        'matched_commit_at', 'reverted_at', 'session_ended_at',
      ],
      yieldRows,
    );

    // ── Promo codes. ──
    await insertRows(
      client,
      'promo_codes',
      ['id', 'code', 'plan', 'credits_cents', 'max_uses', 'uses_count', 'expires_at'],
      [
        { id: 'promo_demo_launch', code: 'LAUNCH50', plan: 'growth', credits_cents: 5_000_00, max_uses: 100, uses_count: 12, expires_at: periodEnd },
        { id: 'promo_demo_partner', code: 'PARTNER', plan: 'scale', credits_cents: 10_000_00, max_uses: 10, uses_count: 3, expires_at: null },
      ],
      500,
      `ON CONFLICT (id) DO UPDATE SET
        code = EXCLUDED.code,
        plan = EXCLUDED.plan,
        credits_cents = EXCLUDED.credits_cents,
        max_uses = EXCLUDED.max_uses,
        uses_count = EXCLUDED.uses_count,
        expires_at = EXCLUDED.expires_at`,
    );

    // ── Optimize findings: real rule_ids + body/fix FORMAT matching
    //    apps/proxy/src/optimize/rules/*.ts, referencing seeded models. ──
    const findings = buildOptimizeFindings(now, profile);
    for (const f of findings) {
      await client.query(
        `INSERT INTO optimize_findings
           (team_id, rule_id, severity, estimated_savings_microcents, body_md, fix_md, status, first_seen_at, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8)
         ON CONFLICT (team_id, rule_id) DO UPDATE SET
           severity = EXCLUDED.severity,
           estimated_savings_microcents = EXCLUDED.estimated_savings_microcents,
           body_md = EXCLUDED.body_md,
           fix_md = EXCLUDED.fix_md,
           status = 'open',
           last_seen_at = EXCLUDED.last_seen_at`,
        [
          DEMO_TEAM_ID,
          f.rule_id,
          f.severity,
          f.estimated_savings_microcents,
          f.body_md,
          f.fix_md,
          new Date(now - 14 * dayMs),
          new Date(now - f.lastSeenOffHours * 60 * 60 * 1000),
        ],
      );
    }

    await client.query('COMMIT');

    // ── Summary: per-tier user counts + spend / savings. ──
    const usd = (n: number) => n / MICROCENTS_PER_USD;
    const perUserSpend = new Map<string, number>();
    for (const r of ds.requestLogs) {
      const u = r.api_key_id.split('_').slice(0, 3).join('_'); // key_demo_u{idx}
      perUserSpend.set(u, (perUserSpend.get(u) ?? 0) + r.actual_cost_microcents);
    }
    let heavy = 0;
    let moderate = 0;
    let light = 0;
    for (const cents of perUserSpend.values()) {
      const dollars = usd(cents);
      if (dollars >= 4_000) heavy++;
      else if (dollars >= 800) moderate++;
      else light++;
    }
    const originalUsd = usd(ds.requestLogs.reduce((s, r) => s + r.original_cost_microcents, 0));
    const actualUsd = usd(ds.requestLogs.reduce((s, r) => s + r.actual_cost_microcents, 0));
    const savingsUsd = usd(ds.requestLogs.reduce((s, r) => s + r.savings_microcents, 0));

    console.log(
      [
        `Demo data seeded (profile: ${profile}):`,
        `  team:      ${DEMO_TEAM_ID} (RouteShift Demo)`,
        `  users:     ${ds.users.length}  (heavy ${heavy} / moderate ${moderate} / light ${light})`,
        `  api keys:  ${ds.apiKeys.length}`,
        `  requests:  ${ds.requestLogs.length.toLocaleString()}`,
        `  sessions:  ${ds.sessions.length.toLocaleString()}`,
        `  list spend (pre-routing): $${originalUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
        `  actual spend (post-routing): $${actualUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
        `  savings:   $${savingsUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
        `  findings:  ${findings.length} open`,
        '',
        'Toggle "Sample data" in the dashboard to view it (no logout needed).',
      ].join('\n'),
    );
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

interface DemoFinding {
  rule_id: string;
  severity: 'high' | 'medium';
  estimated_savings_microcents: number;
  body_md: string;
  fix_md: string;
  lastSeenOffHours: number;
}

/**
 * 4–5 OPEN findings using the REAL rule_ids and body_md/fix_md FORMAT from
 * apps/proxy/src/optimize/rules/*.ts, referencing the seeded current roles.
 * Savings reflect the premium-role overspend (the wrong-model finding is the
 * headline: a high-severity overspend routed away from the premium role).
 */
function findingScaleForProfile(profile: DemoSeedProfile): number {
  if (profile === 'small') return 0.12;
  if (profile === 'standard') return 0.45;
  return 1;
}

function scaledCount(base: number, scale: number): string {
  return Math.max(1, Math.round(base * scale)).toLocaleString();
}

function buildOptimizeFindings(now: number, profile: DemoSeedProfile): DemoFinding[] {
  const scale = findingScaleForProfile(profile);
  const premiumModel = CURRENT.default;
  const codingModel = CURRENT.coding;
  const economyModel = CURRENT.economy;
  const usdToMicro = (n: number) => Math.round(n * scale * MICROCENTS_PER_USD);
  const premiumRequests = scaledCount(5_200, scale);
  const systemPromptRequests = scaledCount(18_200, scale);
  const cacheRequests = scaledCount(11_400, scale);
  const duplicateRequests = scaledCount(240, scale);
  const flakyRequests = scaledCount(14_800, scale);
  const cacheGuidance = buildCacheGuidance(codingModel.provider, codingModel.canonical_name, cacheRequests);
  return [
    {
      rule_id: 'wrong-model-for-category',
      severity: 'high',
      // The headline: the premium role on coding is a false economy versus the coding role.
      estimated_savings_microcents: usdToMicro(4_500),
      body_md:
        '78% of your coding traffic over the last 30 days is on a premium model ' +
        `(${premiumModel.canonical_name}, ${premiumRequests} requests). Coding is the workload where retry cycles cost ` +
        'the most — one-shot rate is what dominates total spend, not per-call price, and ' +
        `${premiumModel.canonical_name} is the premium role versus ${codingModel.canonical_name} with no measurable edge here.`,
      fix_md:
        '1. Open `/analytics` and check the "One-shot rate by model" table.\n' +
        `2. If your ${premiumModel.canonical_name} one-shot rate matches ${codingModel.canonical_name}, add a routing rule:\n` +
        '```\nWhen activity = "coding"\nUse ' +
        `${codingModel.canonical_name} (or ${economyModel.canonical_name})\n\`\`\`\n` +
        `3. Keep ${premiumModel.canonical_name} as a fallback for non-coding categories.`,
      lastSeenOffHours: 5,
    },
    {
      rule_id: 'oversized-system-prompt',
      severity: 'high',
      estimated_savings_microcents: usdToMicro(2_200),
      body_md:
        'Your system prompt is **9,400 tokens** at p95 and accounts for **41%** of average ' +
        `input over ${systemPromptRequests} requests in the last 30 days. Stable system instructions of this ` +
        'size are a textbook prompt-caching candidate — most providers can serve cached ' +
        'system tokens at ~10% of normal input cost.',
      fix_md:
        `The selected ${codingModel.provider} cache guidance for ${codingModel.canonical_name}: ${cacheGuidance.fix}\n` +
        'Apply it to the stable system instructions before comparing cache-hit rates.',
      lastSeenOffHours: 9,
    },
    {
      rule_id: 'low-cache-hit',
      severity: 'medium',
      estimated_savings_microcents: usdToMicro(1_300),
      body_md: cacheGuidance.body,
      fix_md: cacheGuidance.fix,
      lastSeenOffHours: 14,
    },
    {
      rule_id: 'duplicate-requests',
      severity: 'medium',
      estimated_savings_microcents: usdToMicro(620),
      body_md:
        `One request shape was sent **${duplicateRequests} times** in the last 24 hours with no response-cache ` +
        'hits. At ~$0.0180 per request, that\'s wasted spend on identical work. Enabling ' +
        'response caching for this team would short-circuit duplicates after the first request.',
      fix_md:
        'Enable response caching in **/settings → Response Cache**. RouteShift hashes ' +
        '(messages, system, tools) and returns the cached response for identical follow-ups ' +
        'within the configured TTL — no upstream call, no cost.\n\n' +
        'If duplicates are coming from upstream-agent retries, check the agent\'s retry config ' +
        'first — caching masks the retry but doesn\'t fix the underlying loop.',
      lastSeenOffHours: 2,
    },
    {
      rule_id: 'always-failing-primary',
      severity: 'medium',
      estimated_savings_microcents: usdToMicro(340),
      body_md:
        `**${CURRENT.default.provider}** returned 5xx on **6.4%** of ${flakyRequests} requests over the last 30 days. ` +
        "That's above the 5% threshold where retries start to dominate user-visible latency.",
      fix_md:
        '1. Open `/routing` and check the rule that targets ' +
        `**${CURRENT.default.provider}** as primary.\n` +
        '2. Promote your secondary provider above it, keeping the flaky one as a fallback.\n' +
        '3. If multiple keys to the same provider exist, weighted load-balancing (LAY-319) routes traffic away from a degraded key automatically.',
      lastSeenOffHours: 7,
    },
  ];
}
main().catch((err) => {
  console.error('Demo seed failed:', err);
  process.exit(1);
});
