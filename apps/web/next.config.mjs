/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @pubshift/core ships TypeScript sources, not a build artifact.
  transpilePackages: ['@pubshift/core'],
  // Route handlers are not body-capped by Next; the 50MB limit is enforced in
  // app/api/convert/route.ts, and any proxy in front of this must allow at least that.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default nextConfig;
