import { beforeEach, describe, expect, it, vi } from 'vitest';

// RSH-60 #16: oauth/token mints a key BEFORE recording it in key_identities, so a
// crash/dropped-response between mint and attach leaves a live, full-access key
// that's invisible to the identity audit and lives until its 30-day TTL. The
// sweeper revokes such orphans (oauth_device-minted, no key_identities row, past
// the device-code TTL), bounding their lifetime to one sweep interval.

const h = vi.hoisted(() => ({
  clientQuery: vi.fn(),
  release: vi.fn(),
  connect: vi.fn(),
}));

vi.mock('../src/db/pool.js', () => ({ getPool: () => ({ connect: h.connect }) }));

import { sweepOrphanedOAuthKeys } from '../src/oauth/orphan-key-sweeper.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  h.connect.mockResolvedValue({ query: h.clientQuery, release: h.release });
});

describe('sweepOrphanedOAuthKeys (RSH-60 #16)', () => {
  it('revokes orphaned oauth_device keys past the TTL and reports the count', async () => {
    h.clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ pg_try_advisory_xact_lock: true }] }) // lock
      .mockResolvedValueOnce({ rows: [{ id: 'k1' }, { id: 'k2' }], rowCount: 2 }) // UPDATE … RETURNING
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const res = await sweepOrphanedOAuthKeys();

    expect(res.revoked).toBe(2);
    const update = String(h.clientQuery.mock.calls[2]![0]);
    expect(update).toContain('UPDATE api_keys');
    expect(update).toContain('revoked_at = now()');
    expect(update).toContain("metadata->>'created_via' = 'oauth_device'");
    expect(update).toContain('revoked_at IS NULL'); // don't touch already-revoked
    expect(update).toContain('api_key_id IS NULL'); // only unattached (orphan) keys
    expect(h.clientQuery).toHaveBeenNthCalledWith(4, 'COMMIT');
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it('no-ops (and runs no UPDATE) when another replica holds the advisory lock', async () => {
    h.clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ pg_try_advisory_xact_lock: false }] }) // lock NOT acquired
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    const res = await sweepOrphanedOAuthKeys();

    expect(res.revoked).toBe(0);
    const ranUpdate = h.clientQuery.mock.calls.some((c) => String(c[0]).includes('UPDATE api_keys'));
    expect(ranUpdate).toBe(false);
    expect(h.clientQuery).toHaveBeenNthCalledWith(3, 'ROLLBACK');
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back and returns 0 on a query error', async () => {
    h.clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ pg_try_advisory_xact_lock: true }] }) // lock
      .mockRejectedValueOnce(new Error('boom')) // UPDATE throws
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await sweepOrphanedOAuthKeys();

    expect(res.revoked).toBe(0);
    expect(h.release).toHaveBeenCalledTimes(1);
  });
});
