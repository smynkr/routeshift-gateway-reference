import { describe, expect, it } from 'vitest';
import type { AuditEventType } from './audit-events.js';

describe('AuditEventType', () => {
  it('includes sso_issued', () => {
    // Compile-time check: this assignment fails to typecheck if
    // 'sso_issued' isn't a member of the union. Runtime assertion is a
    // formality — `tsc --noEmit` is what actually enforces this.
    const t: AuditEventType = 'sso_issued';
    expect(t).toBe('sso_issued');
  });
});
