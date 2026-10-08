// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { AcceptInviteCard } from '@/app/invite/[token]/accept-invite';

let paramsValue: { token?: string | string[] } = {};

vi.mock('next/navigation', () => ({
  useParams: () => paramsValue,
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

afterEach(() => cleanup());
beforeEach(() => {
  paramsValue = { token: 'valid-token' };
  vi.restoreAllMocks();
});

describe('AcceptInviteCard token validation', () => {
  it.each([
    ['array token', ['token-a', 'token-b']],
    ['empty token', ''],
    ['missing token', undefined],
  ])('rejects %s before making a POST', (_label, token) => {
    paramsValue = { token };
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    render(<AcceptInviteCard />);

    expect(screen.getByText('Invalid invitation token')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Accept Invitation' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends only a validated string token', async () => {
    paramsValue = { token: 'token with spaces' };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'not accepted' }), { status: 400 }),
    );

    render(<AcceptInviteCard />);
    fireEvent.click(screen.getByRole('button', { name: 'Accept Invitation' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith('/api/invitations/accept', expect.objectContaining({
      body: JSON.stringify({ token: 'token with spaces' }),
    }));
  });
});
