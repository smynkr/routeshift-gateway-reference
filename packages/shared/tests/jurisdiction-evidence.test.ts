import { describe, expect, it } from 'vitest';
import { verifyJurisdictionEvidence, JURISDICTION_EVIDENCE_LIFETIME_DAYS } from '../src/jurisdiction-evidence';
import { hasCurrentJurisdictionEvidence, applyProviderPreferences, type ProviderEndpoint } from '../src/provider-preferences';
import { MODEL_ENDPOINTS } from '../src/provider-endpoints';

/** Early-warning window: the staleness gate fails 30 days BEFORE expiry, so
 *  re-verification is scheduled instead of discovered at the flip instant. */
const EARLY_WARNING_DAYS = 30;

describe('verifyJurisdictionEvidence (RSH-164 lifecycle)', () => {
  it('stamps verified evidence with the policy expiry window', () => {
    const evidence = verifyJurisdictionEvidence({
      source: 'provider_contract',
      verified_at: '2026-08-10T00:00:00Z',
      lifetimeDays: 365,
    });
    expect(evidence.status).toBe('verified');
    expect(evidence.verified_at).toBe('2026-08-10T00:00:00.000Z');
    expect(evidence.expires_at).toBe('2027-08-10T00:00:00.000Z');
    expect(hasCurrentJurisdictionEvidence(evidence)).toBe(true);
  });

  it('THROWS on a future-dated review stamp (fail loud at construction)', () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(() => verifyJurisdictionEvidence({ source: 'provider_legal_review', verified_at: future })).toThrow(
      /verified_at is in the future/,
    );
  });

  it('THROWS on malformed or sloppy (non-ISO) dates', () => {
    expect(() => verifyJurisdictionEvidence({ source: 'provider_contract', verified_at: 'not-a-date' })).toThrow();
    expect(() => verifyJurisdictionEvidence({ source: 'provider_contract', verified_at: 'August 10, 2026' })).toThrow(
      /ISO-8601/,
    );
  });

  it('THROWS on out-of-range lifetimes (cannot mint never-expiring evidence)', () => {
    expect(() =>
      verifyJurisdictionEvidence({ source: 'provider_contract', verified_at: '2026-08-10T00:00:00Z', lifetimeDays: 0 }),
    ).toThrow(/lifetimeDays/);
    expect(() =>
      verifyJurisdictionEvidence({ source: 'provider_contract', verified_at: '2026-08-10T00:00:00Z', lifetimeDays: 10_000 }),
    ).toThrow(/lifetimeDays/);
  });

  it('defaults the lifetime to the policy constant', () => {
    const evidence = verifyJurisdictionEvidence({ source: 'provider_contract', verified_at: '2026-08-10T00:00:00Z' });
    expect(evidence.expires_at).toBe('2027-08-10T00:00:00.000Z');
    expect(JURISDICTION_EVIDENCE_LIFETIME_DAYS).toBe(365);
  });
});

describe('MODEL_ENDPOINTS evidence registry', () => {
  it('every evidence-bearing endpoint is CURRENT with 30 days of lead time (staleness gate)', () => {
    const all = Object.values(MODEL_ENDPOINTS).flat();
    const withEvidence = all.filter((e) => e.jurisdiction_evidence != null);
    for (const endpoint of withEvidence) {
      const evidence = endpoint.jurisdiction_evidence!;
      expect(
        hasCurrentJurisdictionEvidence(evidence),
        `${endpoint.provider}:${endpoint.model} evidence not current — re-verify`,
      ).toBe(true);
      const remainingMs = Date.parse(evidence.expires_at) - Date.now();
      expect(
        remainingMs > EARLY_WARNING_DAYS * 86_400_000,
        `${endpoint.provider}:${endpoint.model} evidence expires within ${EARLY_WARNING_DAYS} days — re-verify NOW`,
      ).toBe(true);
    }
  });

  it('caps every evidence lifetime at the policy window (no never-expiring evidence)', () => {
    const all = Object.values(MODEL_ENDPOINTS).flat();
    const withEvidence = all.filter((e) => e.jurisdiction_evidence != null);
    for (const endpoint of withEvidence) {
      const evidence = endpoint.jurisdiction_evidence!;
      const lifetimeMs = Date.parse(evidence.expires_at) - Date.parse(evidence.verified_at);
      expect(lifetimeMs).toBeGreaterThan(0);
      expect(lifetimeMs).toBeLessThanOrEqual(JURISDICTION_EVIDENCE_LIFETIME_DAYS * 86_400_000);
    }
  });

  it('every evidence-bearing endpoint declares a non-empty jurisdiction', () => {
    for (const endpoint of Object.values(MODEL_ENDPOINTS).flat()) {
      if (endpoint.jurisdiction_evidence == null) continue;
      expect(endpoint.jurisdictions?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('matching jurisdictions with stale/null evidence stay inadmissible (fail-open guard)', () => {
    const stale = verifyJurisdictionEvidence({ source: 'provider_contract', verified_at: '2020-01-01T00:00:00Z' });
    const endpoints: ProviderEndpoint[] = [
      { provider: 'openai', model: 'gpt-5.5', zdr: false, jurisdictions: ['US'], jurisdiction_evidence: stale },
      { provider: 'openai', model: 'gpt-5.5', zdr: false, jurisdictions: ['US'], jurisdiction_evidence: null },
    ];
    for (const endpoint of endpoints) {
      expect(applyProviderPreferences([endpoint], { data_residency: ['US'] })).toEqual({
        ok: false,
        reason: 'no_eligible_provider_residency',
      });
    }
  });

  it('locks the catalog evidence state: NO endpoint is residency-eligible (RSH-164 audit)', () => {
    // 2026-08-10 audit of 13 providers' public terms found no strict region
    // guarantee (deepseek's CN claim withdrawn on its own policy's hedges —
    // see docs/compliance/RSH-164-jurisdiction-review.md). The catalog
    // declares zero evidence: every residency preference fails closed.
    const all = Object.values(MODEL_ENDPOINTS).flat();
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((e) => e.jurisdiction_evidence == null)).toBe(true);
    expect(applyResidency(all, ['CN'])).toEqual({ ok: false, reason: 'no_eligible_provider_residency' });
    expect(applyResidency(all, ['US'])).toEqual({ ok: false, reason: 'no_eligible_provider_residency' });
    expect(applyResidency(all, ['EU'])).toEqual({ ok: false, reason: 'no_eligible_provider_residency' });
  });
});

function applyResidency(endpoints: readonly ProviderEndpoint[], residency: string[]): ReturnType<typeof applyProviderPreferences<ProviderEndpoint>> {
  return applyProviderPreferences(endpoints, { data_residency: residency });
}
