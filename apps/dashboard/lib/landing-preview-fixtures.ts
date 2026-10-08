import { requireCurrentModel } from './current-models';

const PREVIEW_MODELS = {
  default: requireCurrentModel('default'),
  economy: requireCurrentModel('economy'),
  coding: requireCurrentModel('coding'),
  reasoning: requireCurrentModel('reasoning'),
} as const;
export type LandingPreviewStat = {
  label: string;
  target: number;
  source: 'sample';
  prefix?: string;
  suffix?: string;
  decimals?: number;
};

export type LandingPreviewActivityRow = {
  rowLabel: string;
  provider: string;
  model: string;
  status: number;
  latency: string;
  cost: string;
  cached: boolean;
  source: 'sample';
};

export const LANDING_DASHBOARD_PREVIEW_SAMPLE = {
  provenance: {
    source: 'sample',
    label: 'Sample preview',
    badge: 'Sample',
    activityTitle: 'Sample Activity',
    chartTitle: 'Sample Cost Savings Trend',
    chartPeriodLabel: 'Illustrative 12-month trend',
    description:
      'Illustrative sample data for the landing page preview; not live customer telemetry.',
  },
  stats: [
    { label: 'Total Saved', target: 12847, prefix: '$', suffix: '', decimals: 0, source: 'sample' },
    { label: 'Cost Reduction', target: 47, prefix: '', suffix: '%', decimals: 0, source: 'sample' },
    { label: 'Cache Hit Rate', target: 34, prefix: '', suffix: '%', decimals: 0, source: 'sample' },
    { label: 'Requests Routed', target: 2.3, prefix: '', suffix: 'M', decimals: 1, source: 'sample' },
  ],
  chartBars: [28, 42, 35, 58, 52, 72, 65, 85, 78, 92, 88, 95],
  // not-a-provider-allowlist — landing preview fixture rows
  activityRows: [
    {
      rowLabel: 'Example 1',
      provider: PREVIEW_MODELS.default.provider,
      model: PREVIEW_MODELS.default.canonical_name,
      status: 200,
      latency: '342ms',
      cost: '$0.0031',
      cached: false,
      source: 'sample',
    },
    {
      rowLabel: 'Example 2',
      provider: PREVIEW_MODELS.coding.provider,
      model: PREVIEW_MODELS.coding.canonical_name,
      status: 200,
      latency: '1ms',
      cost: '$0.00',
      cached: true,
      source: 'sample',
    },
    {
      rowLabel: 'Example 3',
      provider: PREVIEW_MODELS.economy.provider,
      model: PREVIEW_MODELS.economy.canonical_name,
      status: 200,
      latency: '189ms',
      cost: '$0.0008',
      cached: false,
      source: 'sample',
    },
    {
      rowLabel: 'Example 4',
      provider: PREVIEW_MODELS.reasoning.provider,
      model: PREVIEW_MODELS.reasoning.canonical_name,
      status: 200,
      latency: '2ms',
      cost: '$0.00',
      cached: true,
      source: 'sample',
    },
  ],
} as const satisfies {
  provenance: {
    source: 'sample';
    label: string;
    badge: string;
    activityTitle: string;
    chartTitle: string;
    chartPeriodLabel: string;
    description: string;
  };
  stats: readonly LandingPreviewStat[];
  chartBars: readonly number[];
  activityRows: readonly LandingPreviewActivityRow[];
};
