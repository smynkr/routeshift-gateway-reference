import { describe, expect, it, vi } from 'vitest';
import { emailDomain, isEmailDomainAllowed } from '@/lib/email-allowlist';

describe('emailDomain', () => {
  it('extracts the lowercased domain', () => {
    expect(emailDomain('Dev@RouteShift.IO')).toBe('routeshift.io');
  });

  it('uses the last @ for addresses with quoted locals', () => {
    expect(emailDomain('"weird@local"@acme.com')).toBe('acme.com');
  });

  it('rejects malformed inputs', () => {
    expect(emailDomain('no-at-sign')).toBeNull();
    expect(emailDomain('trailing@')).toBeNull();
    expect(emailDomain('@nolocal.com')).toBe('nolocal.com');
    expect(emailDomain('localhost@localhost')).toBeNull(); // no dot
    expect(emailDomain('')).toBeNull();
  });
});

function poolReturning(rows: unknown[]) {
  return { query: vi.fn().mockResolvedValue({ rows }) };
}

describe('isEmailDomainAllowed', () => {
  it('allows when a matching row exists', async () => {
    const pool = poolReturning([{ '?column?': 1 }]);
    await expect(isEmailDomainAllowed(pool, 'team_dev', 'dev@routeshift.io')).resolves.toBe(true);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('allowed_email_domains'), [
      'team_dev',
      'routeshift.io',
    ]);
  });

  it('fails closed when no row matches', async () => {
    const pool = poolReturning([]);
    await expect(isEmailDomainAllowed(pool, 'team_dev', 'dev@evil.com')).resolves.toBe(false);
  });

  it('fails closed on a malformed email without hitting the DB', async () => {
    const pool = poolReturning([{ x: 1 }]);
    await expect(isEmailDomainAllowed(pool, 'team_dev', 'garbage')).resolves.toBe(false);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('fails closed on an empty team id without hitting the DB', async () => {
    const pool = poolReturning([{ x: 1 }]);
    await expect(isEmailDomainAllowed(pool, '', 'dev@routeshift.io')).resolves.toBe(false);
    expect(pool.query).not.toHaveBeenCalled();
  });
});
