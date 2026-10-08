export interface SavingsReceiptSummary {
  month: string;
  totalRequests: number;
  totalOriginalMicrocents: string | number;
  totalActualMicrocents: string | number;
  totalBilledMicrocents: string | number;
  totalSavingsMicrocents: string | number;
  unknownCostRequests: number;
  actualCostsQualified: boolean;
  isDemo?: boolean;
}

export interface SavingsReceiptDailyRow {
  day: string;
  originalMicrocents: string | number;
  actualMicrocents: string | number;
  savingsMicrocents: string | number;
  requests: number;
  unknownCostRequests: number;
}

export interface SavingsReceiptModelRow {
  provider: string;
  model: string;
  requests: number;
  savingsMicrocents: string | number;
}

export function parseReceiptMonth(value: string | null, _now = new Date()): { start: Date; end: Date; label: string } | null {
  if (!value || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return null;
  const [yearText, monthText] = value.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  if (year < 1970 || year > 9999) return null;

  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  const label = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(start);
  return { start, end, label };
}

export function escapeCsv(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  const safeText = typeof value === 'string' && /^[=+\-@\t\r]/.test(text)
    ? `'${text}`
    : text;
  return /[",\n\r]/.test(safeText) ? `"${safeText.replaceAll('"', '""')}"` : safeText;
}

function formatUsd(microcents: string | number): string {
  const raw = String(microcents);
  if (/^-?\d+$/.test(raw)) {
    const value = BigInt(raw);
    const negative = value < BigInt(0);
    const absolute = negative ? -value : value;
    const decimals = absolute < BigInt(1_000_000) ? 4 : 2;
    const scale = decimals === 4 ? BigInt(10_000) : BigInt(1_000_000);
    const rounded = (absolute + scale / BigInt(2)) / scale;
    const decimalScale = BigInt(10) ** BigInt(decimals);
    const whole = rounded / decimalScale;
    const fraction = (rounded % decimalScale).toString().padStart(decimals, '0');
    return `${negative ? '-' : ''}$${whole}.${fraction}`;
  }
  const usd = Number(microcents) / 100_000_000;
  return Number.isFinite(usd) ? `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}` : '—';
}

function row(values: Array<string | number | null>): string {
  return values.map(escapeCsv).join(',');
}

export function buildSavingsReceiptCsv(
  summary: SavingsReceiptSummary,
  daily: SavingsReceiptDailyRow[],
  byModel: SavingsReceiptModelRow[],
): string {
  const lines = [
    row(['section', 'field', 'value']),
    row(['summary', 'is_demo', String(summary.isDemo === true)]),
    row(['summary', 'month', summary.month]),
    row(['summary', 'total_requests', summary.totalRequests]),
    row(['summary', 'total_original_microcents', summary.totalOriginalMicrocents]),
    row(['summary', 'total_original_usd', formatUsd(summary.totalOriginalMicrocents)]),
    row(['summary', 'total_actual_microcents', summary.totalActualMicrocents]),
    row(['summary', 'total_actual_usd', formatUsd(summary.totalActualMicrocents)]),
    row(['summary', 'total_billed_microcents', summary.totalBilledMicrocents]),
    row(['summary', 'total_billed_usd', formatUsd(summary.totalBilledMicrocents)]),
    row(['summary', 'total_savings_microcents', summary.totalSavingsMicrocents]),
    row(['summary', 'total_savings_usd', formatUsd(summary.totalSavingsMicrocents)]),
    row(['summary', 'unknown_cost_requests', summary.unknownCostRequests]),
    row(['summary', 'actual_costs_qualified', String(summary.actualCostsQualified)]),
    '',
    row([
      'daily',
      'day',
      'original_microcents',
      'original_usd',
      'actual_microcents',
      'actual_usd',
      'savings_microcents',
      'savings_usd',
      'requests',
      'unknown_cost_requests',
    ]),
    ...daily.map((entry) => row([
      'daily',
      entry.day,
      entry.originalMicrocents,
      formatUsd(entry.originalMicrocents),
      entry.actualMicrocents,
      formatUsd(entry.actualMicrocents),
      entry.savingsMicrocents,
      formatUsd(entry.savingsMicrocents),
      entry.requests,
      entry.unknownCostRequests,
    ])),
    '',
    row(['model', 'provider', 'model', 'requests', 'savings_microcents', 'savings_usd']),
    ...byModel.map((entry) => row([
      'model',
      entry.provider,
      entry.model,
      entry.requests,
      entry.savingsMicrocents,
      formatUsd(entry.savingsMicrocents),
    ])),
  ];

  return `${lines.join('\n')}\n`;
}
