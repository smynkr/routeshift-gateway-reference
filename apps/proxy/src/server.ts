import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleProxyRequest } from './proxy-handler.js';
import { handleEmbeddingsRequest } from './embeddings/handler.js';
import {
  handleCreateKey,
  handleListKeys,
  handleListKeyAudit,
  handleListTeamAudit,
  handleRevokeKey,
  handleRotateKey,
  handleUpdateKey,
} from './admin/keys.js';
import { handleCreateRule, handleListRules, handleUpdateRule, handleDeleteRule } from './admin/rules.js';
import { handleGetAutoRouteSettings, handleInvalidateAutoRouteSettings, handleUpdateAutoRouteSettings } from './admin/auto-route.js';
import { handleGetIdentityBudget, handleListIdentityBudgets, handlePutIdentityBudget } from './admin/identity-budgets.js';
import { handleListPromoCodes, handleCreatePromoCode, handleDeletePromoCode } from './admin/promo-codes.js';
import { handleSessionsWindow } from './admin/sessions.js';
import {
  handleGetTeamRateLimits,
  handleUpdateTeamRateLimits,
} from './admin/team-rate-limits.js';
import {
  handleDeviceCode,
  handleDeviceVerifyGet,
  handleDeviceVerifyPost,
  handleDeviceCallback,
  handleDeviceToken,
} from './oauth/sso-device-handlers.js';
import {
  handleCreateIdpConfig,
  handleUpdateIdpConfig,
  handleDeleteIdpConfig,
} from './admin/idp-configs.js';
import { requireAdminAuth } from './admin/auth.js';
import { handleShadowExperiments, handleShadowExperimentById } from './admin/shadow-experiments.js';
import { config } from './config.js';
import { getPool } from './db/pool.js';
import { handleMonthlyUsage } from './usage/monthly.js';
import { handleUsageByIdentity } from './usage/by-identity.js';
import { handleUsageSavings } from './usage/savings.js';
import { handleTokenHygiene } from './usage/token-hygiene.js';
import { handleGenerationLookup } from './usage/generation-lookup.js';
import { handleUsageSummary } from './usage/summary.js';
import { handleOptimizeFindings } from './optimize/findings-endpoint.js';
import { handleSavingsSeries } from './usage/savings-series.js';
import { handleByModelDay } from './usage/by-model-day.js';
import { invalidateKeyCache } from './billing/provider-key-crypto.js';
import { responseCache } from './cache/response-cache.js';
import { invalidateAliasCache } from './routing/model-aliases.js';
import { invalidatePresetCache } from './presets/resolver.js';
import { invalidateBillingModeCache } from './billing/plan-limits.js';
import { handleCatalogManifest, handleModelsList, handleModelDetail } from './catalog/handlers.js';
import { CATALOG_FRESHNESS_MANIFEST, getCatalogFreshness } from '@routeshift/shared';
import { captureException } from './observability/sentry.js';
import { getLoggerStats } from './logging/logger.js';

function parseUrl(url: string): { path: string; segments: string[] } {
  const path = url.split('?')[0];
  const segments = path.split('/').filter(Boolean);
  return { path, segments };
}

function getRequiredOperatorTeamId(req: IncomingMessage, res: ServerResponse): string | null {
  const teamId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('team_id');
  const normalized = teamId?.trim();
  if (
    teamId &&
    normalized === teamId &&
    normalized !== '' &&
    !['*', 'null', 'undefined'].includes(normalized.toLowerCase())
  ) return teamId;
  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'team_id is required', code: 'invalid_team_id' } }));
  return null;
}

function applyCors(req: IncomingMessage, res: ServerResponse, path: string): boolean {
  const requestOrigin = req.headers.origin;
  const allowedOrigins = config.corsOrigins;
  const allowWildcard = allowedOrigins.includes('*');
  const allowedOrigin = allowWildcard ? '*' : allowedOrigins.find(origin => origin === requestOrigin);

  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    if (allowedOrigin !== '*') {
      res.setHeader('Vary', 'Origin');
    }
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // RSH-100: the 5 /oauth/device/* endpoints are exempt from the
  // origin-allowlist rejection below. They're reached either by the verify
  // page's own same-origin fetch() POST (browsers attach an Origin header
  // to same-origin state-changing requests too, not just cross-origin ones)
  // or by non-browser CLI calls with no Origin header at all. CORS_ORIGIN is
  // configured to let the dashboard's origin call the proxy's admin API --
  // it was never meant to gate the proxy's own verify page calling itself,
  // and nothing outside RouteShift's own origin has any legitimate reason to
  // call these endpoints from a browser, so there's no cross-tenant/
  // third-party surface being protected by rejecting them here. Without this
  // exemption, any deployment where CORS_ORIGIN doesn't happen to include
  // the proxy's own origin would silently 403 every Approve/Deny click.
  if (path.startsWith('/oauth/device/')) {
    return true;
  }

  if (!allowWildcard && requestOrigin && !allowedOrigin) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'CORS origin is not allowed' } }));
    return false;
  }

  return true;
}

/** Lifecycle handle returned by createProxyServer (test + runtime contract). */
export interface ProxyServer {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  server: Server;
}

export function createProxyServer(port: number): ProxyServer {
  const server = createServer(handleRequest);

  function handleRequest(req: IncomingMessage, res: ServerResponse) {
    // Security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');

    const { path, segments } = parseUrl(req.url ?? '');

    // CORS
    if (!applyCors(req, res, path)) return;

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check
    if (req.method === 'GET' && path === '/health') {
      handleHealthCheck(res).catch(handleError(res));
      return;
    }

    // Proxy endpoint
    if (req.method === 'POST' && path === '/v1/chat/completions') {
      handleProxyRequest(req, res).catch(handleError(res));
      return;
    }

    if (req.method === 'POST' && path === '/v1/embeddings') {
      handleEmbeddingsRequest(req, res).catch(handleError(res));
      return;
    }


    if (req.method === 'GET' && path === '/v1/models/catalog-manifest') {
      handleCatalogManifest(req, res).catch(handleError(res));
      return;
    }
    if (req.method === 'GET' && path === '/v1/models') {
      handleModelsList(req, res).catch(handleError(res));
      return;
    }
    if (req.method === 'GET' && segments[0] === 'v1' && segments[1] === 'models' && segments[2] && !segments[3]) {
      let modelId: string;
      try {
        modelId = decodeURIComponent(segments[2]);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: { message: 'Invalid model id encoding', code: 'invalid_model_id_encoding' },
        }));
        return;
      }
      handleModelDetail(req, res, modelId).catch(handleError(res));
      return;
    }

    if (req.method === 'GET' && path === '/v1/usage/monthly') {
      if (!requireAdminAuth(req, res)) return;
      handleMonthlyUsage(req, res).catch(handleError(res));
      return;
    }

    if (req.method === 'GET' && path === '/v1/usage/savings') {
      if (!requireAdminAuth(req, res)) return;
      handleUsageSavings(req, res).catch(handleError(res));
      return;
    }

    if (req.method === 'GET' && path === '/api/v1/generation') {
      handleGenerationLookup(req, res).catch(handleError(res));
      return;
    }

    // Customer-facing, team-scoped usage summary for the `routeshift usage`
    // TUI. Auth is the customer's own sk-proxy- key (team resolved from the
    // key inside the handler) — deliberately NOT requireAdminAuth, and the
    // handler ignores any ?team_id= param.
    if (req.method === 'GET' && path === '/v1/usage/summary') {
      handleUsageSummary(req, res).catch(handleError(res));
      return;
    }

    // RSH-100: SSO device-flow (RFC 8628). Public, unauthenticated -- these
    // are how a device with no browser starts the flow and how a browser
    // completes the human-facing leg. Each handler does its own per-IP
    // rate limiting internally (see rate-limit/ip-limiter.ts).
    if (req.method === 'POST' && path === '/oauth/device/code') {
      handleDeviceCode(req, res).catch(handleError(res));
      return;
    }
    if (req.method === 'GET' && path === '/oauth/device/verify') {
      handleDeviceVerifyGet(req, res).catch(handleError(res));
      return;
    }
    if (req.method === 'POST' && path === '/oauth/device/verify') {
      handleDeviceVerifyPost(req, res).catch(handleError(res));
      return;
    }
    if (req.method === 'GET' && path === '/oauth/device/callback') {
      handleDeviceCallback(req, res).catch(handleError(res));
      return;
    }
    if (req.method === 'POST' && path === '/oauth/device/token') {
      handleDeviceToken(req, res).catch(handleError(res));
      return;
    }

    if (req.method === 'GET' && path === '/admin/usage/token-hygiene') {
      if (!requireAdminAuth(req, res)) return;
      handleTokenHygiene(req, res).catch(handleError(res));
      return;
    }

    if (req.method === 'GET' && path === '/admin/usage/by-identity') {
      if (!requireAdminAuth(req, res)) return;
      handleUsageByIdentity(req, res).catch(handleError(res));
      return;
    }

    if (req.method === 'GET' && path === '/admin/optimize/findings') {
      if (!requireAdminAuth(req, res)) return;
      handleOptimizeFindings(req, res).catch(handleError(res));
      return;
    }

    if (req.method === 'GET' && path === '/admin/usage/savings-series') {
      if (!requireAdminAuth(req, res)) return;
      handleSavingsSeries(req, res).catch(handleError(res));
      return;
    }

    if (req.method === 'GET' && path === '/admin/usage/by-model-day') {
      if (!requireAdminAuth(req, res)) return;
      handleByModelDay(req, res).catch(handleError(res));
      return;
    }

    if (req.method === 'GET' && path === '/admin/sessions/window') {
      if (!requireAdminAuth(req, res)) return;
      handleSessionsWindow(req, res).catch(handleError(res));
      return;
    }

    // Provider-key cache bust. Called by the dashboard after a PUT/DELETE on
    // /api/provider-keys/* so the proxy doesn't serve stale credentials or
    // responses from its 5-minute in-process caches. Body: { team_id, provider? }
    if (req.method === 'POST' && path === '/admin/provider-keys/invalidate') {
      if (!requireAdminAuth(req, res)) return;
      handleInvalidateProviderKey(req, res).catch(handleError(res));
      return;
    }

    // Model-alias cache bust. Called by the dashboard after a write on
    // /api/model-aliases so the proxy picks up new aliases within one
    // request rather than waiting for the 60s cache TTL. Body: { team_id }
    if (req.method === 'POST' && path === '/admin/model-aliases/invalidate') {
      if (!requireAdminAuth(req, res)) return;
      handleInvalidateModelAliases(req, res).catch(handleError(res));
      return;
    }

    // Preset cache bust. Called by dashboard preset writes; bounded 60s TTL is
    // the multi-instance fallback, mirroring model aliases.
    if (req.method === 'POST' && path === '/admin/presets/invalidate') {
      if (!requireAdminAuth(req, res)) return;
      handleInvalidatePresets(req, res).catch(handleError(res));
      return;
    }

    // Billing-mode cache bust. Called by the dashboard after a mode flip so
    // the proxy picks up the new mode within one request rather than waiting
    // for the 60s billingModeCache TTL.
    if (req.method === 'POST' && path === '/admin/billing-mode/invalidate') {
      if (!requireAdminAuth(req, res)) return;
      handleInvalidateBillingMode(req, res).catch(handleError(res));
      return;
    }

    // Admin API routes
    if ((req.method === 'GET' || req.method === 'POST') && path === '/admin/shadow-experiments') {
      if (!requireAdminAuth(req, res)) return;
      const teamId = getRequiredOperatorTeamId(req, res);
      if (!teamId) return;
      handleShadowExperiments(req, res, teamId).catch(handleError(res));
      return;
    }
    if (
      (req.method === 'PATCH' || req.method === 'DELETE') &&
      segments[0] === 'admin' &&
      segments[1] === 'shadow-experiments' &&
      segments[2] &&
      !segments[3]
    ) {
      if (!requireAdminAuth(req, res)) return;
      const teamId = getRequiredOperatorTeamId(req, res);
      if (!teamId) return;
      handleShadowExperimentById(req, res, teamId, segments[2]).catch(handleError(res));
      return;
    }

    if (req.method === 'POST' && path === '/admin/keys') {
      if (!requireAdminAuth(req, res)) return;
      handleCreateKey(req, res).catch(handleError(res));
      return;
    }
    if (req.method === 'GET' && path === '/admin/keys') {
      if (!requireAdminAuth(req, res)) return;
      handleListKeys(req, res).catch(handleError(res));
      return;
    }
    if (req.method === 'DELETE' && segments[0] === 'admin' && segments[1] === 'keys' && segments[2]) {
      if (!requireAdminAuth(req, res)) return;
      handleRevokeKey(req, res, segments[2]).catch(handleError(res));
      return;
    }
    if (req.method === 'PATCH' && segments[0] === 'admin' && segments[1] === 'keys' && segments[2]) {
      if (!requireAdminAuth(req, res)) return;
      handleUpdateKey(req, res, segments[2]).catch(handleError(res));
      return;
    }
    // LAY-347: team-wide audit feed. Must be matched before the per-key
    // route because '/admin/keys/audit' shares the segments[2] slot with
    // a keyId-based path; UUIDs never literally equal 'audit', so this is
    // safe.
    if (
      req.method === 'GET' &&
      segments[0] === 'admin' &&
      segments[1] === 'keys' &&
      segments[2] === 'audit' &&
      !segments[3]
    ) {
      if (!requireAdminAuth(req, res)) return;
      handleListTeamAudit(req, res).catch(handleError(res));
      return;
    }
    // LAY-331: per-key audit trail. The !segments[4] guard mirrors the
    // team-audit route above and keeps the router's notion of "the per-key
    // audit endpoint" identical to the scoped allowlist's exactly-five-raw-
    // segments shape — deeper paths 404 for every token class.
    if (
      req.method === 'GET' &&
      segments[0] === 'admin' &&
      segments[1] === 'keys' &&
      segments[2] &&
      segments[3] === 'audit' &&
      !segments[4]
    ) {
      if (!requireAdminAuth(req, res)) return;
      handleListKeyAudit(req, res, segments[2]).catch(handleError(res));
      return;
    }
    // LAY-339: rotate-with-grace flow for api_keys.
    if (
      req.method === 'POST' &&
      segments[0] === 'admin' &&
      segments[1] === 'keys' &&
      segments[2] &&
      segments[3] === 'rotate'
    ) {
      if (!requireAdminAuth(req, res)) return;
      handleRotateKey(req, res, segments[2]).catch(handleError(res));
      return;
    }

    // RSH-100: per-team SSO connection config. Same auth model as
    // /admin/keys -- requireAdminAuth, no session/RBAC concept in this app.
    if (req.method === 'POST' && path === '/admin/idp-configs') {
      if (!requireAdminAuth(req, res)) return;
      handleCreateIdpConfig(req, res).catch(handleError(res));
      return;
    }
    if (req.method === 'PATCH' && segments[0] === 'admin' && segments[1] === 'idp-configs' && segments[2]) {
      if (!requireAdminAuth(req, res)) return;
      handleUpdateIdpConfig(req, res, segments[2]).catch(handleError(res));
      return;
    }
    if (req.method === 'DELETE' && segments[0] === 'admin' && segments[1] === 'idp-configs' && segments[2]) {
      if (!requireAdminAuth(req, res)) return;
      handleDeleteIdpConfig(req, res, segments[2]).catch(handleError(res));
      return;
    }

    if (req.method === 'POST' && path === '/admin/rules') {
      if (!requireAdminAuth(req, res)) return;
      handleCreateRule(req, res).catch(handleError(res));
      return;
    }
    if (req.method === 'GET' && path === '/admin/rules') {
      if (!requireAdminAuth(req, res)) return;
      handleListRules(req, res).catch(handleError(res));
      return;
    }
    if (req.method === 'PATCH' && segments[0] === 'admin' && segments[1] === 'rules' && segments[2]) {
      if (!requireAdminAuth(req, res)) return;
      handleUpdateRule(req, res, segments[2]).catch(handleError(res));
      return;
    }
    if (req.method === 'DELETE' && segments[0] === 'admin' && segments[1] === 'rules' && segments[2]) {
      if (!requireAdminAuth(req, res)) return;
      handleDeleteRule(req, res, segments[2]).catch(handleError(res));
      return;
    }
    if (req.method === 'GET' && path === '/admin/auto-route') {
      if (!requireAdminAuth(req, res)) return;
      handleGetAutoRouteSettings(req, res).catch(handleError(res));
      return;
    }
    if (req.method === 'POST' && path === '/admin/auto-route') {
      if (!requireAdminAuth(req, res)) return;
      handleUpdateAutoRouteSettings(req, res).catch(handleError(res));
      return;
    }
    if (req.method === 'POST' && path === '/admin/auto-route/invalidate') {
      if (!requireAdminAuth(req, res)) return;
      handleInvalidateAutoRouteSettings(req, res).catch(handleError(res));
      return;
    }
    // RSH-140: per-identity budget caps.
    if (req.method === 'GET' && path === '/admin/identity-budgets') {
      if (!requireAdminAuth(req, res)) return;
      handleListIdentityBudgets(req, res).catch(handleError(res));
      return;
    }
    if (req.method === 'GET' && path === '/admin/identity-budgets/one') {
      if (!requireAdminAuth(req, res)) return;
      handleGetIdentityBudget(req, res).catch(handleError(res));
      return;
    }
    if (req.method === 'PUT' && path === '/admin/identity-budgets/one') {
      if (!requireAdminAuth(req, res)) return;
      handlePutIdentityBudget(req, res).catch(handleError(res));
      return;
    }
    // LAY-348: workspace TPM cap.
    if (req.method === 'GET' && path === '/admin/team/rate-limits') {
      if (!requireAdminAuth(req, res)) return;
      handleGetTeamRateLimits(req, res).catch(handleError(res));
      return;
    }
    if (req.method === 'PATCH' && path === '/admin/team/rate-limits') {
      if (!requireAdminAuth(req, res)) return;
      handleUpdateTeamRateLimits(req, res).catch(handleError(res));
      return;
    }
    if (req.method === 'GET' && path === '/admin/promo-codes') {
      if (!requireAdminAuth(req, res)) return;
      handleListPromoCodes(req, res).catch(handleError(res));
      return;
    }
    if (req.method === 'POST' && path === '/admin/promo-codes') {
      if (!requireAdminAuth(req, res)) return;
      handleCreatePromoCode(req, res).catch(handleError(res));
      return;
    }
    if (req.method === 'DELETE' && segments[0] === 'admin' && segments[1] === 'promo-codes' && segments[2]) {
      if (!requireAdminAuth(req, res)) return;
      handleDeletePromoCode(req, res, segments[2]).catch(handleError(res));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Not found' } }));
  }

  async function handleInvalidateProviderKey(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: any;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid JSON in request body' } }));
      return;
    }
    const teamId = typeof body.team_id === 'string' ? body.team_id : null;
    if (!teamId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'team_id is required' } }));
      return;
    }
    const provider = typeof body.provider === 'string' ? body.provider : undefined;
    invalidateKeyCache(teamId, provider);
    responseCache.invalidateTeam(teamId, provider);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ invalidated: true, team_id: teamId, provider: provider ?? null }));
  }

  async function handleInvalidateModelAliases(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: any;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid JSON in request body' } }));
      return;
    }
    const teamId = typeof body.team_id === 'string' ? body.team_id : undefined;
    invalidateAliasCache(teamId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ invalidated: true, team_id: teamId ?? 'all' }));
  }

  async function handleInvalidatePresets(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: any;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid JSON in request body' } }));
      return;
    }
    const teamId = typeof body.team_id === 'string' ? body.team_id : undefined;
    invalidatePresetCache(teamId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ invalidated: true, team_id: teamId ?? 'all' }));
  }

  async function handleInvalidateBillingMode(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: any;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid JSON in request body' } }));
      return;
    }
    const teamId = typeof body.team_id === 'string' ? body.team_id : undefined;
    if (teamId) invalidateBillingModeCache(teamId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ invalidated: true, team_id: teamId ?? 'all' }));
  }

  async function handleHealthCheck(res: ServerResponse) {
    let pgStatus = 'ok';
    if (config.databaseUrl) {
      try {
        await getPool().query('SELECT 1');
      } catch {
        pgStatus = 'error';
      }
    } else {
      pgStatus = 'not_configured';
    }
    const overall = pgStatus === 'error' ? 'degraded' : 'ok';
    const body: Record<string, unknown> = {
      status: overall,
      postgres: pgStatus,
      catalog_freshness: getCatalogFreshness(new Date(), CATALOG_FRESHNESS_MANIFEST.generated_at),
    };
    // Surface in-memory log-buffer health (pending/dropped) for the configured
    // sinks. Informational only — dropped logs don't flip the overall status
    // (that would let a transient sink blip pull a request-healthy instance out
    // of the pool); they're exposed so the loss is observable via /health.
    const logging = getLoggerStats();
    if (logging.postgres || logging.clickhouse) {
      body.logging = {
        ...(logging.postgres ? { postgres: logging.postgres } : {}),
        ...(logging.clickhouse ? { clickhouse: logging.clickhouse } : {}),
      };
    }
    res.writeHead(overall === 'ok' ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  function handleError(res: ServerResponse) {
    return (err: Error) => {
      console.error('Route error:', err);
      captureException(err, { tags: { source: 'proxy_route' } });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Internal server error' } }));
      }
    };
  }

  return {
    start: () =>
      new Promise<void>((resolve) => {
        server.listen(port, () => {
          console.log(`RouteShift listening on port ${port}`);
          resolve();
        });
      }),
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
    server,
  };
}
