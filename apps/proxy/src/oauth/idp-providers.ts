// RSH-100: OIDC client for the two fixed, supported providers (Google
// Workspace, Okta). Both are standard-compliant OIDC issuers, so this is
// one generic OIDC client, not two provider-specific ones -- "provider"
// only constrains WHICH issuers a team is allowed to register (see
// idp_configs.provider CHECK + sso-connections.ts validation), not the
// protocol handling here.
//
// IMPORTANT: jose's createRemoteJWKSet does its OWN unguarded fetch,
// which would bypass this app's SSRF guard for a team-supplied jwks_uri.
// Fetch the JWKS ourselves via safeFetch and hand jose the already-fetched
// JSON via createLocalJWKSet instead.
import { createLocalJWKSet, jwtVerify } from 'jose';
import { safeFetch, type SafeFetchResult } from '../plugins/safe-fetch.js';

const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;

export class IdTokenVerificationError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'IdTokenVerificationError';
  }
}

export class DomainClaimMismatchError extends Error {
  constructor(public readonly tokenDomain: string, public readonly expectedDomain: string) {
    super(`ID token email domain '${tokenDomain}' does not match expected domain '${expectedDomain}'`);
    this.name = 'DomainClaimMismatchError';
  }
}

function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 0 || at === email.length - 1) return null;
  return email.slice(at + 1).trim().toLowerCase();
}

export interface VerifyIdTokenInput {
  idToken: string;
  issuer: string;
  jwksUri: string;
  audience: string;
  expectedNonce: string;
  expectedLoginDomain: string;
}

export interface VerifiedIdentity {
  email: string;
  sub: string;
}

export async function verifyIdToken(input: VerifyIdTokenInput): Promise<VerifiedIdentity> {
  let jwksRes;
  try {
    jwksRes = await safeFetch(input.jwksUri, { method: 'GET' });
  } catch (err) {
    throw new IdTokenVerificationError('failed to fetch JWKS', err);
  }
  if (jwksRes.statusCode !== 200) {
    throw new IdTokenVerificationError(`JWKS endpoint returned ${jwksRes.statusCode}`);
  }
  let jwks;
  try {
    jwks = JSON.parse(jwksRes.body.toString('utf-8'));
  } catch (err) {
    throw new IdTokenVerificationError('malformed JWKS document', err);
  }

  let keySet;
  try {
    keySet = createLocalJWKSet(jwks);
  } catch (err) {
    throw new IdTokenVerificationError('malformed JWKS document', err);
  }

  let payload;
  try {
    ({ payload } = await jwtVerify(input.idToken, keySet, {
      issuer: input.issuer,
      audience: input.audience,
      algorithms: ['RS256'], // explicit allowlist -- defends against algorithm-confusion
    }));
  } catch (err) {
    throw new IdTokenVerificationError('ID token signature/claims verification failed', err);
  }

  if (payload.nonce !== input.expectedNonce) {
    throw new IdTokenVerificationError('nonce mismatch');
  }

  const email = payload.email;
  if (typeof email !== 'string' || email.length === 0) {
    throw new IdTokenVerificationError('ID token missing email claim');
  }
  // Require an affirmative email_verified assertion before this address can
  // mint an API key. Fail CLOSED on a missing claim: OIDC treats an absent
  // email_verified as "no verification assertion", and the audience/signature/
  // domain checks establish the issuer and tenant but NOT that the subject
  // controls this mailbox -- so on an IdP that lets a user self-edit their
  // profile email, an absent claim would let them mint a key for any other
  // address in the domain (impersonation on a money path). The only relaxation
  // over a strict `=== true` is accepting the string "true": some IdPs
  // serialize the boolean, and a stringified affirmative is still an
  // affirmative. (An Okta org that omits the claim must be configured to emit
  // it -- e.g. via the email scope / a custom claim -- rather than having the
  // proxy trust an unverified address.)
  const emailVerified = payload.email_verified;
  if (emailVerified !== true && emailVerified !== 'true') {
    throw new IdTokenVerificationError('IdP did not assert email_verified');
  }

  const domain = emailDomain(email);
  if (!domain || domain !== input.expectedLoginDomain.toLowerCase()) {
    throw new DomainClaimMismatchError(domain ?? '(unparseable)', input.expectedLoginDomain);
  }

  if (typeof payload.sub !== 'string') {
    throw new IdTokenVerificationError('ID token missing sub claim');
  }

  return { email, sub: payload.sub };
}

export interface OidcAuthorizationUrlInput {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
}

export function buildAuthorizationUrl(input: OidcAuthorizationUrlInput): string {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', input.state);
  url.searchParams.set('nonce', input.nonce);
  return url.toString();
}

export interface ExchangeCodeInput {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}

/** One token-endpoint exchange attempt using a specific client-authentication
 * method. client_secret_post carries the secret in the form body;
 * client_secret_basic carries it in an HTTP Basic Authorization header (with
 * the id/secret application/x-www-form-urlencoded per RFC 6749 §2.3.1). */
async function tokenExchangeRequest(
  input: ExchangeCodeInput,
  authMethod: 'post' | 'basic',
): Promise<SafeFetchResult> {
  const params: Record<string, string> = {
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
  };
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (authMethod === 'post') {
    params.client_secret = input.clientSecret;
  } else {
    const credentials = `${encodeURIComponent(input.clientId)}:${encodeURIComponent(input.clientSecret)}`;
    headers.Authorization = `Basic ${Buffer.from(credentials).toString('base64')}`;
  }

  try {
    return await safeFetch(input.tokenEndpoint, {
      method: 'POST',
      headers,
      body: new URLSearchParams(params).toString(),
      maxBytes: MAX_TOKEN_RESPONSE_BYTES,
    });
  } catch (err) {
    throw new IdTokenVerificationError('token exchange request failed', err);
  }
}

function oauthErrorCode(res: SafeFetchResult): string | null {
  try {
    const parsed: unknown = JSON.parse(res.body.toString('utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const error = (parsed as { error?: unknown }).error;
      return typeof error === 'string' ? error : null;
    }
  } catch {
    // A malformed/non-OAuth response is not eligible for an auth-method retry.
  }
  return null;
}

function tokenEndpointError(res: SafeFetchResult): IdTokenVerificationError {
  const error = oauthErrorCode(res);
  return new IdTokenVerificationError(
    error
      ? `token endpoint returned ${res.statusCode} (error=${error})`
      : `token endpoint returned ${res.statusCode}`,
  );
}

/** Confidential-client authorization-code exchange (server-side, with
 * client_secret) -- this runs in apps/proxy, not a browser, so it's a
 * confidential client and doesn't need PKCE.
 *
 * Tries client_secret_post first, then retries once with client_secret_basic
 * on a 401 invalid_client: Okta apps default to client_secret_basic and will
 * reject a post-style exchange, while others accept only post. A given IdP app
 * is configured for exactly one method, so at most one retry ever occurs. */
export async function exchangeCodeForIdToken(input: ExchangeCodeInput): Promise<string> {
  let res = await tokenExchangeRequest(input, 'post');
  if (res.statusCode === 401 && oauthErrorCode(res) === 'invalid_client') {
    res = await tokenExchangeRequest(input, 'basic');
  }
  if (res.statusCode !== 200) {
    throw tokenEndpointError(res);
  }
  let parsed: { id_token?: unknown };
  try {
    parsed = JSON.parse(res.body.toString('utf-8'));
  } catch (err) {
    throw new IdTokenVerificationError('malformed token response', err);
  }
  if (typeof parsed.id_token !== 'string') {
    throw new IdTokenVerificationError('token response missing id_token');
  }
  return parsed.id_token;
}
