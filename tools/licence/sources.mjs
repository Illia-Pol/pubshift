#!/usr/bin/env node
/**
 * The MPL-2.0 source obligation, made operational.
 *
 * Shipping pubshift.wasm to a browser is distribution of libmspub and librevenge in
 * Executable Form. MPL-2.0 section 3.2(a) then requires two things, and both are easy
 * to get wrong by writing a sentence instead of shipping a file:
 *
 *   1. the corresponding Source Code Form must *be available*, and
 *   2. recipients of the binary must be *told how to get it*.
 *
 * (2) is the /credits page and public/licences/. (1) is this script.
 *
 *   node tools/licence/sources.mjs fetch     download the pinned sources into third_party/
 *   node tools/licence/sources.mjs verify    check third_party/ still matches the pin
 *   node tools/licence/sources.mjs offer     build the corresponding-source tarball to publish
 *   node tools/licence/sources.mjs notices   regenerate THIRD-PARTY-NOTICES.md from the pin
 *
 * `fetch` needs network and git; `verify`, `offer` and `notices` do not (beyond what
 * fetch already put on disk). Nothing here talks to any service but the pinned upstreams.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PIN_PATH = path.join(ROOT, 'wasm', 'third-party.json');
const THIRD_PARTY = path.join(ROOT, 'third_party');

const pin = JSON.parse(readFileSync(PIN_PATH, 'utf8'));

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${res.status}`);
  return res;
}

function capture(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (res.status !== 0) return null;
  return res.stdout.trim();
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Components whose source we are actually obliged to hand over. */
function sourceOfferComponents() {
  return pin.components.filter((c) => c.obligation === 'source-offer');
}

/* ------------------------------------------------------------------ fetch -- */

function fetchGit(c) {
  const dest = path.join(THIRD_PARTY, c.id);
  if (!existsSync(dest)) {
    console.log(`  cloning ${c.source.url}`);
    run('git', ['clone', '--quiet', c.source.url, dest]);
  }
  // Fetch by commit rather than by tag: a tag can be moved, a commit cannot.
  run('git', ['-C', dest, 'fetch', '--quiet', 'origin', c.source.commit], { stdio: 'ignore' });
  run('git', ['-C', dest, 'checkout', '--quiet', c.source.commit]);
}

async function fetchTarball(c) {
  const dest = path.join(THIRD_PARTY, c.id);
  const archive = path.join(THIRD_PARTY, c.source.filename);

  if (!existsSync(archive)) {
    console.log(`  downloading ${c.source.filename}`);
    const res = await fetch(c.source.url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`download failed: ${res.status} ${c.source.url}`);
    writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  }

  const got = sha256(archive);
  if (got !== c.source.sha256) {
    // Refuse to unpack. A digest mismatch means the thing we would publish as
    // "the source for our binary" is not the thing we compiled.
    rmSync(archive, { force: true });
    throw new Error(
      `${c.id}: sha256 mismatch\n  expected ${c.source.sha256}\n  got      ${got}\n` +
        `The download was deleted. Either upstream re-rolled the tarball or it is not genuine; ` +
        `resolve that before shipping a binary built from it.`,
    );
  }

  if (!existsSync(dest)) {
    mkdirSync(dest, { recursive: true });
    run('tar', ['-xJf', archive, '-C', dest, '--strip-components=1']);
  }
}

async function cmdFetch() {
  mkdirSync(THIRD_PARTY, { recursive: true });
  for (const c of sourceOfferComponents()) {
    console.log(`${c.id} ${c.version}`);
    if (c.source.type === 'git') fetchGit(c);
    else if (c.source.type === 'tarball') await fetchTarball(c);
    else throw new Error(`${c.id}: don't know how to fetch source type ${c.source.type}`);
  }
  console.log('\nthird_party/ now holds the exact source the WASM build compiles.');
  console.log('wasm/build.sh picks it up automatically (it looks in $ROOT/third_party first).');
}

/* ----------------------------------------------------------------- verify -- */

function cmdVerify() {
  let bad = 0;
  for (const c of sourceOfferComponents()) {
    const dir = path.join(THIRD_PARTY, c.id);
    if (!existsSync(dir)) {
      console.error(`MISSING  ${c.id} — run: node tools/licence/sources.mjs fetch`);
      bad++;
      continue;
    }
    if (c.source.type === 'git') {
      const head = capture('git', ['-C', dir, 'rev-parse', 'HEAD']);
      if (head !== c.source.commit) {
        console.error(`DRIFT    ${c.id} — HEAD ${head ?? '(not a git checkout)'} != pinned ${c.source.commit}`);
        bad++;
        continue;
      }
      const dirty = capture('git', ['-C', dir, 'status', '--porcelain']);
      if (dirty) {
        // A locally-patched upstream is fine, but then it is a Modification under
        // MPL-2.0 and the patch has to be published with the source, not lost.
        console.error(`DIRTY    ${c.id} — local edits are not recorded in the pin:\n${dirty}`);
        bad++;
        continue;
      }
    } else if (c.source.type === 'tarball') {
      const archive = path.join(THIRD_PARTY, c.source.filename);
      if (!existsSync(archive)) {
        console.error(`MISSING  ${c.id} — ${c.source.filename} is gone; cannot prove what was unpacked`);
        bad++;
        continue;
      }
      const got = sha256(archive);
      if (got !== c.source.sha256) {
        console.error(`DRIFT    ${c.id} — sha256 ${got} != pinned ${c.source.sha256}`);
        bad++;
        continue;
      }
    }
    console.log(`ok       ${c.id} ${c.version}`);
  }

  if (bad > 0) {
    console.error(`\n${bad} component(s) do not match wasm/third-party.json.`);
    console.error('Do not publish a binary until this is clean: the source offer would be false.');
    process.exit(1);
  }
  console.log('\nAll source-offer components match the pin.');
}

/* ------------------------------------------------------------------ offer -- */

/**
 * Everything a recipient needs to rebuild the exact pubshift.wasm they were served:
 * upstream source, our build inputs, and the build script itself.
 */
const OUR_BUILD_INPUTS = [
  'wasm/api.cpp',
  'wasm/build.sh',
  'wasm/icu_shim.cpp',
  'wasm/icu_shim.h',
  'wasm/icu_shim_data.inc',
  'wasm/textdecoder.js',
  'wasm/index.mjs',
  'wasm/index.d.ts',
  'wasm/third-party.json',
  'wasm/config',
  'wasm/include',
  'wasm/tools',
  'LICENSE',
  'THIRD-PARTY-NOTICES.md',
];

function cmdOffer() {
  cmdVerify();

  const outDir = path.join(ROOT, 'dist-source');
  const stamp = new Date().toISOString().slice(0, 10);
  const stage = path.join(outDir, `pubshift-corresponding-source-${stamp}`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  for (const c of sourceOfferComponents()) {
    const from = path.join(THIRD_PARTY, c.id);
    const to = path.join(stage, 'third_party', c.id);
    mkdirSync(path.dirname(to), { recursive: true });
    // Copy the working tree, not the VCS metadata: a .git directory would make the
    // tarball enormous and is not what "Source Code Form" means.
    run('rsync', ['-a', '--exclude', '.git', `${from}/`, `${to}/`]);
  }

  for (const rel of OUR_BUILD_INPUTS) {
    const from = path.join(ROOT, rel);
    if (!existsSync(from)) continue;
    const to = path.join(stage, rel);
    mkdirSync(path.dirname(to), { recursive: true });
    run('rsync', ['-a', from + (statSync(from).isDirectory() ? '/' : ''), to + (statSync(from).isDirectory() ? '/' : '')]);
  }

  writeFileSync(
    path.join(stage, 'README.txt'),
    [
      'Corresponding Source for pubshift.wasm',
      '======================================',
      '',
      'This archive is published to satisfy Mozilla Public License 2.0 section 3.2(a)',
      'for the compiled libraries inside pubshift.wasm.',
      '',
      'It contains:',
      '  third_party/libmspub    MPL-2.0, unmodified, at the pinned commit',
      '  third_party/librevenge  MPL-2.0 (also available under LGPL-2.1+), unmodified',
      '  wasm/                   our build inputs: the build script, the config headers',
      '                          that replace the autotools-generated ones, the ICU shim',
      '                          that replaces ICU, and the extractor entry point',
      '',
      'Exact provenance, including commit hashes and digests, is in wasm/third-party.json.',
      'Build with wasm/build.sh and an emscripten matching the version recorded in',
      'SOURCES.txt next to the binary you were served.',
      '',
      'libmspub and librevenge are works of the Document Liberation Project. Pubshift did',
      'not write them and claims no credit for them.',
      '',
    ].join('\n'),
  );

  const tarball = `${stage}.tar.gz`;
  rmSync(tarball, { force: true });
  run('tar', ['-czf', tarball, '-C', outDir, path.basename(stage)]);
  rmSync(stage, { recursive: true, force: true });

  const digest = sha256(tarball);
  writeFileSync(`${tarball}.sha256`, `${digest}  ${path.basename(tarball)}\n`);

  console.log(`\nwrote ${tarball}`);
  console.log(`sha256 ${digest}`);
  console.log('\nPublish this next to the site and point the /credits page at it.');
  console.log('Section 3.2(a) allows charging no more than the cost of distribution — so, nothing.');
}

/* ---------------------------------------------------------------- notices -- */

function cmdNotices() {
  const lines = [];
  const p = (s = '') => lines.push(s);

  p('# Third-party notices');
  p();
  p('<!-- GENERATED by tools/licence/sources.mjs notices — edit wasm/third-party.json instead. -->');
  p();
  p('Pubshift itself is MPL-2.0 (see `LICENSE`). It ships a WebAssembly module,');
  p('`pubshift.wasm`, that contains compiled third-party code. Serving that file to a');
  p('browser is distribution in Executable Form, so the notices below travel with it.');
  p();
  p('The exact provenance of every component — commit hashes, digests, upstream URLs —');
  p('is in [`wasm/third-party.json`](wasm/third-party.json), which is the single source of');
  p('truth and is checked by `node tools/licence/sources.mjs verify`.');
  p();

  for (const c of pin.components) {
    p(`## ${c.name}${c.version.startsWith('recorded') || c.version.startsWith('see') ? '' : ` ${c.version}`}`);
    p();
    p(`- **Licence:** ${c.licence}${c.licenceTaken ? ` — taken here under ${c.licenceTaken}` : ''}`);
    if (c.project) p(`- **Project:** ${c.project}`);
    p(`- **Home:** ${c.homepage}`);
    p(`- **Why it is here:** ${c.role}`);
    if (c.source?.url) p(`- **Source:** ${c.source.url}`);
    if (c.source?.commit) p(`- **Commit:** \`${c.source.commit}\``);
    if (c.source?.sha256) p(`- **sha256:** \`${c.source.sha256}\``);
    p(`- **Modified by us:** ${c.modified ? 'yes' : 'no'}`);
    if (c.modificationNote) p(`  - ${c.modificationNote}`);
    if (c.obligationNote) p(`- **Obligation:** ${c.obligationNote}`);
    p();
  }

  p('## The source offer');
  p();
  p('MPL-2.0 section 3.2(a) requires that the Source Code Form of the MPL-covered code in');
  p('`pubshift.wasm` be available to anyone who receives the binary, at no more than the');
  p('cost of distribution. Pubshift meets this by publishing the complete corresponding');
  p('source — upstream libraries at the pinned revisions, plus every build input of ours —');
  p('as a downloadable archive, and by linking it from the site itself.');
  p();
  p('Build the archive with:');
  p();
  p('```bash');
  p('node tools/licence/sources.mjs fetch    # pinned upstream source into third_party/');
  p('node tools/licence/sources.mjs offer    # -> dist-source/pubshift-corresponding-source-<date>.tar.gz');
  p('```');
  p();
  p('Upload it next to the site and set `NEXT_PUBLIC_SOURCE_OFFER_URL` so the credits page');
  p('links the copy that matches the binary being served.');
  p();

  const out = path.join(ROOT, 'THIRD-PARTY-NOTICES.md');
  writeFileSync(out, lines.join('\n'));
  console.log(`wrote ${out}`);
}

/* -------------------------------------------------------------------- cli -- */

const cmd = process.argv[2];
const table = { fetch: cmdFetch, verify: cmdVerify, offer: cmdOffer, notices: cmdNotices };

if (!cmd || !table[cmd]) {
  console.error('usage: node tools/licence/sources.mjs <fetch|verify|offer|notices>');
  process.exit(2);
}

try {
  await table[cmd]();
} catch (err) {
  console.error(`\n${err.message}`);
  process.exit(1);
}
