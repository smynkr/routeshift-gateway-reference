export interface Config {
  port: number;
  databaseUrl: string | undefined;
  clickhouseUrl: string | undefined;
  adminSecret: string | undefined;
  corsOrigins: string[];
  maxRequestBodyBytes: number;
  searchBackend: string;
  exaApiKey: string | undefined;
  webSearchSurchargeMicrocents: number;
  pluginFetchTimeoutMs: number;
  pluginMaxFileBytes: number;
  pluginMaxFilePages: number;
  pluginMaxExtractedTextChars: number;
  pluginMaxTotalFileBytes: number;
  pluginMaxTotalExtractedTextChars: number;
  pluginMaxFiles: number;
  nodeEnv: string;
  /**
   * Lease bound for budget reservations (RSH-138). Must exceed the full
   * admission-to-dispatch path (plugin execution, post-plugin adjustment,
   * provider/fallback/cascade wall-clock ceiling, stream-drain margin).
   */
  budgetReservationLeaseMs: number;
}

function parseCorsOrigins(value: string | undefined, isProduction: boolean): string[] {
  const origins = (value ?? '*')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

  if (isProduction && (origins.length === 0 || origins.includes('*'))) {
    console.error('FATAL: CORS_ORIGIN must list explicit origins in production; wildcard (*) is not allowed');
    process.exit(1);
  }

  return origins.length > 0 ? origins : ['*'];
}

export function loadConfig(): Config {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const isProduction = nodeEnv === 'production';

  if (isProduction) {
    const missing: string[] = [];
    if (!process.env.DATABASE_URL) missing.push('DATABASE_URL');
    if (!process.env.ADMIN_SECRET) missing.push('ADMIN_SECRET');
    if (!process.env.PROVIDER_KEY_SECRET) missing.push('PROVIDER_KEY_SECRET');
    if (!process.env.CORS_ORIGIN) missing.push('CORS_ORIGIN');
    if (missing.length > 0) {
      console.error(`FATAL: Missing required env vars in production: ${missing.join(', ')}`);
      process.exit(1);
    }
  }

  if (!isProduction) {
    if (!process.env.ADMIN_SECRET) {
      console.warn('WARNING: ADMIN_SECRET not set — admin API will fail closed unless ALLOW_UNAUTHENTICATED_ADMIN_DEV=true and bound to localhost');
    }
    const hasCloudflarePlatformKey = Boolean(process.env.CLOUDFLARE_WORKERS_AI_TOKEN)
      && /^[0-9a-f]{32}$/.test(process.env.CLOUDFLARE_ACCOUNT_ID ?? '');
    const hasNeuralWattPlatformKey = Boolean(process.env.NEURALWATT_API_KEY);
    const providers = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY'];
    if (!providers.some(k => process.env[k]) && !hasCloudflarePlatformKey && !hasNeuralWattPlatformKey) {
      console.warn('WARNING: No usable provider API keys set — proxy cannot route requests');
    }
  }

  return {
    port: parseInt(process.env.PORT ?? '4000', 10),
    databaseUrl: process.env.DATABASE_URL,
    clickhouseUrl: process.env.CLICKHOUSE_URL,
    adminSecret: process.env.ADMIN_SECRET,
    corsOrigins: parseCorsOrigins(process.env.CORS_ORIGIN, isProduction),
    // 14 MiB leaves room for JSON/base64 overhead around the default 10 MiB
    // decoded PDF cap. Keep an override at least that large when file uploads
    // are enabled; otherwise the HTTP body gate fires before the advertised
    // file-parser limit can return its stable warning.
    maxRequestBodyBytes: parseInt(process.env.MAX_REQUEST_BODY_BYTES ?? '14680064', 10),
    searchBackend: process.env.SEARCH_BACKEND ?? 'exa',
    exaApiKey: process.env.EXA_API_KEY,
    webSearchSurchargeMicrocents: parseInt(process.env.WEB_SEARCH_SURCHARGE_MICROCENTS ?? '500000', 10),
    pluginFetchTimeoutMs: parseInt(process.env.PLUGIN_FETCH_TIMEOUT_MS ?? '5000', 10),
    pluginMaxFileBytes: parseInt(process.env.PLUGIN_MAX_FILE_BYTES ?? '10485760', 10),
    pluginMaxFilePages: parseInt(process.env.PLUGIN_MAX_FILE_PAGES ?? '100', 10),
    pluginMaxExtractedTextChars: parseInt(process.env.PLUGIN_MAX_EXTRACTED_TEXT_CHARS ?? '1000000', 10),
    pluginMaxTotalFileBytes: parseInt(process.env.PLUGIN_MAX_TOTAL_FILE_BYTES ?? '10485760', 10),
    pluginMaxTotalExtractedTextChars: parseInt(process.env.PLUGIN_MAX_TOTAL_EXTRACTED_TEXT_CHARS ?? '1000000', 10),
    pluginMaxFiles: parseInt(process.env.PLUGIN_MAX_FILES ?? '10', 10),
    nodeEnv,
    // 600s default: must exceed the relay's 5-minute stream heartbeat so the
    // budget lease is refreshed before it can expire mid-stream; admission
    // refuses capped traffic when a configured bound cannot cover the path.
    budgetReservationLeaseMs: parseInt(process.env.BUDGET_RESERVATION_LEASE_MS ?? '600000', 10),
  };
}

export const config = loadConfig();
