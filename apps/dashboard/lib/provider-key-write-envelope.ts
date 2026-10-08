import { classifyEnvelope } from '@routeshift/shared/provider-key-envelope';

const V3_WRITE_ERROR = 'V3 provider-key writes require version-aware persistence';

export function classifyDashboardWritableEnvelope(encrypted: string) {
  const scheme = classifyEnvelope(encrypted);
  if (scheme === 'team-dek-v3') {
    throw new Error(V3_WRITE_ERROR);
  }
  return scheme;
}
