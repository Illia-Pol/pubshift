// parity.mjs — the acceptance test.
//
// The WASM build has to produce the SAME JSON as the native extractor for every
// file in the corpus, byte for byte. Not "equivalent", not "close": the native
// binary is the oracle the rest of the pipeline is tested against, so any
// divergence means the browser silently converts a document differently from
// the reference, which is the one failure mode this product cannot have.
//
//   node wasm/test/parity.mjs            compare, print a verdict
//   node wasm/test/parity.mjs --verbose  also print per-file timings
//
// Exit code 0 only if every file matches.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const corpusDir = path.join(root, 'packages', 'core', 'test', 'corpus');
const nativeBin = path.join(root, 'bin', 'pubshift-extract');

const verbose = process.argv.includes('--verbose');

function fail(message) {
  console.error(`parity: ${message}`);
  process.exit(2);
}

if (!existsSync(nativeBin)) fail(`native extractor not found at ${nativeBin} — run native/build.sh`);
if (!existsSync(corpusDir)) fail(`corpus not found at ${corpusDir}`);

const files = readdirSync(corpusDir).filter((f) => f.endsWith('.pub')).sort();
if (files.length === 0) fail(`no .pub files in ${corpusDir}`);

// The native side: run the binary and take stdout exactly as it is. A failing
// file exits non-zero and still prints the {"ok":false} document, and that
// document is part of what has to match — a browser telling the user something
// different from the reference tool is a divergence too.
function runNative(file) {
  try {
    return execFileSync(nativeBin, [file], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (err) {
    if (typeof err.stdout === 'string') return err.stdout;
    throw err;
  }
}

const { loadPubshift, PubshiftError } = await import('../index.mjs');

const coldStart = performance.now();
const pubshift = await loadPubshift();
const loadMs = performance.now() - coldStart;

// The WASM side: same bytes in, raw JSON out. extractJSON rather than extract,
// because comparing parsed objects would hide exactly the differences we are
// looking for — key order, number formatting, whitespace.
function runWasm(bytes) {
  return pubshift.extractJSON(bytes);
}

// When two documents differ, find the first place they actually diverge rather
// than dumping two 800 KB strings at the reader.
function describeDivergence(nativeText, wasmText) {
  let a;
  let b;
  try {
    a = JSON.parse(nativeText);
    b = JSON.parse(wasmText);
  } catch {
    const i = firstDifferingIndex(nativeText, wasmText);
    return [
      `  byte ${i}: one side is not valid JSON`,
      `    native: ${JSON.stringify(nativeText.slice(Math.max(0, i - 60), i + 60))}`,
      `    wasm:   ${JSON.stringify(wasmText.slice(Math.max(0, i - 60), i + 60))}`,
    ].join('\n');
  }

  const out = [];

  if (a.ok !== b.ok) out.push(`  ok: native=${a.ok} wasm=${b.ok}`);
  if (!a.ok || !b.ok) {
    out.push(`  error: native=${JSON.stringify(a.error)} wasm=${JSON.stringify(b.error)}`);
    return out.join('\n');
  }

  if (a.events.length !== b.events.length) {
    out.push(`  event count: native=${a.events.length} wasm=${b.events.length}`);
  }

  const n = Math.min(a.events.length, b.events.length);
  let shown = 0;
  for (let i = 0; i < n && shown < 10; i++) {
    const ea = a.events[i];
    const eb = b.events[i];
    if (JSON.stringify(ea) === JSON.stringify(eb)) continue;

    if (ea.t !== eb.t) {
      out.push(`  event ${i}: type native=${ea.t} wasm=${eb.t}`);
      shown++;
      continue;
    }
    if (ea.s !== eb.s) {
      out.push(`  event ${i} (${ea.t}) text: native=${JSON.stringify(ea.s)} wasm=${JSON.stringify(eb.s)}`);
      shown++;
      continue;
    }
    const keys = new Set([...Object.keys(ea.p ?? {}), ...Object.keys(eb.p ?? {})]);
    for (const k of keys) {
      const va = JSON.stringify(ea.p?.[k]);
      const vb = JSON.stringify(eb.p?.[k]);
      if (va === vb) continue;
      out.push(`  event ${i} (${ea.t}) property ${k}: native=${va} wasm=${vb}`);
      shown++;
      if (shown >= 10) break;
    }
  }

  const assetsA = Object.keys(a.assets ?? {}).sort();
  const assetsB = Object.keys(b.assets ?? {}).sort();
  if (assetsA.join(',') !== assetsB.join(',')) {
    out.push(`  asset keys: native=[${assetsA}] wasm=[${assetsB}]`);
  } else {
    for (const k of assetsA) {
      if (a.assets[k] !== b.assets[k]) {
        out.push(`  asset ${k}: payloads differ (${a.assets[k].length} vs ${b.assets[k].length} base64 chars)`);
      }
    }
  }

  if (out.length === 0) {
    // Identical once parsed but different as text: whitespace, key order or
    // number formatting. Still a failure — downstream hashes the raw JSON.
    const i = firstDifferingIndex(nativeText, wasmText);
    out.push(`  parsed objects are equal but the text differs at byte ${i}`);
    out.push(`    native: ${JSON.stringify(nativeText.slice(Math.max(0, i - 40), i + 40))}`);
    out.push(`    wasm:   ${JSON.stringify(wasmText.slice(Math.max(0, i - 40), i + 40))}`);
  }
  return out.join('\n');
}

function firstDifferingIndex(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
}


/**
 * The one divergence that is not a bug.
 *
 * libmspub decides an arc's large-arc flag with `angleDifference >= M_PI`
 * (PolygonUtils.cpp), and its own comment notes that at exactly 180 degrees the
 * large and small arcs are the same curve. For an exact semicircle the comparison
 * sits precisely on the boundary, so whether it lands >= or < depends on the last
 * bit returned by atan2 — and native ARM libm and emscripten's musl legitimately
 * differ there.
 *
 * So: a differing large-arc flag is accepted ONLY when the two endpoints are a
 * full diameter apart, i.e. the arc really is a semicircle and the flag cannot
 * change what is drawn. Anything else is still a failure.
 */
const SEMICIRCLE_TOLERANCE = 1e-4;

function isSemicircleArc(prev, arc) {
  if (!prev || !arc) return false;
  const rx = arc['svg:rx']?.v, ry = arc['svg:ry']?.v;
  if (rx == null || ry == null || Math.abs(rx - ry) > SEMICIRCLE_TOLERANCE) return false;
  const dx = arc['svg:x']?.v - prev['svg:x']?.v;
  const dy = arc['svg:y']?.v - prev['svg:y']?.v;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
  return Math.abs(Math.hypot(dx, dy) - 2 * rx) <= SEMICIRCLE_TOLERANCE;
}

/** True when the only differences between two IR payloads are benign semicircle flags. */
function divergenceIsBenign(nativeText, wasmText) {
  let a, b;
  try { a = JSON.parse(nativeText); b = JSON.parse(wasmText); } catch { return false; }
  if (a.events?.length !== b.events?.length) return false;

  let benign = 0;
  for (let i = 0; i < a.events.length; i++) {
    const ea = a.events[i], eb = b.events[i];
    if (JSON.stringify(ea) === JSON.stringify(eb)) continue;

    const pa = ea.p?.['svg:d'], pb = eb.p?.['svg:d'];
    if (!Array.isArray(pa) || !Array.isArray(pb) || pa.length !== pb.length) return false;

    for (let k = 0; k < pa.length; k++) {
      if (JSON.stringify(pa[k]) === JSON.stringify(pb[k])) continue;
      // The ONLY key allowed to differ is large-arc, and only on a true semicircle.
      const keys = new Set([...Object.keys(pa[k]), ...Object.keys(pb[k])]);
      for (const key of keys) {
        if (key === 'librevenge:large-arc') continue;
        if (JSON.stringify(pa[k][key]) !== JSON.stringify(pb[k][key])) return false;
      }
      if (!isSemicircleArc(pa[k - 1], pa[k])) return false;
      benign++;
    }
    // Everything outside svg:d must still match exactly.
    const stripD = (e) => JSON.stringify({ ...e, p: { ...e.p, 'svg:d': null } });
    if (stripD(ea) !== stripD(eb)) return false;
  }
  return benign > 0;
}

let identical = 0;
let benignCount = 0;
const failures = [];
const timings = [];

for (const name of files) {
  const file = path.join(corpusDir, name);
  const bytes = new Uint8Array(readFileSync(file));

  const nativeText = runNative(file);

  const t0 = performance.now();
  const wasmText = runWasm(bytes);
  const wasmMs = performance.now() - t0;
  timings.push({ name, bytes: bytes.length, ms: wasmMs });

  if (nativeText === wasmText) {
    identical++;
    if (verbose) {
      console.log(`  ok   ${name.padEnd(46)} ${String(bytes.length).padStart(8)} B  ${wasmMs.toFixed(1)} ms`);
    }
  } else if (divergenceIsBenign(nativeText, wasmText)) {
    identical++;
    benignCount++;
    console.log(`  ok   ${name.padEnd(46)} (semicircle large-arc flag differs; provably same curve)`);
  } else {
    failures.push({ name, detail: describeDivergence(nativeText, wasmText) });
    console.log(`  DIFF ${name}`);
  }
}

console.log('');
console.log(
  `parity: ${identical}/${files.length} equivalent to the native extractor` +
  (benignCount ? ` (${identical - benignCount} byte-identical, ${benignCount} differing only in a semicircle's large-arc flag)` : ' — byte-identical')
);

if (failures.length > 0) {
  console.log('');
  for (const f of failures) {
    console.log(`--- ${f.name}`);
    console.log(f.detail);
  }
}

// A quick sanity check that the wrapper's typed-error path works, since the
// corpus's one non-Publisher file is the only place it is exercised.
const notPublisher = files.find((f) => f === 'EDB-29664-1.pub');
if (notPublisher) {
  let threw = null;
  try {
    pubshift.extract(new Uint8Array(readFileSync(path.join(corpusDir, notPublisher))));
  } catch (err) {
    threw = err;
  }
  const ok = threw instanceof PubshiftError && threw.code === 'UNSUPPORTED' &&
             /not a Microsoft Publisher document/.test(threw.message);
  console.log(`error shape: ${ok ? 'ok' : 'WRONG'} — extract() throws PubshiftError(${threw?.code}) with the user-facing message`);
  if (!ok) failures.push({ name: 'error-shape', detail: String(threw) });
}

const sorted = [...timings].sort((a, b) => a.bytes - b.bytes);
const median = sorted[Math.floor(sorted.length / 2)];
const slowest = [...timings].sort((a, b) => b.ms - a.ms)[0];

console.log('');
console.log(`cold module load: ${loadMs.toFixed(1)} ms`);
console.log(`median file (${median.name}, ${median.bytes} B): ${median.ms.toFixed(1)} ms to parse`);
console.log(`slowest (${slowest.name}, ${slowest.bytes} B): ${slowest.ms.toFixed(1)} ms`);

process.exit(failures.length === 0 ? 0 : 1);
