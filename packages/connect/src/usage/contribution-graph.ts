// Geometry for the GitHub-style contribution graph: a 7-row × weeks-column grid
// (2D) and a static isometric projection (3D). Pure — the .tsx components render
// the output. Level→glyph/color maps live here so 2D color + NO_COLOR fallback
// and the 3D shading share one ramp.

export interface ContribCell {
  date: string; // YYYY-MM-DD
  level: 0 | 1 | 2 | 3 | 4;
  spend_microcents: number;
  tokens: number;
}

export interface ContribGrid {
  /** weeks[col] is a length-7 array indexed by weekday (0=Sun..6=Sat); null = padding. */
  weeks: Array<Array<ContribCell | null>>;
}

const GLYPHS = ['·', '░', '▒', '▓', '█'] as const;
// GitHub-style green ramp; level 0 is a dim gray. Ink accepts hex colors.
const COLORS = ['#30363d', '#0e4429', '#006d32', '#26a641', '#39d353'] as const;

export function levelGlyph(level: 0 | 1 | 2 | 3 | 4): string { return GLYPHS[level]; }
export function levelColor(level: 0 | 1 | 2 | 3 | 4): string { return COLORS[level]; }

/** Chunk a chronological day list into week columns aligned to UTC weekday. */
export function buildContributionGrid(days: ContribCell[]): ContribGrid {
  if (days.length === 0) return { weeks: [] };

  const weeks: Array<Array<ContribCell | null>> = [];
  // Each column is a Sun..Sat week; unfilled leading/trailing slots stay null
  // (padding) so the first/last partial weeks align to the correct weekday.
  let col: Array<ContribCell | null> = new Array(7).fill(null);

  for (const day of days) {
    const wd = utcWeekday(day.date);
    // A new Sunday starts a fresh column — but skip the push for the very first
    // Sunday, when col is still all-null (avoids a leading empty week).
    if (wd === 0 && col.some((c) => c !== null)) {
      weeks.push(col);
      col = new Array(7).fill(null);
    }
    col[wd] = day;
  }
  if (col.some((c) => c !== null)) weeks.push(col);

  return { weeks };
}

function utcWeekday(isoDate: string): number {
  return new Date(`${isoDate}T00:00:00.000Z`).getUTCDay();
}

export interface Iso3dResult {
  lines: string[];
  shownWeeks: number;
  truncatedWeeks: number;
}

/**
 * Static isometric projection: weeks advance along X (one column each), weekdays
 * recede diagonally (each weekday shifts +1 X and -1 Y), and each day is an
 * extruded column of `level` glyphs drawn upward. Newer weeks are painted last
 * so they overlay older ones (depth). Width-aware: if the full grid is wider
 * than the terminal, only the most recent weeks that fit are drawn and the rest
 * are reported via `truncatedWeeks` (never silently cropped).
 */
export function render3dIsometric(grid: ContribGrid, termWidth: number): Iso3dResult {
  const totalWeeks = grid.weeks.length;
  if (totalWeeks === 0) return { lines: [], shownWeeks: 0, truncatedWeeks: 0 };

  // Canvas width for W weeks ≈ W + 7 (the diagonal weekday recession). Choose the
  // largest recent window that fits; always show at least one week. (On a
  // pathologically narrow terminal — fewer than ~8 columns — that one week may
  // still overflow; rendering nothing would be worse, so we accept the overrun.)
  const maxWeeks = Math.max(1, termWidth - 7);
  const shownWeeks = Math.min(totalWeeks, maxWeeks);
  const truncatedWeeks = totalWeeks - shownWeeks;
  const weeks = grid.weeks.slice(totalWeeks - shownWeeks);

  const MAX_BAR = 4;     // levels 1..4 → up to 4 stacked glyphs
  const DAYS = 7;
  const width = shownWeeks + DAYS;          // x = week + weekday
  const height = DAYS + MAX_BAR;            // diagonal recession + extrusion
  const canvas: string[][] = Array.from({ length: height }, () => new Array(width).fill(' '));

  for (let w = 0; w < weeks.length; w++) {  // back-to-front: old → new
    const col = weeks[w];
    for (let d = 0; d < DAYS; d++) {
      const cell = col[d];
      if (!cell || cell.level === 0) continue;
      const x = w + d;
      const baseY = (height - 1) - d;
      const glyph = levelGlyph(cell.level);
      for (let h = 0; h < cell.level; h++) {
        const y = baseY - h;
        if (y >= 0 && y < height && x >= 0 && x < width) canvas[y][x] = glyph;
      }
    }
  }

  return { lines: canvas.map((row) => row.join('').replace(/\s+$/, '')), shownWeeks, truncatedWeeks };
}
