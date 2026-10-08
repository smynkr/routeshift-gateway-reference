export interface GatewayPhaseMarks {
  handlerStart: number;
  upstreamStart: number;
  upstreamEnd: number;
  logEnqueueStart: number;
  logEnqueueEnd: number;
  handlerEnd: number;
}

export interface GatewayPhaseSample {
  pre_upstream_ms: number;
  mock_upstream_ms: number;
  post_upstream_ms: number;
  log_enqueue_ms: number;
  gateway_added_ms: number;
  total_handler_ms: number;
}

export interface LatencyStats {
  samples: number;
  mean_ms: number;
  min_ms: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  max_ms: number;
}

export interface GatewayIterationEvidence {
  statusCode: number;
  responseBody: string;
  upstreamHits: number;
  logEnqueues: number;
  marks: GatewayPhaseMarks;
  upstreamRequestBody: string;
  logRecord: Record<string, unknown>;
  responseHeaders: Record<string, string>;
  expectedResponse: {
    id: string;
    model: string;
    content: string;
  };
  expectedRoute: {
    provider: string;
    requestedModel: string;
    resolvedModel: string;
  };
}

export interface GatewayBenchmarkEnvironment {
  run_at_utc: string;
  commit: string;
  dirty: boolean;
  node: string;
  platform: NodeJS.Platform;
  os: string;
  os_release: string;
  arch: string;
  cpu: string;
  logical_cpus: number;
  measured_iterations: number;
  warmup_iterations: number;
  concurrency: number;
  payload_bytes: number;
  rule_count: number;
  mock_response_bytes: number;
  mock_upstream_delay_ms: number;
  timing_clock: string;
  source_mode: string;
  workload: string;
  log_boundary: string;
}

export interface GatewayBenchmarkReport {
  schema: 'routeshift.gateway-latency.v1';
  metric_boundary: string;
  environment: GatewayBenchmarkEnvironment;
  phases: {
    pre_upstream: LatencyStats;
    mock_upstream: LatencyStats;
    post_upstream: LatencyStats;
    log_enqueue: LatencyStats;
    gateway_added: LatencyStats;
    total_handler: LatencyStats;
  };
}

export function assertGatewayBenchmarkRunCounts(
  measuredIterations: number,
  warmupIterations: number,
  expectedMeasuredIterations: number,
  expectedWarmupIterations: number,
): void {
  const counts = [
    measuredIterations,
    warmupIterations,
    expectedMeasuredIterations,
    expectedWarmupIterations,
  ];
  if (!counts.every(Number.isSafeInteger) || counts.some((count) => count < 0)) {
    throw new Error('Benchmark iteration counts must be non-negative safe integers');
  }
  if (measuredIterations !== expectedMeasuredIterations) {
    throw new Error(
      `Latency benchmark captured ${measuredIterations} measured iterations; expected exactly ${expectedMeasuredIterations}`,
    );
  }
  if (warmupIterations !== expectedWarmupIterations) {
    throw new Error(
      `Latency benchmark captured ${warmupIterations} warmup iterations; expected exactly ${expectedWarmupIterations}`,
    );
  }
}

function percentile(sorted: readonly number[], quantile: number): number {
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index]!;
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

export function computeLatencyStats(values: readonly number[]): LatencyStats {
  if (values.length === 0) throw new Error('Latency stats require at least one sample');
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('Latency samples must be finite, non-negative numbers');
  }

  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return {
    samples: sorted.length,
    mean_ms: rounded(mean),
    min_ms: rounded(sorted[0]!),
    p50_ms: rounded(percentile(sorted, 0.5)),
    p95_ms: rounded(percentile(sorted, 0.95)),
    p99_ms: rounded(percentile(sorted, 0.99)),
    max_ms: rounded(sorted[sorted.length - 1]!),
  };
}

export function validateGatewayIteration(evidence: GatewayIterationEvidence): GatewayPhaseSample {
  if (evidence.statusCode !== 200) {
    const diagnostic = evidence.responseBody.slice(0, 240).replace(/\s+/g, ' ');
    throw new Error(`Benchmark request returned HTTP ${evidence.statusCode}; expected 200; body=${diagnostic}`);
  }
  if (evidence.upstreamHits !== 1) {
    throw new Error(`Benchmark request reached the mock upstream ${evidence.upstreamHits} times; expected exactly 1`);
  }
  if (evidence.logEnqueues !== 1) {
    throw new Error(`Benchmark request enqueued ${evidence.logEnqueues} logs; expected exactly 1`);
  }

  let upstreamRequest: unknown;
  try {
    upstreamRequest = JSON.parse(evidence.upstreamRequestBody);
  } catch {
    throw new Error('Benchmark upstream request body was not valid JSON');
  }
  if (
    !upstreamRequest
    || typeof upstreamRequest !== 'object'
    || (upstreamRequest as Record<string, unknown>).model !== evidence.expectedRoute.resolvedModel
  ) {
    throw new Error('Benchmark upstream request did not use the expected routed model');
  }
  if (
    evidence.logRecord.provider !== evidence.expectedRoute.provider
    || evidence.logRecord.model_requested !== evidence.expectedRoute.requestedModel
    || evidence.logRecord.model_resolved !== evidence.expectedRoute.resolvedModel
    || evidence.logRecord.status_code !== 200
  ) {
    throw new Error('Benchmark log did not preserve the expected provider, requested model, resolved model, and status');
  }
  if (
    evidence.responseHeaders['X-RouteShift-Provider'] !== evidence.expectedRoute.provider
    || evidence.responseHeaders['X-RouteShift-Model'] !== evidence.expectedRoute.resolvedModel
  ) {
    throw new Error('Benchmark response headers did not preserve the expected provider and routed model');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(evidence.responseBody);
  } catch {
    throw new Error('Benchmark response was not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Benchmark response was not a canonical chat.completion');
  }
  const response = parsed as Record<string, unknown>;
  const choices = response.choices;
  const firstChoice = Array.isArray(choices) ? choices[0] : undefined;
  const message = firstChoice && typeof firstChoice === 'object'
    ? (firstChoice as Record<string, unknown>).message
    : undefined;
  const content = message && typeof message === 'object'
    ? (message as Record<string, unknown>).content
    : undefined;
  if (
    response.object !== 'chat.completion'
    || response.id !== evidence.expectedResponse.id
    || response.model !== evidence.expectedResponse.model
    || content !== evidence.expectedResponse.content
  ) {
    throw new Error('Benchmark response did not match the expected chat.completion marker, model, and content');
  }

  const { marks } = evidence;
  const ordered = [
    marks.handlerStart,
    marks.upstreamStart,
    marks.upstreamEnd,
    marks.logEnqueueStart,
    marks.logEnqueueEnd,
    marks.handlerEnd,
  ];
  if (ordered.some((value) => !Number.isFinite(value))) {
    throw new Error('Benchmark phase markers must all be finite numbers');
  }
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]! < ordered[index - 1]!) {
      throw new Error('Benchmark phase markers are not monotonic');
    }
  }

  const preUpstream = marks.upstreamStart - marks.handlerStart;
  const mockUpstream = marks.upstreamEnd - marks.upstreamStart;
  const postUpstream = marks.handlerEnd - marks.upstreamEnd;
  const logEnqueue = marks.logEnqueueEnd - marks.logEnqueueStart;
  return {
    pre_upstream_ms: preUpstream,
    mock_upstream_ms: mockUpstream,
    post_upstream_ms: postUpstream,
    log_enqueue_ms: logEnqueue,
    gateway_added_ms: preUpstream + postUpstream,
    total_handler_ms: marks.handlerEnd - marks.handlerStart,
  };
}

export function buildGatewayBenchmarkReport(
  samples: readonly GatewayPhaseSample[],
  environment: GatewayBenchmarkEnvironment,
): GatewayBenchmarkReport {
  if (samples.length === 0) throw new Error('Gateway benchmark report requires measured samples');
  const stats = (key: keyof GatewayPhaseSample) => computeLatencyStats(samples.map((sample) => sample[key]));
  return {
    schema: 'routeshift.gateway-latency.v1',
    metric_boundary: 'handler entry to upstream dispatch plus upstream completion to handler return; excludes the mock upstream interval and asynchronous sink flushes',
    environment,
    phases: {
      pre_upstream: stats('pre_upstream_ms'),
      mock_upstream: stats('mock_upstream_ms'),
      post_upstream: stats('post_upstream_ms'),
      log_enqueue: stats('log_enqueue_ms'),
      gateway_added: stats('gateway_added_ms'),
      total_handler: stats('total_handler_ms'),
    },
  };
}
