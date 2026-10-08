import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClickHouseIngester } from '../src/logging/clickhouse.js';

describe('ClickHouseIngester', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rejects table names outside allowlist', () => {
    expect(() => new ClickHouseIngester('https://ch.local', 'other_table')).toThrow(
      "ClickHouse table 'other_table' is not in the allowlist",
    );
  });

  it('flushes batch successfully and clears buffer', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const ingester = new ClickHouseIngester('https://ch.local', 'request_logs', 2, 60_000);
    ingester.push({ id: 'r1', api_key_id: 'key-1', layer_identity_id: 'identity-1', system_prompt_tokens: 9000, message_hash: 'hash-1' });
    ingester.push({ id: 'r2', api_key_id: 'key-1', layer_identity_id: 'identity-1', system_prompt_tokens: 9000, message_hash: 'hash-1' });

    await ingester.shutdown();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('https://ch.local/?query=INSERT%20INTO%20request_logs%20FORMAT%20JSONEachRow');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' });
    expect(fetchMock.mock.calls[0][1]?.body).toContain('layer_identity_id');
    expect(fetchMock.mock.calls[0][1]?.body).toContain('system_prompt_tokens');
  });

  it('re-queues records when fetch throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const ingester = new ClickHouseIngester('https://ch.local', 'request_logs', 100, 60_000);
    ingester.push({ id: 'r1' });

    await ingester.flush();
    await ingester.shutdown();

    expect(fetchMock).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith('ClickHouse insert error:', expect.any(Error));
  });

  it('re-queues records when ClickHouse returns a non-2xx response', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn(async () => new Response('bad insert', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const ingester = new ClickHouseIngester('https://ch.local', 'request_logs', 100, 60_000);
    ingester.push({ id: 'r1' });

    await ingester.flush();
    await ingester.shutdown();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith('ClickHouse insert failed: 500 bad insert');
  });

  // --- RSH-64: re-queue must use concat, not unshift(...batch) ---

  it('re-queues a failed batch in FRONT of records that arrived during the flush (concat order)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let failNext = true;
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(init.body);
      if (failNext) {
        failNext = false;
        return new Response('boom', { status: 500 });
      }
      return new Response('', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    // High maxSize so push() never auto-flushes; we drive flush() by hand.
    const ingester = new ClickHouseIngester('https://ch.local', 'request_logs', 100_000, 60_000);
    ingester.push({ id: 'r1' });
    ingester.push({ id: 'r2' });

    const flushing = ingester.flush(); // takes [r1,r2]; fetch resolves 500 (in-flight)
    ingester.push({ id: 'n1' }); // newcomer arrives during the flush
    await flushing; // re-queue [r1,r2] in front of [n1] → [r1,r2,n1]

    await ingester.flush(); // success: sends all three in original order

    const sent = bodies[1].split('\n').map((line) => (JSON.parse(line) as { id: string }).id);
    expect(sent).toEqual(['r1', 'r2', 'n1']);
    await ingester.shutdown();
  });

  it('re-queues a large failed batch without throwing a spread/arg RangeError', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn(async () => new Response('down', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    // Large enough that `unshift(...batch)` could blow the argument-count limit;
    // concat handles any size. Cap is well above the batch so nothing is dropped.
    const BIG = 100_000;
    const ingester = new ClickHouseIngester('https://ch.local', 'request_logs', BIG + 1, 60_000, BIG + 1);
    for (let i = 0; i < BIG; i++) ingester.push({ id: `r${i}` });

    await expect(ingester.flush()).resolves.toBeUndefined();
    expect(ingester.pendingCount).toBe(BIG); // whole batch retained, none lost
    clearTimer(ingester);
  });

  it('push: buffer cap drops oldest and accounts the drop, staying bounded', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    // Tiny injected cap + huge maxSize → exercise the cap without auto-flush.
    const ingester = new ClickHouseIngester('https://ch.local', 'request_logs', 100_000, 60_000, 5);
    for (let i = 0; i < 8; i++) ingester.push({ id: `r${i}` });

    expect(ingester.pendingCount).toBe(5); // bounded at the cap
    expect(ingester.droppedCount).toBe(3); // 3 oldest dropped AND accounted
    await ingester.shutdown();
  });

  it('failure re-queue stays bounded and accounts forced drops (cap holds on the catch path)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn(async () => {
      throw new Error('CH down');
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const ingester = new ClickHouseIngester('https://ch.local', 'request_logs', 100_000, 60_000, 5); // cap 5
    for (let i = 0; i < 5; i++) ingester.push({ id: `b${i}` }); // buffer = 5
    const flushing = ingester.flush(); // takes 5, empties buffer, fetch throws (in-flight)
    for (let i = 0; i < 4; i++) ingester.push({ id: `n${i}` }); // newcomers arrive → buffer = 4
    await flushing; // catch: 5 re-queued in front of 4 = 9 → drop 4 oldest, back to cap

    expect(ingester.pendingCount).toBe(5); // bounded despite batch + newcomers > cap (not ~2x)
    expect(ingester.droppedCount).toBe(4); // forced re-queue drops are accounted
    clearTimer(ingester);
  });
});

/** Stop the flush interval without triggering a final flush() — for tests whose
 * stubbed fetch fails, where shutdown()'s flush would just re-queue again. */
function clearTimer(ingester: ClickHouseIngester): void {
  clearInterval((ingester as unknown as { flushTimer: NodeJS.Timeout }).flushTimer);
}
