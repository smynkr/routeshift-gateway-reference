import { config } from './config.js';
import { createProxyServer } from './server.js';
import { closePool } from './db/pool.js';
import { shutdownLogger } from './logging/logger.js';
import { stopSavingsReporter } from './billing/savings-reporter.js';
import { stopAutoTopUpWorker } from './billing/auto-topup-worker.js';
import { stopPendingHoldReconciliationWorker } from './billing/pending-hold-reconciliation-worker.js';
import { stopSessionAggregator } from './observability/session-aggregator.js';
import { stopYieldCorrelator } from './observability/yield-correlator.js';
import { stopOptimizeEngine } from './optimize/engine.js';
import { stopSpendAnomalyWorker } from './observability/spend-anomaly-worker.js';
import { responseCache } from './cache/response-cache.js';
import { installUpstreamAgent, destroyUpstreamAgent } from './upstream-agent.js';
import { startProxyRuntime } from './runtime.js';
import { captureException, flushSentry, initSentry } from './observability/sentry.js';
import { flushPostHog, initPostHog } from './observability/posthog.js';

// Pool TLS connections to upstream LLM providers before any fetch fires.
installUpstreamAgent();
initSentry();
initPostHog();

const proxy = createProxyServer(config.port);
await startProxyRuntime(proxy);

async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`${signal} received, shutting down...`);
  await proxy.stop();
  await shutdownLogger();
  responseCache.shutdown();
  stopAutoTopUpWorker();
  stopPendingHoldReconciliationWorker();
  stopSavingsReporter();
  stopSessionAggregator();
  stopYieldCorrelator();
  stopOptimizeEngine();
  stopSpendAnomalyWorker();
  await destroyUpstreamAgent();
  await closePool();
  await flushPostHog();
  await flushSentry();
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', async (err) => {
  console.error('Uncaught exception:', err);
  captureException(err, { tags: { source: 'uncaughtException' } });
  await flushPostHog();
  await flushSentry();
  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  console.error('Unhandled rejection:', reason);
  captureException(reason, { tags: { source: 'unhandledRejection' } });
  await flushPostHog();
  await flushSentry();
  process.exit(1);
});
