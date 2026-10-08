import { createHash } from 'node:crypto';
import type { CanonicalMessage } from '@routeshift/shared';

const BUCKET_MS = 30 * 60 * 1000;
const FIRST_MSG_MAX = 1000;

export interface DeriveSessionInput {
  headers: Record<string, string | undefined>;
  messages: CanonicalMessage[];
  teamId: string;
  apiKeyId: string | null;
  timestamp: number;
}

export function deriveSessionId(input: DeriveSessionInput): string {
  const explicit = input.headers['x-routeshift-session-id'] ?? input.headers['x-conversation-id'];
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;

  const firstUser = input.messages.find((m) => m.role === 'user');
  const firstText = firstUser ? messageText(firstUser).slice(0, FIRST_MSG_MAX) : '';
  const bucket = Math.floor(input.timestamp / BUCKET_MS);
  const key = [input.teamId, input.apiKeyId ?? 'anonymous', bucket, firstText].join('|');

  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function messageText(m: CanonicalMessage): string {
  if (typeof m.content === 'string') return m.content;
  // content is caller-supplied JSON — a non-array shape (object, number, null)
  // is malformed but must not crash session derivation. Treat it as no text.
  if (!Array.isArray(m.content)) return '';
  return m.content
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('');
}
