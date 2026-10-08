/**
 * Shared helpers to mitigate SSRF vectors when building upstream provider URLs
 * from customer/admin-supplied metadata fields.
 */

export function validateHostInterpolation(value: string, pattern: RegExp, errorMsg: string): string {
  if (!pattern.test(value)) {
    throw new Error(errorMsg);
  }
  return value;
}

export function buildSafeUpstreamUrl(
  endpointUrl: string,
  allowedHostSuffixes?: string[],
  customErrorMsg?: string
): URL {
  const parsed = new URL(endpointUrl);
  const hostname = parsed.hostname.toLowerCase();
  
  if (allowedHostSuffixes && allowedHostSuffixes.length > 0) {
    const isAllowed = allowedHostSuffixes.some(suffix => hostname.endsWith(suffix.toLowerCase()));
    if (!isAllowed) {
      throw new Error(customErrorMsg || `endpoint_url must be an HTTPS endpoint matching one of the allowed host suffixes with no credentials, query, or fragment`);
    }
  }

  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(customErrorMsg || 'endpoint_url must be an HTTPS endpoint with no credentials, query, or fragment');
  }

  return parsed;
}
