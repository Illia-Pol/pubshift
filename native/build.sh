#!/usr/bin/env bash
#
# Builds bin/pubshift-extract — the native extractor, which is the oracle the
# WebAssembly build is checked against (wasm/test/parity.mjs).
#
# It compiles libmspub and librevenge FROM SOURCE rather than linking Homebrew's
# prebuilt libmspub, and it does so from the same checkout and with the same
# floating-point contraction setting as wasm/build.sh. That is not tidiness:
#
#   libmspub computes an ellipse centre as `y + scaleY * v` and then decides an
#   arc's large-arc flag with `angleDifference >= M_PI`. On arm64, clang defaults
#   to -ffp-contract=on and fuses that into a single FMA, landing one ULP away
#   from where two separate roundings put it. For an exact semicircle that one ULP
#   decides the flag. WebAssembly has no scalar FMA instruction, so a WASM build
#   cannot reproduce it at any optimisation level.
#
# Linking a prebuilt library therefore made one corpus file (fdo68259-5.pub)
# diverge for reasons that had nothing to do with the port. An oracle whose answer
# depends on whether the host CPU has an FMA unit is not an oracle, so both sides
# now compile the same code with -ffp-contract=off.
#
# Requirements: brew install libmspub librevenge icu4c boost
# (libmspub is still installed for its headers and for pub2raw/pub2xhtml, which
# are useful when diagnosing what upstream does with a file.)
#
# Override the source checkout with PUBSHIFT_SRC; it must contain libmspub/ and
# librevenge/, and is the same variable wasm/build.sh uses.

set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)/.."

SRC="${PUBSHIFT_SRC:-}"
if [ -z "$SRC" ]; then
  for cand in \
    "$ROOT/vendor" \
    /private/tmp/claude-501/-Users-illia-pol/*/scratchpad/src \
    /tmp/pubshift-src; do
    [ -d "$cand/libmspub" ] && [ -d "$cand/librevenge" ] && SRC="$cand" && break
  done
fi
[ -n "$SRC" ] || {
  echo "error: set PUBSHIFT_SRC to a directory holding libmspub/ and librevenge/ checkouts." >&2
  echo "       git clone https://github.com/LibreOffice/libmspub" >&2
  exit 1
}

MSPUB="$SRC/libmspub"
REV="$SRC/librevenge"
for d in "$MSPUB/src/lib" "$REV/src/lib" "$MSPUB/inc" "$REV/inc"; do
  [ -d "$d" ] || { echo "error: missing $d" >&2; exit 1; }
done

ICU="$(brew --prefix icu4c@78)"
BOOST="$(brew --prefix boost)"
export PKG_CONFIG_PATH="$ICU/lib/pkgconfig:${PKG_CONFIG_PATH:-}"

# Same subset wasm/build.sh compiles: librevenge's core and stream objects. The
# output generators are unused — the IR comes from our own collector.
REV_SOURCES=(
  RVNGBinaryData RVNGMemoryStream RVNGProperty RVNGPropertyList
  RVNGPropertyListVector RVNGString RVNGStringVector
  RVNGStreamImplementation RVNGDirectoryStream RVNGOLEStream RVNGZipStream
)

SOURCES=("$MSPUB"/src/lib/*.cpp)
for n in "${REV_SOURCES[@]}"; do SOURCES+=("$REV/src/lib/$n.cpp"); done
SOURCES+=(extract.cpp)

mkdir -p "$ROOT/bin" build

g++ -std=c++17 -O2 \
  -ffp-contract=off \
  -DHAVE_CONFIG_H -DLIBMSPUB_BUILD=1 \
  -I"$MSPUB/inc" -I"$MSPUB/src/lib" \
  -I"$REV/inc" -I"$REV/src/lib" \
  -I"config/libmspub" \
  -I"$ICU/include" -I"$BOOST/include" \
  -Wall -Wno-unused-function -Wno-unused-parameter -Wno-deprecated-declarations \
  "${SOURCES[@]}" \
  -o "$ROOT/bin/pubshift-extract" \
  -L"$ICU/lib" -licuuc -licui18n -licudata -lz

echo "built: bin/pubshift-extract  (libmspub+librevenge from $SRC, -ffp-contract=off)"
