import { afterEach, describe, expect, it } from 'vitest';
import { getPlatformKey } from '../src/providers/platform-keys.js';

describe('getPlatformKey', () => {
  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_WORKERS_AI_TOKEN;
    delete process.env.NEURALWATT_API_KEY;
  });

  it('never exposes a RouteShift-funded key to subscription/BYOK mode', () => {
    process.env.OPENAI_API_KEY = 'platform-openai-key';

    expect(getPlatformKey('openai', 'subscription')).toBeUndefined();
    expect(getPlatformKey('openai', 'credits')).toBe('platform-openai-key');
  });

  it('resolves Cloudflare platform credentials only with a valid account in credits mode', () => {
    process.env.CLOUDFLARE_WORKERS_AI_TOKEN = 'platform-cloudflare-key';
    process.env.NEURALWATT_API_KEY = 'legacy-neuralwatt-key';

    expect(getPlatformKey('cloudflare-workers-ai', 'credits')).toBeUndefined();

    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    expect(getPlatformKey('cloudflare-workers-ai', 'subscription')).toBeUndefined();
    expect(getPlatformKey('cloudflare-workers-ai', 'credits')).toBe('platform-cloudflare-key');
    expect(getPlatformKey('neuralwatt', 'subscription')).toBeUndefined();
    expect(getPlatformKey('neuralwatt', 'credits')).toBe('legacy-neuralwatt-key');

    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789ABCDEF0123456789ABCDEF';
    expect(getPlatformKey('cloudflare-workers-ai', 'credits')).toBeUndefined();
  });
});
