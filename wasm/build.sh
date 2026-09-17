#!/usr/bin/env bash
#
# Builds dist/pubshift.mjs + dist/pubshift.wasm: libmspub and librevenge
# compiled straight to WebAssembly, so a .pub file is converted inside the tab
# and never leaves the machine.
#
# No autotools. Both libraries are 45 .cpp files between them with no generated
# sources worth the trouble, so emcc compiles them directly against the
# hand-written config headers in config/. That also keeps the build honest about
# its inputs: everything it compiles is listed right here.
#
# Usage:  ./build.sh [--debug]
#
# Prerequisites (see README.md):
#   emscripten on PATH, and libmspub + librevenge checkouts findable via
#   PUBSHIFT_SRC (defaults to the scratch checkout used during development).

set -euo pipefail
cd "$(dirname "$0")"
WASM_DIR="$(pwd)"
ROOT="$(cd .. && pwd)"

DEBUG=0
[ "${1:-}" = "--debug" ] && DEBUG=1

# ---------------------------------------------------------------- toolchain --

if [ -n "${EMSCRIPTEN_ROOT:-}" ]; then
  export PATH="$EMSCRIPTEN_ROOT:$PATH"
elif [ -d /opt/homebrew/Cellar/emscripten ] && ! command -v emcc >/dev/null 2>&1; then
  # Homebrew keeps the real emcc in libexec; take the newest installed.
  latest="$(ls -1d /opt/homebrew/Cellar/emscripten/*/libexec 2>/dev/null | sort -V | tail -1)"
  [ -n "$latest" ] && export PATH="$latest:$PATH"
fi
: "${EMSDK_PYTHON:=$(command -v python3 || true)}"
export EMSDK_PYTHON

command -v em++ >/dev/null 2>&1 || {
  echo "error: em++ not on PATH. Set EMSCRIPTEN_ROOT to your emscripten dir." >&2
  exit 1
}

# ------------------------------------------------------------------ sources --

SRC="${PUBSHIFT_SRC:-}"
if [ -z "$SRC" ]; then
  for cand in \
    "$ROOT/third_party" \
    /private/tmp/claude-501/-Users-illia-pol/cdcaf96d-92b0-40f9-b037-9f16e3768b9b/scratchpad/src
  do
    [ -d "$cand/libmspub" ] && [ -d "$cand/librevenge" ] && SRC="$cand" && break
  done
fi
[ -n "$SRC" ] || { echo "error: set PUBSHIFT_SRC to the dir holding libmspub/ and librevenge/" >&2; exit 1; }

MSPUB="$SRC/libmspub"
REV="$SRC/librevenge"
for d in "$MSPUB/src/lib" "$REV/src/lib" "$MSPUB/inc" "$REV/inc"; do
  [ -d "$d" ] || { echo "error: missing $d" >&2; exit 1; }
done

# librevenge builds three libraries upstream; we need the core objects and the
# stream objects. The generators (HTML/CSV/SVG/raw/text output) are dead weight
# here — libmspub never calls them and the IR is produced by our own collector.
REV_SOURCES=(
  RVNGBinaryData RVNGMemoryStream RVNGProperty RVNGPropertyList
  RVNGPropertyListVector RVNGString RVNGStringVector
  RVNGStreamImplementation RVNGDirectoryStream RVNGOLEStream RVNGZipStream
)

SOURCES=("$MSPUB"/src/lib/*.cpp)
for n in "${REV_SOURCES[@]}"; do SOURCES+=("$REV/src/lib/$n.cpp"); done
SOURCES+=("$WASM_DIR/icu_shim.cpp" "$WASM_DIR/api.cpp")

# ------------------------------------------------------------------- flags ---

INCLUDES=(
  -I"$MSPUB/inc" -I"$MSPUB/src/lib"
  -I"$REV/inc"   -I"$REV/src/lib"
  -I"$WASM_DIR/config/libmspub"
  -I"$WASM_DIR"
  # Ahead of everything so libmspub's `#include <unicode/ucnv.h>` resolves to
  # the shim. Nothing here shadows a real header for any other build.
  -I"$WASM_DIR/include"
)

CXXFLAGS=(
  -std=c++17
  -DHAVE_CONFIG_H -DLIBMSPUB_BUILD=1
  --use-port=boost_headers
  -sUSE_ZLIB=1
  # libmspub signals malformed files by throwing, and extract.cpp catches to
  # turn that into a readable message, so catching has to actually work.
  -fwasm-exceptions
  -fno-rtti
  -Wall -Wno-unused-function -Wno-unused-parameter
)

if [ "$DEBUG" = "1" ]; then
  CXXFLAGS+=(-O0 -g3 -sASSERTIONS=2 -sSAFE_HEAP=1 -sSTACK_OVERFLOW_CHECK=2)
  OUTDIR="$WASM_DIR/dist-debug"
else
  CXXFLAGS+=(-O3 -DNDEBUG -flto)
  OUTDIR="$WASM_DIR/dist"
fi

LDFLAGS=(
  -sEXPORT_ES6=1
  -sMODULARIZE=1
  -sEXPORT_NAME=createPubshift
  # No MEMFS, no NODEFS, no stdin: the document arrives as bytes in memory and
  # leaves as bytes in memory. Dropping the filesystem is most of the reason
  # this module is small enough to fetch before the user notices.
  -sFILESYSTEM=0
  -sENVIRONMENT=web,worker,node
  -sALLOW_MEMORY_GROWTH=1
  -sINITIAL_MEMORY=33554432
  # 512 MB. Publisher files carry uncompressed bitmaps; the corpus tops out
  # around 800 KB of JSON but real newsletters are much heavier.
  -sMAXIMUM_MEMORY=536870912
  -sEXPORTED_FUNCTIONS=_pubshift_extract,_pubshift_free,_pubshift_version,_malloc,_free
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU32,UTF8ToString
  -sINCOMING_MODULE_JS_API=wasmBinary,locateFile,print,printErr,instantiateWasm
  --js-library "$WASM_DIR/textdecoder.js"
)
[ "$DEBUG" = "1" ] || LDFLAGS+=(-O3 -flto --closure=0)

mkdir -p "$OUTDIR"

echo "pubshift wasm build"
echo "  em++      $(em++ --version | head -1 | sed 's/emcc (.*) //')"
echo "  sources   ${#SOURCES[@]} files from $SRC"
echo "  output    $OUTDIR/pubshift.mjs"

# em++ rather than emcc: this is C++ and the link needs libc++.
em++ "${CXXFLAGS[@]}" "${INCLUDES[@]}" "${SOURCES[@]}" \
     "${LDFLAGS[@]}" -o "$OUTDIR/pubshift.mjs"

wasm_size=$(wc -c < "$OUTDIR/pubshift.wasm" | tr -d ' ')
mjs_size=$(wc -c < "$OUTDIR/pubshift.mjs" | tr -d ' ')
gz=$( (gzip -9 -c "$OUTDIR/pubshift.wasm" | wc -c) | tr -d ' ')

# SOURCES.txt — what actually went into this binary.
#
# third-party.json pins the components; this records which build produced the
# artifact sitting next to it, including the versions third-party.json defers to
# ("recorded-at-build-time"). Serving pubshift.wasm from a web page distributes
# MPL-2.0 code in executable form, and an offer of source that cannot say which
# source is not an offer, so this is written by the build rather than by hand.
{
  echo "pubshift wasm build manifest"
  echo "generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo
  echo "toolchain"
  echo "  emscripten: $(em++ --version | head -1)"
  echo "  clang:      $(em++ -v 2>&1 | grep -m1 'clang version' || echo 'unknown')"
  echo
  echo "third-party source"
  echo "  root: $SRC"
  if [ -d "$MSPUB/.git" ]; then
    echo "  libmspub:   $(git -C "$MSPUB" rev-parse HEAD 2>/dev/null || echo unknown)" \
         "($(git -C "$MSPUB" log -1 --format=%cI 2>/dev/null || echo '?'))"
  else
    mspub_ver="$(sed -nE 's/^m4_define\(\[libmspub_version_(major|minor|micro)\],\[([0-9]+)\]\)$/\2/p' "$MSPUB/configure.ac" 2>/dev/null | paste -sd. -)"
    echo "  libmspub:   ${mspub_ver:-unknown} (release tree, not a git checkout)"
  fi
  if [ -d "$REV/.git" ]; then
    echo "  librevenge: $(git -C "$REV" rev-parse HEAD 2>/dev/null || echo unknown)"
  else
    rev_ver="$(sed -nE 's/^m4_define\(\[librevenge_version_(major|minor|micro)\],\[([0-9]+)\]\)$/\2/p' "$REV/configure.ac" 2>/dev/null | paste -sd. -)"
    echo "  librevenge: ${rev_ver:-unknown} (release tree, not a git checkout)"
  fi
  echo "  boost:      emscripten port boost_headers"
  echo "  zlib:       emscripten port (-sUSE_ZLIB=1)"
  echo "  ICU:        not linked — see wasm/icu_shim.cpp and wasm/icu_shim_data.inc"
  echo
  echo "compiled translation units (${#SOURCES[@]})"
  for s in "${SOURCES[@]}"; do
    rel="${s#"$SRC/"}"; rel="${rel#"$ROOT/"}"
    echo "  $rel"
  done
  echo
  echo "flags"
  echo "  ${CXXFLAGS[*]}"
  echo "  ${LDFLAGS[*]}"
  echo
  echo "artifacts"
  for f in pubshift.wasm pubshift.mjs; do
    echo "  $f  $(wc -c < "$OUTDIR/$f" | tr -d ' ') bytes  sha256=$(shasum -a 256 "$OUTDIR/$f" | cut -d' ' -f1)"
  done
} > "$OUTDIR/SOURCES.txt"

echo "built:"
printf "  pubshift.wasm  %s bytes (%s gzipped)\n" "$wasm_size" "$gz"
printf "  pubshift.mjs   %s bytes\n" "$mjs_size"
printf "  SOURCES.txt    what went into it\n"
