// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CountUp } from '@/components/marketing/count-up';
import { Reveal } from '@/components/marketing/reveal';
import { RouteDecisionTrace } from '@/components/marketing/route-decision-trace';

afterEach(() => {
  cleanup();
});

describe('landing delight layer', () => {
  it('renders reveal children synchronously without an observer host', () => {
    render(
      <Reveal>
        <p>Proof content stays readable</p>
      </Reveal>,
    );
    expect(screen.getByText('Proof content stays readable')).toBeDefined();
  });

  it('renders the final count-up value with an accessible name', () => {
    render(<CountUp target={2300} prefix="$" />);
    const value = screen.getByLabelText('$2,300');
    expect(value.textContent).toBe('$2,300');
  });

  it('hydrates server-rendered counts without replacing the page for motion-enabled browsers', async () => {
    const browserWindow = window;
    const mediaDescriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    const container = document.createElement('div');
    const onRecoverableError = vi.fn();
    let root: Root | undefined;
    try {
      vi.stubGlobal('window', undefined);
      container.innerHTML = renderToString(<CountUp target={2300} prefix="$" />);
      vi.stubGlobal('window', browserWindow);
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: () => ({ matches: false }),
      });
      document.body.append(container);
      await act(async () => {
        root = hydrateRoot(container, <CountUp target={2300} prefix="$" />, { onRecoverableError });
      });
      expect(onRecoverableError).not.toHaveBeenCalled();
      expect(container.textContent).toBe('$2,300');
    } finally {
      vi.stubGlobal('window', browserWindow);
      await act(async () => root?.unmount());
      container.remove();
      if (mediaDescriptor) Object.defineProperty(window, 'matchMedia', mediaDescriptor);
      else Reflect.deleteProperty(window, 'matchMedia');
      vi.unstubAllGlobals();
    }
  });

  it('exposes plain, markdown, and agent-JSON trace exports', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      render(<RouteDecisionTrace />);
      fireEvent.click(screen.getByRole('button', { name: 'Copy as Markdown' }));
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText.mock.calls[0][0]).toContain('## RouteShift decision');
      expect(writeText.mock.calls[0][0]).toContain('Interactive example');

      fireEvent.click(screen.getByRole('button', { name: 'Copy for agent (JSON)' }));
      expect(writeText).toHaveBeenCalledTimes(2);
      const parsed = JSON.parse(writeText.mock.calls[1][0] as string) as { provenance: string };
      expect(parsed.provenance).toContain('Interactive example');

      // The original plain-text export remains the default path.
      fireEvent.click(screen.getByRole('button', { name: 'Copy explanation' }));
      expect(writeText).toHaveBeenCalledTimes(3);
      expect(writeText.mock.calls[2][0]).toContain('Requested route:');
    } finally {
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    }
  });
});
