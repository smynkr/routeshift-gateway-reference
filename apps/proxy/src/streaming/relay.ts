// apps/proxy/src/streaming/relay.ts
import type { ServerResponse } from 'node:http';
import type { CanonicalStreamChunk } from '@routeshift/shared';
import type { LLMProvider } from '../providers/types.js';
import { SSEParser } from './sse-parser.js';

export const CHUNK_TIMEOUT_MS = 30_000;
export const DRAIN_TIMEOUT_MS = 5_000;
export const CREDIT_RESERVATION_HEARTBEAT_MIN_INTERVAL_MS = 5 * 60 * 1000;
const CREDIT_RESERVATION_HEARTBEAT_TIMEOUT_MS = 30_000;
const CREDIT_RESERVATION_HEARTBEAT_FAILURE = 'Credit reservation heartbeat failed';

function readWithTimeout<T>(reader: ReadableStreamDefaultReader<T>): Promise<ReadableStreamReadResult<T>> {
  return Promise.race([
    reader.read(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Stream read timeout')), CHUNK_TIMEOUT_MS)
    ),
  ]);
}

async function refreshCreditReservationWithTimeout(refresh: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      refresh(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Credit reservation heartbeat timed out')),
          CREDIT_RESERVATION_HEARTBEAT_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface RelayResult {
  chunks: CanonicalStreamChunk[];
  ttft_ms: number | null;
  /** True if the client disconnected mid-stream — caller can skip or
   *  partial-attribute billing for the unread tail. */
  clientAborted: boolean;
  /** HTTP status actually written to the client. 200 for a normal stream — an
   *  error mid-stream is delivered as an in-band SSE error chunk *after* the 200
   *  head is already committed, so the wire status stays 200 — and 502 only when
   *  the upstream returned no body. The caller logs this instead of hard-coding
   *  200 (which mislabelled the no-body 502 as a success). */
  statusCode: number;
  /** Set when the stream died mid-flight from a genuine upstream/processing
   *  failure (read timeout, parse error, write fault) rather than a clean finish
   *  or a client abort. The wire status is already committed as 200, so the
   *  caller logs this as a distinct error_type — otherwise a truncated/errored
   *  stream is counted as a 200 success in analytics and alerting. Undefined on
   *  a clean stream or a client-initiated abort. */
  streamError?: string;
}

/** A liveness lease for a durable credit reservation during a long stream. */
export interface RelayCreditReservationLease {
  /** Heartbeats are throttled to no more than one every five minutes. */
  intervalMs: number;
  /**
   * Caller-provided heartbeat. May compose several renewals (e.g. a credit
   * reservation refresh and an RSH-138 budget reservation lease refresh);
   * the relay only invokes it and never inspects its internals.
   */
  refresh: () => Promise<void>;
}

export async function relayStream(
  upstreamResponse: Response,
  clientResponse: ServerResponse,
  provider: LLMProvider,
  creditReservationLease?: RelayCreditReservationLease,
): Promise<RelayResult> {
  if (!upstreamResponse.body) {
    clientResponse.writeHead(502, { 'Content-Type': 'application/json' });
    clientResponse.end(JSON.stringify({ error: { message: 'No response body from upstream' } }));
    return { chunks: [], ttft_ms: null, clientAborted: false, statusCode: 502 };
  }
  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SSEParser();
  const chunks: CanonicalStreamChunk[] = [];
  let firstChunkTime: number | null = null;
  let streamError: string | undefined;
  const startTime = Date.now();
  const heartbeatIntervalMs = creditReservationLease
    ? Math.max(CREDIT_RESERVATION_HEARTBEAT_MIN_INTERVAL_MS, creditReservationLease.intervalMs)
    : 0;
  let lastHeartbeatAt = startTime;

  // Detect client disconnect so we can cancel the upstream reader and
  // stop draining bytes the user will never see.
  let clientAborted = false;
  const onClientClose = () => {
    clientAborted = true;
    reader.cancel().catch(() => {});
  };
  clientResponse.once('close', onClientClose);

  clientResponse.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  try {
    while (!clientAborted) {
      const { done, value } = await readWithTimeout(reader);
      if (done) break;

      // Renew only after the upstream has actually produced bytes. This covers
      // provider keepalives without creating a timer that can falsely keep an
      // abandoned request alive, and it stops before delivering a chunk if the
      // durable reservation is no longer refreshable.
      if (
        creditReservationLease
        && Date.now() - lastHeartbeatAt >= heartbeatIntervalMs
      ) {
        try {
          await refreshCreditReservationWithTimeout(creditReservationLease.refresh);
          lastHeartbeatAt = Date.now();
        } catch {
          // Cancellation is best-effort: an upstream implementation may return
          // a promise that never settles. Do not let that delay the fail-closed
          // billing result and unknown-cost hold.
          void reader.cancel().catch(() => {});
          throw new Error(CREDIT_RESERVATION_HEARTBEAT_FAILURE);
        }
      }

      const text = decoder.decode(value, { stream: true });
      const events = parser.push(text);

      for (const event of events) {
        if (clientAborted) break;
        const parsed = provider.parseStreamChunk(event);
        if (!parsed) continue;
        // A single SSE event can yield more than one canonical chunk (e.g. Gemini
        // bundles the final content delta together with its finish/usage chunk).
        const canonicalChunks = Array.isArray(parsed) ? parsed : [parsed];
        for (const canonical of canonicalChunks) {
          if (clientAborted) break;
          if (firstChunkTime === null && canonical.type === 'content_delta') {
            firstChunkTime = Date.now();
          }
          chunks.push(canonical);
          const ok = clientResponse.write(`data: ${JSON.stringify(canonical)}\n\n`);
          if (!ok && !clientResponse.destroyed) {
            // Bound the drain wait so a destroyed-but-not-yet-emitted-close
            // socket cannot stall the loop indefinitely.
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, DRAIN_TIMEOUT_MS);
              clientResponse.once('drain', () => {
                clearTimeout(timer);
                resolve();
              });
            });
          }
        }
      }
    }

    if (!clientAborted) {
      clientResponse.write('data: [DONE]\n\n');
      clientResponse.end();
    }
  } catch (err) {
    // Surface upstream stream failures (read timeouts, parse errors, write
    // faults) — otherwise a stream that dies mid-flight is invisible to operators
    // AND mislogged as a 200 success. A read that rejects *because the client
    // cancelled* is expected, not a failure, so only flag genuine upstream/
    // processing errors (the loop exits cleanly on a normal abort and never
    // reaches here; a cancel-induced reject lands here with clientAborted=true).
    const creditReservationHeartbeatFailed =
      err instanceof Error && err.message === CREDIT_RESERVATION_HEARTBEAT_FAILURE;
    // Billing classification must survive a client disconnect that races a
    // hung heartbeat. Client writes remain suppressed below, but the caller
    // still needs the sentinel to retain the unknown-cost hold.
    if (creditReservationHeartbeatFailed) {
      streamError = 'credit_reservation_heartbeat_failed';
    }
    if (!clientAborted) {
      console.error('[relay] stream error:', err);
      streamError ??=
        err instanceof Error && err.message === 'Stream read timeout'
            ? 'stream_read_timeout'
            : 'stream_failed';
      if (!clientResponse.destroyed) {
        const errorChunk: CanonicalStreamChunk = {
          type: 'error',
          stop_reason: 'error',
        };
        clientResponse.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
        clientResponse.end();
      }
    }
  } finally {
    clientResponse.removeListener('close', onClientClose);
  }

  return {
    chunks,
    ttft_ms: firstChunkTime ? firstChunkTime - startTime : null,
    clientAborted,
    statusCode: 200,
    streamError,
  };
}
