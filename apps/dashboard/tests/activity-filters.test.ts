import { describe, expect, it } from 'vitest';
import {
  buildActivityHref,
  parseActivityFilters,
  serializeActivityFilters,
} from '@/lib/activity-filters';

describe('Activity URL filters', () => {
  it('normalizes valid filters and round-trips them', () => {
    const filters = parseActivityFilters({
      provider: 'openai',
      model: '  gpt-5  ',
      resolved_model: '  gpt-5.4  ',
      status: 'error',
      category: 'coding',
      api_key_id: ' key_1 ',
      session: ' session_1 ',
      from: '2026-08-20T00:00:00Z',
      to: '2026-08-26T00:00:00Z',
    });

    expect(filters).toEqual({
      provider: 'openai',
      model: 'gpt-5',
      resolved_model: 'gpt-5.4',
      status: 'error',
      category: 'coding',
      api_key_id: 'key_1',
      session: 'session_1',
      from: '2026-08-20T00:00:00.000Z',
      to: '2026-08-26T00:00:00.000Z',
    });
    expect(parseActivityFilters(Object.fromEntries(serializeActivityFilters(filters)))).toEqual(filters);
  });

  it('drops an empty or oversized exact resolved-model value', () => {
    expect(parseActivityFilters({ resolved_model: '   ' })).toEqual({});
    expect(parseActivityFilters({ resolved_model: 'x'.repeat(201) })).toEqual({});
  });

  it('drops unknown, oversized, invalid, and reversed values', () => {
    expect(parseActivityFilters({
      provider: 'unknown',
      model: 'x'.repeat(201),
      resolved_model: 'x'.repeat(201),
      status: '500',
      category: '__proto__',
      api_key_id: 'x'.repeat(257),
      session: '',
      from: '2026-08-27T00:00:00Z',
      to: '2026-08-26T00:00:00Z',
      extra: 'ignored',
    })).toEqual({});
  });

  it('rejects calendar-invalid dates and accepts valid ISO instants with offsets', () => {
    expect(parseActivityFilters({ from: '2026-02-30T00:00:00Z' })).toEqual({});
    expect(parseActivityFilters({ from: '2026-13-01T00:00:00Z' })).toEqual({});
    expect(parseActivityFilters({ from: '2026-02-29T00:00:00Z' })).toEqual({});
    expect(parseActivityFilters({ from: '2024-02-29T00:00:00-05:00' })).toEqual({
      from: '2024-02-29T05:00:00.000Z',
    });
    expect(parseActivityFilters({ from: '2026-08-20T12:00:00+05:30' })).toEqual({
      from: '2026-08-20T06:30:00.000Z',
    });
    expect(parseActivityFilters({ from: '2026-08-20T12:00:00' })).toEqual({});
    expect(parseActivityFilters({ from: '2026-08-20' })).toEqual({});
  });

  it('uses the first value from repeated query parameters', () => {
    expect(parseActivityFilters({
      provider: ['anthropic', 'openai'],
      model: [' gpt-5.4 ', 'ignored'],
      resolved_model: [' gpt-5.4 ', 'ignored'],
      status: ['success', 'error'],
    })).toEqual({
      provider: 'anthropic',
      model: 'gpt-5.4',
      resolved_model: 'gpt-5.4',
      status: 'success',
    });
  });

  it('creates deterministic URLs in the Activity filter order', () => {
    const filters = {
      provider: 'openai' as const,
      model: 'gpt-5',
      resolved_model: 'gpt-5.4',
      status: 'error' as const,
      category: 'coding' as const,
      api_key_id: 'key_1',
      session: 'session_1',
      from: '2026-08-20T00:00:00.000Z',
      to: '2026-08-26T00:00:00.000Z',
    };

    expect(serializeActivityFilters(filters).toString()).toBe(
      'provider=openai&model=gpt-5&resolved_model=gpt-5.4&status=error&category=coding&api_key_id=key_1&session=session_1&from=2026-08-20T00%3A00%3A00.000Z&to=2026-08-26T00%3A00%3A00.000Z',
    );
    expect(buildActivityHref(filters)).toBe(
      '/activity?provider=openai&model=gpt-5&resolved_model=gpt-5.4&status=error&category=coding&api_key_id=key_1&session=session_1&from=2026-08-20T00%3A00%3A00.000Z&to=2026-08-26T00%3A00%3A00.000Z',
    );
  });

});
