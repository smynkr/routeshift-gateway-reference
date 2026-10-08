import { describe, expect, it } from 'vitest';
import { openaiEnv } from '../src/tools/openai-env';

// RSH-60: env.sh is meant to be `source`d. The token/base URL were interpolated
// into double-quoted strings, so a value containing a quote or $(...) could break
// out and execute as shell. Emit single-quoted shell literals instead.

const ctx = (token: string, baseUrl = 'http://localhost:4000') =>
  ({ home: '/tmp/does-not-exist-rsh60', baseUrl, token, keyPrefix: 'sk-proxy-x' }) as never;

describe('openai-env shell escaping (RSH-60)', () => {
  it('single-quotes a token that tries to break out of the string', () => {
    const after = openaiEnv.plan(ctx('a"; touch /tmp/pwned #')).afterText;
    expect(after).toContain(`export OPENAI_API_KEY='a"; touch /tmp/pwned #'`);
    // No double-quoted interpolation that would let $(...)/;/backtick execute.
    expect(after).not.toContain('OPENAI_API_KEY="');
  });

  it('escapes an embedded single quote with the \'\\\'\' sequence', () => {
    const after = openaiEnv.plan(ctx("ab'cd")).afterText;
    expect(after).toContain(`export OPENAI_API_KEY='ab'\\''cd'`);
  });

  it('single-quotes the base URL too', () => {
    const after = openaiEnv.plan(ctx('sk-proxy-x', 'https://api.test')).afterText;
    expect(after).toContain(`export OPENAI_BASE_URL='https://api.test/v1'`);
  });
});
