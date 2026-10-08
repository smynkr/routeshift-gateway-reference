'use client';

/**
 * Shared cookie/analytics-consent state.
 *
 * The site presents a cookie notice (see components/cookie-notice.tsx) with an
 * implied-consent stance ("by continuing you agree"). This helper lets the
 * notice and every analytics provider agree on one source of truth so that a
 * user who explicitly DECLINES is actually honoured: declined → no third-party
 * analytics/session-replay initialises.
 *
 * Model: opt-OUT. Analytics may run unless the user has explicitly declined.
 * (For strict GDPR/ePrivacy opt-IN, flip `analyticsAllowed` to require
 * `read() === 'accepted'` — see the review notes — and surface the notice on
 * authenticated routes too.)
 */
export const CONSENT_KEY = 'routeshift-cookie-consent';
export const CONSENT_CHANGE_EVENT = 'routeshift-consent-change';

export type ConsentChoice = 'accepted' | 'declined';

export function readConsent(): ConsentChoice | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(CONSENT_KEY);
    return value === 'accepted' || value === 'declined' ? value : null;
  } catch {
    return null;
  }
}

/** True unless the user has explicitly opted out of analytics. */
export function analyticsAllowed(): boolean {
  return readConsent() !== 'declined';
}

export function writeConsent(choice: ConsentChoice): void {
  try {
    window.localStorage.setItem(CONSENT_KEY, choice);
  } catch {
    // localStorage can throw (private mode, disabled storage); consent simply
    // won't persist, which fails safe to the implied-consent default.
  }
  try {
    window.dispatchEvent(new CustomEvent(CONSENT_CHANGE_EVENT));
  } catch {
    // CustomEvent unsupported — providers fall back to checking on next load.
  }
}
