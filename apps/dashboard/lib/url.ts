export function getSafeCallbackUrl(callbackUrl: string | null): string {
  if (!callbackUrl) return '/overview';
  try {
    const parsed = new URL(callbackUrl, window.location.origin);
    if (parsed.origin === window.location.origin) {
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  } catch {}
  return '/overview';
}

export function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname);
  } catch {
    return false;
  }
}
