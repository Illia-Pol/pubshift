import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';

/**
 * The site is a static export (next.config.mjs), which has no server to decide
 * anything per request. Saying so explicitly is what lets Next write this out as
 * a file at build time instead of refusing to build.
 */
export const dynamic = 'force-static';

/**
 * Everything here is meant to be found — there is no private area, because there
 * are no accounts and no uploaded files to keep out of an index.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/' }],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
