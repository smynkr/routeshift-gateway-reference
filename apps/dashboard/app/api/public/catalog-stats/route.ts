import { NextResponse } from 'next/server';
import { fetchLandingCatalogStats } from '@/lib/landing-catalog';
import { PROXY_URL } from '@/lib/proxy';

const CACHE_CONTROL = 'public, s-maxage=3600';

export async function GET() {
  const stats = await fetchLandingCatalogStats(PROXY_URL);
  if (!stats) {
    console.warn('Public catalog stats unavailable from runtime proxy');
    return NextResponse.json(
      { error: 'catalog_unavailable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return NextResponse.json(stats, { headers: { 'Cache-Control': CACHE_CONTROL } });
}
