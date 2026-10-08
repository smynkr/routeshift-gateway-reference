import type { Metadata } from 'next';
import NewRuleClient from './new-rule-client';

export const metadata: Metadata = { title: 'New Rule' };

export default function NewRulePage() {
  return <NewRuleClient />;
}
