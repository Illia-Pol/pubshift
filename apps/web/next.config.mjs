import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const emitDir = resolve(here, '../../packages/core/src/emit');
const emitStub = join(here, 'lib/emitters/unavailable.ts');

/**
 * `@emit/<format>` resolves to the real emitter when it is in the tree, and to a
 * stub that refuses politely when it is not. See `types/emit.d.ts`.
 */
const FORMATS = ['pptx', 'docx', 'pdf', 'svg'];

const emitterExists = Object.fromEntries(
  FORMATS.map((format) => [format, existsSync(join(emitDir, `${format}.ts`))]),
);

function emitterAliases() {
  const alias = {};
  for (const format of FORMATS) {
    alias[`@emit/${format}`] = emitterExists[format] ? join(emitDir, `${format}.ts`) : emitStub;
  }
  return alias;
}

const isDev = process.env.NODE_ENV === 'development';

/**
 * The one thing that forces a server.
 *
 * The converter is entirely client-side, so the site is a directory of static files
 * that a CDN serves for approximately nothing and that keeps working unattended long
 * after anyone is paying attention to it — which, given that demand for this tool ends
 * shortly after 1 October 2026, is the point (docs/POSITIONING.md).
 *
 * Stripe breaks that in exactly one place: a webhook has to be received somewhere, and
 * a secret key may not be in a browser. So the payment endpoints are named
 * `route.pay.ts`, and `pay.ts` is only added to `pageExtensions` when
 * PUBSHIFT_PAYMENTS=1. With payments off they are not routes at all — not compiled,
 * not reachable — and `output: 'export'` is free to produce a pure static site.
 *
 * Turning payments on costs the static export and nothing else; the free converter is
 * byte-for-byte the same either way. See docs/DEPLOY.md.
 */
const paymentsEnabled = process.env.PUBSHIFT_PAYMENTS === '1';

/**
 * The whole product is "your document never leaves this tab". `connect-src 'self'`
 * is that promise written somewhere the browser enforces it: if any dependency
 * ever tries to POST a file anywhere, the request fails instead of succeeding
 * quietly. `wasm-unsafe-eval` is what lets the Publisher reader instantiate;
 * `blob:` covers the worker and the page previews, both of which are built in
 * memory from the user's own file.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @pubshift/core ships TypeScript sources, not a build artifact.
  transpilePackages: ['@pubshift/core'],

  // Read by lib/available.ts. The picker can then tell the truth about what this
  // build produces without importing a megabyte of emitters to find out.
  env: {
    NEXT_PUBLIC_PUBSHIFT_EMITTERS: JSON.stringify(emitterExists),
  },

  ...(paymentsEnabled ? {} : { output: 'export' }),

  // Only `route.pay.ts` / `page.pay.tsx` are affected: with payments off the suffix is
  // not a recognised page extension, so those files are invisible to the router.
  pageExtensions: paymentsEnabled ? ['tsx', 'ts', 'pay.tsx', 'pay.ts'] : ['tsx', 'ts'],

  // There is no image optimiser on a CDN-hosted static export, and no photography here
  // to optimise.
  images: { unoptimized: true },

  // Emits `out/credits/index.html` rather than `out/credits.html`, which every static
  // host serves correctly without extension-guessing rules.
  trailingSlash: true,

  webpack: (config) => {
    config.resolve.alias = { ...config.resolve.alias, ...emitterAliases() };
    return config;
  },

  // There is no upload endpoint and no server-side conversion, so there is no
  // body limit to state: the bytes are read by the page that the user is looking at.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default nextConfig;
