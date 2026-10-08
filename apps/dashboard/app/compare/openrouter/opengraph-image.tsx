import { ImageResponse } from 'next/og';

export const alt = 'RouteShift vs OpenRouter — pricing and feature comparison.';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

// Per-route Open Graph image (Next.js file convention). Dependency-free:
// no external font fetches, no filesystem reads.
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
          background: 'linear-gradient(135deg, #09090b 0%, #09090b 55%, #07130f 100%)',
          padding: '80px 96px',
          fontFamily: 'sans-serif',
        }}
      >
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
        <div
          style={{
            display: 'flex',
            fontSize: 72,
            fontWeight: 700,
            letterSpacing: -2,
            color: '#ffffff',
            lineHeight: 1.05,
          }}
        >
          RouteShift vs OpenRouter
        </div>
        <div
          style={{
            display: 'flex',
            marginTop: 24,
            fontSize: 34,
            fontWeight: 400,
            color: '#a1a1aa',
            lineHeight: 1.3,
          }}
        >
          Policy routing &amp; measured savings vs model breadth.
        </div>
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
          routeshift.io/compare/openrouter
        </div>
      </div>
    ),
    { ...size },
  );
}
