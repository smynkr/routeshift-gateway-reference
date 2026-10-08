export interface ApiKeyInfo {
  id: string;
  teamId: string;
  allowedModels: string[] | null;
  rateLimitOverride: { requests_per_minute?: number; tokens_per_minute?: number } | null;
  metadata: Record<string, unknown>;
  /** RSH-146: org-policy preset binding minted onto the key. The handler
   *  applies it on every request; null = no binding. */
  presetSlug: string | null;
  presetVersion: number | null;
}
