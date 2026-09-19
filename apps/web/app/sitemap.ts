import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';

/**
 * The site is a static export (next.config.mjs), which has no server to decide
 * anything per request. Saying so explicitly is what lets Next write this out as
 * a file at build time instead of refusing to build.
 */
export const dynamic = 'force-static';

/**
 * A short sitemap looks like a waste of a file until you remember what it is for:
 * telling a crawler this is the whole site, so the landing page is not treated as one
 * entry point among hundreds of thin ones.
 *
 * `/batch` is here because it answers a different search than the front page does —
 * "convert a folder of pub files", "bulk pub converter" — and because it was invisible
 * to crawlers and to people alike until it was listed.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();

  return [
    {
      url: `${SITE_URL}/`,
      lastModified,
      changeFrequency: 'weekly',
      priority: 1,
    },
    {
      url: `${SITE_URL}/batch`,
      lastModified,
      changeFrequency: 'monthly',
      priority: 0.8,
    },
    {
      url: `${SITE_URL}/privacy`,
      lastModified,
      changeFrequency: 'yearly',
      priority: 0.3,
    },
  ];
}
