import { PROVIDERS, type Provider } from '@routeshift/shared';
import { ACTIVITY_CATEGORIES, type ActivityCategory } from '@/lib/activity-categories';

export interface ActivityFilters {
  provider?: Provider;
  model?: string;
  resolved_model?: string;
  status?: 'success' | 'error';
  category?: ActivityCategory | 'uncategorized';
  api_key_id?: string;
  session?: string;
  from?: string;
  to?: string;
}

export type ActivitySearchParams = Record<string, string | string[] | undefined>;

type ActivityFilterInput = Partial<Record<keyof ActivityFilters, string | undefined>>;

const PROVIDER_VALUES: Record<string, true> = Object.fromEntries(PROVIDERS.map((provider) => [provider, true]));
const CATEGORY_VALUES: Record<string, true> = Object.fromEntries(ACTIVITY_CATEGORIES.map((category) => [category, true]));
const MAX_MODEL_LENGTH = 200;
const MAX_ID_LENGTH = 256;
const ISO_INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function firstString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeBoundedText(value: string | undefined, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : undefined;
}

function normalizeProvider(value: string | undefined): Provider | undefined {
  const normalized = normalizeBoundedText(value, MAX_ID_LENGTH);
  return normalized && Object.hasOwn(PROVIDER_VALUES, normalized) ? (normalized as Provider) : undefined;
}

function normalizeStatus(value: string | undefined): ActivityFilters['status'] {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized === 'success' || normalized === 'error' ? normalized : undefined;
}

function normalizeCategory(value: string | undefined): ActivityFilters['category'] {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (normalized === 'uncategorized') return normalized;
  return normalized && Object.hasOwn(CATEGORY_VALUES, normalized) ? (normalized as ActivityCategory) : undefined;
}
function normalizeDate(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  const match = ISO_INSTANT_PATTERN.exec(normalized);
  if (!match) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const maxDay = month === 2 && isLeapYear ? 29 : DAYS_IN_MONTH[month - 1];
  if (!maxDay || day < 1 || day > maxDay) return undefined;

  if (match[4] !== undefined) {
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6] ?? '0');
    if (hour > 23 || minute > 59 || second > 59) return undefined;
    if (match[8] !== 'Z') {
      const offsetHour = Number(match[8]?.slice(1, 3));
      const offsetMinute = Number(match[8]?.slice(4, 6));
      if (offsetHour > 23 || offsetMinute > 59) return undefined;
    }
  }

  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function normalizeFilters(input: ActivityFilterInput): ActivityFilters {
  const from = normalizeDate(input.from);
  const to = normalizeDate(input.to);
  const filters: ActivityFilters = {
    provider: normalizeProvider(input.provider),
    model: normalizeBoundedText(input.model, MAX_MODEL_LENGTH),
    resolved_model: normalizeBoundedText(input.resolved_model, MAX_MODEL_LENGTH),
    status: normalizeStatus(input.status),
    category: normalizeCategory(input.category),
    api_key_id: normalizeBoundedText(input.api_key_id, MAX_ID_LENGTH),
    session: normalizeBoundedText(input.session, MAX_ID_LENGTH),
    from,
    to,
  };

  if (from && to && from > to) {
    delete filters.from;
    delete filters.to;
  }

  return Object.fromEntries(
    Object.entries(filters).filter(([, value]) => value !== undefined),
  ) as ActivityFilters;
}

export function parseActivityFilters(input: ActivitySearchParams): ActivityFilters {
  return normalizeFilters({
    provider: firstString(input.provider),
    model: firstString(input.model),
    resolved_model: firstString(input.resolved_model),
    status: firstString(input.status),
    category: firstString(input.category),
    api_key_id: firstString(input.api_key_id),
    session: firstString(input.session),
    from: firstString(input.from),
    to: firstString(input.to),
  });
}

export function serializeActivityFilters(filters: ActivityFilters): URLSearchParams {
  const normalized = normalizeFilters(filters);
  const params = new URLSearchParams();
  for (const key of ['provider', 'model', 'resolved_model', 'status', 'category', 'api_key_id', 'session', 'from', 'to'] as const) {
    const value = normalized[key];
    if (value !== undefined) params.set(key, value);
  }
  return params;
}

export function buildActivityHref(filters: ActivityFilters): string {
  const query = serializeActivityFilters(filters).toString();
  return query ? `/activity?${query}` : '/activity';
}
