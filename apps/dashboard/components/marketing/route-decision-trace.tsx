'use client';

import { useMemo, useState } from 'react';
import { evaluateRules, RouteBlockedError } from '@routeshift/shared';
import { CopyButton } from '@/components/copy-button';
import {
  DEMO_PLAYGROUND_RULES,
  explainPlaygroundDecision,
  playgroundContext,
} from '@/lib/routing-playground';
import { requireCurrentModel } from '@/lib/current-models';


const CODING_MODEL = requireCurrentModel('coding');
const DEFAULT_MODEL = requireCurrentModel('default');

const SCENARIOS = {
  coding: {
    label: 'Code review',
    model: CODING_MODEL.canonical_name,
    provider: CODING_MODEL.provider,
    prompt: 'Review this TypeScript function and suggest a fix.',
    estimatedInputTokens: 1_200,
  },
  general: {
    label: 'General Q&A',
    model: DEFAULT_MODEL.canonical_name,
    provider: DEFAULT_MODEL.provider,
    prompt: 'Summarize the key tradeoffs in one paragraph.',
    estimatedInputTokens: 800,
  },
  oversized: {
    label: 'Oversized context',
    model: DEFAULT_MODEL.canonical_name,
    provider: DEFAULT_MODEL.provider,
    prompt: 'Review this 400k-token TypeScript monorepo in one pass.',
    estimatedInputTokens: 500_000,
  },
} as const;

const SCENARIO_KEYS = ['coding', 'general', 'oversized'] as const;
type ScenarioKey = (typeof SCENARIO_KEYS)[number];

type RouteDecisionTraceProps = {
  ruleEvaluator?: typeof evaluateRules;
};

export function RouteDecisionTrace({ ruleEvaluator = evaluateRules }: RouteDecisionTraceProps = {}) {
  const [scenarioKey, setScenarioKey] = useState<ScenarioKey>('coding');
  const scenario = SCENARIOS[scenarioKey];
  const evaluated = useMemo(() => {
    const context = playgroundContext({
      model: scenario.model,
      provider: scenario.provider,
      prompt: scenario.prompt,
      estimatedInputTokens: scenario.estimatedInputTokens,
    });
    try {
      return { context, decision: ruleEvaluator([...DEMO_PLAYGROUND_RULES], context), blockedReason: null };
    } catch (error) {
      const message = error instanceof RouteBlockedError
        ? error.message
        : error instanceof Error ? error.message : 'Route evaluation failed';
      return { context, decision: null, blockedReason: message };
    }
  }, [scenario, ruleEvaluator]);

  const reason = evaluated.decision
    ? explainPlaygroundDecision(evaluated.decision, evaluated.context)
    : `Blocked: ${evaluated.blockedReason ?? 'Route evaluation failed'}`;
  const requestedRoute = `${evaluated.context.provider_requested}/${evaluated.context.model_requested}`;
  const resolvedRoute = evaluated.decision
    ? `${evaluated.decision.provider}/${evaluated.decision.model}`
    : `Blocked: ${evaluated.blockedReason ?? 'Route evaluation failed'}`;
  const derivedTags = evaluated.context.tags.length > 0 ? evaluated.context.tags.join(', ') : 'none';
  const matchedRule = evaluated.decision ? evaluated.decision.rule_id ?? 'default' : 'blocked';
  const fallbacks = evaluated.decision
    ? evaluated.decision.fallback_chain.length > 0
      ? evaluated.decision.fallback_chain.map((route) => `${route.provider}/${route.model}`).join(', ')
      : 'none'
    : 'none';
  const copyText = [
    `Requested route: ${requestedRoute}`,
    `Prompt: ${scenario.prompt}`,
    `Derived tags: ${derivedTags}`,
    `Matched rule: ${matchedRule}`,
    `Resolved route: ${resolvedRoute}`,
    `Fallbacks: ${fallbacks}`,
    `Reason: ${reason}`,
  ].join('\n');
  const copyMarkdown = [
    `## RouteShift decision (${scenario.label})`,
    ``,
    `- Requested route: \`${requestedRoute}\``,
    `- Prompt: ${scenario.prompt}`,
    `- Derived tags: \`${derivedTags}\``,
    `- Matched rule: \`${matchedRule}\``,
    `- Resolved route: \`${resolvedRoute}\``,
    `- Fallbacks: \`${fallbacks}\``,
    ``,
    `**Why:** ${reason}`,
    ``,
    `_Interactive example · fixed sample rules · no provider call._`,
  ].join('\n');
  const copyJson = JSON.stringify(
    {
      example: scenario.label,
      requested_route: requestedRoute,
      prompt: scenario.prompt,
      derived_tags: evaluated.context.tags,
      matched_rule: matchedRule,
      resolved_route: evaluated.decision ? `${evaluated.decision.provider}/${evaluated.decision.model}` : null,
      blocked_reason: evaluated.blockedReason,
      fallbacks: evaluated.decision ? evaluated.decision.fallback_chain.map((route) => `${route.provider}/${route.model}`) : [],
      reason,
      provenance: 'Interactive example · fixed sample rules · no provider call.',
    },
    null,
    2,
  );

  return (
    <section
      aria-labelledby="route-decision-trace-heading"
      className="rounded-2xl border border-white/[0.08] bg-[#0c0c0e] p-5 sm:p-7"
    >
      <div>
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-emerald-400">Routing proof</p>
        <h2 id="route-decision-trace-heading" className="mt-3 text-2xl font-semibold tracking-tight text-white sm:text-3xl">
          See the decision before you send traffic
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-zinc-400">
          Interactive example · fixed sample rules · no provider call.
        </p>
      </div>

      <div className="mt-7 flex flex-wrap gap-2" role="group" aria-label="Route examples">
        {SCENARIO_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={scenarioKey === key}
            onClick={() => setScenarioKey(key)}
            className={`rounded-full border px-3 py-2 text-sm transition-colors ${
              scenarioKey === key
                ? 'border-emerald-400/50 bg-emerald-400/10 text-emerald-300'
                : 'border-white/[0.1] text-zinc-400 hover:border-white/[0.2] hover:text-white'
            }`}
          >
            {SCENARIOS[key].label}
          </button>
        ))}
      </div>

      <ol className="mt-7 space-y-3" aria-label="Route decision steps">
        <li className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
          <div className="flex items-center gap-3">
            <span className="font-mono text-xs text-zinc-400">01</span>
            <h3 className="text-sm font-semibold uppercase tracking-[0.14em] text-white">Request</h3>
          </div>
          <dl className="mt-4 space-y-2 text-sm">
            <div className="flex flex-wrap justify-between gap-3">
              <dt className="text-zinc-400">Requested route</dt>
              <dd className="font-mono text-zinc-200">{requestedRoute} (requested)</dd>
            </div>
            <div className="flex flex-wrap justify-between gap-3">
              <dt className="text-zinc-400">Prompt</dt>
              <dd className="max-w-[32rem] text-right text-zinc-300 select-text">{scenario.prompt}</dd>
            </div>
          </dl>
        </li>

        <li className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
          <div className="flex items-center gap-3">
            <span className="font-mono text-xs text-zinc-400">02</span>
            <h3 className="text-sm font-semibold uppercase tracking-[0.14em] text-white">Policy</h3>
          </div>
          <dl className="mt-4 space-y-2 text-sm">
            <div className="flex flex-wrap justify-between gap-3">
              <dt className="text-zinc-400">Derived tags</dt>
              <dd className="font-mono text-zinc-200">{derivedTags}</dd>
            </div>
            <div className="flex flex-wrap justify-between gap-3">
              <dt className="text-zinc-400">Matched rule</dt>
              <dd className="font-mono text-zinc-200">{matchedRule}</dd>
            </div>
          </dl>
        </li>

        <li className="rounded-xl border border-emerald-400/20 bg-emerald-400/[0.04] p-4">
          <div className="flex items-center gap-3">
            <span className="font-mono text-xs text-zinc-400">03</span>
            <h3 className="text-sm font-semibold uppercase tracking-[0.14em] text-white">Route</h3>
          </div>
          <dl className="mt-4 space-y-2 text-sm">
            <div className="flex flex-wrap justify-between gap-3">
              <dt className="text-zinc-400">{evaluated.blockedReason ? 'Outcome' : 'Resolved route'}</dt>
              <dd className={`font-mono ${evaluated.blockedReason ? 'text-amber-300' : 'text-emerald-300'}`}>{resolvedRoute}</dd>
            </div>
            <div className="flex flex-wrap justify-between gap-3">
              <dt className="text-zinc-400">Fallbacks</dt>
              <dd className="font-mono text-zinc-200">{fallbacks}</dd>
            </div>
          </dl>
        </li>
      </ol>

      <div className="mt-6 rounded-xl border border-white/[0.07] bg-black/20 p-4">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-400">Why this route</p>
        <p className="mt-3 select-text text-sm leading-relaxed text-zinc-300">{reason}</p>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
        <p className="text-xs text-zinc-400">Select the explanation if clipboard access is unavailable.</p>
        <div className="flex flex-wrap items-center gap-1">
          <CopyButton
            text={copyText}
            label="Copy explanation"
            failureLabel="Copy failed — select the explanation"
            className="inline-flex min-h-11 items-center justify-center px-3"
          />
          <CopyButton
            text={copyMarkdown}
            label="Copy as Markdown"
            failureLabel="Copy failed — select the explanation"
            className="inline-flex min-h-11 items-center justify-center px-3"
          />
          <CopyButton
            text={copyJson}
            label="Copy for agent (JSON)"
            failureLabel="Copy failed — select the explanation"
            className="inline-flex min-h-11 items-center justify-center px-3"
          />
        </div>
      </div>
    </section>
  );
}
