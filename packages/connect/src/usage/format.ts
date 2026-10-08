// Pure display formatters for the usage TUI. Money is microcents (1 USD = 1e8).

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function formatUsd(microcents: number | null | undefined): string {
  if (microcents == null) return '—';
  const dollars = microcents / 1e8;
  if (dollars > 0 && dollars < 0.01) return '<$0.01';
  return USD.format(dollars);
}

export function humanizeTokens(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${trim(n / 1e9)}B`;
  if (abs >= 1e6) return `${trim(n / 1e6)}M`;
  if (abs >= 1e3) return `${trim(n / 1e3)}K`;
  return String(n);
}

function trim(v: number): string {
  // One decimal with explicit round-half-up, then drop a trailing ".0" (1.0K -> 1K).
  const rounded = Math.round(v * 10) / 10;
  return rounded.toFixed(1).replace(/\.0$/, '');
}

export function formatDay(iso: string): string {
  return iso.slice(0, 10);
}
