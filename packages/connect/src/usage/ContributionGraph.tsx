import React from 'react';
import { Box, Text } from 'ink';
import type { UsageSummary } from './client';
import { formatUsd } from './format';
import {
  buildContributionGrid,
  render3dIsometric,
  levelGlyph,
  levelColor,
  type ContribCell,
} from './contribution-graph';

const WEEKDAY_LABELS = ['', 'Mon', '', 'Wed', '', 'Fri', '']; // rows 0..6 (Sun..Sat)

export function ContributionGraph(
  { data, mode, color, width }: { data: UsageSummary; mode: '2d' | '3d'; color: boolean; width: number },
): React.ReactElement {
  const cells: ContribCell[] = data.contributions.map((c) => ({
    date: c.date, level: c.level, spend_microcents: c.spend_microcents, tokens: c.tokens,
  }));
  const grid = buildContributionGrid(cells);
  const total = data.contributions.reduce((sum, c) => sum + c.spend_microcents, 0);

  if (mode === '3d') {
    const iso = render3dIsometric(grid, width);
    return (
      <Box flexDirection="column">
        <Text bold>Usage landscape (3D)</Text>
        {/* Per-cell level color is lost once the isometric canvas is flattened
            to strings; the 3D view uses a single accent color (column height,
            not hue, conveys intensity here). */}
        {iso.lines.map((line, i) => (
          <Text key={i} color={color ? 'green' : undefined}>{line}</Text>
        ))}
        {iso.truncatedWeeks > 0 && <Text dimColor>(showing last {iso.shownWeeks} weeks)</Text>}
        <Legend color={color} total={total} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>Contributions</Text>
      {[0, 1, 2, 3, 4, 5, 6].map((row) => (
        <Box key={row}>
          <Text dimColor>{WEEKDAY_LABELS[row].padEnd(4)}</Text>
          <Text>
            {grid.weeks.map((week, col) => {
              const cell = week[row];
              const level = cell ? cell.level : 0;
              const glyph = cell ? levelGlyph(level) : ' ';
              return (
                <Text key={col} color={color && cell ? levelColor(level) : undefined}>{glyph}</Text>
              );
            })}
          </Text>
        </Box>
      ))}
      <Legend color={color} total={total} />
    </Box>
  );
}

function Legend({ color, total }: { color: boolean; total: number }): React.ReactElement {
  return (
    <Box>
      <Text dimColor>less </Text>
      {[0, 1, 2, 3, 4].map((l) => (
        <Text key={l} color={color ? levelColor(l as 0 | 1 | 2 | 3 | 4) : undefined}>{levelGlyph(l as 0 | 1 | 2 | 3 | 4)}</Text>
      ))}
      <Text dimColor> more   {formatUsd(total)} this window</Text>
    </Box>
  );
}
