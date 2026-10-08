import { describe, expect, it } from 'vitest';
import { applyProviderPreferences, hasCurrentJurisdictionEvidence, parseProviderPreferences } from '../src/provider-preferences';
import { MODEL_ENDPOINTS } from '../src/provider-endpoints';

describe('applyProviderPreferences', () => {
  const endpoints = [
    { provider: 'openai', model: 'gpt-5.5', zdr: false },
    { provider: 'azure', model: 'gpt-5.5', zdr: true },
    { provider: 'anthropic', model: 'claude-sonnet-4-6', zdr: true },
  ];

  it('orders endpoints by provider.order without dropping unspecified providers', () => {
    const result = applyProviderPreferences(endpoints, { order: ['anthropic', 'azure'] });

    expect(result).toEqual({
      ok: true,
      endpoints: [endpoints[2], endpoints[1], endpoints[0]],
      strippedRequestFields: ['provider'],
    });
  });

  it('applies deny before order', () => {
    const result = applyProviderPreferences(endpoints, { deny: ['openai'], order: ['openai', 'anthropic'] });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.endpoints.map((e) => e.provider)).toEqual(['anthropic', 'azure']);
  });

  it('does not mark provider for stripping when no provider-targeting prefs are applied', () => {
    const result = applyProviderPreferences(endpoints, {});

    expect(result).toEqual({ ok: true, endpoints, strippedRequestFields: [] });
  });

  it('fail-closes when data_collection=deny leaves no ZDR endpoints', () => {
    const result = applyProviderPreferences(
      [{ provider: 'openai', model: 'gpt-5.5', zdr: false }],
      { data_collection: 'deny' },
    );

    expect(result).toEqual({ ok: false, reason: 'no_eligible_provider' });
  });

  it('carries allow_fallbacks without treating it as provider stripping', () => {
    const result = applyProviderPreferences(endpoints, { allow_fallbacks: false });

    expect(result).toEqual({
      ok: true,
      endpoints,
      strippedRequestFields: [],
      allow_fallbacks: false,
    });
  });

  it('sorts by total endpoint price when provider.sort=price', () => {
    const result = applyProviderPreferences([
      { provider: 'openai', model: 'gpt-5.5-pro', zdr: false },
      { provider: 'azure', model: 'gpt-5.5-pro', zdr: true },
    ], { sort: 'price' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.endpoints.map((endpoint) => endpoint.provider)).toEqual(['azure', 'openai']);
  });

  it('sorts by maintained throughput hints when provider.sort=throughput', () => {
    const result = applyProviderPreferences([
      { provider: 'together', model: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo', zdr: false, throughput_hint: 0.7 },
      { provider: 'groq', model: 'llama-3.1-70b-versatile', zdr: false, throughput_hint: 1.0 },
    ], { sort: 'throughput' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.endpoints.map((endpoint) => endpoint.provider)).toEqual(['groq', 'together']);
  });

  it('fails clearly when requested sort lacks deterministic ranking data', () => {
    expect(applyProviderPreferences([
      { provider: 'together', model: 'missing-price-a', zdr: false },
      { provider: 'groq', model: 'missing-price-b', zdr: false },
    ], { sort: 'price' })).toEqual({
      ok: false,
      reason: 'unsupported_provider_sort',
    });
  });
});

describe('parseProviderPreferences', () => {
  it('normalizes valid provider preference objects and deduplicates lists', () => {
    expect(parseProviderPreferences({
      order: ['azure', 'openai', 'azure'],
      allow: ['azure'],
      data_collection: 'deny',
      allow_fallbacks: false,
      sort: 'price',
    })).toEqual({
      ok: true,
      value: {
        order: ['azure', 'openai'],
        allow: ['azure'],
        data_collection: 'deny',
        allow_fallbacks: false,
        sort: 'price',
      },
    });
  });

  it('rejects unknown providers, values, and keys', () => {
    expect(parseProviderPreferences({ allow: ['evil'] })).toEqual({ ok: false, reason: 'invalid_provider_prefs' });
    expect(parseProviderPreferences({ data_collection: 'DENY' })).toEqual({ ok: false, reason: 'invalid_provider_prefs' });
    expect(parseProviderPreferences({ sort: 'latency' })).toEqual({ ok: false, reason: 'invalid_provider_prefs' });
    expect(parseProviderPreferences({ sort: 'random' })).toEqual({ ok: false, reason: 'invalid_provider_prefs' });
    expect(parseProviderPreferences({ api_key: 'secret' })).toEqual({ ok: false, reason: 'invalid_provider_prefs' });
  });
});

describe('data residency preferences', () => {
  const currentEvidence = { source: 'provider_legal_review' as const, status: 'verified' as const, verified_at: '2026-01-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z' };
  const endpoints = [
    { provider: 'azure', model: 'gpt-5.5', zdr: true, jurisdictions: ['US'], jurisdiction_evidence: currentEvidence },
    { provider: 'openai', model: 'gpt-5.5', zdr: false, jurisdictions: ['US'] },
  ];

  it('selects only endpoints with verified evidence for the requested jurisdiction', () => {
    expect(applyProviderPreferences(endpoints, { data_residency: ['US'] })).toMatchObject({
      ok: true, endpoints: [endpoints[0]], strippedRequestFields: ['provider'],
    });
  });

  it('fails closed with the residency reason for stale or malformed evidence', () => {
    for (const evidence of [
      { ...currentEvidence, expires_at: '2020-01-01T00:00:00Z' },
      { ...currentEvidence, verified_at: 'not-a-date' },
    ]) {
      expect(applyProviderPreferences([{ ...endpoints[0], jurisdiction_evidence: evidence }], { data_residency: ['US'] })).toEqual({
        ok: false, reason: 'no_eligible_provider_residency',
      });
    }
  });

  it('keeps only verified, current residency candidates for fallback replay', () => {
    const result = applyProviderPreferences([
      endpoints[0],
      { provider: 'openai', model: 'gpt-5.5', zdr: false, jurisdictions: ['US'], jurisdiction_evidence: { ...currentEvidence, expires_at: '2020-01-01T00:00:00Z' } },
    ], { data_residency: ['US'] });
    expect(result).toMatchObject({ ok: true, endpoints: [endpoints[0]], strippedRequestFields: ['provider'] });
  });

  it('fails closed with a residency-specific reason when evidence is absent', () => {
    expect(applyProviderPreferences(endpoints, { data_residency: ['EU'] })).toEqual({
      ok: false, reason: 'no_eligible_provider_residency',
    });
  });

  it('parses canonical requested jurisdictions without conflating them with retention', () => {
    expect(parseProviderPreferences({ data_residency: ['EU-DE', 'EU-DE'] })).toEqual({
      ok: true, value: { data_residency: ['EU-DE'] },
    });
  });

  it('locks the catalog state RSH-156 derives from: no catalog endpoint carries residency evidence', () => {
    // RSH-164 audit (2026-08-10): 13 providers' public terms reviewed; none
    // meets the strict-region bar (deepseek's CN claim withdrawn on its own
    // policy's hedges). The catalog declares zero evidence — every residency
    // preference fails closed until a defensible claim exists.
    const all = Object.values(MODEL_ENDPOINTS).flat();
    expect(all.length).toBeGreaterThan(0);
    expect(applyProviderPreferences(all, { data_residency: ['US'] })).toEqual({ ok: false, reason: 'no_eligible_provider_residency' });
    expect(applyProviderPreferences(all, { data_residency: ['CN'] })).toEqual({ ok: false, reason: 'no_eligible_provider_residency' });
  });
});

describe('hasCurrentJurisdictionEvidence', () => {
  const now = new Date('2026-08-08T12:00:00Z');
  const valid = {
    source: 'provider_contract' as const,
    status: 'verified' as const,
    verified_at: '2026-08-01T00:00:00Z',
    expires_at: '2026-09-01T00:00:00Z',
  };

  it('accepts verified evidence that is current and chronologically valid', () => {
    expect(hasCurrentJurisdictionEvidence(valid, now)).toBe(true);
  });

  it('rejects future-dated verification', () => {
    expect(hasCurrentJurisdictionEvidence({
      ...valid,
      verified_at: '2026-08-09T00:00:00Z',
    }, now)).toBe(false);
  });

  it('rejects expired, malformed, or non-chronological evidence', () => {
    for (const evidence of [
      { ...valid, expires_at: '2026-08-08T12:00:00Z' },
      { ...valid, verified_at: 'not-a-date' },
      { ...valid, expires_at: '2026-07-01T00:00:00Z' },
      { ...valid, source: 'provider_marketing' },
      { ...valid, status: 'pending' },
    ]) {
      expect(hasCurrentJurisdictionEvidence(evidence as never, now)).toBe(false);
    }
  });
});
