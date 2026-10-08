import React from 'react';
import { Box, Text } from 'ink';
import type { UsageSummary } from './client';
import { formatUsd, humanizeTokens } from './format';

export function Summary({ data }: { data: UsageSummary }): React.ReactElement {
  const s = data.summary;
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>Spend </Text><Text color="cyan">{formatUsd(s.spend_microcents)}</Text>
        <Text>   </Text>
        <Text bold>Saved </Text><Text color="green">{formatUsd(s.savings_microcents)}</Text>
        <Text>   </Text>
        <Text bold>Credit </Text><Text color="yellow">{formatUsd(s.credit_balance_microcents)}</Text>
      </Box>
      <Box>
        <Text dimColor>
          {humanizeTokens(s.input_tokens)} in · {humanizeTokens(s.output_tokens)} out · {humanizeTokens(s.cache_read_tokens)} cache-read · {s.requests.toLocaleString('en-US')} reqs
        </Text>
      </Box>
    </Box>
  );
}
