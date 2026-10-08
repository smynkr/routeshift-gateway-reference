import type { JurisdictionEvidence } from './provider-preferences';

/**
 * RSH-164 evidence lifecycle policy.
 *
 * Who verifies: a human review of the provider's published contract/legal
 * terms (the `source` label records which kind of review). When: `verified_at`
 * stamps the review date. Expiry: evidence is valid for
 * `JURISDICTION_EVIDENCE_LIFETIME_DAYS` after verification — the registry
 * staleness test (tests/jurisdiction-evidence.test.ts) fails loudly the day
 * any evidence-bearing endpoint goes stale, so expiry is a hard re-verify
 * reminder, never a silent drop.
 *
 * The future-dated question (RSH-156 review round): resolved fail-closed.
 * `hasCurrentJurisdictionEvidence` already rejects `verified_at` in the
 * future; this builder refuses to construct such evidence at all, so a
 * future-dated stamp cannot even enter the catalog.
 */
export const JURISDICTION_EVIDENCE_LIFETIME_DAYS = 365;

export interface JurisdictionEvidenceInput {
  source: 'provider_legal_review' | 'provider_contract';
  /** ISO timestamp of the human review; must not be in the future. */
  verified_at: string;
  /** Override for tests; defaults to JURISDICTION_EVIDENCE_LIFETIME_DAYS. */
  lifetimeDays?: number;
}

/**
 * Stamp verified jurisdiction evidence. THROWS on any invalid input — a
 * future-dated or malformed review stamp, or an out-of-range lifetime —
 * because silently degrading to no-evidence at module load would smuggle
 * `null` under a non-null type (the review-round `!` hazard). The registry
 * staleness gate then fails loudly before expiry so re-verification is
 * scheduled, never discovered.
 *
 * The wall-clock coupling is deliberate and bounded: evidence is only ever
 * stamped at authoring time (the verified_at is the human review date), and
 * the staleness gate carries a 30-day early-warning threshold.
 */
export function verifyJurisdictionEvidence(input: JurisdictionEvidenceInput): JurisdictionEvidence {
  if (input.source !== 'provider_legal_review' && input.source !== 'provider_contract') {
    throw new Error('verifyJurisdictionEvidence: unknown evidence source');
  }
  // Strict ISO-8601: Date.parse alone accepts sloppy human formats
  // ('August 10, 2026') that have no place in an evidence ledger.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(input.verified_at)) {
    throw new Error('verifyJurisdictionEvidence: verified_at must be ISO-8601 UTC (YYYY-MM-DDTHH:mm:ssZ)');
  }
  const verifiedMs = Date.parse(input.verified_at);
  if (!Number.isFinite(verifiedMs)) {
    throw new Error('verifyJurisdictionEvidence: verified_at is not a parseable date');
  }
  if (verifiedMs > Date.now()) {
    throw new Error('verifyJurisdictionEvidence: verified_at is in the future');
  }
  const lifetimeDays = input.lifetimeDays ?? JURISDICTION_EVIDENCE_LIFETIME_DAYS;
  if (!Number.isFinite(lifetimeDays) || lifetimeDays < 1 || lifetimeDays > JURISDICTION_EVIDENCE_LIFETIME_DAYS) {
    throw new Error(
      `verifyJurisdictionEvidence: lifetimeDays must be within [1, ${JURISDICTION_EVIDENCE_LIFETIME_DAYS}]`,
    );
  }
  const expiresMs = verifiedMs + lifetimeDays * 86_400_000;
  return {
    source: input.source,
    status: 'verified',
    verified_at: new Date(verifiedMs).toISOString(),
    expires_at: new Date(expiresMs).toISOString(),
  };
}
