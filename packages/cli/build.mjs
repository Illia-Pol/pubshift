/**
 * Builds the shippable package.
 *
 * Two things happen here, and both exist for the same reason: the buyer is a church
 * or school administrator who was told to "install Node and run one command". They
 * will not install a compiler, they will not run `brew`, and on a locked-down school
 * machine they may not be able to reach npm at all after the first download.
 *
 *  1. `src/*.ts` and everything it imports — @pubshift/core, jszip, pdf-lib — are
 *     bundled into `dist/`. The published package therefore declares no runtime
 *     dependencies: one tarball, no transitive install, nothing to resolve.
 *
 *  2. The WebAssembly reader is *copied*, not bundled, into `vendor/wasm/`.
 *     `wasm/dist/pubshift.mjs` is Emscripten output that branches on the host
 *     environment at runtime and locates its own `.wasm` next to itself; bundlers
 *     lose that fight (apps/web/lib/convert.ts says so at length). Copying the pair
 *     side by side keeps Emscripten's own path logic intact and costs 480 KB.
 *
 * The native extractor in `bin/pubshift-extract` is deliberately NOT used: it needs
 * libmspub and icu4c from Homebrew, which is a Mac-with-developer-tools assumption.
 * The WASM build is the same C++ compiled to a file that runs anywhere Node runs —
 * and `node wasm/test/parity.mjs` is the standing proof the two agree byte for byte.
 */

import { build } from 'esbuild';
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');

const manifest = JSON.parse(await readFile(path.join(here, 'package.json'), 'utf8'));

await rm(path.join(here, 'dist'), { recursive: true, force: true });
await mkdir(path.join(here, 'dist'), { recursive: true });

await build({
  entryPoints: {
    cli: path.join(here, 'src', 'cli.ts'),
    worker: path.join(here, 'src', 'worker.ts'),
  },
  outdir: path.join(here, 'dist'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  // The floor in package.json#engines. Node 18 is what a 2023-era Windows machine
  // has after "install the LTS", and asking an administrator to upgrade Node before
  // they can rescue their archive is a support ticket we do not need.
  target: 'node18',
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  logLevel: 'info',
  define: {
    __PUBSHIFT_CLI_VERSION__: JSON.stringify(manifest.version),
  },
  banner: {
    // jszip and pdf-lib are published as CommonJS. Bundled into an ESM output they
    // still expect `require` to exist for their own internal lookups.
    js: [
      "import { createRequire as __pubshiftCreateRequire } from 'node:module';",
      'const require = __pubshiftCreateRequire(import.meta.url);',
    ].join('\n'),
  },
});

// --- the reader -------------------------------------------------------------

const vendor = path.join(here, 'vendor', 'wasm');
await rm(path.join(here, 'vendor'), { recursive: true, force: true });
await mkdir(path.join(vendor, 'dist'), { recursive: true });

await cp(path.join(repo, 'wasm', 'index.mjs'), path.join(vendor, 'index.mjs'));
await cp(path.join(repo, 'wasm', 'dist', 'pubshift.mjs'), path.join(vendor, 'dist', 'pubshift.mjs'));
await cp(path.join(repo, 'wasm', 'dist', 'pubshift.wasm'), path.join(vendor, 'dist', 'pubshift.wasm'));

// `files` in package.json ships `vendor/`, and npm would otherwise treat a directory
// with no package.json as just files — which is what we want. This marker only
// records where the copy came from, for anyone who finds it later and wonders.
await writeFile(
  path.join(vendor, 'PROVENANCE.txt'),
  [
    'Copied verbatim from wasm/ in the pubshift repository by packages/cli/build.mjs.',
    'Do not edit here; edit wasm/ and rebuild.',
    `Copied at build time from: ${path.relative(repo, path.join(repo, 'wasm'))}`,
    '',
  ].join('\n'),
  'utf8',
);

console.log('built dist/ and vendor/wasm/');
