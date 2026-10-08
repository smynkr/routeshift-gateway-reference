// @vitest-environment jsdom

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { DeviceApprovalClient } from '@/components/device-approval-client';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

afterEach(cleanup);

describe('DeviceApprovalClient', () => {
  it('renders human-readable consent for every supported capability', () => {
    render(
      <DeviceApprovalClient
        initialUserCode="BCDF-GHJK"
        lookup={{
          found: true,
          clientName: 'RouteShift Connect',
          scopes: ['inference', 'read'],
          status: 'pending',
        }}
        signedInAs="dev@routeshift.io"
        teamName="RouteShift"
      />,
    );

    expect(screen.getByText('Send model requests through RouteShift on your behalf')).toBeTruthy();
    expect(screen.getByText("View your team's RouteShift usage and generation details")).toBeTruthy();
  });
});
