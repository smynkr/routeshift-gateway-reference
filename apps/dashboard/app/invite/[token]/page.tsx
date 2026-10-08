import type { Metadata } from 'next';
import { AcceptInviteCard } from './accept-invite';

export const metadata: Metadata = {
  title: 'Accept Invitation',
  description: 'Accept your invitation to join a team on RouteShift.',
};

export default function AcceptInvitePage() {
  return <AcceptInviteCard />;
}
