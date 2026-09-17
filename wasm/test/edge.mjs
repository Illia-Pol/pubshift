// edge.mjs — parity on inputs the corpus cannot cover.
//
// The corpus is 31 real documents. Everything in it has bytes, a header, and a
// plausible structure. What a drop zone actually receives is anything: a
// zero-byte file, a half-finished download, a PDF someone renamed, a file that
// starts like an OLE container and then stops. Those go down different code
// paths in libmspub, and the failure message is the only thing the person will
// ever see, so the two builds have to agree there too.
//
// Same rule as parity.mjs: byte-identical, or it fails.
//
//   node wasm/test/edge.mjs

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPubshift } from '../index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const nativeBin = path.join(root, 'bin', 'pubshift-extract');
const corpusDir = path.join(root, 'packages', 'core', 'test', 'corpus');

if (!existsSync(nativeBin)) {
  console.error(`edge: native extractor not found at ${nativeBin}`);
  process.exit(2);
}

const real = readFileSync(path.join(corpusDir, 'tables.pub'));
const big = readFileSync(path.join(corpusDir, '923566.pub'));

// A deterministic pseudo-random filler, so a failure is reproducible.
function pseudoRandom(n, seed = 1) {
  const out = new Uint8Array(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out[i] = (x >>> 24) & 0xff;
  }
  return out;
}

const cases = [
  ['empty', new Uint8Array(0)],
  ['one zero byte', new Uint8Array(1)],
  ['plain text', new TextEncoder().encode('This is not a Publisher file, it is a note.')],
  ['truncated to 8 bytes', new Uint8Array(real.subarray(0, 8))],
  ['truncated to 100 bytes', new Uint8Array(real.subarray(0, 100))],
  ['truncated mid-document', new Uint8Array(big.subarray(0, 3000))],
  ['first half of a real file', new Uint8Array(big.subarray(0, big.length >> 1))],
  ['header only, then noise', (() => {
    const b = new Uint8Array(2048);
    b.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    b.set(pseudoRandom(2040, 7), 8);
    return b;
  })()],
  ['pure noise', pseudoRandom(8192, 42)],
  ['real file with a flipped header byte', (() => {
    const b = new Uint8Array(real); b[0] ^= 0xff; return b;
  })()],
  ['real file with a flipped byte in the body', (() => {
    const b = new Uint8Array(real); b[b.length >> 1] ^= 0xff; return b;
  })()],
  ['real file with its tail cut off', new Uint8Array(real.subarray(0, real.length - 512))],
  ['real file with 1 KB appended', (() => {
    const b = new Uint8Array(real.length + 1024);
    b.set(real); b.set(pseudoRandom(1024, 3), real.length);
    return b;
  })()],
];

const pubshift = await loadPubshift();
const dir = mkdtempSync(path.join(tmpdir(), 'pubshift-edge-'));

let identical = 0;
const failures = [];

try {
  for (const [name, bytes] of cases) {
    const file = path.join(dir, 'case.pub');
    writeFileSync(file, bytes);

    let nativeText;
    try {
      nativeText = execFileSync(nativeBin, [file], { encoding: 'utf8', maxBuffer: 1 << 28 });
    } catch (err) {
      if (typeof err.stdout === 'string') nativeText = err.stdout;
      else throw err;
    }

    let wasmText;
    try {
      wasmText = pubshift.extractJSON(bytes);
    } catch (err) {
      wasmText = `<<threw: ${err}>>`;
    }

    if (nativeText === wasmText) {
      identical++;
      const verdict = JSON.parse(nativeText).ok ? 'parsed' : JSON.parse(nativeText).error.code;
      console.log(`  ok   ${name.padEnd(38)} both say ${verdict}`);
    } else {
      failures.push({ name, nativeText, wasmText });
      console.log(`  DIFF ${name}`);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('');
console.log(`edge cases: ${identical}/${cases.length} byte-identical to the native extractor`);
for (const f of failures) {
  console.log('');
  console.log(`--- ${f.name}`);
  console.log(`  native: ${f.nativeText.slice(0, 300)}`);
  console.log(`  wasm:   ${f.wasmText.slice(0, 300)}`);
}
process.exit(failures.length === 0 ? 0 : 1);
