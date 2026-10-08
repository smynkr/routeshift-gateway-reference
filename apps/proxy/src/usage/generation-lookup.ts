import type { IncomingMessage, ServerResponse } from 'node:http';
import { getPool } from '../db/pool.js';
import { validateApiKey } from '../auth/api-key.js';
import { keyHasReadScope } from '../auth/scope.js';

interface GenerationRow {
  id: string; model_resolved: string; provider: string; timestamp: string;
  input_tokens: number; output_tokens: number; actual_cost_microcents: number;
  plugin_cost_microcents: number;
  total_latency_ms: number; ttft_ms: number | null; is_streaming: boolean;
}

export async function getGeneration(id: string, teamId: string): Promise<GenerationRow | null> {
  const pool = getPool();
  // ALWAYS team-scoped. There is no code path that selects by id alone.
  const { rows } = await pool.query(
    `SELECT id, model_resolved, provider, timestamp, input_tokens, output_tokens,
            actual_cost_microcents, COALESCE(plugin_cost_microcents, 0) AS plugin_cost_microcents,
            total_latency_ms, ttft_ms, is_streaming
       FROM request_logs WHERE id = $1 AND team_id = $2 LIMIT 1`,
    [id, teamId],
  );
  return rows[0] ?? null;
}

export async function handleGenerationLookup(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = req.headers['authorization'];
  const key = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!key || !key.startsWith('sk-proxy-')) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'API key required' } }));
    return;
  }
  const info = await validateApiKey(key);
  if (!info) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
    return;
  }
  const teamId = info.teamId;
  if (!keyHasReadScope(info.metadata)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'insufficient_scope: missing read scope', code: 'insufficient_scope' } }));
    return;
  }
  const id = new URL(req.url ?? '', 'http://x').searchParams.get('id') ?? '';
  const row = id ? await getGeneration(id, teamId) : null;
  if (!row) {
    // Request logs are written asynchronously, so a freshly-created generation
    // can transiently 404 until persistence catches up.
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Generation not found', code: 'generation_not_found' } }));
    return;
  }
  // generation_time = total latency minus time-to-first-token (the streaming
  // body window). Clamp at 0 so malformed/clock-skewed rows can never report a
  // negative duration to billing/SLA consumers.
  const genTime = Math.max(
    0,
    row.ttft_ms != null ? row.total_latency_ms - row.ttft_ms : row.total_latency_ms,
  );
  // request_logs does not yet persist cancellation or cache-discount fields.
  // Return null rather than presenting false/zero placeholders as facts.
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    data: {
      id: row.id,
      model: row.model_resolved,
      provider_name: row.provider,
      created_at: row.timestamp,
      streamed: row.is_streaming,
      cancelled: null,
      tokens_prompt: row.input_tokens,
      tokens_completion: row.output_tokens,
      total_cost: (Number(row.actual_cost_microcents) + Number(row.plugin_cost_microcents ?? 0)) / 1e8,
      cache_discount: null,
      latency: row.total_latency_ms,
      generation_time: genTime,
    },
  }));
}
