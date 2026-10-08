import { describe, it, expect } from 'vitest';
import { keyHasInferenceScope, keyHasReadScope } from '../src/auth/scope.js';

// RSH-69: device-flow key scope enforcement. keyHasInferenceScope is the shared
// gate used by BOTH the chat path (proxy-handler) and the embeddings handler so
// a key scoped without `inference` cannot reach either billable-inference
// surface. Read scopes gate reporting endpoints separately.
describe('keyHasInferenceScope', () => {
  it('allows an unscoped key (no scope metadata)', () => {
    expect(keyHasInferenceScope({})).toBe(true);
    expect(keyHasInferenceScope(null)).toBe(true);
    expect(keyHasInferenceScope(undefined)).toBe(true);
  });

  it('allows a key whose scope is an empty string', () => {
    expect(keyHasInferenceScope({ scope: '' })).toBe(true);
  });

  it('rejects malformed non-empty legacy scope instead of treating it as unscoped', () => {
    expect(keyHasInferenceScope({ scope: '   ' })).toBe(false);
    expect(keyHasInferenceScope({ scope: ',,,' })).toBe(false);
  });

  it('treats a legacy empty/missing OAuth-device scope as inference-only', () => {
    expect(keyHasInferenceScope({ created_via: 'oauth_device', scope: '' })).toBe(true);
    expect(keyHasInferenceScope({ created_via: 'oauth_device', scope: '   ' })).toBe(true);
    expect(keyHasInferenceScope({ created_via: 'oauth_device' })).toBe(true);
  });

  it('allows a scoped key that includes inference (space- or comma-delimited)', () => {
    expect(keyHasInferenceScope({ scope: 'inference' })).toBe(true);
    expect(keyHasInferenceScope({ scope: 'inference billing' })).toBe(true);
    expect(keyHasInferenceScope({ scope: 'billing,inference' })).toBe(true);
  });

  it('rejects a scoped key that omits inference', () => {
    expect(keyHasInferenceScope({ scope: 'profile' })).toBe(false);
    expect(keyHasInferenceScope({ scope: 'billing,usage' })).toBe(false);
  });

  it('does not substring-match (inferencex is not inference)', () => {
    expect(keyHasInferenceScope({ scope: 'inferencex' })).toBe(false);
  });
});

describe('keyHasReadScope', () => {
  it('allows an unscoped key (no scope metadata)', () => {
    expect(keyHasReadScope({})).toBe(true);
    expect(keyHasReadScope(null)).toBe(true);
    expect(keyHasReadScope(undefined)).toBe(true);
  });

  it('allows a key whose scope is an empty string', () => {
    expect(keyHasReadScope({ scope: '' })).toBe(true);
  });

  it('rejects malformed non-empty legacy scope instead of treating it as unscoped', () => {
    expect(keyHasReadScope({ scope: '   ' })).toBe(false);
    expect(keyHasReadScope({ scope: ',,,' })).toBe(false);
  });

  it('denies read for a legacy empty/missing OAuth-device scope', () => {
    expect(keyHasReadScope({ created_via: 'oauth_device', scope: '' })).toBe(false);
    expect(keyHasReadScope({ created_via: 'oauth_device', scope: '   ' })).toBe(false);
    expect(keyHasReadScope({ created_via: 'oauth_device' })).toBe(false);
  });

  it('allows a scoped key that includes read (space- or comma-delimited)', () => {
    expect(keyHasReadScope({ scope: 'read' })).toBe(true);
    expect(keyHasReadScope({ scope: 'read inference' })).toBe(true);
    expect(keyHasReadScope({ scope: 'read,billing' })).toBe(true);
  });

  it('rejects a scoped key that omits read', () => {
    expect(keyHasReadScope({ scope: 'inference' })).toBe(false);
    expect(keyHasReadScope({ scope: 'billing,usage' })).toBe(false);
  });

  it('does not substring-match (readwrite is not read)', () => {
    expect(keyHasReadScope({ scope: 'readwrite' })).toBe(false);
  });
});
