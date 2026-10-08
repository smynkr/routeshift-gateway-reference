// Secret hygiene. The minted key must never be printed in full to stdout, a
// log, or a diff. We show only the non-secret prefix (sk-proxy-<env>_<team>)
// and mask the random tail.

export function maskSecret(secret: string): string {
  if (!secret) return '';
  // RouteShift keys are sk-proxy-<env>_<team>_<random>. Show only the first two
  // underscore-delimited segments (the non-secret prefix) and mask the rest to
  // a fixed width. Capping by segment count — rather than lastIndexOf('_') —
  // keeps the mask safe even if the random tail ever contained an underscore.
  const segments = secret.split('_');
  const shown = segments.length >= 3 ? `${segments.slice(0, 2).join('_')}_` : secret.slice(0, 8);
  return `${shown}${'•'.repeat(8)}`;
}

/** Replace every occurrence of `secret` in `text` with its masked form. */
export function redact(text: string, secret: string | null | undefined): string {
  if (!secret) return text;
  return text.split(secret).join(maskSecret(secret));
}

// RouteShift keys are sk-proxy-<env>_<team>_<random>. Match a whole token,
// stopping at the delimiters that bound a key in the files we diff (whitespace,
// quotes, backticks, and JSON/shell punctuation), so the random tail is masked
// even when the exact value isn't known to us.
const ROUTESHIFT_KEY_RE = /sk-proxy-[^\s"'`,;]+/g;

/**
 * Redact a diff before it is printed (RSH-58). Masks every KNOWN secret by exact
 * match — the freshly minted token AND any prior key we hold (e.g. the previous
 * keychain value) — then runs a structural pass that masks ANY RouteShift-format
 * key still present. The structural pass closes the gap where the old key on a
 * removed line came from a source we don't track (a file-resident key that has
 * diverged from the keychain), honoring diff.ts's "callers MUST redact both
 * inputs" contract regardless of value.
 */
export function redactDiff(text: string, knownSecrets: Array<string | null | undefined>): string {
  let out = text;
  for (const secret of knownSecrets) out = redact(out, secret);
  return out.replace(ROUTESHIFT_KEY_RE, (match) => maskSecret(match));
}
