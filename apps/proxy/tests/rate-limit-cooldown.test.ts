// LAY-320: per-credential rate-limit cooldowns.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetCooldowns,
  getCooledLabels,
  isCoolingDown,
  listActiveCooldowns,
  markCooldown,
} from '../src/billing/rate-limit-cooldown.js';

beforeEach(() => {
  _resetCooldowns();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('rate-limit cooldown registry', () => {
  it('marks a credential as cooling down for 30s by default', () => {
    markCooldown('team_a', 'openai', 'primary');
    expect(isCoolingDown('team_a', 'openai', 'primary')).toBe(true);
    vi.advanceTimersByTime(29_999);
    expect(isCoolingDown('team_a', 'openai', 'primary')).toBe(true);
    vi.advanceTimersByTime(2);
    expect(isCoolingDown('team_a', 'openai', 'primary')).toBe(false);
  });

  it('honors a custom duration', () => {
    markCooldown('team_a', 'openai', 'primary', 5_000);
    expect(isCoolingDown('team_a', 'openai', 'primary')).toBe(true);
    vi.advanceTimersByTime(5_001);
    expect(isCoolingDown('team_a', 'openai', 'primary')).toBe(false);
  });

  it('cooldowns are scoped per (team, provider, label)', () => {
    markCooldown('team_a', 'openai', 'primary');
    expect(isCoolingDown('team_a', 'openai', 'primary')).toBe(true);
    expect(isCoolingDown('team_a', 'openai', 'backup')).toBe(false);
    expect(isCoolingDown('team_a', 'anthropic', 'primary')).toBe(false);
    expect(isCoolingDown('team_b', 'openai', 'primary')).toBe(false);
  });

  it('getCooledLabels returns only the labels for the (team, provider) bucket', () => {
    markCooldown('team_a', 'openai', 'primary');
    markCooldown('team_a', 'openai', 'backup');
    markCooldown('team_a', 'anthropic', 'primary');
    markCooldown('team_b', 'openai', 'primary');

    const cooled = getCooledLabels('team_a', 'openai');
    expect(cooled.has('primary')).toBe(true);
    expect(cooled.has('backup')).toBe(true);
    expect(cooled.size).toBe(2);
  });

  it('expired entries are reaped on read', () => {
    markCooldown('team_a', 'openai', 'primary', 1_000);
    markCooldown('team_a', 'openai', 'backup', 60_000);
    vi.advanceTimersByTime(2_000);

    const cooled = getCooledLabels('team_a', 'openai');
    expect(cooled.has('primary')).toBe(false);
    expect(cooled.has('backup')).toBe(true);
  });

  it('listActiveCooldowns can filter by team and reaps expired', () => {
    markCooldown('team_a', 'openai', 'primary', 1_000);
    markCooldown('team_b', 'openai', 'primary', 60_000);
    vi.advanceTimersByTime(2_000);

    const all = listActiveCooldowns();
    expect(all.length).toBe(1);
    expect(all[0]!.team_id).toBe('team_b');

    const teamA = listActiveCooldowns('team_a');
    expect(teamA.length).toBe(0);
  });

  it('handles labels that contain colons without splitting them', () => {
    markCooldown('team_a', 'openai', 'east:us:1');
    const all = listActiveCooldowns('team_a');
    expect(all[0]!.label).toBe('east:us:1');
  });
});
