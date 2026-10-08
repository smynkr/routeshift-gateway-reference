import { ImageResponse } from 'next/og';

export const alt = 'RouteShift — The LLM proxy that pays for itself.';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

// Root-level Open Graph image (Next.js file convention wires it into the root
// layout's metadata automatically). Dependency-free: no external font fetches,
// no filesystem reads — Satori's default sans rendering is sufficient.
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'flex-start',
          // Dark base fading into the brand's deep emerald-black (matches the
          // routeshift-mark.svg gradient stops).
          background: 'linear-gradient(135deg, #09090b 0%, #09090b 55%, #07130f 100%)',
          padding: '80px 96px',
          fontFamily: 'sans-serif',
        }}
      >
        {/* Brand mark tile */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 96,
            height: 96,
            borderRadius: 24,
            background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
            marginBottom: 48,
          }}
        >
          <span style={{ fontSize: 56, fontWeight: 700, color: '#ffffff', lineHeight: 1 }}>
            R
          </span>
        </div>

        {/* Wordmark */}
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            fontSize: 88,
            fontWeight: 700,
            letterSpacing: -2,
            color: '#ffffff',
            lineHeight: 1.05,
          }}
        >
          RouteShift
        </div>

        {/* Tagline */}
        <div
          style={{
            display: 'flex',
            marginTop: 24,
            fontSize: 36,
            fontWeight: 400,
            color: '#a1a1aa',
            lineHeight: 1.3,
          }}
        >
          The LLM proxy that pays for itself.
        </div>

        {/* Domain pill */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            marginTop: 56,
            paddingTop: 12,
            paddingBottom: 12,
            paddingLeft: 24,
            paddingRight: 24,
            borderRadius: 9999,
            border: '1px solid rgba(16, 185, 129, 0.35)',
            background: 'rgba(16, 185, 129, 0.08)',
            color: '#6ee7b7',
            fontSize: 24,
            fontWeight: 500,
          }}
        >
          routeshift.io
        </div>
      </div>
    ),
    { ...size },
  );
}
