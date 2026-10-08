import type { Metadata } from "next";
import { DM_Sans, JetBrains_Mono, Instrument_Serif } from "next/font/google";
import { AmplitudeProvider } from "@/components/amplitude-provider";
import { MixpanelProvider } from "@/components/mixpanel-provider";
import { PostHogProvider } from "@/components/posthog-provider";
import { GoogleAnalytics } from "@/components/google-analytics";
import { CookieNotice } from "@/components/cookie-notice";
import { PUBLIC_APP_BASE_URL, PUBLIC_REFERENCE_URL } from "@/lib/public-urls";
import "./globals.css";

const GA_MEASUREMENT_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;

const dmSans = DM_Sans({
  variable: "--font-dm-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const instrumentSerif = Instrument_Serif({
  subsets: ['latin'],
  weight: ['400'],
  style: ['normal', 'italic'],
  variable: '--font-heading',
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL(PUBLIC_APP_BASE_URL),
  title: {
    default: "RouteShift gateway reference — archived source",
    template: "%s | RouteShift reference",
  },
  description:
    "Unmaintained RouteShift gateway source for inspection and local self-hosting. No hosted service, support, or security-update commitment.",
  keywords: [
    "LLM proxy",
    "AI cost optimization",
    "LLM cost reduction",
    "OpenAI proxy",
    "Anthropic proxy",
    "LLM API gateway",
    "smart routing",
    "AI model routing",
    "reduce LLM costs",
    "LLM caching",
    "AI spend management",
  ],
  robots: {
    index: false,
    follow: false,
    googleBot: { index: false, follow: false },
  },
  openGraph: {
    title: "RouteShift gateway reference — archived source",
    description:
      "Historical gateway source for inspection and local self-hosting, without hosted-service or maintenance commitments.",
    siteName: "RouteShift",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "RouteShift gateway reference — archived source",
    description:
      "Unmaintained gateway reference source. Historical product screens are not offers of a hosted service.",
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "32x32" },
      { url: "/brand/routeshift-mark.svg", type: "image/svg+xml" },
    ],
    shortcut: "/favicon.ico",
    apple: "/brand/routeshift-mark.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`dark ${dmSans.variable} ${jetbrainsMono.variable} ${instrumentSerif.variable}`}>
      <head />
      <body
        className="overflow-x-hidden antialiased"
      >
        {GA_MEASUREMENT_ID ? <GoogleAnalytics measurementId={GA_MEASUREMENT_ID} /> : null}
        <PostHogProvider>
          <AmplitudeProvider>
            <MixpanelProvider>
              <aside className="border-b border-amber-500/30 px-4 py-2 text-center text-sm text-amber-200">
                Archived, unmaintained source. These historical screens are not a hosted-service offer.{' '}
                <a href={PUBLIC_REFERENCE_URL} className="underline underline-offset-4">Read the archive limits.</a>
              </aside>
              {children}
              <CookieNotice />
            </MixpanelProvider>
          </AmplitudeProvider>
        </PostHogProvider>
      </body>
    </html>
  );
}
