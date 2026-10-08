// apps/proxy/src/admin/idp-configs.ts
// RSH-100: POST/PATCH/DELETE /admin/idp-configs. Guarded by requireAdminAuth
// at the route-registration layer (server.ts), exactly like /admin/keys --
// this app has no session/RBAC concept, so team_id is explicit (body for
// POST, query param for PATCH/DELETE) rather than inferred from a session.
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createIdpConfig,
  updateIdpConfig,
  deleteIdpConfig,
  IdpConfigDomainConflictError,
  UnsafeIssuerError,
  SsoDeviceFlowDisabledError,
  type IdpProvider,
} from '../oauth/sso-connections.js';

// Bound buffered body size (admin idp-config payloads are small JSON). This
// route is admin-authenticated so the blast radius is lower than the
// unauthenticated /oauth/device/* handlers, but there's no reason to buffer an
// unbounded body here either. Keep over-cap distinct from malformed JSON so
// callers can return the protocol-correct 413 without losing the exact reason.
const MAX_JSON_BODY_BYTES = 64 * 1024;

class JsonBodyTooLargeError extends Error {
  constructor() {
    super('Request body too large');
    this.name = 'JsonBodyTooLargeError';
  }
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_JSON_BODY_BYTES) {
      // Continue consuming the request without buffering it. Destroying the
      // request here can tear down the shared socket before the 413 is sent.
      req.resume();
      throw new JsonBodyTooLargeError();
    }
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString());
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sendError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message } }));
}

const VALID_PROVIDERS = new Set<IdpProvider>(['google_workspace', 'okta']);

export async function handleCreateIdpConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown> | null;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    if (err instanceof JsonBodyTooLargeError) return sendError(res, 413, err.message);
    throw err;
  }
  if (!body) return sendError(res, 400, 'Invalid JSON in request body');

  const teamId = body.team_id;
  if (typeof teamId !== 'string' || teamId.length === 0 || teamId === '*') {
    return sendError(res, 400, 'team_id is required');
  }

  // RSH-86: defense-in-depth — if the auth middleware validated against a
  // query-string team_id (scoped tokens), the body must agree. Without this
  // check, a future allowlist expansion permitting POST for scoped tokens
  // would enable cross-tenant idp_config creation (body.team_id ≠
  // query.team_id). Mirrors handleCreateKey in admin/keys.ts.
  const url = new URL(req.url ?? '/', 'http://localhost');
  const queryTeamId = url.searchParams.get('team_id');
  if (queryTeamId && queryTeamId !== teamId) {
    return sendError(res, 403, 'body team_id does not match query team_id');
  }

  const provider = body.provider;
  if (typeof provider !== 'string' || !VALID_PROVIDERS.has(provider as IdpProvider)) {
    return sendError(res, 400, "provider must be 'google_workspace' or 'okta'");
  }
  const loginDomain = body.login_domain;
  if (typeof loginDomain !== 'string' || loginDomain.length === 0 || loginDomain.length > 255 || !loginDomain.includes('.')) {
    return sendError(res, 400, 'login_domain must be a valid domain');
  }
  const issuer = body.issuer;
  if (typeof issuer !== 'string' || !issuer.startsWith('https://')) {
    return sendError(res, 400, 'issuer must be an https:// URL');
  }
  const clientId = body.client_id;
  if (typeof clientId !== 'string' || clientId.length === 0) {
    return sendError(res, 400, 'client_id is required');
  }
  const clientSecret = body.client_secret;
  if (typeof clientSecret !== 'string' || clientSecret.length === 0) {
    return sendError(res, 400, 'client_secret is required');
  }

  try {
    const result = await createIdpConfig({
      teamId, provider: provider as IdpProvider, loginDomain, issuer, clientId, clientSecret,
    });
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: result.id }));
  } catch (err) {
    if (err instanceof IdpConfigDomainConflictError) {
      return sendError(res, 409, `login_domain '${loginDomain}' is already registered to another team`);
    }
    if (err instanceof UnsafeIssuerError) {
      return sendError(res, 400, 'issuer failed validation (unreachable, blocked, or malformed discovery document)');
    }
    if (err instanceof SsoDeviceFlowDisabledError) {
      return sendError(res, 403, 'SSO device-flow login is not enabled in this environment');
    }
    throw err;
  }
}

export async function handleUpdateIdpConfig(
  req: IncomingMessage,
  res: ServerResponse,
  idpConfigId: string,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const teamId = url.searchParams.get('team_id');
  if (!teamId || teamId === '*') return sendError(res, 400, 'team_id query parameter is required');

  let body: Record<string, unknown> | null;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    if (err instanceof JsonBodyTooLargeError) return sendError(res, 413, err.message);
    throw err;
  }
  if (!body) return sendError(res, 400, 'Invalid JSON in request body');

  const update: { issuer?: string; clientId?: string; clientSecret?: string } = {};
  if ('issuer' in body) {
    if (typeof body.issuer !== 'string' || !body.issuer.startsWith('https://')) {
      return sendError(res, 400, 'issuer must be an https:// URL');
    }
    update.issuer = body.issuer;
  }
  if ('client_id' in body) {
    if (typeof body.client_id !== 'string' || body.client_id.length === 0) {
      return sendError(res, 400, 'client_id must be a non-empty string');
    }
    update.clientId = body.client_id;
  }
  if ('client_secret' in body) {
    if (typeof body.client_secret !== 'string' || body.client_secret.length === 0) {
      return sendError(res, 400, 'client_secret must be a non-empty string');
    }
    update.clientSecret = body.client_secret;
  }

  // updateIdpConfig's early-return for a no-op update (`sets.length === 0
  // return true`) never queries the database, so it can't distinguish a
  // real no-op update on an existing row from a PATCH with an empty body
  // against a nonexistent id or one belonging to a different team. Guard
  // here instead of relying on that function to 404 -- mirrors
  // handleUpdateKey's `setExprs.length === 0` → 400 guard in admin/keys.ts.
  if (update.issuer === undefined && update.clientId === undefined && update.clientSecret === undefined) {
    return sendError(res, 400, 'No updatable fields provided (issuer, client_id, or client_secret required)');
  }

  try {
    const found = await updateIdpConfig(idpConfigId, teamId, update);
    if (!found) return sendError(res, 404, 'idp_config not found');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    if (err instanceof UnsafeIssuerError) {
      return sendError(res, 400, 'issuer failed validation (unreachable, blocked, or malformed discovery document)');
    }
    throw err;
  }
}

export async function handleDeleteIdpConfig(
  req: IncomingMessage,
  res: ServerResponse,
  idpConfigId: string,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const teamId = url.searchParams.get('team_id');
  if (!teamId || teamId === '*') return sendError(res, 400, 'team_id query parameter is required');

  const found = await deleteIdpConfig(idpConfigId, teamId);
  if (!found) return sendError(res, 404, 'idp_config not found');
  res.writeHead(204);
  res.end();
}
