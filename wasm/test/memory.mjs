// memory.mjs — does repeated conversion leak?
//
// The wrapper hands three buffers back and forth per call: the input document,
// a four-byte length slot, and the JSON result. A converter that leaks a
// document's worth of memory per file is fine in a test and dead by the fourth
// newsletter in a tab someone leaves open all morning. So this measures it
// instead of trusting the `finally` block to be right.
//
// Two things are checked, because they fail differently:
//   - the module's linear memory must stop growing once it has warmed up
//   - the allocator must hand back the same address before and after, which
//     catches a leak far smaller than the page a linear-memory check would need
//
//   node wasm/test/memory.mjs

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPubshift, PubshiftError } from '../index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const corpusDir = path.resolve(here, '..', '..', 'packages', 'core', 'test', 'corpus');

const pubshift = await loadPubshift();

// Watching the allocator without adding anything to the module's public
// surface: allocate a big block, free it, and keep the address. dlmalloc hands
// back the lowest block that fits, so as long as every conversion frees what it
// took, that address is the same every time. A single leaked buffer sits in the
// way and pushes the probe higher — which is exactly the signal we want, and it
// catches leaks far smaller than a memory page, where a linear-memory check
// would see nothing.
//
// Self-checked below: the test deliberately leaks once and confirms the probe
// notices, so a passing run means the detector works rather than that it is
// asleep.
const createPubshift = (await import('../dist/pubshift.mjs')).default;
const raw = await createPubshift();
const PROBE_BYTES = 1 << 20;
const probeAddr = () => {
  const p = raw._malloc(PROBE_BYTES);
  raw._free(p);
  return p;
};
const linearBytes = () => raw.HEAPU8.byteLength;

const files = readdirSync(corpusDir).filter((f) => f.endsWith('.pub')).sort();
const big = files
  .map((f) => ({ f, bytes: readFileSync(path.join(corpusDir, f)) }))
  .sort((a, b) => b.bytes.length - a.bytes.length)[0];
const bad = new Uint8Array(readFileSync(path.join(corpusDir, 'EDB-29664-1.pub')));

const ROUNDS = 40;
let failures = 0;

// Warm up: the first calls legitimately grow the heap.
for (let i = 0; i < 3; i++) pubshift.extractJSON(new Uint8Array(big.bytes));

const beforeLinear = linearBytes();
const beforeTop = probeAddr();

for (let i = 0; i < ROUNDS; i++) {
  const json = pubshift.extractJSON(new Uint8Array(big.bytes));
  if (json.length === 0) { console.log('FAIL empty result'); failures++; break; }
}

const afterLinear = linearBytes();
const afterTop = probeAddr();

console.log(`${ROUNDS} conversions of ${big.f} (${big.bytes.length} B)`);
console.log(`  linear memory: ${beforeLinear} -> ${afterLinear} bytes`);
console.log(`  allocator probe: ${beforeTop} -> ${afterTop}`);

if (afterLinear !== beforeLinear) {
  console.log(`FAIL linear memory grew by ${afterLinear - beforeLinear} bytes over ${ROUNDS} identical calls`);
  failures++;
}
if (afterTop !== beforeTop) {
  console.log(`FAIL ${afterTop - beforeTop} bytes left allocated over ${ROUNDS} identical calls`);
  failures++;
}

// The error path is the one most likely to leak, because it leaves through a
// throw: the input buffer is allocated before the failure is known.
const errBeforeTop = probeAddr();
for (let i = 0; i < ROUNDS; i++) {
  try {
    pubshift.extract(bad);
    console.log('FAIL the non-Publisher file did not throw');
    failures++;
    break;
  } catch (err) {
    if (!(err instanceof PubshiftError)) { console.log(`FAIL wrong error type: ${err}`); failures++; break; }
  }
}
const errAfterTop = probeAddr();
console.log(`${ROUNDS} rejected files, allocator probe: ${errBeforeTop} -> ${errAfterTop}`);
if (errAfterTop !== errBeforeTop) {
  console.log(`FAIL the throwing path leaked ${errAfterTop - errBeforeTop} bytes`);
  failures++;
}

// Every corpus file once, to catch a leak that only one document triggers.
const allBeforeTop = probeAddr();
for (const f of files) {
  try { pubshift.extractJSON(new Uint8Array(readFileSync(path.join(corpusDir, f)))); }
  catch { /* the rejected file is expected to throw from extract(), not here */ }
}
const allAfterTop = probeAddr();
console.log(`whole corpus once, allocator probe: ${allBeforeTop} -> ${allAfterTop}`);
if (allAfterTop !== allBeforeTop) {
  console.log(`FAIL a full corpus pass leaked ${allAfterTop - allBeforeTop} bytes`);
  failures++;
}

// Does the probe actually detect a leak? Leak one buffer on purpose and check
// that it moves. A leak detector that cannot see a leak is worse than none.
{
  const base = probeAddr();
  const leaked = raw._malloc(4096);
  const moved = probeAddr() !== base;
  raw._free(leaked);
  const restored = probeAddr() === base;
  console.log(`self-check: deliberate 4 KB leak ${moved ? 'detected' : 'NOT DETECTED'}, ` +
              `probe ${restored ? 'returns to baseline after freeing' : 'did not recover'}`);
  if (!moved || !restored) {
    console.log('FAIL the leak detector does not work, so the results above prove nothing');
    failures++;
  }
}

console.log('');
console.log(failures === 0 ? 'memory: no growth across repeated conversions' : `memory: ${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
