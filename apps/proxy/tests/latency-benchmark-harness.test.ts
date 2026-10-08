import { describe, expect, it } from 'vitest';
import {
  assertGatewayBenchmarkRunCounts,
  buildGatewayBenchmarkReport,
  computeLatencyStats,
  validateGatewayIteration,
  type GatewayIterationEvidence,
  type GatewayPhaseSample,
} from '../src/benchmarks/latency-harness.js';

function validEvidence(overrides: Partial<GatewayIterationEvidence> = {}): GatewayIterationEvidence {
  return {
    statusCode: 200,
    responseBody: JSON.stringify({
      id: 'chatcmpl-benchmark',
      object: 'chat.completion',
      model: 'gpt-4o-mini',
      choices: [{ message: { content: 'Benchmark response' } }],
    }),
    upstreamHits: 1,
    logEnqueues: 1,
    marks: {
      handlerStart: 1,
      upstreamStart: 4,
      upstreamEnd: 5,
      logEnqueueStart: 7,
      logEnqueueEnd: 8,
      handlerEnd: 9,
    },
    upstreamRequestBody: JSON.stringify({ model: 'gpt-4o-mini' }),
    logRecord: {
      provider: 'openai',
      model_requested: 'gpt-4o',
      model_resolved: 'gpt-4o-mini',
      status_code: 200,
    },
    responseHeaders: {
      'X-RouteShift-Provider': 'openai',
      'X-RouteShift-Model': 'gpt-4o-mini',
    },
    expectedResponse: {
      id: 'chatcmpl-benchmark',
      model: 'gpt-4o-mini',
      content: 'Benchmark response',
    },
    expectedRoute: {
      provider: 'openai',
      requestedModel: 'gpt-4o',
      resolvedModel: 'gpt-4o-mini',
    },
    ...overrides,
  };
}

describe('gateway latency benchmark harness', () => {
  it('computes nearest-rank percentiles without mutating the input', () => {
    const values = Array.from({ length: 100 }, (_, index) => 100 - index);
    const before = [...values];

    expect(computeLatencyStats(values)).toEqual({
      samples: 100,
      mean_ms: 50.5,
      min_ms: 1,
      p50_ms: 50,
      p95_ms: 95,
      p99_ms: 99,
      max_ms: 100,
    });
    expect(values).toEqual(before);
  });

  it('rejects empty, negative, and non-finite latency samples', () => {
    expect(() => computeLatencyStats([])).toThrow('at least one sample');
    expect(() => computeLatencyStats([1, -1])).toThrow('finite, non-negative');
    expect(() => computeLatencyStats([Number.NaN])).toThrow('finite, non-negative');
  });

  it('requires the configured warmup and measured iteration counts before publishing', () => {
    expect(() => assertGatewayBenchmarkRunCounts(1_000, 100, 1_000, 100)).not.toThrow();
    expect(() => assertGatewayBenchmarkRunCounts(999, 100, 1_000, 100)).toThrow('expected exactly 1000');
    expect(() => assertGatewayBenchmarkRunCounts(1_000, 99, 1_000, 100)).toThrow('expected exactly 100');
    expect(() => assertGatewayBenchmarkRunCounts(1_000.5, 100, 1_000, 100)).toThrow('safe integers');
  });

  it('derives pre-upstream, post-upstream, logging, and gateway-added phases', () => {
    expect(validateGatewayIteration(validEvidence())).toEqual({
      pre_upstream_ms: 3,
      mock_upstream_ms: 1,
      post_upstream_ms: 4,
      log_enqueue_ms: 1,
      gateway_added_ms: 7,
      total_handler_ms: 8,
    });
  });

  it.each([
    ['HTTP error path', { statusCode: 500 }, 'returned HTTP 500'],
    ['missing upstream dispatch', { upstreamHits: 0 }, 'mock upstream 0 times'],
    ['duplicate upstream dispatch', { upstreamHits: 2 }, 'mock upstream 2 times'],
    ['missing log enqueue', { logEnqueues: 0 }, 'enqueued 0 logs'],
    ['duplicate log enqueue', { logEnqueues: 2 }, 'enqueued 2 logs'],
    ['invalid JSON', { responseBody: 'not-json' }, 'not valid JSON'],
    ['wrong response contract', { responseBody: JSON.stringify({ object: 'error' }) }, 'did not match'],
    ['wrong success marker', {
      responseBody: JSON.stringify({
        id: 'chatcmpl-wrong', object: 'chat.completion', model: 'gpt-4o-mini',
        choices: [{ message: { content: 'Benchmark response' } }],
      }),
    }, 'did not match'],
    ['wrong routed upstream model', { upstreamRequestBody: JSON.stringify({ model: 'gpt-4o' }) }, 'expected routed model'],
    ['wrong logged model', {
      logRecord: { provider: 'openai', model_requested: 'gpt-4o', model_resolved: 'gpt-4o', status_code: 200 },
    }, 'log did not preserve'],
    ['wrong response model header', {
      responseHeaders: { 'X-RouteShift-Provider': 'openai', 'X-RouteShift-Model': 'gpt-4o' },
    }, 'response headers did not preserve'],
  ])('fails closed for %s', (_name, override, message) => {
    expect(() => validateGatewayIteration(validEvidence(override))).toThrow(message);
  });

  it('rejects missing or out-of-order phase markers', () => {
    expect(() => validateGatewayIteration(validEvidence({
      marks: { ...validEvidence().marks, logEnqueueStart: Number.NaN },
    }))).toThrow('finite numbers');
    expect(() => validateGatewayIteration(validEvidence({
      marks: { ...validEvidence().marks, upstreamEnd: 10 },
    }))).toThrow('not monotonic');
  });

  it('builds a schema-versioned report with the exact measured sample count', () => {
    const sample: GatewayPhaseSample = {
      pre_upstream_ms: 1,
      mock_upstream_ms: 0.1,
      post_upstream_ms: 2,
      log_enqueue_ms: 0.2,
      gateway_added_ms: 3,
      total_handler_ms: 3.1,
    };
    const report = buildGatewayBenchmarkReport([sample, sample], {
      run_at_utc: '2026-07-10T00:00:00.000Z',
      commit: 'test-commit',
      dirty: false,
      node: 'test-node',
      platform: 'darwin',
      os: 'Darwin',
      os_release: 'test-release',
      arch: 'test-arch',
      cpu: 'test-cpu',
      logical_cpus: 1,
      measured_iterations: 2,
      warmup_iterations: 100,
      concurrency: 1,
      payload_bytes: 123,
      rule_count: 3,
      mock_response_bytes: 456,
      mock_upstream_delay_ms: 0,
      timing_clock: 'performance.now()',
      source_mode: 'Vitest source transform',
      workload: 'test workload',
      log_boundary: 'in-memory enqueue',
    });

    expect(report.schema).toBe('routeshift.gateway-latency.v1');
    expect(report.phases.gateway_added.samples).toBe(2);
    expect(report.phases.gateway_added.mean_ms).toBe(3);
    expect(report.metric_boundary).toContain('excludes the mock upstream interval');
  });
});
