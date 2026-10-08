/**
 * AXI-8: the identity sampled from key metadata at request time is the
 * attribution of record for request_logs.layer_identity_id. Both the chat
 * and embeddings loggers must stamp it through this single helper so the
 * snapshot can never diverge between sinks; returns null when the field is
 * absent/empty and the writer stores the '' sentinel (ClickHouse parity).
 *
 * Lives in its own module (not auth/api-key.ts) because proxy/embeddings
 * test suites mock that whole module, which would silently erase this export.
 */
export function layerIdentityFromMetadata(metadata: Record<string, unknown> | undefined): string | null {
  const value = metadata?.layer_identity_id;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
