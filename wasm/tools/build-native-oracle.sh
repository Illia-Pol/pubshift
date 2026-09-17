#!/usr/bin/env bash
#
# Builds a native extractor that a WASM build can actually be compared against,
# and reports whether the two agree on the whole corpus.
#
# Why this is not just native/build.sh
# ------------------------------------
# `bin/pubshift-extract` links Homebrew's prebuilt libmspub, which was compiled
# with clang's default -ffp-contract=on. On arm64 that fuses `a + b*c` into a
# single FMA, so an intermediate lands one ULP away from where two separate
# roundings would put it. WebAssembly has no scalar FMA instruction at any
# optimisation level, so a WASM build cannot reproduce that, and one corpus file
# (fdo68259-5.pub) ends up with a different `librevenge:large-arc` flag on an
# exact semicircle, where libmspub decides with `angleDifference >= M_PI`.
#
# This script compiles libmspub and librevenge from source with
# -ffp-contract=off — everything else identical, real ICU and all — and diffs the
# result against the WASM build. That isolates the cause: with contraction off,
# all 31 files are byte-identical.
#
# It is a measurement tool, not a replacement extractor. Fixing this properly
# means native/build.sh producing a float-deterministic binary, which is worth
# doing on its own merits: an oracle whose output depends on whether the host CPU
# has an FMA unit will disagree with itself across machines.
#
# Usage:  ./build-native-oracle.sh [--compare]
#   (no args)   build it, print the path
#   --compare   also run both builds over the corpus and report the difference

set -euo pipefail
cd "$(dirname "$0")/.."
WASM_DIR="$(pwd)"
ROOT="$(cd .. && pwd)"
OUT="${PUBSHIFT_ORACLE_OUT:-${TMPDIR:-/tmp}/pubshift-oracle}"
mkdir -p "$OUT"

SRC="${PUBSHIFT_SRC:-}"
if [ -z "$SRC" ]; then
  for cand in "$ROOT/third_party" \
    /private/tmp/claude-501/-Users-illia-pol/cdcaf96d-92b0-40f9-b037-9f16e3768b9b/scratchpad/src; do
    [ -d "$cand/libmspub" ] && [ -d "$cand/librevenge" ] && SRC="$cand" && break
  done
fi
[ -n "$SRC" ] || { echo "error: set PUBSHIFT_SRC to the dir holding libmspub/ and librevenge/" >&2; exit 1; }

MSPUB="$SRC/libmspub"
REV="$SRC/librevenge"

# boost is header-only for these two libraries. Reuse whatever emscripten
# already downloaded rather than asking for a second copy.
BOOST=""
for cand in /opt/homebrew/Cellar/emscripten/*/libexec/cache/ports/boost_headers \
            "${EMSCRIPTEN_ROOT:-}/cache/ports/boost_headers" \
            /usr/local/include /opt/homebrew/include; do
  [ -d "$cand/boost" ] && BOOST="$cand" && break
done
[ -n "$BOOST" ] || { echo "error: no boost headers found (run wasm/build.sh once to fetch them)" >&2; exit 1; }

ICU_PREFIX="$(brew --prefix icu4c@78 2>/dev/null || echo /usr/local)"

REV_SOURCES=(
  RVNGBinaryData RVNGMemoryStream RVNGProperty RVNGPropertyList
  RVNGPropertyListVector RVNGString RVNGStringVector
  RVNGStreamImplementation RVNGDirectoryStream RVNGOLEStream RVNGZipStream
)
SOURCES=("$MSPUB"/src/lib/*.cpp)
for n in "${REV_SOURCES[@]}"; do SOURCES+=("$REV/src/lib/$n.cpp"); done
SOURCES+=("$ROOT/native/extract.cpp")

echo "building a float-deterministic native extractor (${#SOURCES[@]} sources)"
g++ -std=c++17 -O2 -w -ffp-contract=off \
  -DHAVE_CONFIG_H -DLIBMSPUB_BUILD=1 \
  -I"$MSPUB/inc" -I"$MSPUB/src/lib" -I"$REV/inc" -I"$REV/src/lib" \
  -I"$WASM_DIR/config/libmspub" -isystem"$BOOST" -I"$ICU_PREFIX/include" \
  "${SOURCES[@]}" -o "$OUT/pubshift-extract-deterministic" \
  -L"$ICU_PREFIX/lib" -licui18n -licuuc -licudata -lz

echo "built: $OUT/pubshift-extract-deterministic"

[ "${1:-}" = "--compare" ] || exit 0

CORPUS="$ROOT/packages/core/test/corpus"
node - "$OUT/pubshift-extract-deterministic" "$CORPUS" <<'NODE'
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const [bin, corpus] = process.argv.slice(2);
const { loadPubshift } = await import(path.resolve('index.mjs'));
const pubshift = await loadPubshift();

const run = (f) => {
  try { return execFileSync(bin, [f], { encoding: 'utf8', maxBuffer: 1 << 28 }); }
  catch (e) { if (typeof e.stdout === 'string') return e.stdout; throw e; }
};

const files = readdirSync(corpus).filter((f) => f.endsWith('.pub')).sort();
let same = 0;
const diff = [];
for (const f of files) {
  const a = run(path.join(corpus, f));
  const b = pubshift.extractJSON(new Uint8Array(readFileSync(path.join(corpus, f))));
  if (a === b) same++; else diff.push(f);
}
console.log(`\ndeterministic native vs wasm: ${same}/${files.length} byte-identical`);
if (diff.length) console.log(`differ: ${diff.join(' ')}`);
process.exit(diff.length === 0 ? 0 : 1);
NODE
