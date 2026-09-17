#!/usr/bin/env bash
# Builds the test-only module that exposes the ICU shim directly, so
# test/encoding.mjs can compare it against the real-ICU fixtures.
#
# Separate from build.sh on purpose: none of this is in the shipped artifact.
set -euo pipefail
cd "$(dirname "$0")/.."
WASM_DIR="$(pwd)"

if [ -n "${EMSCRIPTEN_ROOT:-}" ]; then
  export PATH="$EMSCRIPTEN_ROOT:$PATH"
elif [ -d /opt/homebrew/Cellar/emscripten ] && ! command -v em++ >/dev/null 2>&1; then
  latest="$(ls -1d /opt/homebrew/Cellar/emscripten/*/libexec 2>/dev/null | sort -V | tail -1)"
  [ -n "$latest" ] && export PATH="$latest:$PATH"
fi
: "${EMSDK_PYTHON:=$(command -v python3 || true)}"
export EMSDK_PYTHON

command -v em++ >/dev/null 2>&1 || { echo "error: em++ not on PATH" >&2; exit 1; }

mkdir -p test/build
em++ -std=c++17 -O2 -fno-rtti \
  -I"$WASM_DIR" \
  "$WASM_DIR/icu_shim.cpp" "$WASM_DIR/test/shim_probe.cpp" \
  -sEXPORT_ES6=1 -sMODULARIZE=1 -sEXPORT_NAME=createShimProbe \
  -sFILESYSTEM=0 -sENVIRONMENT=web,worker,node -sALLOW_MEMORY_GROWTH=1 \
  -sEXPORTED_FUNCTIONS=_probe_decode,_probe_locale,_probe_locale_id,_probe_detect,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAP32,HEAPU32,UTF8ToString,stringToUTF8 \
  --js-library "$WASM_DIR/textdecoder.js" \
  -o test/build/shim-probe.mjs

echo "built: wasm/test/build/shim-probe.mjs"
