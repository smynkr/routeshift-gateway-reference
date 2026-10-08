import type { Metadata } from 'next';
import { MarketingNav } from '@/components/marketing/marketing-nav';
import { MarketingFooter } from '@/components/marketing/marketing-footer';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description:
    'How RouteShift collects, uses, and shares data, including analytics and session-replay tooling, and how to opt out.',
};

export default function PrivacyPage() {
  return (
    <div className="dark min-h-screen bg-[#09090b] text-white">
      <MarketingNav />
      <main className="mx-auto w-full max-w-3xl px-4 py-16 sm:px-6 sm:py-20">
        <h1 className="text-3xl font-bold mb-6">Privacy Policy</h1>
        <p className="text-zinc-400 mb-4">Last updated: June 13, 2026</p>
        <div className="max-w-none text-zinc-300 space-y-4">
          <p>Your privacy is important to us. This policy explains how we handle your data.</p>

          <h2 className="text-xl font-semibold mt-8 text-white">1. Data Collection</h2>
          <p>We collect information you provide directly to us when you create an account, use our proxy services, or communicate with us.</p>

          <h2 className="text-xl font-semibold mt-8 text-white">2. Use of Data</h2>
          <p>We use the data we collect to provide, maintain, and improve our services, and to protect RouteShift and our users.</p>

          <h2 className="text-xl font-semibold mt-8 text-white">3. Analytics &amp; Cookies</h2>
          <p>
            On our public website we use third-party analytics and product-analytics tools to understand
            how visitors find and use RouteShift. These tools set cookies and similar identifiers in your
            browser. The providers we use are:
          </p>
          <ul className="list-disc pl-6 space-y-1">
            <li><strong>PostHog</strong> — product analytics and event tracking.</li>
            <li><strong>Mixpanel</strong> — product analytics, and session replay (see below).</li>
            <li><strong>Amplitude</strong> — product analytics, and session replay (see below).</li>
            <li><strong>Google Analytics</strong> — aggregate website traffic analytics.</li>
          </ul>
          <p>
            These providers may collect your IP address, device and browser information, pages viewed,
            referring URLs, and interaction events. We do not sell this data.
          </p>

          <h2 className="text-xl font-semibold mt-8 text-white">4. Session Replay</h2>
          <p>
            Mixpanel and Amplitude may record a replay of your interactions with our public website
            (clicks, navigation, and page content) to help us diagnose usability issues. Session replay
            is configured to <strong>mask all text and form inputs by default</strong>, and to block
            images and video, so the content you type is not captured. Replay only runs when analytics
            are enabled (see opt-out below).
          </p>

          <h2 className="text-xl font-semibold mt-8 text-white">5. Your Choices &amp; Opt-Out</h2>
          <p>
            When you first visit our website you are shown a cookie notice. Analytics run unless you
            choose <strong>Decline</strong> in that notice; declining stops these providers from
            initialising and immediately stops any in-progress session replay. Your choice is stored
            locally in your browser (key <code>routeshift-cookie-consent</code>); clearing your browser
            storage resets it. You can also block these tools using your browser&apos;s cookie controls
            or tracker-blocking extensions.
          </p>

          <h2 className="text-xl font-semibold mt-8 text-white">6. Data Retention</h2>
          <p>We retain your information as long as necessary to provide the services you have requested. Analytics data is retained according to each provider&apos;s default retention settings.</p>

          <h2 className="text-xl font-semibold mt-8 text-white">7. Contact</h2>
          <p>For privacy questions or data-access/deletion requests, contact us at the address listed on our website.</p>
        </div>
      </main>
      <MarketingFooter />
    </div>
  );
}
