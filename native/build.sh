#!/usr/bin/env bash
# Builds pubshift-extract. Requires: libmspub, librevenge, icu4c (see README).
set -euo pipefail
cd "$(dirname "$0")"
if command -v brew >/dev/null 2>&1; then
  export PKG_CONFIG_PATH="$(brew --prefix icu4c@78)/lib/pkgconfig:${PKG_CONFIG_PATH:-}"
fi
mkdir -p ../bin
g++ -std=c++17 -O2 -Wall \
  $(pkg-config --cflags libmspub-0.1 librevenge-0.0 librevenge-stream-0.0) \
  extract.cpp -o ../bin/pubshift-extract \
  $(pkg-config --libs libmspub-0.1 librevenge-0.0 librevenge-stream-0.0)
echo "built: bin/pubshift-extract"
