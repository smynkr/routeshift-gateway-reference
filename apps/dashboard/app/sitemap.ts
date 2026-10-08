import { MetadataRoute } from 'next';
import { PUBLIC_APP_BASE_URL } from '@/lib/public-urls';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: new URL('/', PUBLIC_APP_BASE_URL).toString(),
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 1,
    },
    {
      url: new URL('/rankings', PUBLIC_APP_BASE_URL).toString(),
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    {
      url: new URL('/models', PUBLIC_APP_BASE_URL).toString(),
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    {
      url: new URL('/compare', PUBLIC_APP_BASE_URL).toString(),
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.7,
    },
    {
      url: new URL('/compare/openrouter', PUBLIC_APP_BASE_URL).toString(),
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.7,
    },
    {
      url: new URL('/compare/vercel-ai-gateway', PUBLIC_APP_BASE_URL).toString(),
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.7,
    },
    {
      url: new URL('/compare/helicone', PUBLIC_APP_BASE_URL).toString(),
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.7,
    },
    {
      url: new URL('/compare/portkey', PUBLIC_APP_BASE_URL).toString(),
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.7,
    },
    {
      url: new URL('/changelog', PUBLIC_APP_BASE_URL).toString(),
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.5,
    },
    {
      url: new URL('/security', PUBLIC_APP_BASE_URL).toString(),
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.6,
    },
    {
      url: new URL('/privacy', PUBLIC_APP_BASE_URL).toString(),
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.3,
    },
    {
      url: new URL('/terms', PUBLIC_APP_BASE_URL).toString(),
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.3,
    },
  ];
}
