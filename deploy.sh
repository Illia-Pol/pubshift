#!/usr/bin/env bash
#
# Builds the site for a specific public URL and leaves it in apps/web/out,
# ready to drag onto any static host.
#
#   ./deploy.sh https://pubshift.pages.dev        # first deploy, free subdomain
#   ./deploy.sh https://pubshift.app              # once the domain is pointed at it
#
# The URL matters: it is what canonical links, OpenGraph tags and sitemap.xml
# contain. Building for one address and serving from another tells search engines
# the real site lives somewhere that does not exist yet.
#
# CONTACT_EMAIL, if set, puts a "tell me when I can buy this" mailto on /batch.
# Without an address that section is simply absent — see lib/interest.ts.
set -euo pipefail
cd "$(dirname "$0")"

URL="${1:-}"
if [ -z "$URL" ]; then
  echo "usage: ./deploy.sh <public-url> [contact-email]" >&2
  echo "   eg: ./deploy.sh https://pubshift.pages.dev you@example.com" >&2
  exit 2
fi
URL="${URL%/}"
EMAIL="${2:-${CONTACT_EMAIL:-}}"

# The converter must exist, or we would ship a converter-shaped site that cannot convert.
if [ ! -f wasm/dist/pubshift.wasm ]; then
  echo "wasm/dist/pubshift.wasm is missing — run ./wasm/build.sh first." >&2
  exit 1
fi

echo "Building for $URL"
rm -rf apps/web/.next apps/web/out
NEXT_PUBLIC_SITE_URL="$URL" \
NEXT_PUBLIC_CONTACT_EMAIL="$EMAIL" \
  npm run build --workspace @pubshift/web

FILES=$(find apps/web/out -type f | wc -l | tr -d ' ')
SIZE=$(du -sh apps/web/out | cut -f1)

echo
echo "Ready: apps/web/out  ($FILES files, $SIZE)"
echo
echo "Upload that folder to any static host. It needs no server, no database and no"
echo "build step on their side — every file is final."
echo
echo "Check afterwards, on the live site:"
echo "  1. Drop a .pub file in. It should convert without any network request."
echo "  2. View source: a <meta http-equiv=\"Content-Security-Policy\"> must be present."
echo "  3. Open $URL/sitemap.xml — it should list / , /batch and /privacy."
