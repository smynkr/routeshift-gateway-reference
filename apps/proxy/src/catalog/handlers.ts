import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildDocsCatalogArtifact, buildModelsList, buildModelDetail } from '@routeshift/shared';
import { validateApiKey } from '../auth/api-key.js';

const DOCS_CATALOG_ARTIFACT = buildDocsCatalogArtifact();


/** Optional auth: returns the key's allowedModels (or null for unauthenticated /
 *  invalid key). Never throws, never rejects a public read. */
async function optionalAllowedModels(req: IncomingMessage): Promise<string[] | null> {
  const auth = req.headers['authorization'];
  const key = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!key || !key.startsWith('sk-proxy-')) return null;
  const info = await validateApiKey(key).catch(() => null);
  if (!info) return null;
  return info.allowedModels && info.allowedModels.length > 0 ? info.allowedModels : null;
}

export async function handleModelsList(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const allowed = await optionalAllowedModels(req);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(buildModelsList(allowed)));
}

export async function handleCatalogManifest(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=3600',
  });
  res.end(JSON.stringify(DOCS_CATALOG_ARTIFACT));
}

export async function handleModelDetail(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const allowed = await optionalAllowedModels(req);
  const model = buildModelDetail(id, allowed);
  if (!model) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Model not found', code: 'model_not_found' } }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(model));
}
