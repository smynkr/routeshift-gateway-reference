import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryKeychain, type KeychainStore } from '../src/keychain';

afterEach(() => {
  vi.doUnmock('@napi-rs/keyring');
  vi.resetModules();
});

describe('memoryKeychain (test double mirroring the real store contract)', () => {
  it('round-trips set/get/delete', () => {
    const kc: KeychainStore = memoryKeychain();
    expect(kc.get('https://api.routeshift.io')).toBeNull();
    kc.set('https://api.routeshift.io', 'sk-proxy-live_acme_secret');
    expect(kc.get('https://api.routeshift.io')).toBe('sk-proxy-live_acme_secret');
    expect(kc.delete('https://api.routeshift.io')).toBe('deleted');
    expect(kc.get('https://api.routeshift.io')).toBeNull();
    expect(kc.delete('https://api.routeshift.io')).toBe('absent');
  });

  it('isolates accounts', () => {
    const kc = memoryKeychain();
    kc.set('a', '1');
    kc.set('b', '2');
    expect(kc.get('a')).toBe('1');
    expect(kc.get('b')).toBe('2');
  });
});

describe('osKeychain delete result mapping', () => {
  it('returns error when the backing keychain delete throws', async () => {
    vi.resetModules();
    vi.doMock('@napi-rs/keyring', () => ({
      Entry: class {
        getPassword(): string | null {
          return null;
        }

        setPassword(): void {}

        deletePassword(): boolean {
          throw new Error('keychain locked');
        }
      },
    }));

    const { osKeychain } = await import('../src/keychain');
    expect(osKeychain.delete('https://api.routeshift.io')).toBe('error');
  });
});
