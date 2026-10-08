// OS keychain access for the RouteShift token. `connect` writes the minted key
// here; `usage` reads it. The OS keychain (macOS Keychain / Linux Secret
// Service / Windows Credential Manager) is encrypted-at-rest and OS-gated.
//
// The repo-wide migration of connect's plaintext tool-config copies to the
// keychain is tracked in Linear RSH-37; this module is the shared mechanism.
import { Entry } from '@napi-rs/keyring';

const SERVICE = 'routeshift';

export interface KeychainStore {
  /** The stored secret for `account`, or null if absent / keychain unavailable. */
  get(account: string): string | null;
  /** Store `secret` for `account`. Throws if the keychain write fails. */
  set(account: string, secret: string): void;
  /** Delete the entry; distinguishes absent credentials from keychain failures. */
  delete(account: string): KeychainDeleteResult;
}

export type KeychainDeleteResult = 'deleted' | 'absent' | 'error';

// Real OS-backed store. Reads/deletes are best-effort (a locked or absent
// keychain — e.g. headless Linux without a Secret Service daemon — yields
// null/'error' rather than crashing the CLI). Writes surface errors so `connect`
// can warn and fall back to the ROUTESHIFT_TOKEN env path.
export const osKeychain: KeychainStore = {
  get(account) {
    try {
      return new Entry(SERVICE, account).getPassword();
    } catch (err) {
      debugKeychain('get', err);
      return null;
    }
  },
  set(account, secret) {
    new Entry(SERVICE, account).setPassword(secret);
  },
  delete(account) {
    try {
      return new Entry(SERVICE, account).deletePassword() ? 'deleted' : 'absent';
    } catch (err) {
      debugKeychain('delete', err);
      return 'error';
    }
  },
};

// A missing/locked keychain is a normal, recoverable state (callers fall back to
// the ROUTESHIFT_TOKEN env var), so we swallow the error — but surface it under
// DEBUG so an operator can tell "never stored" from "keychain unavailable".
// Only the error message is logged, never the secret.
function debugKeychain(op: string, err: unknown): void {
  if (process.env.DEBUG?.includes('routeshift')) {
    console.error(`[routeshift:keychain] ${op} failed:`, (err as Error).message);
  }
}

/** In-memory store with identical semantics, for tests and `--no-keychain` paths. */
export function memoryKeychain(seed: Record<string, string> = {}): KeychainStore {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    get: (account) => map.get(account) ?? null,
    set: (account, secret) => { map.set(account, secret); },
    delete: (account) => (map.delete(account) ? 'deleted' : 'absent'),
  };
}
