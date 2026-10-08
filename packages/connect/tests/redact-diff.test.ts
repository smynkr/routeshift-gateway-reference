import { describe, expect, it } from 'vitest';
import { renderDiff } from '../src/diff';
import { redactDiff } from '../src/redact';

// RSH-58 finding #2: the re-connect confirm diff printed the OLD key in
// cleartext — redact() only masked the freshly minted token, so the previous
// key on the removed (`-`) diff line leaked to stdout/scrollback. redactDiff
// must mask every known secret AND any RouteShift-format key by pattern, so the
// diff is safe regardless of which old value is present or where it came from.

const OLD = 'sk-proxy-prod_teamA_OLDOLDOLDOLDOLDOLDOLDOLD';
const NEW = 'sk-proxy-prod_teamA_NEWNEWNEWNEWNEWNEWNEWNEW';

describe('redactDiff (connect re-connect diff hygiene)', () => {
  it('masks the previous key when it is a known secret (keychain rotation)', () => {
    const before = `OPENAI_API_KEY=${OLD}`;
    const after = `OPENAI_API_KEY=${NEW}`;

    const diff = redactDiff(renderDiff(before, after), [NEW, OLD]);

    expect(diff).not.toContain(OLD);
    expect(diff).not.toContain(NEW);
    expect(diff).toContain('sk-proxy-prod_teamA_'); // non-secret prefix still shown
  });

  it('masks an old key that is NOT among the known secrets (file-resident/divergent)', () => {
    // The structural pass must catch a key that diverges from the keychain value
    // (e.g. --no-keychain installs or manual edits): only the NEW token is known.
    const before = `  "apiKey": "${OLD}"`;
    const after = `  "apiKey": "${NEW}"`;

    const diff = redactDiff(renderDiff(before, after), [NEW, null]);

    expect(diff).not.toContain(OLD);
    expect(diff).not.toContain(NEW);
    expect(diff).toContain('sk-proxy-prod_teamA_');
  });
});
