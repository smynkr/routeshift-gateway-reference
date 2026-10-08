/**
 * Capability indices — the OpenRouter-style agentic/coding/intelligence axes
 * (0-100) that RSH-143 carries in the catalog and feeds to the auto-router.
 *
 * PROVENANCE CONTRACT (mirrors the RSH-164 jurisdiction-evidence standard):
 * an index value is a CLAIM about measured capability. It may only be entered
 * when the human curator read it from the declared source on the declared
 * as-of date; it must NEVER be derived from intelligence_tier, guessed, or
 * extrapolated from pricing. The provenance travels WITH the value (source +
 * source_as_of on every index set), so re-curating one model can never
 * restamp another, and the /v1/models + MCP surfaces expose it verbatim.
 *
 * CURRENT STATE (as-of 2026-08-10): the source below (OpenRouter's per-model
 * performance data) is reachable ONLY through their OAuth-gated MCP server
 * (mcp.openrouter.ai — authorization_code flow, no client_credentials), so
 * ZERO models carry indices today. The mechanism ships complete and inert;
 * the curation procedure below is the first-defensible-claim path.
 */

export interface CapabilityIndices {
  /**
   * 0-100. Higher = stronger on the axis. Each axis is OPTIONAL: the source
   * may verify only some axes for a model, and "missing axis = no signal"
   * is the honest default the contract promises — the router treats a
   * missing axis like a missing set (factor 1.0). Fabricating a value to
   * fill a gap is forbidden; leaving the axis out is correct.
   */
  agentic?: number;
  coding?: number;
  intelligence?: number;
  /** Human-readable citation (name + URL) a reviewer can open. */
  source: string;
  /**
   * Per-model provenance date (ISO) — the day the values were read from the
   * source. Per-model, NOT global: re-curating one model must not restamp
   * the others (that would launder stale values as freshly verified).
   */
  source_as_of: string;
}

/** The three task axes; single declaration shared by router and metadata. */
export type CapabilityAxis = keyof Pick<CapabilityIndices, 'agentic' | 'coding' | 'intelligence'>;

export const CAPABILITY_INDEX_MIN = 0;
export const CAPABILITY_INDEX_MAX = 100;

const AXIS_KEYS = ['agentic', 'coding', 'intelligence'] as const;

export function isValidCapabilityIndices(value: unknown): value is CapabilityIndices {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  // strict keys: an unknown extra key would be published verbatim to the
  // public surface — reject the whole set instead
  for (const key of Object.keys(v)) {
    if (key !== 'source' && key !== 'source_as_of' && !(AXIS_KEYS as readonly string[]).includes(key)) {
      return false;
    }
  }
  // at least one measured axis; an empty claim is not a claim
  let axesPresent = 0;
  for (const axis of AXIS_KEYS) {
    const n = v[axis];
    if (n === undefined) continue;
    axesPresent += 1;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < CAPABILITY_INDEX_MIN || n > CAPABILITY_INDEX_MAX) {
      return false;
    }
  }
  if (axesPresent === 0) return false;
  if (typeof v.source !== 'string' || v.source.length === 0) return false;
  // Provenance: a dated as_of is part of the value. This validator is
  // deliberately PURE (no Date.now()) — it runs in the router's hot path, so
  // wall-clock freshness is enforced by the registry gate test instead
  // (isFreshSourceAsOf), keeping routing decisions replayable.
  const asOf = v.source_as_of;
  if (typeof asOf !== 'string' || asOf.length === 0) return false;
  // ISO 8601 only (date-only or full timestamp): locale-ambiguous forms like
  // '08/10/2026' must not reach the public surface as provenance
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?Z)?$/.test(asOf)) return false;
  if (Number.isNaN(Date.parse(asOf))) return false;
  // Calendar-exactness: JS Date.parse NORMALIZES impossible dates ('2026-02-31'
  // rolls to 2026-03-03), so a regex+parse pass alone would launder a typo'd
  // provenance date into the public surface. Round-trip the parsed value back
  // to its date-only spelling and require equality (date-only strings parse
  // as UTC, so this is timezone-safe).
  const roundTrip = new Date(asOf).toISOString().slice(0, 10);
  if (!asOf.startsWith(roundTrip)) return false;
  return true;
}

/** Clock-skew tolerance for date-only source_as_of values (timezone offsets). */
export const SOURCE_AS_OF_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * Curation-time freshness check (RSH-164 fail-closed precedent — a future
 * stamp is a curation error). Used by the registry gate test, NOT the runtime
 * validator: routing must stay wall-clock independent.
 */
export function isFreshSourceAsOf(asOf: string): boolean {
  return Date.parse(asOf) <= Date.now() + SOURCE_AS_OF_FUTURE_SKEW_MS;
}

/** The one declared source for capability indices. A future source change is
 *  a provenance change: update this record and re-curate; the per-model
 *  `source`/`source_as_of` live ON each index set (see CapabilityIndices). */
export const CAPABILITY_INDEX_SOURCE: {
  name: string;
  url: string;
  notes: string;
} = {
  name: 'OpenRouter model performance data',
  url: 'https://openrouter.ai/models',
  notes:
    'OpenRouter exposes per-model agentic/coding/intelligence indices through its MCP server. '
    + 'Access is OAuth-gated (authorization_code + S256; `claude mcp login openrouter`), so extraction is an '
    + 'interactive, human-curated step: run the MCP server, query the rankings/perf tool for each auto-routable '
    + 'model in MODEL_REGISTRY, and transcribe the values into the registry with the source citation and a '
    + 'per-model source_as_of. Re-verify monthly (OpenRouter recomputes indices regularly). Zero indices are '
    + 'shipped until this runs.',
};
