// LAY-333: per-key spend breakdown for /billing.
//
// Aggregates request_logs by api_key_id over a time window, joining
// api_keys for the prefix/name/metadata. Cache hits are excluded — they
// don't represent upstream cost incurred by the key. Sorted by
// total cost descending so the noisiest keys surface first.
//
// Query params:
//   period: 24h | 7d | 30d | mtd (default mtd — match the rest of /billing)
//
// Returns:
//   period
//   rows: { api_key_id, prefix, name, metadata, requests, input_tokens,
//           output_tokens, cost_microcents }[]
//   total_cost_microcents — billed spend (routing actual cost plus plugin
//                            charges) across rows, useful as a sanity tally
//                            against /billing's headline number.

import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { getEffectiveTeamId } from '@/lib/demo';
import { requireTeamMembership } from '@/lib/rbac';
import { buildBudgetReport, getBudgetWindows, parseUsdCap, type BudgetWindowKind } from '@routeshift/shared';

function periodClause(period: string): { sql: string; param?: number } {
  if (period === '24h') return { sql: 'timestamp >= NOW() - make_interval(hours => $2)', param: 24 };
  if (period === '7d') return { sql: 'timestamp >= NOW() - make_interval(hours => $2)', param: 168 };
  if (period === '30d') return { sql: 'timestamp >= NOW() - make_interval(hours => $2)', param: 720 };
  // 'mtd' (month to date) is the default — matches what the headline /billing uses.
  return { sql: "timestamp >= date_trunc('month', NOW())" };
}

export async function GET(request: Request) {
  try {
    const member = await requireTeamMembership();
    if (!member) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const teamId = await getEffectiveTeamId(member.teamId);
    if (!teamId) {
      return NextResponse.json({ error: 'No team context' }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const period = searchParams.get('period') ?? 'mtd';
    const clause = periodClause(period);

    const pool = getPool();
    const params: unknown[] = [teamId];
    if (clause.param !== undefined) params.push(clause.param);

    const { rows } = await pool.query(
      `
      SELECT
        rl.api_key_id,
        ak.key_prefix,
        ak.name,
        ak.metadata,
        COUNT(*)::int AS requests,
        COALESCE(SUM(rl.input_tokens), 0)::bigint AS input_tokens,
        COALESCE(SUM(rl.output_tokens), 0)::bigint AS output_tokens,
        -- Billing attribution is customer spend, not routing-only cost.
        -- Keep routing actual/savings metrics in their dedicated surfaces.
        COALESCE(SUM(rl.actual_cost_microcents + COALESCE(rl.plugin_cost_microcents, 0)), 0)::bigint AS cost_microcents,
        COUNT(*) FILTER (WHERE rl.actual_cost_known = false)::int AS unknown_cost_requests
      FROM request_logs rl
      LEFT JOIN api_keys ak ON ak.id = rl.api_key_id
      WHERE rl.team_id = $1
        AND ${clause.sql}
        AND COALESCE(rl.cache_hit, false) = false
        AND rl.api_key_id IS NOT NULL
      GROUP BY rl.api_key_id, ak.key_prefix, ak.name, ak.metadata
      ORDER BY cost_microcents DESC
      `,
      params,
    );

    const result = rows.map((r) => ({
      api_key_id: r.api_key_id as string,
      prefix: (r.key_prefix as string | null) ?? null,
      name: (r.name as string | null) ?? '(deleted)',
      metadata: (r.metadata as Record<string, unknown> | null) ?? {},
      requests: Number(r.requests),
      input_tokens: Number(r.input_tokens),
      output_tokens: Number(r.output_tokens),
      cost_microcents: Number(r.cost_microcents),
      unknown_cost_requests: Number(r.unknown_cost_requests ?? 0),
      actual_costs_qualified: Number(r.unknown_cost_requests ?? 0) === 0,
    }));

    // RSH-138: attach current daily/weekly/monthly window status per key.
    // All arithmetic/delegation goes through the shared buildBudgetReport;
    // unknown spend is surfaced as a lower bound, never merged as exact.
    const windows = getBudgetWindows(new Date());
    const [{ rows: capRows }, { rows: keyPeriodRows }, { rows: unboundedRows }, { rows: teamUnboundedRows }, { rows: teamBudgetRows },
           { rows: identityCapRows }, { rows: identityPeriodRows }, { rows: identityUnboundedRows }] = await Promise.all([
      pool.query<{ id: string; daily_usd_cap: string | null; weekly_usd_cap: string | null; monthly_usd_cap: string | null; cap_action: string; soft_alert_at_pct: number | null }>(
        `SELECT id, daily_usd_cap, weekly_usd_cap, monthly_usd_cap, cap_action, soft_alert_at_pct
         FROM api_keys WHERE team_id = $1 AND revoked_at IS NULL`,
        [teamId],
      ),
      pool.query<{
        api_key_id: string;
        window_kind: BudgetWindowKind;
        period_start: Date;
        period_end: Date;
        actual_microcents: string;
        reserved_microcents: string;
        unknown_held_microcents: string;
        unknown_cost_requests: string;
      }>(
        `SELECT api_key_id, window_kind, period_start, period_end,
                actual_microcents, reserved_microcents, unknown_held_microcents, unknown_cost_requests
         FROM budget_period_usage
         WHERE team_id = $1 AND api_key_id IS NOT NULL
           AND window_kind = ANY($2) AND period_start = ANY($3)`,
        [teamId, windows.map((w) => w.kind), windows.map((w) => w.periodStart)],
      ),
      // Key-scoped unbounded unknowns mirror the proxy admission predicate:
      // zero-estimate unknown_held, pending estimate_unavailable, unresolved
      // seed rows — each blocks hard-capped admission for that key.
      pool.query<{ api_key_id: string }>(
        `SELECT DISTINCT r.api_key_id
           FROM budget_reservations r JOIN budget_period_usage p ON p.id = r.period_id
          WHERE p.team_id = $1 AND p.api_key_id IS NOT NULL
            AND ((r.status = 'unknown_held' AND r.estimated_microcents = 0)
              OR (r.status = 'pending' AND r.estimate_unavailable = true))
         UNION
         SELECT DISTINCT p.api_key_id
           FROM budget_period_seeded_requests s JOIN budget_period_usage p ON p.id = s.period_id
          WHERE p.team_id = $1 AND p.api_key_id IS NOT NULL AND s.known_cost = false`,
        [teamId],
      ),
      // Team-scope unbounded unknowns gate EVERY key admission too (the proxy
      // checks both plans) — surface them so the per-key view mirrors the 503s.
      // RSH-140: identity period rows are also api_key_id NULL, so exclude
      // them explicitly (the proxy's team predicate is api_key_id IS NULL AND
      // identity_id IS NULL) — otherwise an identity's unbounded hold would
      // freeze every key on a hard-capped team.
      pool.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM budget_reservations r JOIN budget_period_usage p ON p.id = r.period_id
            WHERE p.team_id = $1 AND p.api_key_id IS NULL AND p.identity_id IS NULL
              AND ((r.status = 'unknown_held' AND r.estimated_microcents = 0)
                OR (r.status = 'pending' AND r.estimate_unavailable = true))
           UNION ALL
           SELECT 1 FROM budget_period_seeded_requests s JOIN budget_period_usage p ON p.id = s.period_id
            WHERE p.team_id = $1 AND p.api_key_id IS NULL AND p.identity_id IS NULL AND s.known_cost = false
         ) AS exists`,
        [teamId],
      ),
      pool.query<{ hard_cap_action: string | null; has_cap: boolean }>(
        `SELECT hard_cap_action,
                (daily_usd_cap IS NOT NULL OR weekly_usd_cap IS NOT NULL OR monthly_usd_cap IS NOT NULL) AS has_cap
           FROM team_budgets WHERE team_id = $1`,
        [teamId],
      ),
      // RSH-140: per-identity caps + period rows + unbounded gates, surfaced
      // per key through the key's layer_identity_id.
      pool.query<{ identity_id: string; daily_usd_cap: string | null; weekly_usd_cap: string | null; monthly_usd_cap: string | null; cap_action: string; soft_alert_at_pct: number | null }>(
        `SELECT identity_id, daily_usd_cap, weekly_usd_cap, monthly_usd_cap, cap_action, soft_alert_at_pct
           FROM identity_budget_caps WHERE team_id = $1`,
        [teamId],
      ),
      pool.query<{
        identity_id: string;
        window_kind: BudgetWindowKind;
        period_start: Date;
        period_end: Date;
        actual_microcents: string;
        reserved_microcents: string;
        unknown_held_microcents: string;
        unknown_cost_requests: string;
      }>(
        `SELECT identity_id, window_kind, period_start, period_end,
                actual_microcents, reserved_microcents, unknown_held_microcents, unknown_cost_requests
         FROM budget_period_usage
         WHERE team_id = $1 AND api_key_id IS NULL AND identity_id IS NOT NULL
           AND window_kind = ANY($2) AND period_start = ANY($3)`,
        [teamId, windows.map((w) => w.kind), windows.map((w) => w.periodStart)],
      ),
      pool.query<{ identity_id: string }>(
        `SELECT DISTINCT r.identity_id
           FROM budget_reservations r JOIN budget_period_usage p ON p.id = r.period_id
          WHERE p.team_id = $1 AND p.api_key_id IS NULL AND p.identity_id IS NOT NULL
            AND ((r.status = 'unknown_held' AND r.estimated_microcents = 0)
              OR (r.status = 'pending' AND r.estimate_unavailable = true))
         UNION
         SELECT DISTINCT p.identity_id
           FROM budget_period_seeded_requests s JOIN budget_period_usage p ON p.id = s.period_id
          WHERE p.team_id = $1 AND p.api_key_id IS NULL AND p.identity_id IS NOT NULL AND s.known_cost = false`,
        [teamId],
      ),
    ]);

    const capsByKey = new Map(capRows.map((c) => [c.id, c]));
    const unboundedKeys = new Set(unboundedRows.map((r) => r.api_key_id));
    // A team-scope unbounded unknown blocks admission for every key on the
    // team — but only when the team actually has a hard-capped window (the
    // proxy gate fires only for plans with a hard action). An alert-only team
    // keeps admitting; don't show its keys as frozen.
    const teamBudget = teamBudgetRows[0] ?? null;
    const teamHardCapped = teamBudget?.has_cap === true
      && (teamBudget.hard_cap_action === 'throttle' || teamBudget.hard_cap_action === 'block');
    if (teamUnboundedRows[0]?.exists && teamHardCapped) {
      for (const row of capRows) unboundedKeys.add(row.id);
    }
    const periodsByKey = new Map<string, Map<BudgetWindowKind, (typeof keyPeriodRows)[number]>>();
    for (const row of keyPeriodRows) {
      const byKind = periodsByKey.get(row.api_key_id) ?? new Map();
      byKind.set(row.window_kind, row);
      periodsByKey.set(row.api_key_id, byKind);
    }

    const identityCapsById = new Map(identityCapRows.map((c) => [c.identity_id, c]));
    const unboundedIdentities = new Set(identityUnboundedRows.map((r) => r.identity_id));
    const identityPeriodsById = new Map<string, Map<BudgetWindowKind, (typeof identityPeriodRows)[number]>>();
    for (const row of identityPeriodRows) {
      const byKind = identityPeriodsById.get(row.identity_id) ?? new Map();
      byKind.set(row.window_kind, row);
      identityPeriodsById.set(row.identity_id, byKind);
    }

    const rowsWithWindows = result.map((row) => {
      const caps = capsByKey.get(row.api_key_id);
      const periods = periodsByKey.get(row.api_key_id);
      // Normalize like the proxy's layerIdentityFromMetadata (trim; empty →
      // no identity): the ledger enforces/stamps the TRIMMED value, so a
      // padded metadata identity must resolve the same maps here or the UI
      // would silently miss enforced identity windows (and the identity_id
      // echoed back would not match the ledger's).
      const rawIdentityId = (row.metadata as Record<string, unknown> | null)?.layer_identity_id;
      const identityId = typeof rawIdentityId === 'string' ? rawIdentityId.trim() : undefined;
      const identityCaps = identityId ? identityCapsById.get(identityId) : undefined;
      const identityPeriods = identityId ? identityPeriodsById.get(identityId) : undefined;
      const identityReport = identityId && (identityCaps || identityPeriods)
        ? buildBudgetReport({
            // identityCaps may be undefined when only spend exists (no caps
            // row yet) — the window still renders as 'no cap' with the real
            // ledger and the unbounded gate
            windows: windows.map((w) => {
              const cap = identityCaps?.[`${w.kind}_usd_cap`] ?? null;
              const period = identityPeriods?.get(w.kind);
              // parseUsdCap: exact decimal spelling → microcents (numeric(20,8)
              // strings can exceed Number-safe microcents and binary-float
              // multiplication misrepresents exact decimals; the proxy enforces
              // the exact value, so the UI must render the same cap).
              const parsedCap = cap != null ? parseUsdCap(cap) : null;
              const capMicrocents = parsedCap?.microcents ?? null;
              const capAction = (identityCaps?.cap_action ?? 'alert') as 'alert' | 'throttle' | 'block';
              return {
                kind: w.kind,
                capMicrocents,
                hardAction: capMicrocents != null ? capAction : null,
                alertAtPct: capMicrocents != null ? (identityCaps?.soft_alert_at_pct ?? 80) : null,
                ledger: period
                  ? {
                      kind: w.kind,
                      periodStart: period.period_start.toISOString(),
                      periodEnd: period.period_end.toISOString(),
                      resetAt: w.resetAt,
                      actualMicrocents: Number(period.actual_microcents),
                      reservedMicrocents: Number(period.reserved_microcents),
                      unknownHeldMicrocents: Number(period.unknown_held_microcents),
                      unknownCostRequests: Number(period.unknown_cost_requests),
                    }
                  : null,
                hasUnboundedUnknown: unboundedIdentities.has(identityId),
              };
            }),
          })
        : null;
      const report = buildBudgetReport({
        windows: windows.map((w) => {
          const cap = caps?.[`${w.kind}_usd_cap`] ?? null;
          const period = periods?.get(w.kind);
          // parseUsdCap: exact decimal spelling → microcents (see the
          // identity block above — same enforcement contract).
          const parsedCap = cap != null ? parseUsdCap(cap) : null;
          const capMicrocents = parsedCap?.microcents ?? null;
          const capAction = (caps?.cap_action ?? 'alert') as 'alert' | 'throttle' | 'block';
          return {
            kind: w.kind,
            capMicrocents,
            // Report the key's ACTUAL policy (admission honors it), not a
            // hardcoded block.
            hardAction: capMicrocents != null ? capAction : null,
            alertAtPct: capMicrocents != null ? (caps?.soft_alert_at_pct ?? 80) : null,
            ledger: period
              ? {
                  kind: w.kind,
                  periodStart: period.period_start.toISOString(),
                  periodEnd: period.period_end.toISOString(),
                  resetAt: w.resetAt,
                  actualMicrocents: Number(period.actual_microcents),
                  reservedMicrocents: Number(period.reserved_microcents),
                  unknownHeldMicrocents: Number(period.unknown_held_microcents),
                  unknownCostRequests: Number(period.unknown_cost_requests),
                }
              : null,
            hasUnboundedUnknown: unboundedKeys.has(row.api_key_id),
          };
        }),
      });
      return {
        ...row,
        budget_windows: report.windows.map((w) => ({
          kind: w.kind,
          cap_usd: w.capMicrocents != null ? w.capMicrocents / 100_000_000 : null,
          committed_usd: w.committedMicrocents / 100_000_000,
          unknown_held_usd: w.unknownHeldMicrocents / 100_000_000,
          unknown_cost_requests: w.unknownCostRequests,
          status: w.status,
          action: w.action,
          reset_at: w.resetAt,
        })),
        identity_windows: identityReport
          ? {
              identity_id: identityId,
              windows: identityReport.windows.map((w) => ({
                kind: w.kind,
                cap_usd: w.capMicrocents != null ? w.capMicrocents / 100_000_000 : null,
                committed_usd: w.committedMicrocents / 100_000_000,
                unknown_held_usd: w.unknownHeldMicrocents / 100_000_000,
                unknown_cost_requests: w.unknownCostRequests,
                status: w.status,
                action: w.action,
                reset_at: w.resetAt,
              })),
            }
          : null,
      };
    });

    const total_cost_microcents = result.reduce((s, r) => s + r.cost_microcents, 0);

    const response = NextResponse.json({
      period,
      rows: rowsWithWindows,
      total_cost_microcents,
      unknown_cost_requests: result.reduce((s, r) => s + r.unknown_cost_requests, 0),
      actual_costs_qualified: result.every((r) => r.actual_costs_qualified),
    });
    response.headers.set('Cache-Control', 'no-store');
    return response;
  } catch (err) {
    console.error('billing/by-key endpoint error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
