import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock DB pool
// ---------------------------------------------------------------------------
const mockQuery = vi.fn();
const mockRelease = vi.fn();
const mockConnect = vi.fn();
const mockDbPricing = vi.fn();

vi.mock('../src/db/pool.js', () => ({
  getPool: () => ({
    query: mockQuery,
    connect: mockConnect,
  }),
}));
vi.mock('../src/cost/pricing-db.js', () => ({
  getDbPricing: (...args: unknown[]) => mockDbPricing(...args),
}));

// ---------------------------------------------------------------------------
// Mock @routeshift/shared — getModelPricing
// ---------------------------------------------------------------------------
vi.mock('@routeshift/shared', async () => {
  const actual = await vi.importActual<typeof import('@routeshift/shared')>('@routeshift/shared');
  return {
    ...actual,
    getModelPricing: (provider: string, model: string) => {
      if (provider === 'openai' && model === 'gpt-4.1') {
        // Prices are in USD per million tokens (e.g., $2.00/M input, $8.00/M output)
        return { provider: 'openai', model: 'gpt-4.1', input_per_million: 2.0, output_per_million: 8.0 };
      }
      if (provider === 'openai' && model === 'gpt-5.6-sol') {
        return {
          provider,
          model,
          input_per_million: 4,
          output_per_million: 20,
          input_per_million_above_272k: 8,
          output_per_million_above_272k: 30,
        };
      }
      return null; // unknown model
    },
  };
});

import {
  preFlightCreditCheck,
  deductCredits,
  reserveCredits,
  heartbeatCreditReservation,
  settleReservedCredits,
  settleReservedCreditsWithUnknownCostHold,
  resolveUnknownCostHold,
  markStaleCreditReservationsForReconciliation,
  checkAutoTopUpNeeded,
  addCredits,
} from '../src/billing/credits.js';

beforeEach(() => {
  mockQuery.mockReset();
  mockRelease.mockReset();
  mockConnect.mockReset();
  mockConnect.mockResolvedValue({ query: mockQuery, release: mockRelease });
  mockDbPricing.mockReset();
  mockDbPricing.mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// preFlightCreditCheck
// ---------------------------------------------------------------------------
describe('preFlightCreditCheck', () => {
  it('returns missing_pricing for unknown model instead of treating it as free', async () => {
    const result = await preFlightCreditCheck('team_1', 'unknown-model', 'unknown', 100, 512, 0);
    expect(result).toEqual({ allowed: false, balance: 0, estimatedCost: 0, reason: 'missing_pricing' });
    expect(mockDbPricing).toHaveBeenCalledWith('unknown', 'unknown-model');
    // Should not hit credit balance DB when pricing is missing.
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('uses DB pricing entries for credit preflight when static pricing is missing', async () => {
    mockDbPricing.mockResolvedValueOnce({
      provider: 'custom',
      model: 'custom-embedding',
      input_per_million: 1,
      output_per_million: 2,
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ balance_microcents: '999999' }] });

    const result = await preFlightCreditCheck('team_1', 'custom-embedding', 'custom', 400, 10, 0);
    expect(result.allowed).toBe(true);
    expect(result.estimatedCost).toBeGreaterThan(0);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('uses the long-context tier for credit preflight above 272K prompt tokens', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ balance_microcents: '99999999999' }] });

    const result = await preFlightCreditCheck(
      'team_1',
      'gpt-5.6-sol',
      'openai',
      272_001 * 4,
      1,
      0,
    );

    const expected = Math.ceil(272_001 * 8 * 100 + 1 * 30 * 100);
    expect(result.estimatedCost).toBe(expected);
    expect(result.allowed).toBe(true);
  });

  it('returns allowed=true when balance is sufficient', async () => {
    // Single upsert RETURNING query
    mockQuery.mockResolvedValueOnce({ rows: [{ balance_microcents: '99999999999' }] });

    const result = await preFlightCreditCheck('team_1', 'gpt-4.1', 'openai', 400, 1024, 0);
    expect(result.allowed).toBe(true);
    expect(result.balance).toBe(99999999999);
    expect(result.estimatedCost).toBeGreaterThan(0);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('returns allowed=false when balance is insufficient', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ balance_microcents: '1' }] });

    const result = await preFlightCreditCheck('team_1', 'gpt-4.1', 'openai', 400, 1024, 0);
    expect(result.allowed).toBe(false);
    expect(result.balance).toBe(1);
  });

  it('treats zero balance as insufficient for non-zero cost', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ balance_microcents: '0' }] });

    const result = await preFlightCreditCheck('team_1', 'gpt-4.1', 'openai', 400, 1024, 0);
    expect(result.allowed).toBe(false);
    expect(result.balance).toBe(0);
    expect(result.estimatedCost).toBeGreaterThan(0);
  });

  it('adds a plugin surcharge before applying plan markup', async () => {
    mockDbPricing.mockResolvedValue({
      provider: 'test',
      model: 'plugin-priced',
      input_per_million: 1,
      output_per_million: 2,
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ balance_microcents: '99999999999' }] });

    const result = await preFlightCreditCheck(
      'team_1',
      'plugin-priced',
      'test',
      400,
      10,
      10,
      500,
    );

    // provider estimate = 100 input * 1 * 100 + 10 output * 2 * 100 = 12,000;
    // plugin surcharge = 500; whole combined amount receives 10% markup.
    expect(result.estimatedCost).toBe(13_750);
  });

  it('treats a held reservation as available during the post-plugin recheck', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ balance_microcents: '50' }] });

    const result = await preFlightCreditCheck('team_1', 'gpt-4.1', 'openai', 400, 1024, 0, 0, 1_000_000);

    expect(result.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deductCredits
// ---------------------------------------------------------------------------
describe('deductCredits', () => {
  it('successfully deducts and returns new balance', async () => {
    // BEGIN → UPDATE RETURNING → INSERT transaction → COMMIT
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ balance_microcents: '900' }] }) // UPDATE RETURNING
      .mockResolvedValueOnce({ rows: [] }) // INSERT transaction
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await deductCredits('team_1', 100, 0, 'req_1', 'test deduction');
    expect(result.success).toBe(true);
    expect(result.newBalance).toBe(900);
    expect(result.amountDeducted).toBe(100);
  });

  it('prevents overdraft — returns actual balance when UPDATE matches no rows', async () => {
    // BEGIN → UPDATE (0 rows) → SELECT balance → COMMIT
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // UPDATE matches 0 rows (overdraft guard)
      .mockResolvedValueOnce({ rows: [{ balance_microcents: '50' }] }) // SELECT balance
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await deductCredits('team_1', 200, 0, 'req_2', 'overdraft test');
    expect(result.success).toBe(false);
    expect(result.newBalance).toBe(50);
    expect(result.amountDeducted).toBe(0);
  });

  it('returns early without UPDATE for zero-cost request', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ balance_microcents: '5000' }] });

    const result = await deductCredits('team_1', 0, 0, 'req_3', 'zero cost');
    expect(result.success).toBe(true);
    expect(result.amountDeducted).toBe(0);
    expect(result.newBalance).toBe(5000);
    // Only one query (SELECT balance), no UPDATE
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('returns early without DB write for negative cost', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ balance_microcents: '5000' }] });

    const result = await deductCredits('team_1', -10, 0, 'req_4', 'negative cost');
    expect(result.success).toBe(true);
    expect(result.amountDeducted).toBe(0);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

describe('streaming credit reservations', () => {
  it('reserves estimated credits with an overdraft guard and transaction record', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ balance_microcents: '900' }] }) // UPDATE RETURNING
      .mockResolvedValueOnce({ rows: [] }) // INSERT transaction
      .mockResolvedValueOnce({ rows: [{ request_id: 'req_stream' }] }) // durable reservation
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await reserveCredits('team_1', 100, 'req_stream', 'gpt stream', 12.5);

    expect(result).toMatchObject({ success: true, newBalance: 900, amountDeducted: 100 });
    expect(mockQuery.mock.calls[1][0]).toContain('balance_microcents - $1 >= overdraft_limit_microcents');
    const txCall = mockQuery.mock.calls[2];
    expect(txCall[0]).toContain('credit_transactions');
    expect(txCall[1][2]).toBe(-100);
    expect(txCall[1][4]).toContain('gpt stream (reservation)');
    expect(txCall[1][4]).not.toContain('streaming reservation');
    expect(mockQuery.mock.calls[3][0]).toContain('pending_unknown_cost_holds');
    expect(mockQuery.mock.calls[3][1]).toEqual(['team_1', 'req_stream', 100, 12.5]);
  });

  it('increments reserved and held amounts on a matching reservation upsert', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ balance_microcents: '800' }] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ request_id: 'req_stream' }] }).mockResolvedValueOnce({ rows: [] });
    await expect(reserveCredits('team_1', 100, 'req_stream', 'gpt stream', 12.5)).resolves.toMatchObject({ success: true, amountDeducted: 100 });
    expect(mockQuery.mock.calls[3][0]).toContain('reserved_microcents = pending_unknown_cost_holds.reserved_microcents + EXCLUDED.reserved_microcents');
    expect(mockQuery.mock.calls[3][0]).toContain('held_microcents = pending_unknown_cost_holds.held_microcents + EXCLUDED.held_microcents');
  });

  it('rolls back when the durable reservation row cannot be written', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ balance_microcents: '900' }] }).mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(new Error('reservation write failed')).mockResolvedValueOnce({ rows: [] });
    await expect(reserveCredits('team_1', 100, 'req_stream', 'gpt stream')).rejects.toThrow('reservation write failed');
    expect(mockQuery.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });

  it('rejects invalid reservation amounts and markup before querying the database', async () => {
    for (const amount of [Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, -1]) await expect(reserveCredits('team_1', amount, 'req_stream', 'invalid')).rejects.toThrow();
    for (const markup of [Number.NaN, Number.POSITIVE_INFINITY, -1]) await expect(reserveCredits('team_1', 100, 'req_stream', 'invalid', markup)).rejects.toThrow();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('fails reservation without writing a transaction when balance is insufficient', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // UPDATE no rows
      .mockResolvedValueOnce({ rows: [{ balance_microcents: '50' }] }) // SELECT balance
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await reserveCredits('team_1', 200, 'req_stream', 'gpt stream');

    expect(result).toEqual({ success: false, newBalance: 50, amountDeducted: 0 });
    expect(mockQuery.mock.calls.some((call) => String(call[0]).includes('credit_transactions'))).toBe(false);
  });

  it('extends only a stale watchdog reservation during a delayed post-plugin reserve', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ balance_microcents: '800' }] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ request_id: 'req_stale' }] }).mockResolvedValueOnce({ rows: [] });
    await expect(reserveCredits('team_1', 100, 'req_stale', 'post-plugin', 10)).resolves.toMatchObject({ success: true, amountDeducted: 100 });
    const upsert = mockQuery.mock.calls[3][0];
    expect(upsert).toContain("status = 'reconciliation_required'");
    expect(upsert).toContain("reason_code = 'stale_credit_reservation'");
    expect(upsert).toContain('held_microcents = pending_unknown_cost_holds.held_microcents + EXCLUDED.held_microcents');
  });

  it('heartbeats only an active reservation or the exact stale watchdog marker', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SET LOCAL statement_timeout
      .mockResolvedValueOnce({ rows: [{ request_id: 'req_stream' }] }) // heartbeat
      .mockResolvedValueOnce({ rows: [] }); // COMMIT
    await expect(heartbeatCreditReservation('team_1', 'req_stream')).resolves.toBeUndefined();
    expect(mockQuery.mock.calls[1][0]).toContain('SET LOCAL statement_timeout = 20000');
    const [sql, params] = mockQuery.mock.calls[2];
    expect(sql).toContain("status = 'reserved'");
    expect(sql).toContain("reason_code = 'stale_credit_reservation'");
    expect(sql).toContain('unknown_attempts = 0');
    expect(sql).toContain('resolved_at IS NULL');
    expect(params).toEqual(['team_1', 'req_stream']);

    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SET LOCAL statement_timeout
      .mockResolvedValueOnce({ rows: [] }) // heartbeat
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK
    await expect(heartbeatCreditReservation('team_1', 'req_terminal')).rejects.toThrow('No active credit reservation exists for heartbeat');
  });

  it('destroys a database client when a heartbeat query never resolves', async () => {
    const hungQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SET LOCAL statement_timeout
      .mockImplementationOnce(() => new Promise(() => {})); // heartbeat
    const release = vi.fn();
    mockConnect.mockResolvedValueOnce({ query: hungQuery, release });

    vi.useFakeTimers();
    try {
      const heartbeat = heartbeatCreditReservation('team_1', 'req_hung');
      const rejection = expect(heartbeat).rejects.toThrow('heartbeat database operation timed out');
      await vi.advanceTimersByTimeAsync(24_000);

      await rejection;
      expect(release).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledWith(expect.any(Error));
    } finally {
      vi.useRealTimers();
    }
  });

  it('refunds the unused part of a streaming reservation', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ reserved_microcents: '100', markup_percent: '0', status: 'reserved' }] }) // reservation lock
      .mockResolvedValueOnce({ rows: [{ balance_microcents: '950' }] }) // UPDATE + refund
      .mockResolvedValueOnce({ rows: [] }) // INSERT transaction
      .mockResolvedValueOnce({ rows: [] }) // DELETE reservation
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await settleReservedCredits('team_1', 100, 50, 0, 'req_stream', 'gpt stream');

    expect(result).toMatchObject({ success: true, newBalance: 950, amountDeducted: 50 });
    const updateCall = mockQuery.mock.calls[2];
    expect(updateCall[1][0]).toBe(50);
    const txCall = mockQuery.mock.calls[3];
    expect(txCall[1][2]).toBe(50);
    expect(txCall[1][4]).toContain('streaming reservation refund');
  });

  it('charges the overage when actual streaming cost exceeds the reservation', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ reserved_microcents: '100', markup_percent: '0', status: 'reserved' }] }) // reservation lock
      .mockResolvedValueOnce({ rows: [{ balance_microcents: '875' }] }) // UPDATE - overage
      .mockResolvedValueOnce({ rows: [] }) // INSERT transaction
      .mockResolvedValueOnce({ rows: [] }) // DELETE reservation
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await settleReservedCredits('team_1', 100, 125, 0, 'req_stream', 'gpt stream');

    expect(result).toMatchObject({ success: true, newBalance: 875, amountDeducted: 125 });
    const updateCall = mockQuery.mock.calls[2];
    expect(updateCall[1][0]).toBe(-25);
    const txCall = mockQuery.mock.calls[3];
    expect(txCall[1][2]).toBe(-25);
    expect(txCall[1][4]).toContain('streaming overage');
  });

  it('persists a clamped exact-settlement shortfall for reconciliation instead of deleting it', async () => {
    // reserved=100, actual=600 (markup 0) -> finalAmount=600, delta=500, balanceDelta=-500.
    // Balance is 100 with an overdraft floor of -300, so the guarded UPDATE
    // matches 0 rows (100-500=-400 < -300). The settlement must then charge as
    // much as the floor allows (down to -300, i.e. 400 collected) and record the
    // uncollected remainder (100) rather than charging nothing.
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ reserved_microcents: '100', markup_percent: '0', status: 'reserved' }] }) // reservation lock
      .mockResolvedValueOnce({ rows: [] }) // guarded UPDATE — 0 rows (would breach floor)
      .mockResolvedValueOnce({ rows: [{ balance_microcents: '100', overdraft_limit_microcents: '-300' }] }) // SELECT ... FOR UPDATE
      .mockResolvedValueOnce({ rows: [] }) // clamp UPDATE
      .mockResolvedValueOnce({ rows: [] }) // INSERT transaction
      .mockResolvedValueOnce({ rows: [] }) // mark durable known-charge shortfall
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await settleReservedCredits('team_1', 100, 600, 0, 'req_stream', 'gpt stream');

    // 400 collected (100 -> -300), 100 uncollected; amountDeducted reflects the
    // actually-collected total (finalAmount 600 minus 100 uncollected).
    expect(result).toMatchObject({ success: true, newBalance: -300, amountDeducted: 500 });
    expect(String(mockQuery.mock.calls[3][0])).toContain('FOR UPDATE');
    const clampUpdate = mockQuery.mock.calls[4];
    expect(clampUpdate[1][0]).toBe(-300); // balance set to the overdraft floor
    const txCall = mockQuery.mock.calls[5];
    expect(txCall[1][2]).toBe(-400); // applied charge
    expect(txCall[1][5]).toBe(-300); // balance_after
    expect(txCall[1][4]).toContain('uncollected 100');
    const holdUpdate = mockQuery.mock.calls[6];
    expect(holdUpdate[0]).toContain('known_charge_microcents = $3');
    expect(holdUpdate[0]).toContain('uncollected_known_charge_microcents = $4');
    expect(holdUpdate[0]).toContain("status = 'reconciliation_required'");
    expect(holdUpdate[0]).not.toContain('DELETE FROM pending_unknown_cost_holds');
    expect(holdUpdate[1]).toEqual(['team_1', 'req_stream', 600, 100]);
  });

  it('leaves an exact reservation durable when an overage is already at the overdraft floor', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ reserved_microcents: '100', markup_percent: '0', status: 'reserved' }] })
      .mockResolvedValueOnce({ rows: [] }) // guarded update cannot collect
      .mockResolvedValueOnce({ rows: [{ balance_microcents: '-300', overdraft_limit_microcents: '-300' }] })
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await settleReservedCredits('team_1', 100, 200, 0, 'req_floor', 'known paid response');

    expect(result).toEqual({ success: false, newBalance: -300, amountDeducted: 100 });
    expect(mockQuery.mock.calls.some((call) => String(call[0]).includes('DELETE FROM pending_unknown_cost_holds'))).toBe(false);
    expect(mockQuery.mock.calls.some((call) => String(call[0]).includes('UPDATE pending_unknown_cost_holds SET'))).toBe(false);
  });
});

describe('unknown-cost credit holds', () => {
  it('settles known marked-up cost, refunds the remainder, and persists a capped pending hold atomically', async () => {
    // BEGIN → advisory lock → lock prior hold → read balance (no refund) → upsert hold → COMMIT
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ reserved_microcents: '100', known_charge_microcents: '0', held_microcents: '100', markup_percent: '10', status: 'reserved' }] })
      .mockResolvedValueOnce({ rows: [{ balance_microcents: '960' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    // reserved=100; known=20 + 10% markup => 22; unknown estimate=90 + 10%
    // markup => 99 but is capped to the 78 credits still reserved. No refund.
    const result = await settleReservedCreditsWithUnknownCostHold(
      'team_1', 100, 20, 90, 10, 'req_unknown', 'ambiguous upstream spend', 'provider_timeout', 1,
    );

    expect(result).toEqual({
      success: true, newBalance: 960, amountDeducted: 100, pendingHoldMicrocents: 78, amountRefunded: 0,
    });
    expect(mockQuery.mock.calls[1][0]).toContain('pg_advisory_xact_lock');
    expect(mockQuery.mock.calls[2][0]).toContain('pending_unknown_cost_holds');
    expect(mockQuery.mock.calls[3][0]).toContain('SELECT balance_microcents');
    const holdUpsert = mockQuery.mock.calls[4];
    expect(holdUpsert[0]).toContain('pending_unknown_cost_holds');
    expect(holdUpsert[0]).toContain('UPDATE pending_unknown_cost_holds');
    expect(holdUpsert[1]).toEqual(['team_1', 'req_unknown', 22, 0, 78, 90, 'provider_timeout', 1]);
  });

  it('refunds only the portion not needed for known cost and the marked-up unknown estimate', async () => {
    // BEGIN → advisory lock → lock → UPDATE refund → ledger → upsert → COMMIT
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ reserved_microcents: '100', known_charge_microcents: '0', held_microcents: '100', markup_percent: '0', status: 'reserved' }] })
      .mockResolvedValueOnce({ rows: [{ balance_microcents: '950' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await settleReservedCreditsWithUnknownCostHold(
      'team_1', 100, 20, 30, 0, 'req_unknown', 'ambiguous upstream spend', 'provider_timeout', 2,
    );

    expect(result).toEqual({
      success: true, newBalance: 950, amountDeducted: 50, pendingHoldMicrocents: 30, amountRefunded: 50,
    });
    expect(mockQuery.mock.calls[3][1][0]).toBe(50);
    expect(mockQuery.mock.calls[4][1][2]).toBe(50);
  });

  it('retains the entire remaining reservation when no unknown-cost estimate is available', async () => {
    // BEGIN → advisory lock → lock → SELECT balance (no adjustment) → upsert → COMMIT
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ reserved_microcents: '100', known_charge_microcents: '0', held_microcents: '100', markup_percent: '0', status: 'reserved' }] })
      .mockResolvedValueOnce({ rows: [{ balance_microcents: '900' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await settleReservedCreditsWithUnknownCostHold(
      'team_1', 100, 20, null, 0, 'req_unknown', 'ambiguous upstream spend', 'provider_timeout', 3,
    );

    expect(result).toEqual({
      success: true, newBalance: 900, amountDeducted: 100, pendingHoldMicrocents: 80, amountRefunded: 0,
    });
    expect(mockQuery.mock.calls[4][1][5]).toBeNull();
  });

  it('adjusts only the retained-hold difference when a retry refines the estimate', async () => {
    // BEGIN → advisory lock → lock existing hold → refund the changed amount → ledger → upsert → COMMIT
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        reserved_microcents: '100', known_charge_microcents: '20', held_microcents: '30', markup_percent: '0', status: 'pending',
      }] })
      .mockResolvedValueOnce({ rows: [{ balance_microcents: '970' }] })
      .mockResolvedValueOnce({ rows: [{ reserved_microcents: '100', known_charge_microcents: '0', held_microcents: '100', markup_percent: '0', status: 'reserved' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await settleReservedCreditsWithUnknownCostHold(
      'team_1', 100, 20, 10, 0, 'req_unknown', 'ambiguous upstream spend', 'provider_timeout', 4,
    );

    expect(result).toEqual({
      success: true, newBalance: 970, amountDeducted: 30, pendingHoldMicrocents: 10, amountRefunded: 20,
    });
    // The first settlement retained 50; only the 20-credit change is refunded.
    expect(mockQuery.mock.calls[3][1][0]).toBe(20);
  });

  it('records only the applied overage when known cost is clamped to the overdraft floor', async () => {
    // BEGIN → advisory lock → missing hold → guarded UPDATE miss → balance/floor
    // lock → clamp UPDATE → ledger → hold upsert → COMMIT.
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ reserved_microcents: '100', known_charge_microcents: '0', held_microcents: '100', markup_percent: '0', status: 'reserved' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        balance_microcents: '100', overdraft_limit_microcents: '-300',
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await settleReservedCreditsWithUnknownCostHold(
      'team_1', 100, 600, 0, 0, 'req_clamped', 'ambiguous upstream spend', 'provider_timeout', 1,
    );

    expect(result).toMatchObject({
      success: true,
      newBalance: -300,
      amountDeducted: 500,
      pendingHoldMicrocents: 0,
      amountRefunded: 0,
    });
    expect(mockQuery.mock.calls[5][1][0]).toBe(-300);
    expect(mockQuery.mock.calls[6][1][2]).toBe(-400);
    expect(mockQuery.mock.calls[6][1][5]).toBe(-300);
    expect(mockQuery.mock.calls[7][1][3]).toBe(100);
  });

  it('does not persist an unknown hold that a floor-clamped replay did not retain', async () => {
    // Replay changes prior K=20,H=10 to K=80,H=20. Only 40 of the required
    // 70 additional microcents can be collected before the -300 floor, so the
    // actual retained amount is 70: K=80, U=10, H=0.
    const pending = {
      reserved_microcents: '100', known_charge_microcents: '20',
      uncollected_known_charge_microcents: '0', held_microcents: '10',
      markup_percent: '0', status: 'pending', reason_code: 'provider_timeout',
      unknown_attempts: 1, resolved_at: null,
    };
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // advisory lock
      .mockResolvedValueOnce({ rows: [pending] }) // pending row lock
      .mockResolvedValueOnce({ rows: [] }) // guarded balance update breaches floor
      .mockResolvedValueOnce({ rows: [{ balance_microcents: '-260', overdraft_limit_microcents: '-300' }] })
      .mockResolvedValueOnce({ rows: [] }) // clamp to floor
      .mockResolvedValueOnce({ rows: [] }) // ledger
      .mockResolvedValueOnce({ rows: [] }) // pending hold update
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await settleReservedCreditsWithUnknownCostHold(
      'team_1', 100, 80, 20, 0, 'req_replay_floor', 'replayed ambiguous spend', 'provider_timeout', 1,
    );

    expect(result).toMatchObject({
      success: true, newBalance: -300, amountDeducted: 70,
      pendingHoldMicrocents: 0, amountRefunded: 0,
    });
    const holdUpdate = mockQuery.mock.calls[7];
    expect(holdUpdate[1]).toEqual([
      'team_1', 'req_replay_floor', 80, 10, 0, 20, 'provider_timeout', 1,
    ]);

    // A zero-cost confirmation cannot terminalize this row at the floor: the
    // retained balance still owes the known-charge shortfall, and there is no
    // fictitious unknown hold available to refund.
    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{
        held_microcents: '0', known_charge_microcents: '80',
        uncollected_known_charge_microcents: '10', markup_percent: '0', status: 'pending',
      }] })
      .mockResolvedValueOnce({ rows: [] }) // collection breaches floor
      .mockResolvedValueOnce({ rows: [{ balance_microcents: '-300' }] })
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const resolution = await resolveUnknownCostHold({
      teamId: 'team_1', requestId: 'req_replay_floor', confirmedUnknownCostMicrocents: 0,
      evidence: 'provider invoice', note: 'unknown spend confirmed zero', resolvedBy: 'ops@example.test',
    });

    expect(resolution).toMatchObject({
      success: false, newBalance: -300, amountDeducted: 70, status: 'pending',
    });
    expect(mockQuery.mock.calls.some((call) => String(call[0]).includes('UPDATE pending_unknown_cost_holds SET'))).toBe(false);
    expect(mockQuery.mock.calls.some((call) => String(call[0]).includes('unknown-cost hold released'))).toBe(false);
  });

  it('allows a stale watchdog marker to yield to exact or unknown settlement', async () => {
    const stale = { reserved_microcents: '100', known_charge_microcents: '0', uncollected_known_charge_microcents: '0', held_microcents: '100', markup_percent: '0', status: 'reconciliation_required', reason_code: 'stale_credit_reservation', unknown_attempts: 0, resolved_at: null };
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [stale] }).mockResolvedValueOnce({ rows: [{ balance_microcents: '900' }] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    await expect(settleReservedCredits('team_1', 100, 100, 0, 'req_stale', 'late exact')).resolves.toMatchObject({ success: true });

    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [stale] }).mockResolvedValueOnce({ rows: [{ balance_microcents: '900' }] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    await expect(settleReservedCreditsWithUnknownCostHold('team_1', 100, 20, 0, 0, 'req_stale', 'late unknown', 'provider_timeout', 1)).resolves.toMatchObject({ success: true, pendingHoldMicrocents: 0 });
  });
});

describe('explicit unknown-cost reconciliation', () => {
  it('rejects a fresh stale watchdog marker before any money mutation, then permits it after the Postgres-clock grace period', async () => {
    const freshStale = {
      held_microcents: '100', known_charge_microcents: '0', uncollected_known_charge_microcents: '0',
      markup_percent: '0', status: 'reconciliation_required', reason_code: 'stale_credit_reservation',
      unknown_attempts: 0, resolved_at: null, resolution_eligible: false,
    };
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [freshStale] }) // locked hold + Postgres-clock eligibility
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK
    await expect(resolveUnknownCostHold({
      teamId: 'team_1', requestId: 'req_fresh_stale', confirmedUnknownCostMicrocents: 0,
      evidence: 'provider invoice', note: 'no spend', resolvedBy: 'ops@example.test',
    })).rejects.toThrow('10-minute grace period');
    expect(mockQuery.mock.calls[1][0]).toContain(
      "THEN updated_at <= now() - interval '10 minutes'",
    );
    expect(mockQuery.mock.calls.some((call) => /credit_balances|credit_transactions|UPDATE pending_unknown_cost_holds SET/.test(String(call[0])))).toBe(false);

    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ ...freshStale, resolution_eligible: true }] })
      .mockResolvedValueOnce({ rows: [{ balance_microcents: '1000' }] }) // refund
      .mockResolvedValueOnce({ rows: [] }) // ledger
      .mockResolvedValueOnce({ rows: [] }) // terminal row
      .mockResolvedValueOnce({ rows: [] }); // COMMIT
    await expect(resolveUnknownCostHold({
      teamId: 'team_1', requestId: 'req_expired_stale', confirmedUnknownCostMicrocents: 0,
      evidence: 'provider invoice', note: 'no spend', resolvedBy: 'ops@example.test',
    })).resolves.toMatchObject({ success: true, status: 'released' });
    expect(mockQuery.mock.calls.some((call) => String(call[0]).includes('credit_transactions'))).toBe(true);
  });

  it('releases a pending tenant hold exactly once when confirmed raw cost is zero', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ held_microcents: '100', known_charge_microcents: '20', markup_percent: '0', status: 'pending' }] })
      .mockResolvedValueOnce({ rows: [{ balance_microcents: '1000' }] }) // refund
      .mockResolvedValueOnce({ rows: [] }) // ledger
      .mockResolvedValueOnce({ rows: [] }) // terminal row
      .mockResolvedValueOnce({ rows: [] }); // COMMIT
    const result = await resolveUnknownCostHold({
      teamId: 'team_1', requestId: 'req_hold', confirmedUnknownCostMicrocents: 0,
      evidence: 'provider invoice', note: 'confirmed no upstream spend', resolvedBy: 'ops@example.test',
    });
    expect(result).toMatchObject({ success: true, status: 'released', amountDeducted: 20, alreadyResolved: false });
    expect(mockQuery.mock.calls[2][1][0]).toBe(100);
    expect(mockQuery.mock.calls[4][1][2]).toBe('released');
  });

  it('reconciles positive confirmed cost and records the marked-up delta', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ held_microcents: '100', known_charge_microcents: '20', markup_percent: '10', status: 'pending' }] }).mockResolvedValueOnce({ rows: [{ balance_microcents: '955' }] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const result = await resolveUnknownCostHold({ teamId: 'team_1', requestId: 'req_hold', confirmedUnknownCostMicrocents: 50, evidence: 'provider invoice', note: 'confirmed spend', resolvedBy: 'ops@example.test' });
    expect(result).toMatchObject({ success: true, status: 'reconciled', finalUnknownChargeMicrocents: 55, amountDeducted: 75 });
    expect(mockQuery.mock.calls[2][1][0]).toBe(45);
    expect(mockQuery.mock.calls[3][0]).toContain('credit_transactions');
    expect(mockQuery.mock.calls[4][1][2]).toBe('reconciled');
  });

  it('refunds a full reconciliation-required reservation when confirmed raw cost is zero', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ held_microcents: '100', known_charge_microcents: '0', markup_percent: '0', status: 'reconciliation_required' }] }).mockResolvedValueOnce({ rows: [{ balance_microcents: '1000' }] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const result = await resolveUnknownCostHold({ teamId: 'team_1', requestId: 'req_stale', confirmedUnknownCostMicrocents: 0, evidence: 'provider invoice', note: 'no spend', resolvedBy: 'ops@example.test' });
    expect(result).toMatchObject({ success: true, status: 'released', amountDeducted: 0 });
    expect(mockQuery.mock.calls[2][1][0]).toBe(100);
    expect(mockQuery.mock.calls[4][1][2]).toBe('released');
  });

  it('collects an exact-settlement shortfall before terminalising its zero-unknown resolution', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ held_microcents: '0', known_charge_microcents: '600', uncollected_known_charge_microcents: '100', markup_percent: '0', status: 'pending' }] }).mockResolvedValueOnce({ rows: [{ balance_microcents: '-100' }] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const result = await resolveUnknownCostHold({ teamId: 'team_1', requestId: 'req_clamped', confirmedUnknownCostMicrocents: 0, evidence: 'provider invoice', note: 'known shortfall recovered', resolvedBy: 'ops@example.test' });
    expect(result).toMatchObject({ success: true, status: 'released', amountDeducted: 600 });
    expect(mockQuery.mock.calls[2][1][0]).toBe(-100);
    expect(mockQuery.mock.calls[3][0]).toContain('credit_transactions');
    expect(mockQuery.mock.calls[4][0]).toContain('uncollected_known_charge_microcents = 0');
  });

  it('reports only retained exact-settlement credit when the shortfall still breaches the overdraft floor', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ held_microcents: '0', known_charge_microcents: '600', uncollected_known_charge_microcents: '100', markup_percent: '0', status: 'reconciliation_required' }] })
      .mockResolvedValueOnce({ rows: [] }) // guarded collection would breach floor
      .mockResolvedValueOnce({ rows: [{ balance_microcents: '-300' }] }) // current balance
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    const result = await resolveUnknownCostHold({
      teamId: 'team_1', requestId: 'req_exact_shortfall', confirmedUnknownCostMicrocents: 0,
      evidence: 'provider invoice', note: 'known shortfall remains unpaid', resolvedBy: 'ops@example.test',
    });

    expect(result).toMatchObject({ success: false, newBalance: -300, amountDeducted: 500, status: 'reconciliation_required' });
    expect(mockQuery.mock.calls.some((call) => String(call[0]).includes('UPDATE pending_unknown_cost_holds SET'))).toBe(false);
  });

  it('reports retained known and held credit when an unknown-cost reconciliation breaches the overdraft floor', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ held_microcents: '100', known_charge_microcents: '20', uncollected_known_charge_microcents: '0', markup_percent: '0', status: 'pending' }] })
      .mockResolvedValueOnce({ rows: [] }) // guarded collection would breach floor
      .mockResolvedValueOnce({ rows: [{ balance_microcents: '-300' }] }) // current balance
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    const result = await resolveUnknownCostHold({
      teamId: 'team_1', requestId: 'req_unknown_shortfall', confirmedUnknownCostMicrocents: 200,
      evidence: 'provider invoice', note: 'unknown cost exceeds hold', resolvedBy: 'ops@example.test',
    });

    expect(result).toMatchObject({ success: false, newBalance: -300, amountDeducted: 120, status: 'pending' });
    expect(mockQuery.mock.calls.some((call) => String(call[0]).includes('UPDATE pending_unknown_cost_holds SET'))).toBe(false);
  });

  it('makes an identical terminal retry a no-op and rejects conflicting evidence', async () => {
    const resolvedRow = {
      held_microcents: '0', known_charge_microcents: '20', markup_percent: '0', status: 'released',
      resolution_raw_cost_microcents: '0', resolution_charge_microcents: '0',
      resolution_evidence: 'provider invoice', resolution_note: 'confirmed no upstream spend', resolved_by: 'ops@example.test',
    };
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [resolvedRow] })
      .mockResolvedValueOnce({ rows: [{ balance_microcents: '1000' }] })
      .mockResolvedValueOnce({ rows: [] });
    const input = { teamId: 'team_1', requestId: 'req_hold', confirmedUnknownCostMicrocents: 0, evidence: 'provider invoice', note: 'confirmed no upstream spend', resolvedBy: 'ops@example.test' };
    await expect(resolveUnknownCostHold(input)).resolves.toMatchObject({ alreadyResolved: true, amountDeducted: 20 });
    expect(mockQuery.mock.calls.some((call) => String(call[0]).includes('credit_transactions'))).toBe(false);

    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [resolvedRow] }).mockResolvedValueOnce({ rows: [] });
    await expect(resolveUnknownCostHold({ ...input, evidence: 'different provider export' })).rejects.toThrow('conflicting evidence');
    expect(mockQuery.mock.calls.some((call) => String(call[0]).includes('credit_balances'))).toBe(false);
  });

  it('does not write balances or ledgers when merely marking a stale reservation', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ team_id: 'team_1', request_id: 'req_stale', reserved_microcents: '100', updated_at: '2026-01-01T00:00:00Z' }] });
    await expect(markStaleCreditReservationsForReconciliation(60_000)).resolves.toBe(1);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][0]).toContain("status = 'reconciliation_required'");
    expect(mockQuery.mock.calls[0][0]).not.toContain('credit_balances');
    expect(mockQuery.mock.calls[0][0]).not.toContain('credit_transactions');
  });
});

// ---------------------------------------------------------------------------
// checkAutoTopUpNeeded
// ---------------------------------------------------------------------------
describe('checkAutoTopUpNeeded', () => {
  it('enqueues when balance is below threshold', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ threshold_microcents: '10000' }] }) // SELECT threshold
      .mockResolvedValueOnce({ rows: [] }); // INSERT into queue

    await checkAutoTopUpNeeded('team_1', 5000);
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[1][0]).toContain('auto_topup_queue');
  });

  it('does not enqueue when balance is above threshold', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ threshold_microcents: '10000' }] });

    await checkAutoTopUpNeeded('team_1', 20000);
    // Only the SELECT, no INSERT
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('returns without action when no settings row exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await checkAutoTopUpNeeded('team_1', 5000);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// addCredits
// ---------------------------------------------------------------------------
describe('addCredits', () => {
  it('converts cents to microcents correctly', async () => {
    // BEGIN → INSERT ensure → UPDATE RETURNING → INSERT transaction → COMMIT
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // INSERT ensure row
      .mockResolvedValueOnce({ rows: [{ balance_microcents: '10000000' }] }) // UPDATE RETURNING
      .mockResolvedValueOnce({ rows: [] }) // INSERT transaction
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    await addCredits('team_1', 10, 'purchase', 'ref_1');
    // The UPDATE should use 10 * 1_000_000 = 10_000_000 (call index 2: after BEGIN + INSERT)
    const updateCall = mockQuery.mock.calls[2];
    expect(updateCall[1][0]).toBe(10_000_000);
  });

  it('creates a transaction record', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // INSERT ensure
      .mockResolvedValueOnce({ rows: [{ balance_microcents: '10000000' }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // INSERT transaction
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    await addCredits('team_1', 10, 'purchase', 'ref_1');
    // Fourth call (index 3) is the INSERT into credit_transactions
    expect(mockQuery).toHaveBeenCalledTimes(5);
    const txCall = mockQuery.mock.calls[3];
    expect(txCall[0]).toContain('credit_transactions');
    expect(txCall[1][3]).toBe('purchase');
  });

  it('ensures row exists on first credit via ON CONFLICT', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // INSERT PaymentIntent parent / lock
      .mockResolvedValueOnce({ rows: [{ team_id: 'team_new', credit_kind: 'auto_topup', amount_microcents: '5000000', credit_applied: false }] }) // SELECT parent FOR UPDATE
      .mockResolvedValueOnce({ rows: [] }) // legacy ledger bootstrap
      .mockResolvedValueOnce({ rows: [] }) // INSERT ensure
      .mockResolvedValueOnce({ rows: [{ withheld_microcents: '0' }] }) // pending reversals
      .mockResolvedValueOnce({ rows: [{ balance_microcents: '5000000' }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // INSERT transaction
      .mockResolvedValueOnce({ rows: [] }) // mark parent credit_applied
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    await addCredits('team_new', 5, 'auto_topup', 'ref_2');
    // Call index 3 is the balance-row ensure after acquiring the shared
    // PaymentIntent lock (BEGIN + INSERT/SELECT parent).
    const ensureCall = mockQuery.mock.calls[4];
    expect(ensureCall[0]).toContain('ON CONFLICT');
    expect(ensureCall[1][0]).toBe('team_new');
  });

  it('credits once and bumps the balance when an idempotency key is first seen', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // INSERT PaymentIntent parent / lock
      .mockResolvedValueOnce({ rows: [{ team_id: 'team_x', credit_kind: 'auto_topup', amount_microcents: '5000000', credit_applied: false }] }) // SELECT parent FOR UPDATE
      .mockResolvedValueOnce({ rows: [] }) // legacy ledger bootstrap
      .mockResolvedValueOnce({ rows: [] }) // INSERT ensure
      .mockResolvedValueOnce({ rows: [{ withheld_microcents: '0' }] }) // pending reversals
      .mockResolvedValueOnce({ rows: [{ id: 'ctx_x' }] }) // claim INSERT (inserted, RETURNING id)
      .mockResolvedValueOnce({ rows: [{ balance_microcents: '5000000' }] }) // UPDATE bump RETURNING true balance
      .mockResolvedValueOnce({ rows: [] }) // UPDATE ledger balance_after backfill
      .mockResolvedValueOnce({ rows: [] }) // mark parent credit_applied
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const bal = await addCredits('team_x', 5, 'auto_topup', 'pi_123', 'pi_123');
    // Returned balance comes from the UPDATE's RETURNING (true post-update value).
    expect(bal).toBe(5_000_000);
    // The claim insert must dedup on the idempotency key.
    const claimCall = mockQuery.mock.calls[6];
    expect(claimCall[0]).toContain('idempotency_key');
    expect(claimCall[0]).toContain('ON CONFLICT');
    expect(claimCall[1]).toContain('pi_123');
    // The balance is bumped after the parent lock and pending-state read.
    expect(mockQuery.mock.calls[7][0]).toContain('UPDATE credit_balances');
    expect(mockQuery.mock.calls[7][0]).toContain('RETURNING');
    // The ledger row's running balance is backfilled with the true post-update value.
    expect(mockQuery.mock.calls[8][0]).toContain('UPDATE credit_transactions SET balance_after_microcents');
    expect(mockQuery.mock.calls[8][1][0]).toBe(5_000_000);
  });

  it('applies pending auto-topup reversals before the worker exposes credit', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // INSERT PaymentIntent parent / lock
      .mockResolvedValueOnce({ rows: [{ team_id: 'team_x', credit_kind: 'auto_topup', amount_microcents: '5000000', credit_applied: false }] }) // SELECT parent FOR UPDATE
      .mockResolvedValueOnce({ rows: [] }) // legacy ledger bootstrap
      .mockResolvedValueOnce({ rows: [] }) // INSERT ensure
      .mockResolvedValueOnce({ rows: [{ withheld_microcents: '2000000' }] }) // pending refund/dispute
      .mockResolvedValueOnce({ rows: [{ id: 'ctx_x' }] }) // claim ledger row
      .mockResolvedValueOnce({ rows: [{ balance_microcents: '3000000' }] }) // UPDATE balance
      .mockResolvedValueOnce({ rows: [] }) // backfill ledger balance
      .mockResolvedValueOnce({ rows: [] }) // mark parent credit_applied
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    await addCredits('team_x', 5, 'auto_topup', 'pi_reversed_first', 'pi_reversed_first');

    const claimCall = mockQuery.mock.calls[6];
    expect(claimCall[1][2]).toBe(3_000_000);
    expect(mockQuery.mock.calls[7][1][0]).toBe(3_000_000);
  });

  it('does NOT re-credit when the idempotency key was already applied (auto-topup replay)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // INSERT PaymentIntent parent / lock
      .mockResolvedValueOnce({ rows: [{ team_id: 'team_x', credit_kind: 'auto_topup', amount_microcents: '5000000', credit_applied: false }] }) // SELECT parent FOR UPDATE
      .mockResolvedValueOnce({ rows: [] }) // legacy ledger bootstrap
      .mockResolvedValueOnce({ rows: [] }) // INSERT ensure
      .mockResolvedValueOnce({ rows: [{ withheld_microcents: '0' }] }) // pending reversals
      .mockResolvedValueOnce({ rows: [] }) // claim INSERT conflicts -> no row
      .mockResolvedValueOnce({ rows: [] }) // mark parent credit_applied
      .mockResolvedValueOnce({ rows: [{ balance_microcents: '5000000' }] }) // SELECT current balance
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const bal = await addCredits('team_x', 5, 'auto_topup', 'pi_123', 'pi_123');
    expect(bal).toBe(5_000_000); // unchanged — credited only once for this PaymentIntent
    // Crucially, NO balance bump happened on the replay.
    const bumpCalls = mockQuery.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('UPDATE credit_balances'),
    );
    expect(bumpCalls).toHaveLength(0);
  });
});
