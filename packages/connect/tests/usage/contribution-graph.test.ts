import { describe, expect, it } from 'vitest';
import {
  buildContributionGrid,
  render3dIsometric,
  levelGlyph,
  levelColor,
  type ContribCell,
} from '../../src/usage/contribution-graph';

// 21 days = 3 full weeks of data (levels cycle 0..4).
function fakeDays(n: number): ContribCell[] {
  const out: ContribCell[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2026, 0, 1 + i)); // 2026-01-01 was a Thursday
    out.push({ date: d.toISOString().slice(0, 10), level: (i % 5) as 0 | 1 | 2 | 3 | 4, spend_microcents: i * 100, tokens: i });
  }
  return out;
}

describe('buildContributionGrid', () => {
  it('produces 7 rows (weekdays) x N week columns with leading padding aligned to weekday', () => {
    const grid = buildContributionGrid(fakeDays(21));
    // Each week column has exactly 7 slots (Sun..Sat); padding slots are null.
    expect(grid.weeks.every((w) => w.length === 7)).toBe(true);
    // 21 days starting Thursday spans exactly 4 columns: [Thu-Sat], [Sun-Sat]x2, [Sun-Wed].
    expect(grid.weeks.length).toBe(4);
    // Total non-null cells equals the number of input days.
    const cells = grid.weeks.flat().filter(Boolean).length;
    expect(cells).toBe(21);
  });

  it('handles an empty contribution set', () => {
    const grid = buildContributionGrid([]);
    expect(grid.weeks).toEqual([]);
  });
});

describe('levelGlyph / levelColor', () => {
  it('maps 0..4 to the five-step glyph ramp', () => {
    expect([0, 1, 2, 3, 4].map((l) => levelGlyph(l as 0 | 1 | 2 | 3 | 4))).toEqual(['·', '░', '▒', '▓', '█']);
  });
  it('returns a color per level and undefined-safe values', () => {
    expect(levelColor(0)).toBeTypeOf('string');
    expect(levelColor(4)).toBeTypeOf('string');
  });
});

describe('render3dIsometric', () => {
  it('renders without throwing and shows all weeks on a wide terminal', () => {
    const grid = buildContributionGrid(fakeDays(70)); // ~10 weeks
    const out = render3dIsometric(grid, 200);
    expect(out.lines.length).toBeGreaterThan(0);
    expect(out.truncatedWeeks).toBe(0);
    expect(out.shownWeeks).toBe(grid.weeks.length);
  });

  it('truncates to the most recent weeks that fit a narrow terminal (no silent crop)', () => {
    const grid = buildContributionGrid(fakeDays(7 * 53)); // ~53 weeks
    const out = render3dIsometric(grid, 30);
    expect(out.shownWeeks).toBeLessThan(grid.weeks.length);
    expect(out.truncatedWeeks).toBe(grid.weeks.length - out.shownWeeks);
    expect(out.shownWeeks).toBeGreaterThanOrEqual(1);
  });
});
