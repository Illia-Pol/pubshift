// encoding.mjs — does the ICU shim actually behave like ICU?
//
// The parity test proves the two builds agree on the corpus. That is the
// acceptance criterion, but it only exercises two of the shim's encodings
// (UTF-16LE and windows-1252), because those are the only ones the 31 corpus
// files ever ask for. This test covers the rest, against fixtures dumped from
// the same icu4c the native extractor links: every single byte of every
// single-byte encoding, the UTF-16LE edge cases, the CJK sequences, and all
// 8896 LCIDs ICU answers for.
//
// Text corruption is the worst failure this product can have — a church
// secretary will not notice that one curly quote became a euro sign until the
// newsletter is printed — so these tables are measured, never eyeballed.
//
//   node wasm/test/encoding.mjs
//
// Needs wasm/test/build/shim-probe.mjs (tools/build-shim-probe.sh).

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const probePath = path.join(here, 'build', 'shim-probe.mjs');

if (!existsSync(probePath)) {
  console.error('encoding: shim probe not built — run wasm/tools/build-shim-probe.sh');
  process.exit(2);
}

const createShimProbe = (await import(probePath)).default;
const m = await createShimProbe();

const converters = JSON.parse(
  readFileSync(path.join(here, 'fixtures', 'icu-converters.json'), 'utf8'),
);
const lcids = JSON.parse(
  readFileSync(path.join(here, 'fixtures', 'icu-lcid.json'), 'utf8'),
);

// --- small helpers over the probe module -----------------------------------

function withCString(s, fn) {
  const len = m.lengthBytesUTF8 ? m.lengthBytesUTF8(s) + 1 : s.length * 4 + 1;
  const ptr = m._malloc(len);
  try {
    m.stringToUTF8(s, ptr, len);
    return fn(ptr);
  } finally {
    m._free(ptr);
  }
}

function decode(enc, hex) {
  const bytes = hex.length ? Uint8Array.from(hex.match(/../g).map((h) => parseInt(h, 16)))
                           : new Uint8Array(0);
  const cap = Math.max(16, bytes.length * 2 + 8);
  let bufPtr = 0;
  let outPtr = 0;
  try {
    bufPtr = m._malloc(Math.max(1, bytes.length));
    m.HEAPU8.set(bytes, bufPtr);
    outPtr = m._malloc(cap * 4);
    return withCString(enc, (encPtr) => {
      const n = m._probe_decode(encPtr, bufPtr, bytes.length, outPtr, cap);
      if (n < 0) return null;
      const out = [];
      for (let i = 0; i < n; i++) out.push(m.HEAPU32[(outPtr >>> 2) + i]);
      return out;
    });
  } finally {
    if (outPtr) m._free(outPtr);
    if (bufPtr) m._free(bufPtr);
  }
}

function locale(lcid) {
  const bufs = [m._malloc(160), m._malloc(160), m._malloc(160)];
  try {
    const ok = m._probe_locale(lcid, bufs[0], bufs[1], bufs[2]);
    if (!ok) return null;
    return {
      language: m.UTF8ToString(bufs[0]),
      country: m.UTF8ToString(bufs[1]),
      script: m.UTF8ToString(bufs[2]),
    };
  } finally {
    bufs.forEach((p) => m._free(p));
  }
}

function localeId(lcid) {
  const p = m._malloc(200);
  try {
    const ok = m._probe_locale_id(lcid, p);
    return ok ? m.UTF8ToString(p) : null;
  } finally {
    m._free(p);
  }
}

// --- the checks -------------------------------------------------------------

const results = [];
function group(name, { total, failures, note, known = 0 }) {
  results.push({ name, total, failures, note, known });
  const bad = failures.length;
  const status = bad === 0 ? (known ? 'ok* ' : 'ok  ') : 'FAIL';
  console.log(`${status} ${name.padEnd(42)} ${total - bad - known}/${total}${note ? `  ${note}` : ''}`);
  for (const f of failures.slice(0, 8)) console.log(`       ${f}`);
  if (bad > 8) console.log(`       ... and ${bad - 8} more`);
}

// 1. Label resolution: the shim must accept what ICU accepts and reject what it
//    rejects, because libmspub skips the text entirely when ucnv_open fails.
{
  const failures = [];
  let total = 0;
  for (const [label, info] of Object.entries(converters.labels)) {
    total++;
    const got = decode(label, '41');
    const icuAccepts = info.status <= 0;   // ICU: <= 0 is success, warnings included
    const shimAccepts = got !== null;
    if (icuAccepts !== shimAccepts) {
      failures.push(`${label}: ICU ${icuAccepts ? 'accepts' : 'rejects'}, shim ${shimAccepts ? 'accepts' : 'rejects'}`);
    }
  }
  group('converter labels accepted/rejected', { total, failures });
}

// 2. Every decode case ICU was probed with, split by encoding so a regression
//    names the encoding rather than a number.
{
  const byEnc = new Map();
  for (const c of converters.cases) {
    if (!byEnc.has(c.enc)) byEnc.set(c.enc, []);
    byEnc.get(c.enc).push(c);
  }
  const delegated = new Set(['windows-932', 'windows-936', 'windows-950']);

  // Read this number with node in mind. node's TextDecoder is ICU-backed, so
  // the delegated CJK encodings agree with the native extractor here almost by
  // construction. A browser's TextDecoder implements WHATWG Encoding and does
  // not, which is why test/browser-check.html exists and why the README quotes
  // Chrome's numbers separately rather than these.
  //
  // Everything the shim decodes itself — the six single-byte tables and
  // UTF-16LE — is host-independent and exact under both, which is the part that
  // matters: those are the only encodings libmspub can actually reach in this
  // build (the detector never returns a CJK name, see icu_shim.cpp).
  //
  // Kept as a mechanism rather than deleted: if a divergence appears it should
  // be pinned to an exact count here, not waved through.
  const KNOWN_GAP = {};

  for (const [enc, cases] of byEnc) {
    const diffs = [];
    for (const c of cases) {
      const got = decode(enc, c.in);
      if (got === null) { diffs.push(`${c.case}: shim refused the label`); continue; }
      const same = got.length === c.out.length && got.every((v, i) => v === c.out[i]);
      if (!same) {
        const brief = c.in.length > 24 ? `${c.in.slice(0, 24)}... (${c.in.length / 2} bytes)` : c.in;
        diffs.push(`${c.case} in=${brief}: ${describeCodepointDiff(c.out, got)}`);
      }
    }

    const expected = KNOWN_GAP[enc] ?? 0;
    const failures = diffs.length === expected
      ? []
      : [`expected ${expected} known divergence(s) from ICU, saw ${diffs.length}`, ...diffs];

    let note = delegated.has(enc) ? '(delegated to the host TextDecoder)' : '';
    if (expected > 0) note += ` — ${expected} known divergence(s), see README`;
    group(`decode ${enc}`, { total: cases.length, failures, note, known: expected });
  }
}

/** Names the first place two code-point sequences part company. */
function describeCodepointDiff(icu, shim) {
  if (icu.length !== shim.length) {
    return `length icu=${icu.length} shim=${shim.length}`;
  }
  for (let i = 0; i < icu.length; i++) {
    if (icu[i] !== shim[i]) {
      return `at ${i}: icu=U+${icu[i].toString(16).toUpperCase()} shim=U+${shim[i].toString(16).toUpperCase()}`;
    }
  }
  return 'identical';
}

// 3. LCIDs. These land in the IR as fo:language / fo:country / fo:script, so
//    they have to be exact for every value ICU answers for.
{
  const failures = [];
  let total = 0;
  for (const [hex, want] of Object.entries(lcids.accepted)) {
    total++;
    const lcid = parseInt(hex, 16);
    const got = locale(lcid);
    if (!got) { failures.push(`${hex}: ICU answers ${want.locale}, shim does not`); continue; }
    if (got.language !== want.language || got.country !== want.country || got.script !== want.script) {
      failures.push(`${hex} (${want.locale}): icu=[${want.language},${want.country},${want.script}] shim=[${got.language},${got.country},${got.script}]`);
    }
    const id = localeId(lcid);
    if (id !== want.locale) failures.push(`${hex}: locale id icu="${want.locale}" shim="${id}"`);
  }
  group('LCID -> language/country/script', { total, failures });
}

// 4. LCIDs ICU rejects must be rejected here too: libmspub emits no language
//    property at all in that case, and inventing one would change the IR.
{
  const failures = [];
  for (const hex of lcids.rejectedSample) {
    const got = locale(parseInt(hex, 16));
    if (got) failures.push(`${hex}: ICU rejects it, shim returned ${JSON.stringify(got)}`);
  }
  group('LCIDs ICU rejects', {
    total: lcids.rejectedSample.length,
    failures,
    note: `(sample of ${lcids.rejectedTotal})`,
  });
}

// 5. The detector. It reports nothing on purpose — see the long note in
//    icu_shim.cpp — which sends libmspub down its own windows-1252 fallback.
//    Pinned here so the choice stays deliberate instead of drifting.
{
  const failures = [];
  const samples = [
    [], [0x41, 0x42, 0x43],
    [0xd0, 0xf3, 0xf1, 0xf1, 0xea, 0xe8, 0xe9],           // the corpus's Cyrillic case
    [0xff, 0xfe, 0x41, 0x00],
  ];
  for (const s of samples) {
    const bytes = Uint8Array.from(s);
    let p = 0;
    try {
      p = m._malloc(Math.max(1, bytes.length));
      m.HEAPU8.set(bytes, p);
      const found = m._probe_detect(p, bytes.length);
      if (found !== 0) failures.push(`detect([${s}]) returned ${found}, expected 0`);
    } finally {
      if (p) m._free(p);
    }
  }
  group('charset detector reports no match', {
    total: samples.length,
    failures,
    note: '(deliberate: drives libmspub\'s windows-1252 fallback)',
  });
}

const failed = results.filter((r) => r.failures.length > 0);
console.log('');
if (failed.length === 0) {
  const total = results.reduce((n, r) => n + r.total, 0);
  const known = results.reduce((n, r) => n + r.known, 0);
  console.log(
    known === 0
      ? `encoding: ${total} checks, all matching real ICU`
      : `encoding: ${total} checks against real ICU — ${total - known} identical, ` +
        `${known} known and pinned (windows-936 unassigned slots; unreachable in this build)`,
  );
} else {
  console.log(`encoding: ${failed.length} group(s) diverge from real ICU`);
}
process.exit(failed.length === 0 ? 0 : 1);
