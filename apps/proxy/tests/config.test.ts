import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('loadConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    delete process.env.DATABASE_URL;
    delete process.env.ADMIN_SECRET;
    delete process.env.PROVIDER_KEY_SECRET;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_WORKERS_AI_TOKEN;
    delete process.env.NEURALWATT_API_KEY;
    delete process.env.CLICKHOUSE_URL;
    delete process.env.CORS_ORIGIN;
    delete process.env.MAX_REQUEST_BODY_BYTES;
    delete process.env.SEARCH_BACKEND;
    delete process.env.EXA_API_KEY;
    delete process.env.WEB_SEARCH_SURCHARGE_MICROCENTS;
    delete process.env.PLUGIN_FETCH_TIMEOUT_MS;
    delete process.env.PLUGIN_MAX_FILE_BYTES;
    delete process.env.PLUGIN_MAX_FILE_PAGES;
    delete process.env.PLUGIN_MAX_EXTRACTED_TEXT_CHARS;
    delete process.env.PLUGIN_MAX_TOTAL_FILE_BYTES;
    delete process.env.PLUGIN_MAX_TOTAL_EXTRACTED_TEXT_CHARS;
    delete process.env.PLUGIN_MAX_FILES;
    delete process.env.PORT;
    delete process.env.ALLOW_UNAUTHENTICATED_ADMIN_DEV;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('parses defaults in development mode', async () => {
    process.env.NODE_ENV = 'development';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { loadConfig } = await import('../src/config.js');
    const cfg = loadConfig();

    expect(cfg.port).toBe(4000);
    expect(cfg.corsOrigins).toEqual(['*']);
    expect(cfg.maxRequestBodyBytes).toBe(14680064);
    expect(cfg.searchBackend).toBe('exa');
    expect(cfg.webSearchSurchargeMicrocents).toBe(500000);
    expect(cfg.pluginFetchTimeoutMs).toBe(5000);
    expect(cfg.pluginMaxFileBytes).toBe(10485760);
    expect(cfg.pluginMaxFilePages).toBe(100);
    expect(cfg.pluginMaxExtractedTextChars).toBe(1000000);
    expect(cfg.pluginMaxTotalFileBytes).toBe(10485760);
    expect(cfg.pluginMaxTotalExtractedTextChars).toBe(1000000);
    expect(cfg.pluginMaxFiles).toBe(10);
    expect(cfg.nodeEnv).toBe('development');
    expect(warnSpy).toHaveBeenCalled();
  });
  it('accepts a valid Cloudflare platform credential pair as usable provider config', async () => {
    process.env.NODE_ENV = 'development';
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    process.env.CLOUDFLARE_WORKERS_AI_TOKEN = 'cloudflare-platform-key';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { loadConfig } = await import('../src/config.js');
    loadConfig();

    expect(warnSpy).not.toHaveBeenCalledWith('WARNING: No usable provider API keys set — proxy cannot route requests');
  });
  it('accepts a legacy NeuralWatt platform key as usable provider config', async () => {
    process.env.NODE_ENV = 'development';
    process.env.NEURALWATT_API_KEY = 'legacy-neuralwatt-key';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { loadConfig } = await import('../src/config.js');
    loadConfig();

    expect(warnSpy).not.toHaveBeenCalledWith('WARNING: No usable provider API keys set — proxy cannot route requests');
  });

  it('exits in production when required env vars are missing', async () => {
    process.env.NODE_ENV = 'production';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    await expect(import('../src/config.js')).rejects.toThrow('process.exit called');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('FATAL: Missing required env vars in production'),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits in production when CORS_ORIGIN is missing or wildcard', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgres://db';
    process.env.ADMIN_SECRET = 'super-secret-admin-token';
    process.env.PROVIDER_KEY_SECRET = 'provider-key-secret';
    process.env.CORS_ORIGIN = '*';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    await expect(import('../src/config.js')).rejects.toThrow('process.exit called');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('FATAL: CORS_ORIGIN must list explicit origins in production'),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('uses explicit values when provided', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgres://db';
    process.env.ADMIN_SECRET = 'super-secret-admin-token';
    process.env.PROVIDER_KEY_SECRET = 'provider-key-secret';
    process.env.CORS_ORIGIN = 'https://dashboard.example.com, https://admin.example.com';
    process.env.MAX_REQUEST_BODY_BYTES = '2048';
    process.env.PORT = '9000';
    process.env.SEARCH_BACKEND = 'exa';
    process.env.EXA_API_KEY = 'exa-test-key';
    process.env.WEB_SEARCH_SURCHARGE_MICROCENTS = '2500';
    process.env.PLUGIN_FETCH_TIMEOUT_MS = '12000';
    process.env.PLUGIN_MAX_FILE_BYTES = '1234';
    process.env.PLUGIN_MAX_FILE_PAGES = '12';
    process.env.PLUGIN_MAX_EXTRACTED_TEXT_CHARS = '3456';
    process.env.PLUGIN_MAX_TOTAL_FILE_BYTES = '4567';
    process.env.PLUGIN_MAX_TOTAL_EXTRACTED_TEXT_CHARS = '5678';
    process.env.PLUGIN_MAX_FILES = '4';

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { loadConfig } = await import('../src/config.js');
    const cfg = loadConfig();

    expect(cfg.port).toBe(9000);
    expect(cfg.databaseUrl).toBe('postgres://db');
    expect(cfg.adminSecret).toBe('super-secret-admin-token');
    expect(cfg.corsOrigins).toEqual(['https://dashboard.example.com', 'https://admin.example.com']);
    expect(cfg.maxRequestBodyBytes).toBe(2048);
    expect(cfg.searchBackend).toBe('exa');
    expect(cfg.exaApiKey).toBe('exa-test-key');
    expect(cfg.webSearchSurchargeMicrocents).toBe(2500);
    expect(cfg.pluginFetchTimeoutMs).toBe(12000);
    expect(cfg.pluginMaxFileBytes).toBe(1234);
    expect(cfg.pluginMaxFilePages).toBe(12);
    expect(cfg.pluginMaxExtractedTextChars).toBe(3456);
    expect(cfg.pluginMaxTotalFileBytes).toBe(4567);
    expect(cfg.pluginMaxTotalExtractedTextChars).toBe(5678);
    expect(cfg.pluginMaxFiles).toBe(4);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
