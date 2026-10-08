// apps/proxy/src/auth/scope.ts
//
// OAuth device-flow key scope enforcement (RSH-69).
//
// A device-flow key carries a `scope` string in its metadata. Legacy
// non-device keys with no scope remain unrestricted. An OAuth-device key with
// a missing/empty scope is treated as inference-only: older dashboard builds
// displayed that consent but accidentally minted an empty (formerly
// unrestricted) scope. Split on whitespace and/or commas to match the
// dashboard's parseScopes() ("inference read" or "inference,read").

function effectiveScopes(
  metadata: Record<string, unknown> | null | undefined,
): string[] | null {
  const rawScope = metadata?.scope;
  if (typeof rawScope === 'string') {
    const scopes = rawScope.split(/[\s,]+/).filter(Boolean);
    if (scopes.length > 0) return scopes;
    // Preserve the previous fail-closed behavior for a non-device key whose
    // scope is non-empty but contains only whitespace/separators. Only a
    // genuinely missing or literal-empty legacy scope means unrestricted.
    if (rawScope.length > 0 && metadata?.created_via !== 'oauth_device') return [];
  }

  // RSH-69 compatibility repair: old OAuth-device grants represented
  // inference consent with an empty scope. Preserve full access only for
  // genuinely legacy/non-device unscoped keys.
  if (metadata?.created_via === 'oauth_device') return ['inference'];
  return null;
}

/** True when the key is permitted to run billable inference. */
export function keyHasInferenceScope(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  const scopes = effectiveScopes(metadata);
  return scopes === null || scopes.includes('inference');
}

/** True when the key is permitted to read reporting/usage data. */
export function keyHasReadScope(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  const scopes = effectiveScopes(metadata);
  return scopes === null || scopes.includes('read');
}
