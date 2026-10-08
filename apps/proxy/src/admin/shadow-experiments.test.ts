import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.fn();
vi.mock('../db/pool.js', () => ({ getPool: () => ({ query: queryMock }) }));

import { handleShadowExperiments, handleShadowExperimentById } from './shadow-experiments.js';

function mockReq(method: string, body?: unknown) {
  const chunks = body !== undefined ? [Buffer.from(JSON.stringify(body))] : [];
  let idx = 0;
  return {
    method,
    resume() {},
    async *[Symbol.asyncIterator]() {
      while (idx < chunks.length) yield chunks[idx++];
    },
  } as never;
}

function mockRes() {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(code: number, headers: Record<string, string>) {
      this.statusCode = code;
      this.headers = headers;
    },
    end(chunk?: string) {
      this.body = chunk ?? '';
    },
  };
}

const VALID_BODY = {
  name: 'Test experiment',
  source_provider: 'openai',
  source_model: 'gpt-4.1',
  candidate_provider: 'anthropic',
  candidate_model: 'claude-sonnet-4-5',
  sample_rate_ppm: 100_000,
  sampling_version: 'v1',
  shadow_sampling_key_version: 'key-2026-07',
  max_samples: 1_000,
  deadline_ms: 30_000,
  max_concurrency: 2,
  max_queue_count: 100,
  max_queue_bytes: 10_485_760,
  max_payload_bytes: 1_048_576,
  per_run_cap_microcents: 50_000_000,
  aggregate_cap_microcents: 5_000_000_000,
  verifier_version: 'v1',
  gate_fingerprint: 'sha256:abc123',
};

describe('shadow-experiments admin API', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('feature gate', () => {
    it('returns 404 when SHADOW_ROUTING_ENABLED is not true', async () => {
      vi.stubEnv('SHADOW_ROUTING_ENABLED', 'false');
      const res = mockRes();
      await handleShadowExperiments(mockReq('GET'), res as never, 'team-a');
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error.code).toBe('shadow_routing_disabled');
    });

    it('returns 404 when SHADOW_ROUTING_ENABLED is unset', async () => {
      vi.stubEnv('SHADOW_ROUTING_ENABLED', '');
      const res = mockRes();
      await handleShadowExperiments(mockReq('GET'), res as never, 'team-a');
      expect(res.statusCode).toBe(404);
    });

    it('returns 404 from the item handler before querying the pool', async () => {
      vi.stubEnv('SHADOW_ROUTING_ENABLED', 'false');
      const res = mockRes();
      await handleShadowExperimentById(mockReq('DELETE'), res as never, 'team-a', 'exp-1');
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error.code).toBe('shadow_routing_disabled');
      expect(queryMock).not.toHaveBeenCalled();
    });
  });

  describe('GET /admin/shadow-experiments', () => {
    it('returns team-scoped experiments', async () => {
      vi.stubEnv('SHADOW_ROUTING_ENABLED', 'true');
      queryMock.mockResolvedValue({ rows: [{ id: 'exp-1', team_id: 'team-a', name: 'Test' }] });
      const res = mockRes();
      await handleShadowExperiments(mockReq('GET'), res as never, 'team-a');
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.experiments).toHaveLength(1);
      // Verify SQL is team-scoped.
      const sql = queryMock.mock.calls[0][0] as string;
      expect(sql).toContain('team_id = $1');
      expect(queryMock.mock.calls[0][1]).toEqual(['team-a']);
    });
  });

  describe('POST /admin/shadow-experiments', () => {
    it('creates an experiment with enabled=false', async () => {
      vi.stubEnv('SHADOW_ROUTING_ENABLED', 'true');
      queryMock.mockResolvedValue({ rows: [{ id: 'new-id', enabled: false, ...VALID_BODY }] });
      const res = mockRes();
      await handleShadowExperiments(mockReq('POST', VALID_BODY), res as never, 'team-a');
      expect(res.statusCode).toBe(201);
      // Verify the INSERT includes enabled=false.
      const sql = queryMock.mock.calls[0][0] as string;
      expect(sql).toContain('false');
    });

    it('rejects missing required fields', async () => {
      vi.stubEnv('SHADOW_ROUTING_ENABLED', 'true');
      const res = mockRes();
      await handleShadowExperiments(mockReq('POST', { name: 'Incomplete' }), res as never, 'team-a');
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe('missing_fields');
    });

    it.each([null, [], 'not an object', 42])('rejects a non-object JSON body %j without querying', async (body) => {
      vi.stubEnv('SHADOW_ROUTING_ENABLED', 'true');
      const res = mockRes();
      await handleShadowExperiments(mockReq('POST', body), res as never, 'team-a');
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe('invalid_json');
      expect(queryMock).not.toHaveBeenCalled();
    });

    it('bounds buffered admin JSON and returns a stable 413', async () => {
      vi.stubEnv('SHADOW_ROUTING_ENABLED', 'true');
      const res = mockRes();
      await handleShadowExperiments(mockReq('POST', { padding: 'x'.repeat(64 * 1024) }), res as never, 'team-a');
      expect(res.statusCode).toBe(413);
      expect(JSON.parse(res.body).error.code).toBe('request_body_too_large');
      expect(queryMock).not.toHaveBeenCalled();
    });

    it.each([
      ['enabled', false],
      ['consent_provider_ack', true],
      ['approved_by', 'admin@example.test'],
    ])('rejects create-only control field %s instead of silently ignoring it', async (field, value) => {
      vi.stubEnv('SHADOW_ROUTING_ENABLED', 'true');
      const res = mockRes();
      await handleShadowExperiments(mockReq('POST', { ...VALID_BODY, [field]: value }), res as never, 'team-a');
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe('invalid_field');
      expect(queryMock).not.toHaveBeenCalled();
    });

    it.each([123, null, '   '])('rejects a non-concrete body team_id %j', async (team_id) => {
      vi.stubEnv('SHADOW_ROUTING_ENABLED', 'true');
      const res = mockRes();
      await handleShadowExperiments(mockReq('POST', { ...VALID_BODY, team_id }), res as never, 'team-a');
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe('invalid_tenant');
      expect(queryMock).not.toHaveBeenCalled();
    });

    it.each([
      ['name', '   '],
      ['source_provider', 123],
      ['candidate_model', {}],
      ['sampling_version', '   '],
      ['gate_fingerprint', []],
    ])('rejects invalid required text field %s=%j before querying', async (field, value) => {
      vi.stubEnv('SHADOW_ROUTING_ENABLED', 'true');
      const res = mockRes();
      await handleShadowExperiments(mockReq('POST', { ...VALID_BODY, [field]: value }), res as never, 'team-a');
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe('invalid_field');
      expect(queryMock).not.toHaveBeenCalled();
    });

    it('requires every execution and spend bound instead of applying defaults', async () => {
      vi.stubEnv('SHADOW_ROUTING_ENABLED', 'true');
      const { max_queue_bytes, ...withoutBound } = VALID_BODY;
      const res = mockRes();
      await handleShadowExperiments(mockReq('POST', withoutBound), res as never, 'team-a');
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe('missing_fields');
      expect(JSON.parse(res.body).error.message).toContain('max_queue_bytes');
      expect(queryMock).not.toHaveBeenCalled();
    });

    it.each([
      ['max_samples', -1],
      ['deadline_ms', 0],
      ['deadline_ms', 1.5],
      ['max_concurrency', 0],
      ['max_concurrency', '2'],
      ['max_payload_bytes', 0],
      ['max_samples', 2_147_483_648],
      ['deadline_ms', 2_147_483_648],
      ['max_concurrency', 2_147_483_648],
      ['max_queue_count', 2_147_483_648],
      ['max_queue_bytes', 2_147_483_648],
      ['max_payload_bytes', 2_147_483_648],
      ['aggregate_cap_microcents', Number.MAX_SAFE_INTEGER + 1],
    ])('rejects invalid explicit execution bound %s=%j before querying', async (field, value) => {
      vi.stubEnv('SHADOW_ROUTING_ENABLED', 'true');
      const res = mockRes();
      await handleShadowExperiments(mockReq('POST', { ...VALID_BODY, [field]: value }), res as never, 'team-a');
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe('invalid_execution_bound');
      expect(queryMock).not.toHaveBeenCalled();
    });

    it('rejects an aggregate cap below the per-run cap before querying', async () => {
      vi.stubEnv('SHADOW_ROUTING_ENABLED', 'true');
      const res = mockRes();
      await handleShadowExperiments(
        mockReq('POST', { ...VALID_BODY, per_run_cap_microcents: 10, aggregate_cap_microcents: 9 }),
        res as never,
        'team-a',
      );
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe('invalid_execution_bound');
      expect(queryMock).not.toHaveBeenCalled();
    });

    it.each([
      ['starts_at', 'not-a-timestamp'],
      ['starts_at', '2026-02-30T00:00:00Z'],
      ['ends_at', '2026-01-01T24:00:00Z'],
      ['ends_at', '2026-01-01T00:00:00+16:00'],
      ['ends_at', '2026-01-01T00:00:00-16:00'],
      ['ends_at', 123],
    ])('rejects invalid POST timestamp %s=%j before querying', async (field, value) => {
      vi.stubEnv('SHADOW_ROUTING_ENABLED', 'true');
      const res = mockRes();
      await handleShadowExperiments(mockReq('POST', { ...VALID_BODY, [field]: value }), res as never, 'team-a');
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe('invalid_field');
      expect(queryMock).not.toHaveBeenCalled();
    });

    it("rejects '*' as team_id", async () => {
      vi.stubEnv('SHADOW_ROUTING_ENABLED', 'true');
      const res = mockRes();
      await handleShadowExperiments(
        mockReq('POST', { ...VALID_BODY, team_id: '*' }),
        res as never,
        'team-a',
      );
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe('invalid_tenant');
    });

    it('rejects mismatched team_id in body', async () => {
      vi.stubEnv('SHADOW_ROUTING_ENABLED', 'true');
      const res = mockRes();
      await handleShadowExperiments(
        mockReq('POST', { ...VALID_BODY, team_id: 'team-other' }),
        res as never,
        'team-a',
      );
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error.code).toBe('tenant_mismatch');
    });

    it('rejects invalid sample_rate_ppm', async () => {
      vi.stubEnv('SHADOW_ROUTING_ENABLED', 'true');
      const res = mockRes();
      await handleShadowExperiments(
        mockReq('POST', { ...VALID_BODY, sample_rate_ppm: 2_000_000 }),
        res as never,
        'team-a',
      );
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe('invalid_sample_rate');
    });

    it("rejects non-platform_funded funding_mode", async () => {
      vi.stubEnv('SHADOW_ROUTING_ENABLED', 'true');
      const res = mockRes();
      await handleShadowExperiments(
        mockReq('POST', { ...VALID_BODY, funding_mode: 'customer_credits' }),
        res as never,
        'team-a',
      );
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe('invalid_funding_mode');
    });
  });

  describe('PATCH /admin/shadow-experiments/:id', () => {
    it('rejects changes to immutable fields', async () => {
      vi.stubEnv('SHADOW_ROUTING_ENABLED', 'true');
      const res = mockRes();
      await handleShadowExperimentById(
        mockReq('PATCH', { sampling_version: 'v2' }),
        res as never,
        'team-a',
        'exp-1',
      );
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe('immutable_field');
    });

    it.each(['constructor', 'toString', '__proto__'])('rejects prototype-named mutable field %s', async (field) => {
      vi.stubEnv('SHADOW_ROUTING_ENABLED', 'true');
      const res = mockRes();
      await handleShadowExperimentById(mockReq('PATCH', JSON.parse(`{"${field}": true}`)), res as never, 'team-a', 'exp-1');
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe('invalid_field');
      expect(queryMock).not.toHaveBeenCalled();
    });

    it('fails closed when asked to enable without an approved consent workflow', async () => {
      vi.stubEnv('SHADOW_ROUTING_ENABLED', 'true');
      const res = mockRes();
      await handleShadowExperimentById(
        mockReq('PATCH', { enabled: true }),
        res as never,
        'team-a',
        'exp-1',
      );
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error.code).toBe('shadow_enablement_unavailable');
      expect(queryMock).not.toHaveBeenCalled();
    });

    it('rejects string boolean activation before Postgres can coerce it', async () => {
      vi.stubEnv('SHADOW_ROUTING_ENABLED', 'true');
      const res = mockRes();
      await handleShadowExperimentById(
        mockReq('PATCH', { enabled: 'true' }),
        res as never,
        'team-a',
        'exp-1',
      );
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe('invalid_enabled');
      expect(queryMock).not.toHaveBeenCalled();
    });

    it.each([-1, 1_000_001, 5_000_000, 1.5, '100'])(
      'rejects invalid PATCH sample_rate_ppm %j before querying',
      async (sample_rate_ppm) => {
        vi.stubEnv('SHADOW_ROUTING_ENABLED', 'true');
        const res = mockRes();
        await handleShadowExperimentById(
          mockReq('PATCH', { sample_rate_ppm }),
          res as never,
          'team-a',
          'exp-1',
        );
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).error.code).toBe('invalid_sample_rate');
        expect(queryMock).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['max_queue_count', 1.5],
      ['deadline_ms', 0],
      ['max_concurrency', 0],
      ['max_payload_bytes', 0],
      ['max_samples', 2_147_483_648],
      ['deadline_ms', 2_147_483_648],
      ['max_concurrency', 2_147_483_648],
      ['max_queue_count', 2_147_483_648],
      ['max_queue_bytes', 2_147_483_648],
      ['max_payload_bytes', 2_147_483_648],
    ])('rejects PATCH bound %s=%j before querying', async (field, value) => {
      vi.stubEnv('SHADOW_ROUTING_ENABLED', 'true');
      const res = mockRes();
      await handleShadowExperimentById(
        mockReq('PATCH', { [field]: value }),
        res as never,
        'team-a',
        'exp-1',
      );
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe('invalid_execution_bound');
      expect(queryMock).not.toHaveBeenCalled();
    });

    it('rejects a partial per-run cap update that would exceed the stored aggregate cap', async () => {
      vi.stubEnv('SHADOW_ROUTING_ENABLED', 'true');
      queryMock
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ invalid_execution_bounds: 'aggregate_cap_microcents' }] });
      const res = mockRes();
      await handleShadowExperimentById(
        mockReq('PATCH', { per_run_cap_microcents: 600 }),
        res as never,
        'team-a',
        'exp-1',
      );
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe('invalid_execution_bound');
      expect(JSON.parse(res.body).error.message).toContain('aggregate_cap_microcents');
      expect(queryMock).toHaveBeenCalledTimes(2);
      const diagnosticSql = queryMock.mock.calls[1][0] as string;
      expect(diagnosticSql).toContain('aggregate_cap_microcents < $1');
      expect(queryMock.mock.calls[1][1]).toEqual([600, 'team-a', 'exp-1']);
    });

    it('reports a legacy invalid bound as invalid_execution_bound instead of leaking a database constraint error', async () => {
      vi.stubEnv('SHADOW_ROUTING_ENABLED', 'true');
      queryMock
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ invalid_execution_bounds: 'deadline_ms, max_payload_bytes' }] });
      const res = mockRes();
      await handleShadowExperimentById(mockReq('PATCH', { name: 'renamed' }), res as never, 'team-a', 'exp-1');
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe('invalid_execution_bound');
      expect(JSON.parse(res.body).error.message).toContain('deadline_ms, max_payload_bytes');
      expect(JSON.parse(res.body).error.message).toContain('repair all invalid bounds atomically');
      const sql = queryMock.mock.calls[0][0] as string;
      expect(sql).toContain('deadline_ms > 0');
      expect(sql).toContain('max_payload_bytes > 0');
      const diagnosticSql = queryMock.mock.calls[1][0] as string;
      expect(diagnosticSql).toContain('team_id = $1 AND id = $2');
      expect(queryMock.mock.calls[1][1]).toEqual(['team-a', 'exp-1']);
    });

    it.each([
      ['starts_at', '2026-02-30T00:00:00Z'],
      ['kill_switch_at', '2026-01-01T24:00:00Z'],
      ['ends_at', '2026-01-01T00:00:00+16:00'],
    ])('rejects a timestamp Postgres would reject before querying: %s=%s', async (field, value) => {
      vi.stubEnv('SHADOW_ROUTING_ENABLED', 'true');
      const res = mockRes();
      await handleShadowExperimentById(mockReq('PATCH', { [field]: value }), res as never, 'team-a', 'exp-1');
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe('invalid_field');
      expect(queryMock).not.toHaveBeenCalled();
    });

    it('accepts a partial aggregate cap update when it remains above the stored per-run cap', async () => {
      vi.stubEnv('SHADOW_ROUTING_ENABLED', 'true');
      queryMock.mockResolvedValue({ rows: [{ id: 'exp-1', aggregate_cap_microcents: 600 }] });
      const res = mockRes();
      await handleShadowExperimentById(
        mockReq('PATCH', { aggregate_cap_microcents: 600 }),
        res as never,
        'team-a',
        'exp-1',
      );
      expect(res.statusCode).toBe(200);
      expect(queryMock.mock.calls[0][0]).toContain('$1 >= per_run_cap_microcents');
    });

    it('updates mutable non-enablement fields with global operator-selected team scope', async () => {
      vi.stubEnv('SHADOW_ROUTING_ENABLED', 'true');
      queryMock.mockResolvedValue({ rows: [{ id: 'exp-1', enabled: false }] });
      const res = mockRes();
      await handleShadowExperimentById(
        mockReq('PATCH', { max_samples: 42 }),
        res as never,
        'team-a',
        'exp-1',
      );
      expect(res.statusCode).toBe(200);
      const sql = queryMock.mock.calls[0][0] as string;
      expect(sql).toContain('team_id');
      expect(sql).toContain('updated_at = now()');
    });
  });

  describe('DELETE /admin/shadow-experiments/:id', () => {
    it('deletes with global operator-selected team scope', async () => {
      vi.stubEnv('SHADOW_ROUTING_ENABLED', 'true');
      queryMock.mockResolvedValue({ rowCount: 1 });
      const res = mockRes();
      await handleShadowExperimentById(mockReq('DELETE'), res as never, 'team-a', 'exp-1');
      expect(res.statusCode).toBe(200);
      const sql = queryMock.mock.calls[0][0] as string;
      expect(sql).toContain('team_id = $1');
      expect(sql).toContain('id = $2');
    });

    it('returns 404 for non-existent experiment', async () => {
      vi.stubEnv('SHADOW_ROUTING_ENABLED', 'true');
      queryMock.mockResolvedValue({ rowCount: 0 });
      const res = mockRes();
      await handleShadowExperimentById(mockReq('DELETE'), res as never, 'team-a', 'exp-missing');
      expect(res.statusCode).toBe(404);
    });
  });
});
