// Unicode sparkline. Maps each value into one of 8 block heights scaled across
// the series min..max. A flat series renders as flat lowest bars.
const BARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

export function sparkline(values: number[]): string {
  if (values.length === 0) return '';
  let min = values[0];
  let max = values[0];
  for (const value of values) {
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  if (min === max) return BARS[0].repeat(values.length);
  return values
    .map((v) => {
      const scaled = (v - min) / (max - min);
      const idx = Math.round(scaled * (BARS.length - 1));
      return BARS[Math.min(BARS.length - 1, Math.max(0, idx))];
    })
    .join('');
}
