// The connect manifest records exactly what RouteShift configured, so `status`
// and `disconnect` are precise: we only ever report and remove config we wrote.
// It stores the non-secret key prefix for display — never the key itself.

import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { writeFileSafe, removeFileIfExists } from './fs-util';

export interface ManifestTool {
  id: string;
  file: string;
  managedKeys: string[];
  configuredAt: string;
}

export interface Manifest {
  version: 1;
  baseUrl: string;
  keyPrefix: string;
  keychainDisabled?: boolean;
  tools: ManifestTool[];
}

export const manifestPath = (home: string) => join(home, '.routeshift', 'connect.json');

export function loadManifest(home: string): Manifest | null {
  const file = manifestPath(home);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.tools)) return parsed;
    return null;
  } catch {
    // The file exists but is unreadable/corrupt. Returning null silently would
    // make `disconnect` report "nothing to disconnect" while live credentials
    // written into tool configs remain on disk. Warn so the user can remediate.
    console.warn(
      `RouteShift: ${file} is unreadable; RouteShift may still be configured in your tool configs. Remove it manually if needed.`,
    );
    return null;
  }
}

export function saveManifest(home: string, manifest: Manifest): void {
  // 0600: not strictly secret (no key), but it describes the user's setup.
  writeFileSafe(manifestPath(home), `${JSON.stringify(manifest, null, 2)}\n`, { secret: true });
}

export function upsertManifestTool(
  home: string,
  meta: { baseUrl: string; keyPrefix: string; keychainDisabled?: boolean },
  tool: Omit<ManifestTool, 'configuredAt'>,
  configuredAt: string,
): Manifest {
  const existing = loadManifest(home);
  const tools = (existing?.tools ?? []).filter((t) => t.id !== tool.id);
  tools.push({ ...tool, configuredAt });
  const manifest: Manifest = {
    version: 1,
    baseUrl: meta.baseUrl,
    keyPrefix: meta.keyPrefix,
    keychainDisabled: meta.keychainDisabled === true ? true : undefined,
    tools,
  };
  saveManifest(home, manifest);
  return manifest;
}

export function removeManifestTool(home: string, toolId: string): void {
  const existing = loadManifest(home);
  if (!existing) return;
  const tools = existing.tools.filter((t) => t.id !== toolId);
  if (tools.length === 0) {
    removeFileIfExists(manifestPath(home));
    return;
  }
  saveManifest(home, { ...existing, tools });
}
