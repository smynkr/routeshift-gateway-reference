import { describe, expect, it } from 'vitest';
import { BedrockProvider } from '../src/providers/bedrock.js';

// The Bedrock region is interpolated into the upstream host
// (bedrock-runtime.<region>.amazonaws.com), so the proxy must reject any region
// that isn't a well-formed AWS region — even though the dashboard validates on
// save, the proxy must not trust stored metadata (SSRF defense-in-depth).
describe('BedrockProvider region validation (SSRF guard)', () => {
  const provider = new BedrockProvider();
  const baseReq = {
    model: 'anthropic.claude-opus-4-6-v1',
    messages: [{ role: 'user' as const, content: 'Hi' }],
    stream: false,
  };

  it('rejects regions that are not well-formed AWS regions', () => {
    const bad = [
      'evil.com',
      'us-east-1.evil.com',
      'us-east-1/../foo',
      'US-EAST-1', // uppercase
      'us-east-1 ', // trailing space
      'us_east_1',
    ];
    for (const region of bad) {
      expect(() =>
        provider.buildRequest(baseReq, 'secret-key', { access_key_id: 'AKIAEXAMPLE', region }),
      ).toThrow(/not a valid AWS region/);
    }
  });

  it('still requires access_key_id and region to be present', () => {
    expect(() =>
      provider.buildRequest(baseReq, 'secret-key', { region: 'us-east-1' }),
    ).toThrow(/requires access_key_id and region/);
    expect(() =>
      provider.buildRequest(baseReq, 'secret-key', { access_key_id: 'AKIAEXAMPLE' }),
    ).toThrow(/requires access_key_id and region/);
  });

  it('accepts well-formed regions (standard + gov-cloud)', () => {
    for (const region of ['us-east-1', 'eu-west-2', 'us-gov-west-1', 'ap-southeast-2']) {
      expect(() =>
        provider.buildRequest(baseReq, 'secret-key', { access_key_id: 'AKIAEXAMPLE', region }),
      ).not.toThrow();
    }
  });
});
