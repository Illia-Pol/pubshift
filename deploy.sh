#!/usr/bin/env bash
#
# Builds the site for a specific public URL and leaves it in apps/web/out,
# ready to drag onto any static host.
#
#   ./deploy.sh https://pubshift.pages.dev             # Cloudflare Pages, free subdomain
#   ./deploy.sh https://you.github.io/pubshift         # GitHub Pages project repo
#   ./deploy.sh https://pubshift.app                   # once a domain points at either
#
# The URL matters: it is what canonical links, OpenGraph tags and sitemap.xml
# contain. Building for one address and serving from another tells search engines
# the real site lives somewhere that does not exist yet.
#
# REPO_URL, if set, puts the "Get the batch runner" button on /batch. Unset, the button
# is absent rather than pointing at a repository that does not exist yet.
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

# Everything after the host is a base path, which is how a GitHub Pages project repo is
# served (`user.github.io/repo`). Absolute paths in the build have to carry it or every
# asset misses by one segment. A root deployment leaves this empty and nothing changes.
BASE_PATH=$(printf '%s' "$URL" | sed -E 's#^https?://[^/]+##')

# The converter must exist, or we would ship a converter-shaped site that cannot convert.
if [ ! -f wasm/dist/pubshift.wasm ]; then
  echo "wasm/dist/pubshift.wasm is missing — run ./wasm/build.sh first." >&2
  exit 1
fi

echo "Building for $URL"
rm -rf apps/web/.next apps/web/out
NEXT_PUBLIC_SITE_URL="$URL" \
NEXT_PUBLIC_CONTACT_EMAIL="$EMAIL" \
NEXT_PUBLIC_BASE_PATH="$BASE_PATH" \
NEXT_PUBLIC_REPO_URL="${REPO_URL:-}" \
  npm run build --workspace @pubshift/web

[ -n "$BASE_PATH" ] && echo "Serving from a subdirectory: $BASE_PATH"
# GitHub Pages runs Jekyll unless told not to, and Jekyll ignores files and folders whose
# names begin with an underscore — which is every one of Next's _next/static assets.
touch apps/web/out/.nojekyll

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
