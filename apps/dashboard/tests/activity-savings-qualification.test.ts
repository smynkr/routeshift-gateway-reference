import { describe, expect, it } from 'vitest';
import { shouldShowRoutingSavings } from '@/app/(dashboard)/activity/activity-client';

describe('activity savings qualification', () => {
  it('hides positive savings when actual cost is unknown', () => {
    expect(shouldShowRoutingSavings({ actual_cost_known: false, savings_microcents: 100 })).toBe(false);
    expect(shouldShowRoutingSavings({ actual_cost_known: true, savings_microcents: 100 })).toBe(true);
  });
});
