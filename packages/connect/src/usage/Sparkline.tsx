import React from 'react';
import { Box, Text } from 'ink';
import type { UsageSummary } from './client';
import { sparkline } from './sparkline-util';
import { formatUsd } from './format';

const MAX_GLYPHS = 120;

export function Sparkline({ data, width = process.stdout.columns ?? 80 }: { data: UsageSummary; width?: number }): React.ReactElement {
  const spend = data.series.map((p) => p.spend_microcents);
  const peak = spend.reduce((max, value) => Math.max(max, value), 0);
  const prefix = 'spend ';
  const suffix = `  peak ${formatUsd(peak)}/${data.range.bucket}`;
  const glyphWidth = Math.floor(Math.max(1, Math.min(MAX_GLYPHS, width - prefix.length - suffix.length)));
  const visibleSpend = bucketSeries(spend, glyphWidth);
  return (
    <Box>
      <Text dimColor>{prefix}</Text>
      <Text color="cyan">{sparkline(visibleSpend)}</Text>
      <Text dimColor>{suffix}</Text>
    </Box>
  );
}

function bucketSeries(values: number[], maxBuckets: number): number[] {
  if (values.length <= maxBuckets) return values;
  return Array.from({ length: maxBuckets }, (_, bucket) => {
    const start = Math.floor((bucket * values.length) / maxBuckets);
    const end = Math.floor(((bucket + 1) * values.length) / maxBuckets);
    const slice = values.slice(start, Math.max(start + 1, end));
    return slice.reduce((sum, value) => sum + value, 0) / slice.length;
  });
}
