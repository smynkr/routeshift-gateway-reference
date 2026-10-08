// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopyButton } from '@/components/copy-button';

afterEach(() => cleanup());

describe('CopyButton', () => {
  it('announces clipboard success only after writeText resolves', async () => {
    let resolveWrite!: () => void;
    const writeText = vi.fn(() => new Promise<void>((resolve) => {
      resolveWrite = resolve;
    }));
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CopyButton text="route explanation" label="Copy explanation" />);
    const button = screen.getByRole('button', { name: 'Copy explanation' });
    expect(button.className).not.toContain('min-h-11');
    expect(button.className).not.toContain('inline-flex');
    expect(button.className).toContain('text-neutral-300');
    expect(button.getAttribute('aria-live')).toBeNull();
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
    fireEvent.click(button);
    expect(screen.queryByText('Copied!')).toBeNull();

    await act(async () => {
      resolveWrite();
    });
    expect(await screen.findByRole('button', { name: 'Copied!' })).toBeDefined();
    expect(writeText).toHaveBeenCalledWith('route explanation');
  });

  it('keeps a truthful manual-copy path when the clipboard rejects', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    render(<CopyButton text="route explanation" label="Copy explanation" />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy explanation' }));

    expect(await screen.findByRole('button', { name: 'Copy failed — select the text' })).toBeDefined();
  });

  it('supports a caller-specific failure label without changing the generic default', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    render(
      <CopyButton
        text="route explanation"
        label="Copy explanation"
        failureLabel="Copy failed — select the explanation"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy explanation' }));

    expect(await screen.findByRole('button', { name: 'Copy failed — select the explanation' })).toBeDefined();
  });

  it('resets on text changes and ignores stale success or failure results', async () => {
    let resolveStaleSuccess!: () => void;
    let rejectStaleFailure!: (reason?: unknown) => void;
    const writeText = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveStaleSuccess = resolve;
      }))
      .mockImplementationOnce(() => new Promise<void>((_, reject) => {
        rejectStaleFailure = reject;
      }));
    Object.assign(navigator, { clipboard: { writeText } });
    const { rerender } = render(<CopyButton text="first explanation" label="Copy explanation" />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy explanation' }));
    expect(await screen.findByRole('button', { name: 'Copied!' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Copied!' }));
    rerender(<CopyButton text="second explanation" label="Copy explanation" />);
    expect(screen.queryByText('Copied!')).toBeNull();

    await act(async () => {
      resolveStaleSuccess();
    });
    expect(screen.queryByText('Copied!')).toBeNull();
    expect(screen.queryByText('Copy failed — select the text')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Copy explanation' }));
    expect(screen.queryByText('Copy failed — select the text')).toBeNull();
    rerender(<CopyButton text="third explanation" label="Copy explanation" />);
    await act(async () => {
      rejectStaleFailure(new Error('denied'));
    });
    expect(screen.queryByText('Copied!')).toBeNull();
    expect(screen.queryByText('Copy failed — select the text')).toBeNull();
  });
});
