import { MetadataRoute } from 'next';
import { PUBLIC_APP_BASE_URL } from '@/lib/public-urls';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/api/', '/_next/', '/favicon.ico'],
    },
    sitemap: new URL('/sitemap.xml', PUBLIC_APP_BASE_URL).toString(),
  };
}
