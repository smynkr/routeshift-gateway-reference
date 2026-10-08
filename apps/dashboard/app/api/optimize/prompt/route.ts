// LAY-353: server endpoint for the prompt-optimizer v1.
//
// Backend selectable via OPTIMIZER_PROVIDER:
//   - bedrock   (recommended)  → AWS Bedrock, Claude on AWS infra
//   - azure                    → Azure OpenAI Service
//   - anthropic (default)      → Anthropic API direct
//
// Each backend returns a uniform {optimized, inputTokens, outputTokens,
// modelUsed} so the cost-delta calc downstream is provider-agnostic.
//
// v1 calls the chosen provider directly with server-side credentials.
// Routing through the user's own RouteShift proxy so the optimization
// shows up in their /billing telemetry is the natural follow-up — see
// the v1.5 note in LAY-353.

import { NextResponse } from 'next/server';
import aws4 from 'aws4';
import { requireTeamMembership } from '@/lib/rbac';
import { checkRateLimit, rateLimitedResponse } from '@/lib/rate-limit';
import { DEMO_WRITE_BLOCKED_MESSAGE, isDemoActive } from '@/lib/demo';
import { getModelPricing } from '@routeshift/shared';

const MAX_INPUT_CHARS = 40_000; // ~10k tokens; anything bigger likely a paste error
const MAX_OUTPUT_TOKENS = 4096;

type Mode = 'compress' | 'clarify' | 'both';
type Provider = 'bedrock' | 'azure' | 'anthropic'; // not-a-provider-allowlist — optimize-prompt runtime subset

const META_PROMPTS: Record<Mode, string> = {
  compress: [
    'You are a prompt-compression assistant. Rewrite the user-supplied system prompt to be 30-50% shorter while preserving every behavior, constraint, edge case, output-format rule, and tool/function reference verbatim or by exact equivalent.',
    'Drop redundant phrasing. Merge near-duplicate rules. Prefer dense imperative voice ("Do X" over "You should consider doing X").',
    'Do not add new rules. Do not soften strict requirements. Do not change persona or scope.',
    'Return ONLY the rewritten prompt — no preamble, no commentary, no markdown fences.',
  ].join(' '),
  clarify: [
    'You are a prompt-clarity assistant. Rewrite the user-supplied system prompt to resolve ambiguity and improve structural clarity.',
    'Restructure into a consistent ordering: role → primary task → constraints → output format → examples (if any). Make implicit expectations explicit. Convert vague qualifiers ("appropriate", "as needed") into concrete criteria.',
    'Length may grow modestly if it improves clarity. Preserve every behavioral rule and tool reference.',
    'Return ONLY the rewritten prompt — no preamble, no commentary, no markdown fences.',
  ].join(' '),
  both: [
    'You are a prompt-rewriting assistant. Rewrite the user-supplied system prompt to be both shorter (target 20-30% reduction) AND clearer (resolve ambiguity, restructure into role → task → constraints → format).',
    'Preserve every behavioral rule, constraint, edge case, and tool reference. Do not add new requirements.',
    'Return ONLY the rewritten prompt — no preamble, no commentary, no markdown fences.',
  ].join(' '),
};

interface OptimizeOutput {
  optimized: string;
  inputTokens: number;
  outputTokens: number;
  modelUsed: string;
  pricingProvider: string; // for getModelPricing lookup ("anthropic", "openai", etc.)
  pricingModel: string;
}

function isMode(value: unknown): value is Mode {
  return value === 'compress' || value === 'clarify' || value === 'both';
}

function pickProvider(): Provider {
  const raw = (process.env.OPTIMIZER_PROVIDER ?? 'anthropic').toLowerCase();
  if (raw === 'bedrock' || raw === 'azure' || raw === 'anthropic') return raw; // not-a-provider-allowlist
  return 'anthropic';
}

// ── Bedrock (recommended) ─────────────────────────────────────────────────
// Default deployment-string for Claude Sonnet 4.5 on Bedrock. The actual
// inference profile varies by region — we accept the full ID via
// OPTIMIZER_MODEL so users can plug in their region's profile (e.g.
// us.anthropic.claude-sonnet-4-5-20250929-v1:0 for cross-region inference).
// Bedrock requires the `us.` cross-region inference profile for Sonnet 4.6 —
// the bare model ID returns "on-demand throughput isn't supported" because
// AWS gates direct invokes for newer Anthropic models. Verified empirically
// 2026-04-30 via direct curl. No date suffix, no `:0` revision.
const BEDROCK_DEFAULT_MODEL = 'us.anthropic.claude-sonnet-4-6';

async function runBedrock(prompt: string, mode: Mode): Promise<OptimizeOutput> {
  const region = process.env.AWS_BEDROCK_REGION;
  const modelId = process.env.OPTIMIZER_MODEL ?? BEDROCK_DEFAULT_MODEL;
  if (!region) {
    throw new Error('Bedrock optimizer not configured. Set AWS_BEDROCK_REGION.');
  }

  // Two auth modes:
  //   1. AWS_BEDROCK_API_KEY (preferred, 2025+) — long-term Bedrock API key,
  //      Bearer auth, no signing. Format: ABSK<base64>.
  //   2. AWS_BEDROCK_ACCESS_KEY_ID + AWS_BEDROCK_SECRET_ACCESS_KEY (legacy) —
  //      IAM keys via sigv4 signing.
  // Prefer the API key if set; fall back to sigv4. Never log either.
  const apiKey = process.env.AWS_BEDROCK_API_KEY;
  const accessKeyId = process.env.AWS_BEDROCK_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_BEDROCK_SECRET_ACCESS_KEY;
  if (!apiKey && !(accessKeyId && secretAccessKey)) {
    throw new Error(
      'Bedrock optimizer not configured. Set AWS_BEDROCK_API_KEY (preferred) or AWS_BEDROCK_ACCESS_KEY_ID + AWS_BEDROCK_SECRET_ACCESS_KEY.',
    );
  }

  const host = `bedrock-runtime.${region}.amazonaws.com`;
  const path = `/model/${encodeURIComponent(modelId)}/invoke`;
  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: MAX_OUTPUT_TOKENS,
    system: META_PROMPTS[mode],
    messages: [{ role: 'user', content: prompt }],
  });

  const headers: Record<string, string> = apiKey
    ? { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }
    : (aws4.sign(
        {
          service: 'bedrock',
          region,
          method: 'POST',
          host,
          path,
          headers: { 'Content-Type': 'application/json' },
          body,
        },
        { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! },
      ).headers as Record<string, string>);

  const res = await fetch(`https://${host}${path}`, {
    method: 'POST',
    headers,
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '<unreadable>');
    throw new Error(`Bedrock returned ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens: number; output_tokens: number };
    model?: string;
  };
  const optimized = data.content?.find((c) => c.type === 'text')?.text?.trim() ?? '';
  if (!optimized) throw new Error('Bedrock returned empty content');

  // Strip the cross-region "us./eu./apac." inference-profile prefix so
  // pricing lookups match the canonical model id in cost-tables.
  const canonicalModel = modelId.replace(/^(us|eu|apac)\./, '');
  return {
    optimized,
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
    modelUsed: canonicalModel,
    pricingProvider: 'anthropic', // Bedrock-Anthropic prices map under the anthropic provider in cost-tables
    pricingModel: canonicalModel.replace(/^anthropic\./, '').replace(/-v\d+:0$/, ''),
  };
}

// ── Azure OpenAI ──────────────────────────────────────────────────────────
async function runAzure(prompt: string, mode: Mode): Promise<OptimizeOutput> {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION ?? '2024-10-21';
  if (!endpoint || !apiKey || !deployment) {
    throw new Error(
      'Azure optimizer not configured. Set AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, AZURE_OPENAI_DEPLOYMENT.',
    );
  }

  const url = `${endpoint.replace(/\/$/, '')}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: META_PROMPTS[mode] },
        { role: 'user', content: prompt },
      ],
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0.3,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '<unreadable>');
    throw new Error(`Azure returned ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens: number; completion_tokens: number };
    model?: string;
  };
  const optimized = data.choices?.[0]?.message?.content?.trim() ?? '';
  if (!optimized) throw new Error('Azure returned empty content');

  // Azure's `model` field comes back as the underlying base model name
  // (e.g. "gpt-4o-2024-08-06"), which is what cost-tables keys on. The
  // deployment name is just the user's alias.
  const baseModel = data.model ?? deployment;
  return {
    optimized,
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    modelUsed: baseModel,
    pricingProvider: 'openai', // Azure OpenAI prices align with OpenAI in cost-tables
    pricingModel: baseModel.replace(/-\d{4}-\d{2}-\d{2}$/, ''), // strip date suffix for lookup
  };
}

// ── Anthropic direct ──────────────────────────────────────────────────────
async function runAnthropic(prompt: string, mode: Mode): Promise<OptimizeOutput> {
  const apiKey = process.env.OPTIMIZER_ANTHROPIC_KEY;
  const model = process.env.OPTIMIZER_MODEL ?? 'claude-sonnet-4-5-20250929';
  if (!apiKey) {
    throw new Error('Anthropic optimizer not configured. Set OPTIMIZER_ANTHROPIC_KEY.');
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: META_PROMPTS[mode],
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '<unreadable>');
    throw new Error(`Anthropic returned ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens: number; output_tokens: number };
    model?: string;
  };
  const optimized = data.content?.find((c) => c.type === 'text')?.text?.trim() ?? '';
  if (!optimized) throw new Error('Anthropic returned empty content');
  return {
    optimized,
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
    modelUsed: data.model ?? model,
    pricingProvider: 'anthropic',
    pricingModel: data.model ?? model,
  };
}

// ──────────────────────────────────────────────────────────────────────────

export async function POST(req: Request): Promise<NextResponse> {
  // Demo mode must never trigger a paid, operator-credentialed LLM call.
  if (await isDemoActive()) {
    return NextResponse.json({ error: DEMO_WRITE_BLOCKED_MESSAGE }, { status: 403 });
  }
  const member = await requireTeamMembership();
  if (!member) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // RSH-52: this route makes a paid, operator-credentialed LLM call. Throttle
  // per team so a single team can't run up provider spend by hammering it.
  const rl = checkRateLimit(`optimize-prompt:${member.teamId}`, {
    limit: 20,
    windowMs: 60_000,
  });
  if (!rl.allowed) return rateLimitedResponse(rl);

  // Cap operator-funded LLM spend at 200/team/day because this bypasses team credits/budgets entirely.
  const dailyRl = checkRateLimit(`optimize-prompt-daily:${member.teamId}`, {
    limit: 200,
    windowMs: 86_400_000,
  });
  if (!dailyRl.allowed) return rateLimitedResponse(dailyRl);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { prompt, mode } = (body ?? {}) as { prompt?: unknown; mode?: unknown };
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    return NextResponse.json({ error: 'prompt must be a non-empty string' }, { status: 400 });
  }
  if (prompt.length > MAX_INPUT_CHARS) {
    return NextResponse.json(
      { error: `prompt exceeds ${MAX_INPUT_CHARS} character limit` },
      { status: 400 },
    );
  }
  if (!isMode(mode)) {
    return NextResponse.json({ error: 'mode must be compress|clarify|both' }, { status: 400 });
  }

  const provider = pickProvider();
  let result: OptimizeOutput;
  try {
    if (provider === 'bedrock') result = await runBedrock(prompt, mode);
    else if (provider === 'azure') result = await runAzure(prompt, mode);
    else result = await runAnthropic(prompt, mode);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Optimizer failed';
    // Misconfiguration is the operator's problem, not the user's — surface
    // it as 503 (service unavailable) so the dashboard can render a clean
    // "set the env vars" message instead of looking like a 500 outage.
    const status = /not configured/i.test(message) ? 503 : 502;
    console.error('optimize-prompt:', message);
    return NextResponse.json({ error: message }, { status });
  }

  // Back out the meta-prompt's share of input tokens so the metric users
  // see reflects only the cost of *their* prompt, not the optimizer's
  // overhead. Char/4 is a ±5% approximation; good enough for a delta.
  const metaTokensApprox = Math.ceil(META_PROMPTS[mode].length / 4);
  const userPromptTokens = Math.max(1, result.inputTokens - metaTokensApprox);

  // Cost-per-1K-calls estimate using the same cost-tables source the
  // /billing dashboard uses. Falls back to a Sonnet-ish default if the
  // model isn't in the table — better than crashing.
  const pricing = getModelPricing(result.pricingProvider, result.pricingModel);
  const inputPerMillion = pricing?.input_per_million ?? 3;
  const costPerKOriginal = (userPromptTokens * inputPerMillion) / 1000;
  const costPerKOptimized = (result.outputTokens * inputPerMillion) / 1000;

  return NextResponse.json({
    optimized: result.optimized,
    originalTokens: userPromptTokens,
    optimizedTokens: result.outputTokens,
    deltaPercent:
      userPromptTokens > 0
        ? Math.round(((userPromptTokens - result.outputTokens) / userPromptTokens) * 100)
        : 0,
    costPerKCallsOriginal: Number(costPerKOriginal.toFixed(4)),
    costPerKCallsOptimized: Number(costPerKOptimized.toFixed(4)),
    modelUsed: result.modelUsed,
    backend: provider,
  });
}
