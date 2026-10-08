import React from 'react';
import { Box, Text } from 'ink';
import type { UsageSummary } from './client';
import { formatUsd, humanizeTokens } from './format';

export function BreakdownTable({ data, focus }: { data: UsageSummary; focus: 'model' | 'key' }): React.ReactElement {
  const modelRows = data.by_model.slice(0, 10).map((r) => ({
    ...r,
    tokens: humanizeTokens(r.input_tokens + r.output_tokens),
    spend: formatUsd(r.spend_microcents),
    savings: formatUsd(r.savings_microcents),
  }));
  const keyRows = data.by_key.slice(0, 10).map((r) => ({
    ...r,
    spend: formatUsd(r.spend_microcents),
    savings: formatUsd(r.savings_microcents),
  }));
  const modelSpendWidth = maxWidth(12, modelRows.map((r) => r.spend));
  const keySpendWidth = maxWidth(12, keyRows.map((r) => r.spend));

  return (
    <Box flexDirection="column">
      <Text bold>{focus === 'model' ? 'By model' : 'By key'} <Text dimColor>(m/k to switch)</Text></Text>
      {focus === 'model'
        ? modelRows.map((r) => (
            <Text key={`${r.model}::${r.provider}`}>
              {pad(r.model, 24)} {pad(r.provider, 10)} {pad(r.tokens, 8)} {padStart(r.spend, modelSpendWidth)} <Text color="green">{r.savings}</Text>
            </Text>
          ))
        : keyRows.map((r) => (
            <Text key={r.api_key_id}>
              {pad(r.key_prefix, 30)} {pad(String(r.requests), 8)} {padStart(r.spend, keySpendWidth)} <Text color="green">{r.savings}</Text>
            </Text>
          ))}
      {focus === 'model' && data.by_model.length === 0 && <Text dimColor>  no model usage</Text>}
      {focus === 'key' && data.by_key.length === 0 && <Text dimColor>  no key usage</Text>}
    </Box>
  );
}

function pad(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : s.padEnd(width);
}

function padStart(s: string, width: number): string {
  return s.length >= width ? s : s.padStart(width);
}

function maxWidth(min: number, values: string[]): number {
  return values.reduce((width, value) => Math.max(width, value.length), min);
}
