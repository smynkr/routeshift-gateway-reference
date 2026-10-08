/**
 * Safely extract `error.message` from an unknown error-response body without
 * disabling type-checking. Returns undefined when the body isn't the expected
 * `{ error: { message: string } }` shape, so callers can fall back.
 */
export function errorMessageFromBody(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const error = (body as Record<string, unknown>).error;
  if (typeof error !== 'object' || error === null) return undefined;
  const message = (error as Record<string, unknown>).message;
  return typeof message === 'string' ? message : undefined;
}

export class ProxyAPIError extends Error {
  constructor(message: string, public readonly status: number, public readonly body?: unknown) {
    super(message);
    this.name = 'ProxyAPIError';
  }
  static fromResponse(status: number, body: unknown): ProxyAPIError {
    const msg = errorMessageFromBody(body) ?? `HTTP ${status}`;
    return new ProxyAPIError(msg, status, body);
  }
}

export class ProxyRateLimitError extends ProxyAPIError {
  constructor(message: string, public readonly retryAfter?: number) {
    super(message, 429);
    this.name = 'ProxyRateLimitError';
  }
}
