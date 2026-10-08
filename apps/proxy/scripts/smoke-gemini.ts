/**
 * Live smoke test for the Gemini structured-output + tool-schema translation.
 * Drives the REAL GeminiProvider.buildRequest/parseResponse against the live
 * Developer API. Not committed — delete after running.
 *
 * Run: GEMINI_API_KEY=... npx tsx scripts/smoke-gemini.ts
 */
import { GeminiProvider } from '../src/providers/gemini.js';
import type { CanonicalRequest } from '@routeshift/shared';

const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
if (!apiKey) {
  console.error('Set GEMINI_API_KEY (or GOOGLE_API_KEY) in env.');
  process.exit(2);
}

const MODEL = process.env.GEMINI_SMOKE_MODEL || 'gemini-2.5-flash';
const provider = new GeminiProvider();

async function send(req: CanonicalRequest): Promise<{ status: number; body: any }> {
  const pr = provider.buildRequest(req, apiKey!);
  const resp = await fetch(pr.url, { method: pr.method, headers: pr.headers, body: pr.body });
  const text = await resp.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: resp.status, body };
}

let failures = 0;
const ok = (label: string, cond: boolean, detail?: string) => {
  console.log(`${cond ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

async function main() {
  console.log(`\n# Gemini live smoke — model=${MODEL}\n`);

  // --- Test A: structured output via response_format json_schema (additionalProperties:false) ---
  const schemaA = {
    type: 'object',
    properties: { city: { type: 'string' }, population: { type: 'integer' } },
    required: ['city', 'population'],
    additionalProperties: false,
  };
  const reqA: CanonicalRequest = {
    model: MODEL,
    messages: [{ role: 'user', content: 'Return the city of France with the largest population and its approximate population.' }],
    response_format: { type: 'json_schema', json_schema: { name: 'city_pop', schema: schemaA } },
    stream: false,
  };
  const a = await send(reqA);
  ok('A: response_format json_schema -> HTTP 200', a.status === 200, `status=${a.status}${a.status !== 200 ? ` body=${JSON.stringify(a.body).slice(0, 400)}` : ''}`);
  if (a.status === 200) {
    const parsed = provider.parseResponse(a.body);
    let obj: any = null;
    try { obj = JSON.parse(parsed.content as string); } catch { /* not JSON */ }
    ok('A: model output is valid JSON', obj !== null, `raw=${String(parsed.content).slice(0, 200)}`);
    ok('A: JSON matches schema keys (city:string, population:integer)',
      !!obj && typeof obj.city === 'string' && Number.isInteger(obj.population),
      obj ? JSON.stringify(obj) : '');
  }

  // --- Test B: json_object mode (no schema) ---
  const reqB: CanonicalRequest = {
    model: MODEL,
    messages: [{ role: 'user', content: 'Give me a JSON object with keys "ok" (boolean true) and "n" (the number 7).' }],
    response_format: { type: 'json_object' },
    stream: false,
  };
  const b = await send(reqB);
  ok('B: response_format json_object -> HTTP 200', b.status === 200, `status=${b.status}`);
  if (b.status === 200) {
    const parsed = provider.parseResponse(b.body);
    let obj: any = null;
    try { obj = JSON.parse(parsed.content as string); } catch { /* */ }
    ok('B: json_object output is valid JSON', obj !== null, String(parsed.content).slice(0, 200));
  }

  // --- Test C: tool schema with additionalProperties:false via parametersJsonSchema ---
  const toolSchema = {
    type: 'object',
    properties: { city: { type: 'string' }, units: { type: 'string', enum: ['c', 'f'] } },
    required: ['city'],
    additionalProperties: false,
  };
  const reqC: CanonicalRequest = {
    model: MODEL,
    messages: [{ role: 'user', content: "What's the weather in Paris? Use the tool." }],
    tools: [{ type: 'function', function: { name: 'get_weather', description: 'Get current weather for a city', parameters: toolSchema } }],
    tool_choice: 'required',
    stream: false,
  };
  const c = await send(reqC);
  // The whole point: additionalProperties:false used to 400 against the OpenAPI-subset
  // `parameters` field. Via parametersJsonSchema it must validate (HTTP 200).
  ok('C: tool params with additionalProperties:false -> HTTP 200 (no schema 400)', c.status === 200,
    `status=${c.status}${c.status !== 200 ? ` body=${JSON.stringify(c.body).slice(0, 400)}` : ''}`);
  if (c.status === 200) {
    const parsed = provider.parseResponse(c.body);
    const call = parsed.tool_calls?.[0];
    ok('C: model returned a function call to get_weather', call?.function?.name === 'get_weather',
      call ? JSON.stringify(call.function) : `stop=${parsed.stop_reason}`);
  }

  console.log(`\n${failures === 0 ? '✅ ALL PASS' : `❌ ${failures} FAILURE(S)`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('smoke crashed:', e); process.exit(1); });
