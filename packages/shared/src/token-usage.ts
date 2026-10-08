export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  /** Tokens used for hidden/provider reasoning, included in output_tokens for billing. */
  reasoning_tokens?: number;
  /**
   * Which TTL tier the cache write used. Anthropic supports '5m' (default
   * ephemeral, 1.25× input price) and '1h' (extended, ~2.0× input price).
   * Absent means the default tier ('5m') or no cache write.
   */
  cache_write_ttl?: '5m' | '1h';
}
