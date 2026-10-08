// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DialogPortal } from '@/components/ui/dialog-portal';

const dialogFiles = [
  'components/dashboard-shell.tsx',
  'components/credits/add-credits-dialog.tsx',
  'components/keys/audit-drawer-button.tsx',
  'components/keys/create-key-dialog.tsx',
  'components/keys/edit-key-dialog.tsx',
  'components/keys/revoke-key-button.tsx',
  'components/keys/rotate-key-button.tsx',
  'components/overview/overview-quick-start.tsx',
  'app/(dashboard)/shadow-experiments/shadow-experiments-client.tsx',
  'components/presets/version-history-drawer.tsx',
  'components/team/invite-member-dialog.tsx',
];

afterEach(() => cleanup());

describe('DialogPortal', () => {
  it('mounts dialog content directly under document.body', () => {
    const { container } = render(
      <div data-testid="inline-root">
        <DialogPortal>
          <div role="dialog">Portal dialog</div>
        </DialogPortal>
      </div>,
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('Portal dialog');
    expect(dialog.parentElement).toBe(document.body);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('uses the portal in every existing dashboard dialog overlay', () => {
    for (const relativePath of dialogFiles) {
      const source = readFileSync(join(__dirname, '..', relativePath), 'utf8');
      expect(source, relativePath).toContain('DialogPortal');
    }
  });
});
