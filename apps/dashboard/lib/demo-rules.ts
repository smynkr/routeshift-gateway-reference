import { requireCurrentModel } from './current-models';
import type { QualityGateConfig } from '@routeshift/shared';

const CURRENT = {
  default: requireCurrentModel('default'),
  economy: requireCurrentModel('economy'),
  coding: requireCurrentModel('coding'),
  reasoning: requireCurrentModel('reasoning'),
} as const;
export interface DemoRoutingRule {
  id: string;
  name: string;
  description: string;
  priority: number;
  enabled: boolean;
  condition: Record<string, unknown>;
  action: Record<string, unknown>;
}

const QUALITY_GATE: QualityGateConfig = {
  version: 1,
  mode: 'cascade',
  on_stream: 'reject',
  unknown_signal: 'reject',
  multi_attempt_billing_ack: true,
  checks: [
    { type: 'stop_reason', reject: ['max_tokens'] },
    { type: 'nonempty_content', min_chars: 1, allow_tool_only: true },
  ],
};

// Rule fixtures for the demo team. Kept as plain importable objects (not
// inline JSON.stringify literals in the seed script) so tests can validate the
// REAL persisted shapes — e.g. the quality gate below must stay storable under
// the proxy admin write-gate's validateQualityGateConfig().
export const DEMO_ROUTING_RULES: DemoRoutingRule[] = [
  {
    id: 'rule_demo_pro_to_sonnet',
    name: `Route ${CURRENT.default.canonical_name} → ${CURRENT.coding.canonical_name} on coding`,
    description:
      `${CURRENT.default.canonical_name} is the premium role while ${CURRENT.coding.canonical_name} handles routine coding. Route coding traffic down.`,
    priority: 100,
    enabled: true,
    condition: { model_requested: CURRENT.default.canonical_name, tags: ['coding'] },
    action: {
      type: 'route',
      target_provider: CURRENT.coding.provider,
      target_model: CURRENT.coding.canonical_name,
      fallback_chain: [{ provider: CURRENT.economy.provider, model: CURRENT.economy.canonical_name }],
    },
  },
  {
    id: 'rule_demo_opus_fallback',
    name: `${CURRENT.reasoning.canonical_name} fallback to ${CURRENT.coding.canonical_name}`,
    description: 'Keep latency stable when the reasoning provider is degraded.',
    priority: 200,
    enabled: true,
    condition: { model_requested: CURRENT.reasoning.canonical_name },
    action: {
      type: 'route',
      target_provider: CURRENT.reasoning.provider,
      target_model: CURRENT.reasoning.canonical_name,
      fallback_chain: [{ provider: CURRENT.coding.provider, model: CURRENT.coding.canonical_name }],
    },
  },
  {
    id: 'rule_demo_quality_gate',
    name: `Quality gate on ${CURRENT.default.canonical_name} extraction traffic`,
    description: 'Reject truncated or empty extraction responses and cascade to the fallback. Multi-attempt billing acknowledged.',
    priority: 250,
    enabled: true,
    // Disjoint from rule_demo_pro_to_sonnet (tags: ['coding'], priority 100):
    // identical conditions would let the lower-numbered rule shadow this gate.
    condition: { model_requested: CURRENT.default.canonical_name, tags: ['extraction'] },
    action: {
      type: 'route',
      target_provider: CURRENT.default.provider,
      target_model: CURRENT.default.canonical_name,
      fallback_chain: [{ provider: CURRENT.coding.provider, model: CURRENT.coding.canonical_name }],
      quality_gate: QUALITY_GATE,
    },
  },
  {
    id: 'rule_demo_cheap_simple',
    name: `Small payloads → ${CURRENT.economy.canonical_name}`,
    description: 'Sub-2k-token requests do not need a frontier model.',
    priority: 300,
    enabled: true,
    condition: { max_input_tokens: 2000 },
    action: { type: 'route', target_provider: CURRENT.economy.provider, target_model: CURRENT.economy.canonical_name },
  },
  {
    id: 'rule_demo_tag_offhours',
    name: 'Tag off-hours traffic',
    description: 'Tag overnight requests for separate cost attribution.',
    priority: 400,
    enabled: false,
    condition: { time_window: { start_hour: 22, end_hour: 6 } },
    action: { type: 'tag', add_tags: ['off-hours'] },
  },
];
