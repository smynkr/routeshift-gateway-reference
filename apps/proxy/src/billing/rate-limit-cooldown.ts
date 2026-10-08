// LAY-320: per-credential rate-limit cooldowns.
//
// On HTTP 429 from an upstream provider we mark the (team, provider, key_label)
// triple "degraded" for ~30s so subsequent selectKey() calls skip it when an
// alternate credential exists. Single-process / in-memory by design — moves to
// Redis if/when we run multi-replica. Entries are reaped lazily on read.
//
// Fixed 30s window for v1. Honoring upstream Retry-After hints is a follow-up
// (some providers send wildly inflated values).

const COOLDOWN_MS = 30 * 1000;

const cooldowns = new Map<string, number>();

function key(teamId: string, provider: string, label: string): string {
  return `${teamId}:${provider}:${label}`;
}

export function markCooldown(
  teamId: string,
  provider: string,
  label: string,
  durationMs: number = COOLDOWN_MS,
): void {
  cooldowns.set(key(teamId, provider, label), Date.now() + durationMs);
}

export function isCoolingDown(teamId: string, provider: string, label: string): boolean {
  const k = key(teamId, provider, label);
  const until = cooldowns.get(k);
  if (until === undefined) return false;
  if (until <= Date.now()) {
    cooldowns.delete(k);
    return false;
  }
  return true;
}

/**
 * Returns the set of currently-cooled labels for (team, provider). Used by
 * selectKey() to decide whether to filter the bucket. Reaps expired entries
 * along the way so the map stays bounded.
 */
export function getCooledLabels(teamId: string, provider: string): Set<string> {
  const now = Date.now();
  const out = new Set<string>();
  const prefix = `${teamId}:${provider}:`;
  for (const [k, until] of cooldowns) {
    if (!k.startsWith(prefix)) continue;
    if (until <= now) {
      cooldowns.delete(k);
      continue;
    }
    out.add(k.slice(prefix.length));
  }
  return out;
}

export interface ActiveCooldown {
  team_id: string;
  provider: string;
  label: string;
  cooldown_until: number;
}

/** Snapshot of active cooldowns. Optionally filtered by team. For dashboard surfacing. */
export function listActiveCooldowns(teamId?: string): ActiveCooldown[] {
  const now = Date.now();
  const out: ActiveCooldown[] = [];
  for (const [k, until] of cooldowns) {
    if (until <= now) {
      cooldowns.delete(k);
      continue;
    }
    const colon1 = k.indexOf(':');
    const colon2 = k.indexOf(':', colon1 + 1);
    if (colon1 < 0 || colon2 < 0) continue;
    const tid = k.slice(0, colon1);
    if (teamId && tid !== teamId) continue;
    out.push({
      team_id: tid,
      provider: k.slice(colon1 + 1, colon2),
      label: k.slice(colon2 + 1),
      cooldown_until: until,
    });
  }
  return out;
}

/** @internal — for testing only */
export function _resetCooldowns(): void {
  cooldowns.clear();
}
