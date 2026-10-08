/**
 * Shared utilities for communicating with the proxy admin API.
 * Eliminates duplication of PROXY_URL, ADMIN_SECRET, and adminHeaders()
 * across multiple API routes and page components.
 */
export const PROXY_URL = process.env.PROXY_URL ?? 'http://localhost:4000';

/**
 * Throws if ADMIN_SECRET is missing or empty.
 * Call inside a try/catch so the existing catch block can return a 502/500.
 */
export function assertAdminSecret(): void {
  if (typeof process.env.ADMIN_SECRET !== 'string' || !process.env.ADMIN_SECRET) {
    throw new Error('Proxy admin secret not configured');
  }
}

export function adminHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  const secret = process.env.ADMIN_SECRET;
  if (secret) h['Authorization'] = `Bearer ${secret}`;
  return h;
}
