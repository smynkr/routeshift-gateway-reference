import { describe, expect, it, vi, beforeEach } from 'vitest';
import { generateKeyPair, exportJWK, importJWK, SignJWT } from 'jose';

// vi.hoisted so this is guaranteed initialized before vitest hoists the
// vi.mock() factory below -- see apps/proxy/src/oauth/sso-connections.test.ts
// for the established pattern (a plain top-level const here throws
// "Cannot access '...' before initialization" under vitest's hoisting).
const { safeFetchMock } = vi.hoisted(() => ({
  safeFetchMock: vi.fn(),
}));

vi.mock('../plugins/safe-fetch.js', () => ({ safeFetch: safeFetchMock }));

import { verifyIdToken, exchangeCodeForIdToken, IdTokenVerificationError, DomainClaimMismatchError } from './idp-providers.js';

describe('verifyIdToken', () => {
  let publicJwk: Record<string, unknown>;
  let privateKey: CryptoKey;

  beforeEach(async () => {
    const { publicKey, privateKey: priv } = await generateKeyPair('RS256');
    privateKey = priv;
    publicJwk = { ...(await exportJWK(publicKey)), alg: 'RS256', use: 'sig', kid: 'test-key-1' };
    safeFetchMock.mockReset();
  });

  async function signToken(claims: Record<string, unknown>): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(privateKey);
  }

  it('verifies a well-formed token, checks email_verified, and confirms the email domain matches', async () => {
    safeFetchMock.mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: Buffer.from(JSON.stringify({ keys: [publicJwk] })),
    });
    const token = await signToken({
      iss: 'https://accounts.example.com',
      aud: 'client-123',
      sub: 'user-1',
      email: 'alice@example.com',
      email_verified: true,
      nonce: 'nonce-abc',
    });

    const result = await verifyIdToken({
      idToken: token,
      issuer: 'https://accounts.example.com',
      jwksUri: 'https://accounts.example.com/jwks',
      audience: 'client-123',
      expectedNonce: 'nonce-abc',
      expectedLoginDomain: 'example.com',
    });

    expect(result.email).toBe('alice@example.com');
  });

  it('rejects a token that OMITS email_verified (fail closed: an absent claim is no verification assertion, so it must not mint a key)', async () => {
    safeFetchMock.mockResolvedValue({ statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify({ keys: [publicJwk] })) });
    const token = await signToken({
      iss: 'https://accounts.example.com', aud: 'client-123', sub: 'user-1',
      email: 'alice@example.com', nonce: 'nonce-abc', // no email_verified claim at all
    });

    await expect(verifyIdToken({
      idToken: token, issuer: 'https://accounts.example.com', jwksUri: 'https://accounts.example.com/jwks',
      audience: 'client-123', expectedNonce: 'nonce-abc', expectedLoginDomain: 'example.com',
    })).rejects.toThrow(IdTokenVerificationError);
  });

  it('accepts email_verified emitted as the string "true" (some IdPs stringify the boolean; a stringified affirmative is still affirmative)', async () => {
    safeFetchMock.mockResolvedValue({ statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify({ keys: [publicJwk] })) });
    const token = await signToken({
      iss: 'https://accounts.example.com', aud: 'client-123', sub: 'user-1',
      email: 'alice@example.com', email_verified: 'true', nonce: 'nonce-abc',
    });

    const result = await verifyIdToken({
      idToken: token, issuer: 'https://accounts.example.com', jwksUri: 'https://accounts.example.com/jwks',
      audience: 'client-123', expectedNonce: 'nonce-abc', expectedLoginDomain: 'example.com',
    });

    expect(result.email).toBe('alice@example.com');
  });

  it('rejects an unverified email', async () => {
    safeFetchMock.mockResolvedValue({ statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify({ keys: [publicJwk] })) });
    const token = await signToken({
      iss: 'https://accounts.example.com', aud: 'client-123', sub: 'user-1',
      email: 'alice@example.com', email_verified: false, nonce: 'nonce-abc',
    });

    await expect(verifyIdToken({
      idToken: token, issuer: 'https://accounts.example.com', jwksUri: 'https://accounts.example.com/jwks',
      audience: 'client-123', expectedNonce: 'nonce-abc', expectedLoginDomain: 'example.com',
    })).rejects.toThrow(IdTokenVerificationError);
  });

  it('rejects when the email domain does not match the resolved team (defends against a token from the wrong org)', async () => {
    safeFetchMock.mockResolvedValue({ statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify({ keys: [publicJwk] })) });
    const token = await signToken({
      iss: 'https://accounts.example.com', aud: 'client-123', sub: 'user-1',
      email: 'mallory@evil.com', email_verified: true, nonce: 'nonce-abc',
    });

    await expect(verifyIdToken({
      idToken: token, issuer: 'https://accounts.example.com', jwksUri: 'https://accounts.example.com/jwks',
      audience: 'client-123', expectedNonce: 'nonce-abc', expectedLoginDomain: 'example.com',
    })).rejects.toThrow(DomainClaimMismatchError);
  });

  it('rejects a nonce mismatch', async () => {
    safeFetchMock.mockResolvedValue({ statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify({ keys: [publicJwk] })) });
    const token = await signToken({
      iss: 'https://accounts.example.com', aud: 'client-123', sub: 'user-1',
      email: 'alice@example.com', email_verified: true, nonce: 'wrong-nonce',
    });

    await expect(verifyIdToken({
      idToken: token, issuer: 'https://accounts.example.com', jwksUri: 'https://accounts.example.com/jwks',
      audience: 'client-123', expectedNonce: 'nonce-abc', expectedLoginDomain: 'example.com',
    })).rejects.toThrow(IdTokenVerificationError);
  });

  it('rejects a token signed by a different key (bad signature)', async () => {
    safeFetchMock.mockResolvedValue({ statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify({ keys: [publicJwk] })) });
    const { privateKey: otherKey } = await generateKeyPair('RS256');
    const forged = await new SignJWT({
      iss: 'https://accounts.example.com', aud: 'client-123', sub: 'user-1',
      email: 'alice@example.com', email_verified: true, nonce: 'nonce-abc',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(otherKey);

    await expect(verifyIdToken({
      idToken: forged, issuer: 'https://accounts.example.com', jwksUri: 'https://accounts.example.com/jwks',
      audience: 'client-123', expectedNonce: 'nonce-abc', expectedLoginDomain: 'example.com',
    })).rejects.toThrow();
  });

  it('fetches the JWKS via the SSRF-safe fetch, not a direct/unguarded fetch', async () => {
    safeFetchMock.mockResolvedValue({ statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify({ keys: [publicJwk] })) });
    const token = await signToken({
      iss: 'https://accounts.example.com', aud: 'client-123', sub: 'user-1',
      email: 'alice@example.com', email_verified: true, nonce: 'nonce-abc',
    });

    await verifyIdToken({
      idToken: token, issuer: 'https://accounts.example.com', jwksUri: 'https://accounts.example.com/jwks',
      audience: 'client-123', expectedNonce: 'nonce-abc', expectedLoginDomain: 'example.com',
    });

    expect(safeFetchMock).toHaveBeenCalledWith('https://accounts.example.com/jwks', expect.anything());
  });

  it('throws a typed error (not a raw jose error) when the JWKS document is valid JSON but not a valid JWKS shape', async () => {
    safeFetchMock.mockResolvedValue({ statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify({})) });
    const token = await signToken({
      iss: 'https://accounts.example.com', aud: 'client-123', sub: 'user-1',
      email: 'alice@example.com', email_verified: true, nonce: 'nonce-abc',
    });

    await expect(verifyIdToken({
      idToken: token, issuer: 'https://accounts.example.com', jwksUri: 'https://accounts.example.com/jwks',
      audience: 'client-123', expectedNonce: 'nonce-abc', expectedLoginDomain: 'example.com',
    })).rejects.toThrow(IdTokenVerificationError);
  });

  it('rejects an HS256-signed token even though it carries alg confusion bait (rejected via key-type resolution)', async () => {
    safeFetchMock.mockResolvedValue({ statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify({ keys: [publicJwk] })) });
    // Sign with an HMAC secret derived from the RSA public modulus -- the classic
    // RS256/HS256 algorithm-confusion attack shape (attacker treats the known
    // public key as an HMAC secret). This is rejected structurally, not by the
    // `algorithms: ['RS256']` allowlist: createLocalJWKSet resolves a key by
    // matching the token's `alg`/`kid` against the JWKS, and an RSA-only JWKS
    // can never produce a symmetric (HS*) key, so jose has no key to verify an
    // HS256 token with regardless of the allowlist. `algorithms: ['RS256']`
    // stays as defense-in-depth against a *same-key-family* downgrade (e.g. an
    // RS256-only key set also accepting a PS256-signed token), which is a
    // different attack class than this test exercises.
    const secret = new TextEncoder().encode('attacker-controlled-hmac-secret');
    const forged = await new SignJWT({
      iss: 'https://accounts.example.com', aud: 'client-123', sub: 'user-1',
      email: 'alice@example.com', email_verified: true, nonce: 'nonce-abc',
    })
      .setProtectedHeader({ alg: 'HS256', kid: 'test-key-1' })
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(secret);

    await expect(verifyIdToken({
      idToken: forged, issuer: 'https://accounts.example.com', jwksUri: 'https://accounts.example.com/jwks',
      audience: 'client-123', expectedNonce: 'nonce-abc', expectedLoginDomain: 'example.com',
    })).rejects.toThrow();
  });

  it('rejects a PS256-signed token against an RS256-only allowlist (same-key-family algorithm downgrade)', async () => {
    // Unlike the HS256/alg:none cases above, this one genuinely depends on
    // `algorithms: ['RS256']`: PS256 and RS256 are both RSA-family signature
    // schemes over the *same* key material, so an RSA JWK entry that omits an
    // explicit `alg` field (as many real IdPs' JWKS entries do) is not
    // filtered out by createLocalJWKSet's key-type resolution just because
    // the token says PS256 -- resolution only checks kty compatibility, and
    // RSA-PSS/RSASSA-PKCS1-v1_5 share the same kty. Without the `algorithms`
    // allowlist, jose would happily verify a PS256-signed token against this
    // "RS256" key set.
    const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
    const rawPubJwk = await exportJWK(publicKey);
    const noAlgJwk = { ...rawPubJwk, use: 'sig', kid: 'test-key-1' }; // no `alg` field, unlike the shared fixture
    safeFetchMock.mockResolvedValue({ statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify({ keys: [noAlgJwk] })) });

    // Re-import the same RSA key material bound to PS256 (jose's WebCrypto
    // CryptoKeys are algorithm-bound, so the RS256 CryptoKey from
    // generateKeyPair can't itself sign with PS256 padding).
    const rawPrivJwk = await exportJWK(privateKey);
    const ps256PrivateKey = await importJWK({ ...rawPrivJwk, alg: 'PS256' }, 'PS256');

    const forged = await new SignJWT({
      iss: 'https://accounts.example.com', aud: 'client-123', sub: 'user-1',
      email: 'alice@example.com', email_verified: true, nonce: 'nonce-abc',
    })
      .setProtectedHeader({ alg: 'PS256', kid: 'test-key-1' })
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(ps256PrivateKey);

    await expect(verifyIdToken({
      idToken: forged, issuer: 'https://accounts.example.com', jwksUri: 'https://accounts.example.com/jwks',
      audience: 'client-123', expectedNonce: 'nonce-abc', expectedLoginDomain: 'example.com',
    })).rejects.toThrow(IdTokenVerificationError);
  });

  it('rejects an unsigned "alg: none" token', async () => {
    // jose unconditionally refuses to accept `alg: none` regardless of the
    // `algorithms` option passed to jwtVerify -- this isn't the allowlist
    // doing the rejecting either, it's a hard rule in jose itself.
    safeFetchMock.mockResolvedValue({ statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify({ keys: [publicJwk] })) });
    const header = Buffer.from(JSON.stringify({ alg: 'none', kid: 'test-key-1' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss: 'https://accounts.example.com', aud: 'client-123', sub: 'user-1',
      email: 'alice@example.com', email_verified: true, nonce: 'nonce-abc',
      exp: Math.floor(Date.now() / 1000) + 600,
    })).toString('base64url');
    const unsigned = `${header}.${payload}.`;

    await expect(verifyIdToken({
      idToken: unsigned, issuer: 'https://accounts.example.com', jwksUri: 'https://accounts.example.com/jwks',
      audience: 'client-123', expectedNonce: 'nonce-abc', expectedLoginDomain: 'example.com',
    })).rejects.toThrow();
  });
});

describe('exchangeCodeForIdToken', () => {
  beforeEach(() => safeFetchMock.mockReset());

  const baseInput = {
    tokenEndpoint: 'https://accounts.example.com/token',
    clientId: 'client-123',
    clientSecret: 's3cr3t',
    code: 'auth-code',
    redirectUri: 'https://proxy.example.com/oauth/device/callback',
  };

  it('exchanges via client_secret_post (credentials in the body) when the IdP accepts it', async () => {
    safeFetchMock.mockResolvedValue({ statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify({ id_token: 'the-id-token' })) });

    const idToken = await exchangeCodeForIdToken(baseInput);

    expect(idToken).toBe('the-id-token');
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    const [, init] = safeFetchMock.mock.calls[0];
    expect(init.body).toContain('client_secret=s3cr3t');
    expect(init.headers?.Authorization).toBeUndefined();
    expect(init.maxBytes).toBe(64 * 1024);
  });

  it('falls back to client_secret_basic (HTTP Basic) when client_secret_post is rejected with 401 (Okta default)', async () => {
    // First attempt (client_secret_post) → 401 invalid_client; retry with Basic → 200.
    safeFetchMock
      .mockResolvedValueOnce({ statusCode: 401, headers: {}, body: Buffer.from(JSON.stringify({ error: 'invalid_client' })) })
      .mockResolvedValueOnce({ statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify({ id_token: 'basic-id-token' })) });

    const idToken = await exchangeCodeForIdToken(baseInput);

    expect(idToken).toBe('basic-id-token');
    expect(safeFetchMock).toHaveBeenCalledTimes(2);
    const [, basicInit] = safeFetchMock.mock.calls[1];
    const expectedAuth = 'Basic ' + Buffer.from('client-123:s3cr3t').toString('base64');
    expect(basicInit.headers?.Authorization).toBe(expectedAuth);
    // On the Basic retry the secret must NOT also be duplicated in the body.
    expect(basicInit.body).not.toContain('client_secret=');
  });

  it('surfaces a non-401 token-endpoint failure without a Basic retry', async () => {
    safeFetchMock.mockResolvedValue({ statusCode: 500, headers: {}, body: Buffer.from('boom') });

    await expect(exchangeCodeForIdToken(baseInput)).rejects.toThrow(IdTokenVerificationError);
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves a non-invalid_client OAuth 401 without a secret-bearing Basic retry', async () => {
    safeFetchMock.mockResolvedValue({
      statusCode: 401,
      headers: {},
      body: Buffer.from(JSON.stringify({ error: 'invalid_grant' })),
    });

    await expect(exchangeCodeForIdToken(baseInput)).rejects.toThrow(
      'token endpoint returned 401 (error=invalid_grant)',
    );
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a malformed non-OAuth 401 response', async () => {
    safeFetchMock.mockResolvedValue({ statusCode: 401, headers: {}, body: Buffer.from('not-json') });

    await expect(exchangeCodeForIdToken(baseInput)).rejects.toThrow('token endpoint returned 401');
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });
});
