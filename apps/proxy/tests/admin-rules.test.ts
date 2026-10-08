import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  checkLimit: vi.fn(),
  invalidateRuleCache: vi.fn(),
  randomUUID: vi.fn(),
}));

vi.mock('../src/db/pool.js', () => ({
  getPool: () => ({ query: mocks.query }),
}));

vi.mock('../src/billing/plan-limits.js', () => ({
  checkLimit: mocks.checkLimit,
}));

vi.mock('../src/routing/rule-cache.js', () => ({
  invalidateRuleCache: mocks.invalidateRuleCache,
}));

vi.mock('node:crypto', () => ({
  randomUUID: mocks.randomUUID,
}));

import { handleCreateRule, handleDeleteRule, handleListRules, handleUpdateRule } from '../src/admin/rules.js';

function makeReq(options?: { url?: string; body?: string }): IncomingMessage {
  const stream = Readable.from(options?.body !== undefined ? [Buffer.from(options.body)] : []);
  return Object.assign(stream, {
    url: options?.url ?? '/',
    headers: { host: 'localhost' },
  }) as IncomingMessage;
}

function makeRes() {
  let statusCode = 0;
  let body = '';
  const headers: Record<string, string> = {};
  const res = {
    writeHead(code: number, nextHeaders: Record<string, string>) {
      statusCode = code;
      Object.assign(headers, nextHeaders);
      return this;
    },
    end(chunk?: string) {
      body = chunk ?? '';
      return this;
    },
  } as unknown as ServerResponse;

  return {
    res,
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
    get headers() {
      return headers;
    },
  };
}

describe('admin rules handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.randomUUID.mockReturnValue('rule-id-123');
    mocks.checkLimit.mockResolvedValue({ allowed: true, current: 1, limit: 100 });
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('rejects a create whose condition.custom the evaluator would silently ignore', async () => {
    const req = makeReq({ url: '/admin/rules', body: JSON.stringify({
      team_id: 'team_a', name: 'r', condition: { custom: { dept: 'research' } },
      action: { type: 'route', target_model: 'gpt-4.1' },
    }) });
    const out = makeRes();
    await handleCreateRule(req, out.res);
    expect(out.statusCode).toBe(400);
    expect(out.body).toContain('custom');
    expect(mocks.query).not.toHaveBeenCalled(); // never persisted
  });

  it('rejects a create with an unsupported modify field', async () => {
    const req = makeReq({ url: '/admin/rules', body: JSON.stringify({
      team_id: 'team_a', name: 'r', action: { type: 'modify', modifications: { max_tokens: 10 } },
    }) });
    const out = makeRes();
    await handleCreateRule(req, out.res);
    expect(out.statusCode).toBe(400);
    expect(out.body).toContain('max_tokens');
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('allows a create with a supported modify action', async () => {
    const action = { type: 'modify', modifications: { max_output_tokens: 500 } };
    const req = makeReq({ url: '/admin/rules', body: JSON.stringify({
      team_id: 'team_a', name: 'r', action,
    }) });
    const out = makeRes();
    await handleCreateRule(req, out.res);

    expect(out.statusCode).toBe(201);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    const values = mocks.query.mock.calls[0][1] as unknown[];
    expect(JSON.parse(values[7] as string)).toEqual(action);
  });

  it('rejects a create whose supported modify field has the wrong value shape', async () => {
    // A supported KEY with a value the evaluator's applyModifications() would
    // silently ignore (max_output_tokens must be a positive number, not a
    // string) must be rejected here too -- otherwise the rule persists as
    // "active" while doing nothing, the exact gap this gate exists to close.
    const req = makeReq({ url: '/admin/rules', body: JSON.stringify({
      team_id: 'team_a', name: 'r',
      action: { type: 'modify', modifications: { max_output_tokens: '500' } },
    }) });
    const out = makeRes();
    await handleCreateRule(req, out.res);
    expect(out.statusCode).toBe(400);
    expect(out.body).toContain('max_output_tokens');
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('rejects a create with an empty-string model_requested modify value', async () => {
    const req = makeReq({ url: '/admin/rules', body: JSON.stringify({
      team_id: 'team_a', name: 'r',
      action: { type: 'modify', modifications: { model_requested: '' } },
    }) });
    const out = makeRes();
    await handleCreateRule(req, out.res);
    expect(out.statusCode).toBe(400);
    expect(out.body).toContain('model_requested');
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('rejects a create with a non-string-array add_tags modify value', async () => {
    const req = makeReq({ url: '/admin/rules', body: JSON.stringify({
      team_id: 'team_a', name: 'r',
      action: { type: 'modify', modifications: { add_tags: 'not-an-array' } },
    }) });
    const out = makeRes();
    await handleCreateRule(req, out.res);
    expect(out.statusCode).toBe(400);
    expect(out.body).toContain('add_tags');
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('rejects an update that introduces condition.custom', async () => {
    const req = makeReq({ url: '/admin/rules/rule-1?team_id=team_a', body: JSON.stringify({
      condition: { custom: { dept: 'x' } },
    }) });
    const out = makeRes();
    await handleUpdateRule(req, out.res, 'rule-1');
    expect(out.statusCode).toBe(400);
    expect(out.body).toContain('custom');
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid create body JSON', async () => {
    const out = makeRes();
    await handleCreateRule(makeReq({ body: '{' }), out.res);

    expect(out.statusCode).toBe(400);
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'Invalid JSON in request body' } });
  });

  it('returns 403 when rule limit is reached', async () => {
    mocks.checkLimit.mockResolvedValueOnce({ allowed: false, current: 10, limit: 10 });
    const out = makeRes();

    await handleCreateRule(
      makeReq({ body: JSON.stringify({ team_id: 'team_1', name: 'Rule A', action: { type: 'route' } }) }),
      out.res,
    );

    expect(out.statusCode).toBe(403);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('returns 400 when required create fields are missing', async () => {
    const out = makeRes();

    await handleCreateRule(
      makeReq({ body: JSON.stringify({ team_id: 'team_1', name: 'Incomplete' }) }),
      out.res,
    );

    expect(out.statusCode).toBe(400);
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'name and action are required' } });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('returns 400 when create team_id is missing', async () => {
    const out = makeRes();

    await handleCreateRule(
      makeReq({ body: JSON.stringify({ name: 'Rule A', action: { type: 'route' } }) }),
      out.res,
    );

    expect(out.statusCode).toBe(400);
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'team_id is required' } });
    expect(mocks.checkLimit).not.toHaveBeenCalled();
  });

  it('rejects a wildcard team_id when creating a rule (cannot create global rules)', async () => {
    const out = makeRes();

    await handleCreateRule(
      makeReq({ body: JSON.stringify({ team_id: '*', name: 'Rule A', action: { type: 'route' } }) }),
      out.res,
    );

    expect(out.statusCode).toBe(400);
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'team_id wildcard is not allowed' } });
    expect(mocks.checkLimit).not.toHaveBeenCalled();
  });

  it('returns 400 for non-object create JSON payload', async () => {
    const out = makeRes();
    await handleCreateRule(makeReq({ body: '1' }), out.res);

    expect(out.statusCode).toBe(400);
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'Invalid JSON in request body' } });
  });

  it('creates a rule and invalidates cache', async () => {
    const out = makeRes();

    await handleCreateRule(
      makeReq({
        body: JSON.stringify({
          team_id: 'team_1',
          name: 'Route to cheap model',
          priority: 100,
          condition: { model_contains: 'gpt' },
          action: { type: 'route', provider: 'openai' },
        }),
      }),
      out.res,
    );

    expect(out.statusCode).toBe(201);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO routing_rules'),
      [
        'rule-id-123',
        'team_1',
        'Route to cheap model',
        null,
        100,
        true,
        JSON.stringify({ model_contains: 'gpt' }),
        JSON.stringify({ type: 'route', provider: 'openai' }),
      ],
    );
    expect(mocks.invalidateRuleCache).toHaveBeenCalledTimes(1);
  });

  it('lists team rules plus wildcard rules', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ id: 'r1', team_id: 'team_1' }, { id: 'r2', team_id: '*' }],
      rowCount: 2,
    });
    const out = makeRes();

    await handleListRules(makeReq({ url: '/admin/rules?team_id=team_1' }), out.res);

    expect(out.statusCode).toBe(200);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE (team_id = $1 OR team_id ='),
      ['team_1'],
    );
    expect(JSON.parse(out.body)).toEqual([{ id: 'r1', team_id: 'team_1' }, { id: 'r2', team_id: '*' }]);
  });

  it('requires team_id when listing rules', async () => {
    const out = makeRes();
    await handleListRules(makeReq({ url: '/admin/rules' }), out.res);

    expect(out.statusCode).toBe(400);
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'team_id query parameter is required' } });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid update JSON body', async () => {
    const out = makeRes();
    await handleUpdateRule(makeReq({ url: '/admin/rules/r1?team_id=team_1', body: '{' }), out.res, 'r1');

    expect(out.statusCode).toBe(400);
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'Invalid JSON in request body' } });
  });

  it('returns 400 for non-object update JSON payload', async () => {
    const out = makeRes();
    await handleUpdateRule(makeReq({ url: '/admin/rules/r1?team_id=team_1', body: 'true' }), out.res, 'r1');

    expect(out.statusCode).toBe(400);
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'Invalid JSON in request body' } });
  });

  it('returns 400 when update has no fields', async () => {
    const out = makeRes();
    await handleUpdateRule(makeReq({ url: '/admin/rules/r1?team_id=team_1', body: '{}' }), out.res, 'r1');

    expect(out.statusCode).toBe(400);
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'No fields to update' } });
  });

  it('updates a team-scoped rule', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const out = makeRes();

    await handleUpdateRule(
      makeReq({
        url: '/admin/rules/r1?team_id=team_1',
        body: JSON.stringify({ name: 'Updated', enabled: false, action: { type: 'drop' } }),
      }),
      out.res,
      'r1',
    );

    expect(out.statusCode).toBe(200);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE routing_rules SET'),
      ['Updated', false, JSON.stringify({ type: 'drop' }), 'r1', 'team_1'],
    );
    expect(mocks.invalidateRuleCache).toHaveBeenCalledTimes(1);
  });

  it('requires team_id when updating a rule', async () => {
    const out = makeRes();
    await handleUpdateRule(makeReq({ url: '/admin/rules/r1', body: JSON.stringify({ name: 'Updated' }) }), out.res, 'r1');

    expect(out.statusCode).toBe(400);
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'team_id query parameter is required' } });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('returns 404 when updating a missing rule', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const out = makeRes();

    await handleUpdateRule(
      makeReq({
        url: '/admin/rules/missing?team_id=team_1',
        body: JSON.stringify({ priority: 250, condition: { model: 'x' } }),
      }),
      out.res,
      'missing',
    );

    expect(out.statusCode).toBe(404);
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'Rule not found' } });
    expect(mocks.invalidateRuleCache).toHaveBeenCalledTimes(1);
  });

  it('deletes a team-scoped rule and returns 404 when not found', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const notFound = makeRes();

    await handleDeleteRule(makeReq({ url: '/admin/rules/r1?team_id=team_1' }), notFound.res, 'r1');

    expect(notFound.statusCode).toBe(404);
    expect(mocks.invalidateRuleCache).toHaveBeenCalledTimes(1);

    mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const ok = makeRes();
    await handleDeleteRule(makeReq({ url: '/admin/rules/r1?team_id=team_1' }), ok.res, 'r1');

    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ deleted: true });
    expect(mocks.invalidateRuleCache).toHaveBeenCalledTimes(2);
  });

  it('requires team_id when deleting a rule', async () => {
    const out = makeRes();
    await handleDeleteRule(makeReq({ url: '/admin/rules/r1' }), out.res, 'r1');

    expect(out.statusCode).toBe(400);
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'team_id query parameter is required' } });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('rejects a wildcard team_id when updating a rule (cannot mutate global rules)', async () => {
    const out = makeRes();
    await handleUpdateRule(
      makeReq({ url: '/admin/rules/r1?team_id=*', body: JSON.stringify({ name: 'Updated' }) }),
      out.res,
      'r1',
    );

    expect(out.statusCode).toBe(400);
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'team_id wildcard is not allowed' } });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('rejects a wildcard team_id when deleting a rule (cannot remove global rules)', async () => {
    const out = makeRes();
    await handleDeleteRule(makeReq({ url: '/admin/rules/r1?team_id=*' }), out.res, 'r1');

    expect(out.statusCode).toBe(400);
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'team_id wildcard is not allowed' } });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  const validGate = {
    version: 1, mode: 'cascade', on_stream: 'reject', unknown_signal: 'reject',
    multi_attempt_billing_ack: true,
    checks: [{ type: 'stop_reason', reject: ['max_tokens'] }],
  };

  it('allows a create with a valid quality_gate on a route action and persists it unchanged', async () => {
    const action = { type: 'route', target_model: 'gpt-4.1', quality_gate: validGate };
    const req = makeReq({ url: '/admin/rules', body: JSON.stringify({ team_id: 'team_a', name: 'r', action }) });
    const out = makeRes();
    await handleCreateRule(req, out.res);

    expect(out.statusCode).toBe(201);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    const values = mocks.query.mock.calls[0][1] as unknown[];
    expect(JSON.parse(values[7] as string)).toEqual(action);
  });

  it('rejects a create with quality_gate on a non-route action', async () => {
    const req = makeReq({ url: '/admin/rules', body: JSON.stringify({
      team_id: 'team_a', name: 'r',
      action: { type: 'block', block_reason: 'nope', quality_gate: validGate },
    }) });
    const out = makeRes();
    await handleCreateRule(req, out.res);

    expect(out.statusCode).toBe(400);
    expect(out.body).toContain('quality_gate');
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('rejects a create whose quality_gate fails strict validation (wrong version)', async () => {
    const req = makeReq({ url: '/admin/rules', body: JSON.stringify({
      team_id: 'team_a', name: 'r',
      action: { type: 'route', target_model: 'gpt-4.1', quality_gate: { ...validGate, version: 2 } },
    }) });
    const out = makeRes();
    await handleCreateRule(req, out.res);

    expect(out.statusCode).toBe(400);
    expect(out.body).toContain('version');
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('rejects a create whose quality_gate has an unknown field', async () => {
    const req = makeReq({ url: '/admin/rules', body: JSON.stringify({
      team_id: 'team_a', name: 'r',
      action: { type: 'route', target_model: 'gpt-4.1', quality_gate: { ...validGate, billing: 'customer' } },
    }) });
    const out = makeRes();
    await handleCreateRule(req, out.res);

    expect(out.statusCode).toBe(400);
    expect(out.body).toContain('billing');
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
