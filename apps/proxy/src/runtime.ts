import type { createProxyServer } from './server.js';
import { runMigrations, applyDevSeed } from './db/migrate.js';
import { ensureClickHouseRequestLogColumns } from './db/clickhouse-schema-apply.js';
import { assertPostgresBudgetLedgerSchema, assertPostgresRequestLogSchema } from './db/postgres-schema-guard.js';
import { config } from './config.js';
import { initLogger } from './logging/logger.js';
import { startSavingsReporter } from './billing/savings-reporter.js';
import { startAutoTopUpWorker } from './billing/auto-topup-worker.js';
import { startPendingHoldReconciliationWorker } from './billing/pending-hold-reconciliation-worker.js';
import { startSessionAggregator } from './observability/session-aggregator.js';
import { startYieldCorrelator } from './observability/yield-correlator.js';
import { startOptimizeEngine } from './optimize/engine.js';
import { startOrphanKeySweeper } from './oauth/orphan-key-sweeper.js';
import { startSpendAnomalyWorker } from './observability/spend-anomaly-worker.js';
import { startSsoSweeper } from './oauth/sso-sweeper.js';

export type ProxyRuntime = ReturnType<typeof createProxyServer>;

export async function startProxyRuntime(proxy: ProxyRuntime): Promise<void> {
  if (config.databaseUrl) {
    if (process.env.ROUTESHIFT_SKIP_MIGRATIONS === '1') {
      console.warn('ROUTESHIFT_SKIP_MIGRATIONS=1 — skipping startup migrations');
    } else {
      await runMigrations();
    }

    // Migration 053 normally creates this column, but a skipped migration or
    // drifted database must never enable a logger that drops unknown-cost
    // audit records. The assertion is read-only; schema mutation stays in
    // migrations.
    await assertPostgresRequestLogSchema();

    // RSH-138: migration 061 normally builds the reservation ledger, but a
    // partial migration-first deploy or drifted database must never admit
    // capped traffic against missing period/reservation relations.
    await assertPostgresBudgetLedgerSchema();

    // RSH-59: the bootstrap admin + dev allowlist are local conveniences and
    // must NEVER be seeded in production (a committed credential = a live prod
    // login). Apply them only outside production, with an explicit opt-in escape
    // hatch for the rare case a non-prod-flagged box needs them.
    const isProduction = (process.env.NODE_ENV ?? 'development') === 'production';
    if (!isProduction || process.env.SEED_DEV_DATA === '1') {
      await applyDevSeed();
    }
  }

  // The PostgreSQL migration runner does not own ClickHouse. Apply its
  // additive request-log column before creating an ingester that emits it; a
  // configured but stale sink would otherwise requeue and eventually drop logs.
  if (config.clickhouseUrl) {
    await ensureClickHouseRequestLogColumns(config.clickhouseUrl);
  }

  initLogger();
  if (config.databaseUrl) {
    // The default-on watchdog starts only after migration/shape checks and
    // logger initialization. It changes lifecycle status, never money.
    startPendingHoldReconciliationWorker();
  }
  proxy.start();
  startSavingsReporter();
  startAutoTopUpWorker();
  startSessionAggregator();
  startYieldCorrelator();
  startOptimizeEngine();
  startOrphanKeySweeper();
  startSsoSweeper();
  startSpendAnomalyWorker();
}
