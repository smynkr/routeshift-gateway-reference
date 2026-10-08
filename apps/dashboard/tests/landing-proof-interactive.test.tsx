// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PricingProof } from '@/components/marketing/pricing-proof';
import { RouteDecisionTrace } from '@/components/marketing/route-decision-trace';
import { UseCases } from '@/components/marketing/use-cases';
import { calculateSavingsScenario } from '@/lib/savings-simulator';

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

afterEach(() => {
  cleanup();
});

describe('interactive landing proof', () => {
  it('calculates the default pricing example through the shared helper', () => {
    const result = calculateSavingsScenario({
      monthlySpendUsd: 10_000,
      modelMix: { low: 50, standard: 30, premium: 20 },
      measuredSavingsPercent: { low: 30, standard: 20, premium: 10 },
      flatMarkupPercent: 5,
    });

    if ('error' in result) {
      throw new Error(result.error);
    }

    expect(result.measuredSavingsUsd).toBe(2_300);
    expect(result.routeShiftFeeUsd).toBe(69);
    expect(result.flatMarkupFeeUsd).toBe(500);
    expect(result.routeShiftDifferenceUsd).toBe(431);
  });

  it('recomputes pricing output when spend and model mix change', () => {
    render(<PricingProof />);

    fireEvent.change(screen.getByRole('slider', { name: 'Monthly spend' }), {
      target: { value: '20000' },
    });
    expect(screen.getByText('Monthly spend: $20,000')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Premium-heavy 20/30/50' }));
    expect(screen.getByText('Model mix: 20% low-cost / 30% standard / 50% premium')).toBeDefined();
    expect(screen.getByText('Difference vs RouteShift savings-share fee: $898')).toBeDefined();
  });

  it('shows the context-window skip explanation for the oversized scenario', () => {
    render(<RouteDecisionTrace />);

    const oversizedScenario = screen.getByRole('button', { name: 'Oversized context' });
    expect(oversizedScenario).toBeDefined();
    fireEvent.click(oversizedScenario);

    expect(screen.getByText(/context window/i)).toBeDefined();
    expect(screen.getByText(/remains on/i)).toBeDefined();
  });

  it('renders each operator job with its destination link', () => {
    render(<UseCases />);

    for (const title of [
      'Cap spend before it ships',
      "Stay up when a provider doesn't",
      'Give every harness the same local route',
    ]) {
      expect(screen.getByRole('heading', { level: 3, name: title })).toBeDefined();
    }

    expect(screen.getByRole('link', { name: 'Review savings receipts' }).getAttribute('href')).toBe('/savings');
    expect(screen.getByRole('link', { name: 'Inspect activity' }).getAttribute('href')).toBe('/activity');
    expect(screen.getByRole('link', { name: 'Read the local setup guide' }).getAttribute('href')).toBe(
      'https://github.com/smynkr/routeshift-gateway-reference#readme',
    );
  });
});
