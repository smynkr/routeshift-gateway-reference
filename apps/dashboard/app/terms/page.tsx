import type { Metadata } from 'next';
import { MarketingNav } from '@/components/marketing/marketing-nav';
import { MarketingFooter } from '@/components/marketing/marketing-footer';

export const metadata: Metadata = {
  title: 'Terms of Service',
  description: 'The terms that govern your use of the RouteShift LLM routing gateway.',
};

export default function TermsPage() {
  return (
    <div className="dark min-h-screen bg-[#09090b] text-white">
      <MarketingNav />
      <main className="mx-auto w-full max-w-3xl px-4 py-16 sm:px-6 sm:py-20">
        <h1 className="text-3xl font-bold mb-6">Terms of Service</h1>
        <p className="text-zinc-400 mb-4">Last updated: May 5, 2026</p>
        <div className="max-w-none text-zinc-300 space-y-4">
          <p>By using RouteShift, you agree to these terms.</p>
          <h2 className="text-xl font-semibold mt-8 text-white">1. Service Description</h2>
          <p>RouteShift provides an LLM proxy service. We reserve the right to modify or discontinue the service at any time.</p>
          <h2 className="text-xl font-semibold mt-8 text-white">2. User Responsibilities</h2>
          <p>You are responsible for maintaining the security of your account and for all activities that occur under your account.</p>
          <h2 className="text-xl font-semibold mt-8 text-white">3. Limitation of Liability</h2>
          <p>RouteShift is provided "as is" without warranty of any kind.</p>
        </div>
      </main>
      <MarketingFooter />
    </div>
  );
}
