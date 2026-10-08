import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { arch, cpus, release, type as osType } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { beforeAll, bench, describe, vi } from 'vitest';
import {
  assertGatewayBenchmarkRunCounts,
  buildGatewayBenchmarkReport,
  validateGatewayIteration,
  type GatewayPhaseMarks,
  type GatewayPhaseSample,
} from '../src/benchmarks/latency-harness.js';

const WARMUP_ITERATIONS = 100;
const MEASURED_ITERATIONS = 1_000;
const originalFetch = globalThis.fetch;
const REQUEST_BODY = {
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Measure the RouteShift gateway hot path.' }],
};
const UPSTREAM_BODY = {
  id: 'chatcmpl-benchmark',
  object: 'chat.completion',
  created: 1,
  model: 'gpt-4o-mini',
  choices: [{
    index: 0,
    message: { role: 'assistant', content: 'Benchmark response' },
    finish_reason: 'stop',
  }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

interface ActiveIteration {
  marks: GatewayPhaseMarks;
  upstreamHits: number;
  logEnqueues: number;
  upstreamResponse: Response;
  upstreamRequestBody: string;
  logRecord: Record<string, unknown> | null;
}

const mocks = vi.hoisted(() => {
  const runtime = {
    current: null as ActiveIteration | null,
    samples: [] as GatewayPhaseSample[],
    logBuffer: [] as unknown[],
    mode: 'idle' as 'idle' | 'warmup' | 'run',
    warmupIterations: 0,
    rules: [
      {
        id: 'benchmark-tag', team_id: '*', name: 'Benchmark tag', priority: 10, enabled: true,
        condition: { model_requested: 'gpt-4o' },
        action: { type: 'tag', add_tags: ['benchmark'] },
      },
      {
        id: 'benchmark-cap', team_id: '*', name: 'Benchmark cap', priority: 20, enabled: true,
        condition: { tags: ['benchmark'] },
        action: { type: 'modify', modifications: { max_output_tokens: 256 } },
      },
      {
        id: 'benchmark-route', team_id: '*', name: 'Benchmark route', priority: 100, enabled: true,
        condition: { tags: ['benchmark'] },
        action: { type: 'route', target_provider: 'openai', target_model: 'gpt-4o-mini' },
      },
    ],
  };

  return {
    runtime,
    config: { maxRequestBodyBytes: 64 * 1024 },
    validateApiKey: async () => ({
      id: 'key_benchmark',
      teamId: 'team_benchmark',
      allowedModels: null,
      rateLimitOverride: null,
    }),
    rateCheck: () => ({ allowed: true, remaining: 999, resetMs: 60_000 }),
    tpmCheck: () => ({ allowed: true, recordId: null, currentTokens: 0, remaining: Infinity, resetMs: 0 }),
    updateTpmEstimate: () => ({ allowed: true, recordId: null, currentTokens: 0, remaining: Infinity, resetMs: 0 }),
    getRulesForTeam: async () => runtime.rules,
    getAutoRouteSettings: async () => ({ enabled: false, strategy: 'balanced' as const, max_fallbacks: 0 }),
    getTeamBillingMode: async () => 'subscription' as const,
    getTeamPlan: async () => 'growth',
    getPlanLimits: () => ({
      maxKeys: Infinity,
      maxRules: Infinity,
      fallbacksEnabled: true,
      savingsSharePercent: 3,
      creditsMarkupPercent: 3,
    }),
    reserveBudget: async () => ({
      allowed: true,
      reservation: {
        requestId: 'bench-req',
        teamId: 'bench-team',
        apiKeyId: null,
        estimatedMicrocents: 100,
        reservedMicrocents: 100,
        dispatched: false,
        terminal: false,
      },
      warnings: [],
    }),
    adjustBudgetReservation: async (input: { reservation: unknown }) => ({
      allowed: true,
      reservation: input.reservation,
      warnings: [],
    }),
    markBudgetReservationDispatched: async () => ({ marked: true, alreadyMarked: false }),
    refreshBudgetReservationLease: async () => ({ refreshed: true }),
    settleBudgetReservation: async () => undefined,
    releaseBudgetReservation: async () => undefined,
    estimateChatBudget: async () => ({ estimatedMicrocents: 100 }),
    getDecryptedProviderKey: async () => ({
      key: 'benchmark-team-provider-key',
      metadata: {},
      label: 'benchmark',
    }),
    getCreditPricing: async () => ({
      provider: 'openai', model: 'gpt-4o-mini', input_per_million: 0.15, output_per_million: 0.6,
    }),
    responseCache: {
      isCacheable: () => false,
      buildKey: () => 'unused-benchmark-cache-key',
      get: () => null,
      set: () => undefined,
    },
    computeRequestCost: async () => ({
      original_cost_microcents: 100,
      actual_cost_microcents: 100,
      savings_microcents: 0,
    }),
    logRequest: (record: unknown) => {
      const current = runtime.current;
      if (!current) throw new Error('Benchmark log enqueue occurred outside an active iteration');
      current.logEnqueues += 1;
      current.marks.logEnqueueStart = globalThis.performance.now();
      runtime.logBuffer.push(record);
      current.logRecord = record as Record<string, unknown>;
      current.marks.logEnqueueEnd = globalThis.performance.now();
    },
    fetchMock: async (_input: RequestInfo | URL, init?: RequestInit) => {
      const current = runtime.current;
      if (!current) throw new Error('Benchmark upstream dispatch occurred outside an active iteration');
      current.upstreamHits += 1;
      current.marks.upstreamStart = globalThis.performance.now();
      current.upstreamRequestBody = typeof init?.body === 'string' ? init.body : '';
      current.marks.upstreamEnd = globalThis.performance.now();
      return current.upstreamResponse;
    },
  };
});

vi.mock('../src/db/pool.js', () => ({
  getPool: () => ({ query: async () => ({ rows: [] }) }),
}));
vi.mock('../src/config.js', () => ({ config: mocks.config }));
vi.mock('../src/auth/api-key.js', () => ({ validateApiKey: mocks.validateApiKey }));
vi.mock('../src/rate-limit/limiter.js', () => ({
  rateLimiter: {
    check: mocks.rateCheck,
    checkTpm: mocks.tpmCheck,
    updateTpmEstimate: mocks.updateTpmEstimate,
    reconcileActualTokens: () => undefined,
    removeRecord: () => undefined,
  },
}));
vi.mock('../src/routing/rule-cache.js', () => ({ getRulesForTeam: mocks.getRulesForTeam }));
vi.mock('../src/admin/auto-route.js', () => ({ getAutoRouteSettings: mocks.getAutoRouteSettings }));
vi.mock('../src/routing/auto-route-availability.js', () => ({ getAutoRouteProviderSignals: async () => [] }));
vi.mock('../src/billing/plan-limits.js', () => ({
  getTeamBillingMode: mocks.getTeamBillingMode,
  getTeamPlan: mocks.getTeamPlan,
  getPlanLimits: mocks.getPlanLimits,
}));
vi.mock('../src/billing/budget-reservations.js', () => ({
  reserveBudget: mocks.reserveBudget,
  adjustBudgetReservation: mocks.adjustBudgetReservation,
  markBudgetReservationDispatched: mocks.markBudgetReservationDispatched,
  refreshBudgetReservationLease: mocks.refreshBudgetReservationLease,
  settleBudgetReservation: mocks.settleBudgetReservation,
  releaseBudgetReservation: mocks.releaseBudgetReservation,
}));
vi.mock('../src/billing/budget-estimate.js', () => ({
  estimateChatBudget: mocks.estimateChatBudget,
}));
vi.mock('../src/billing/provider-key-crypto.js', () => ({
  getDecryptedProviderKey: mocks.getDecryptedProviderKey,
  hasEnabledProviderKey: async () => true,
}));
vi.mock('../src/billing/credits.js', () => ({
  preFlightCreditCheck: async () => ({ allowed: true, balance: 100_000, estimatedCost: 100 }),
  deductCredits: async () => ({ success: true, newBalance: 99_900 }),
  reserveCredits: async () => ({ success: true, newBalance: 99_900, amountDeducted: 100 }),
  settleReservedCredits: async () => ({ success: true, newBalance: 99_900, amountDeducted: 100 }),
  checkAutoTopUpNeeded: async () => undefined,
  getCreditPricing: mocks.getCreditPricing,
}));
vi.mock('../src/cache/response-cache.js', () => ({ responseCache: mocks.responseCache }));
vi.mock('../src/presets/resolver.js', () => ({ resolvePreset: async () => null }));
vi.mock('../src/cost/calculator.js', () => ({ computeRequestCost: mocks.computeRequestCost }));
vi.mock('../src/logging/logger.js', () => ({ logRequest: mocks.logRequest }));
vi.mock('../src/streaming/relay.js', () => ({ relayStream: async () => ({ chunks: [], ttft_ms: null }) }));
vi.mock('../src/routing/fallback.js', () => ({ executeFallbackChain: async () => null }));
vi.mock('../src/routing/circuit-breaker.js', () => ({
  circuitBreaker: { isOpen: () => false, recordFailure: () => undefined, recordSuccess: () => undefined },
}));
vi.mock('../src/observability/sentry.js', () => ({ captureException: () => undefined }));

import { handleProxyRequest } from '../src/proxy-handler.js';

function makeReq(): IncomingMessage {
  const stream = Readable.from([Buffer.from(JSON.stringify(REQUEST_BODY))]);
  return Object.assign(stream, {
    url: '/v1/chat/completions',
    method: 'POST',
    headers: { authorization: 'Bearer sk-proxy-benchmark', host: 'localhost' },
  }) as IncomingMessage;
}

function makeRes() {
  let statusCode = 0;
  let body = '';
  const headers: Record<string, string> = {};
  const res = Object.assign(new EventEmitter(), {
    headersSent: false,
    setHeader(name: string, value: string) {
      headers[name] = value;
      return res;
    },
    writeHead(code: number, nextHeaders?: Record<string, string>) {
      statusCode = code;
      Object.assign(headers, nextHeaders ?? {});
      res.headersSent = true;
      return res;
    },
    end(chunk?: string) {
      body = chunk ?? '';
      res.headersSent = true;
      res.emit('finish');
      return res;
    },
  }) as unknown as ServerResponse & { headersSent: boolean };
  return { res, statusCode: () => statusCode, body: () => body, headers: () => headers };
}

async function runGatewayIteration(): Promise<GatewayPhaseSample> {
  // Fixture construction is outside the measurement boundary. The mock
  // Response is one-use, so every iteration receives a fresh prebuilt body.
  const req = makeReq();
  const out = makeRes();
  const upstreamResponse = new Response(JSON.stringify(UPSTREAM_BODY), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  const marks: GatewayPhaseMarks = {
    handlerStart: globalThis.performance.now(),
    upstreamStart: Number.NaN,
    upstreamEnd: Number.NaN,
    logEnqueueStart: Number.NaN,
    logEnqueueEnd: Number.NaN,
    handlerEnd: Number.NaN,
  };
  const current: ActiveIteration = {
    marks,
    upstreamHits: 0,
    logEnqueues: 0,
    upstreamResponse,
    upstreamRequestBody: '',
    logRecord: null,
  };
  mocks.runtime.current = current;
  try {
    // Start immediately before the production handler entry. Request/response
    // fixture allocation above is intentionally not part of gateway overhead.
    marks.handlerStart = globalThis.performance.now();
    await handleProxyRequest(req, out.res);
    marks.handlerEnd = globalThis.performance.now();
    const sample = validateGatewayIteration({
      statusCode: out.statusCode(),
      responseBody: out.body(),
      upstreamHits: current.upstreamHits,
      logEnqueues: current.logEnqueues,
      marks,
      upstreamRequestBody: current.upstreamRequestBody,
      logRecord: current.logRecord ?? {},
      responseHeaders: out.headers(),
      expectedResponse: {
        id: UPSTREAM_BODY.id,
        model: UPSTREAM_BODY.model,
        content: UPSTREAM_BODY.choices[0].message.content,
      },
      expectedRoute: {
        provider: 'openai',
        requestedModel: REQUEST_BODY.model,
        resolvedModel: UPSTREAM_BODY.model,
      },
    });
    if (mocks.runtime.mode === 'warmup') mocks.runtime.warmupIterations += 1;
    if (mocks.runtime.mode === 'run') mocks.runtime.samples.push(sample);
    return sample;
  } finally {
    mocks.runtime.current = null;
  }
}

function gitOutput(args: string[]): string {
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function writeBenchmarkReport(): void {
  const measured = mocks.runtime.samples;
  assertGatewayBenchmarkRunCounts(
    measured.length,
    mocks.runtime.warmupIterations,
    MEASURED_ITERATIONS,
    WARMUP_ITERATIONS,
  );
  const dirty = gitOutput(['status', '--porcelain']).length > 0;
  const cpuInfo = cpus();
  const report = buildGatewayBenchmarkReport(measured, {
    run_at_utc: new Date().toISOString(),
    commit: gitOutput(['rev-parse', 'HEAD']),
    dirty,
    node: process.version,
    platform: process.platform,
    os: osType(),
    os_release: release(),
    arch: arch(),
    cpu: cpuInfo[0]?.model ?? 'unknown',
    logical_cpus: cpuInfo.length,
    measured_iterations: measured.length,
    warmup_iterations: mocks.runtime.warmupIterations,
    concurrency: 1,
    payload_bytes: Buffer.byteLength(JSON.stringify(REQUEST_BODY)),
    rule_count: mocks.runtime.rules.length,
    mock_response_bytes: Buffer.byteLength(JSON.stringify(UPSTREAM_BODY)),
    mock_upstream_delay_ms: 0,
    timing_clock: 'performance.now() monotonic milliseconds',
    source_mode: 'Vitest/Vite source transform of the current git HEAD',
    workload: 'successful non-streaming, non-cacheable, no-plugin, no-fallback chat completion',
    log_boundary: 'one in-memory enqueue; asynchronous Postgres/ClickHouse flush excluded',
  });
  const outputPath = process.env.ROUTESHIFT_BENCHMARK_OUTPUT;
  if (!outputPath) throw new Error('ROUTESHIFT_BENCHMARK_OUTPUT is required; run the package bench:latency command');
  writeFileSync(outputPath, JSON.stringify(report), { encoding: 'utf8', flag: 'wx' });
}

describe('RouteShift gateway-added latency', () => {
  beforeAll(async () => {
    const dirty = gitOutput(['status', '--porcelain']).length > 0;
    if (dirty && process.env.ROUTESHIFT_BENCHMARK_ALLOW_DIRTY !== '1') {
      throw new Error('Latency benchmark requires a clean worktree; commit the benchmark source or set ROUTESHIFT_BENCHMARK_ALLOW_DIRTY=1 for a non-publishable development run');
    }
    process.env.OPENAI_API_KEY = 'benchmark-platform-key';
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.TOGETHER_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.EXA_API_KEY;
    globalThis.fetch = mocks.fetchMock as unknown as typeof fetch;

    // A separate fail-closed sanity request runs before Tinybench timing. It
    // must return the canonical 200 response, hit upstream once, and enqueue
    // one log or the benchmark aborts before publishing any number.
    await runGatewayIteration();
    mocks.runtime.samples.length = 0;
    mocks.runtime.logBuffer.length = 0;
  });

  bench('successful non-stream cache-miss handler path', async () => {
    await runGatewayIteration();
  }, {
    iterations: MEASURED_ITERATIONS,
    time: 0,
    warmupIterations: WARMUP_ITERATIONS,
    warmupTime: 0,
    throws: true,
    setup: (_task, mode) => {
      // Vitest resets stubbed globals before Tinybench enters its phases, so
      // bind the deterministic upstream at each warmup/run boundary as well.
      globalThis.fetch = mocks.fetchMock as unknown as typeof fetch;
      mocks.runtime.mode = mode;
      if (mode === 'warmup') mocks.runtime.warmupIterations = 0;
      if (mode === 'run') mocks.runtime.samples.length = 0;
    },
    teardown: (_task, mode) => {
      if (mode === 'run') {
        writeBenchmarkReport();
        globalThis.fetch = originalFetch;
      }
      mocks.runtime.mode = 'idle';
    },
  });
});
