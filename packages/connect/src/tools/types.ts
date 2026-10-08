export interface ToolContext {
  /** User home dir (injectable so tests run against a temp dir). */
  home: string;
  /** Configured gateway origin, no trailing slash (e.g. http://localhost:4000). */
  baseUrl: string;
  /** The minted key secret. */
  token: string;
  /** Non-secret key prefix, for display in `status`. */
  keyPrefix: string;
}

export interface ToolPlan {
  toolId: string;
  /** Absolute path of the file that would change. */
  file: string;
  /** Dot-paths (or sentinels) RouteShift will own — recorded for precise disconnect. */
  managedKeys: string[];
  /** Rendered current content for the diff ('' when the file/section is absent). */
  beforeText: string;
  /** Rendered proposed content. */
  afterText: string;
  /** True when afterText embeds the secret (drives 0600 perms + redaction). */
  containsSecret: boolean;
  /** True when before === after (nothing to do — idempotent re-run). */
  unchanged: boolean;
  /** Perform the write. */
  apply(): void;
}

export interface Tool {
  id: string;
  displayName: string;
  /**
   * Wire protocol this tool speaks to the proxy. 'openai' targets
   * `${baseUrl}/v1` (RouteShift's live OpenAI-compatible surface); 'anthropic'
   * targets `${baseUrl}` and depends on the (not-yet-shipped) /v1/messages
   * surface — the CLI warns when configuring those.
   */
  protocol: 'openai' | 'anthropic';
  /** Heuristic: is this tool plausibly installed for this user? */
  detect(home: string): boolean;
  /** Compute the change without writing. */
  plan(ctx: ToolContext): ToolPlan;
  /** Remove only the keys we previously wrote. */
  remove(home: string, file: string, managedKeys: string[]): void;
}
