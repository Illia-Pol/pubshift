#!/usr/bin/env bash
#
# Publishes apps/web/out to the gh-pages branch — with plain git, deliberately.
#
# The first deploy used `npx gh-pages`. It published the site minus the converter:
# it honours the repository's .gitignore while globbing, ours ignores `dist/`, and
# the WebAssembly binary lives at wasm/<hash>/dist/. The page loaded, looked entirely
# healthy, and every conversion 404'd. So this script force-adds and refuses to push
# unless the binary is actually in the commit.
#
#   ./deploy.sh https://illia-pol.github.io/pubshift you@example.com && ./publish.sh
set -euo pipefail
cd "$(dirname "$0")"

REMOTE="${PUBLISH_REMOTE:-git@github-pubshift:Illia-Pol/pubshift.git}"
OUT=apps/web/out

[ -f "$OUT/index.html" ] || { echo "no build in $OUT — run ./deploy.sh first" >&2; exit 1; }

P=$(mktemp -d)
trap 'rm -rf "$P"' EXIT
cp -R "$OUT"/. "$P"/
cd "$P"
git init -q . && git checkout -q -b gh-pages
git add -A -f .
git -c user.name="Illia Poliakov" -c user.email="illiapoliakov1@gmail.com" commit -q -m "Deploy site"

WASM=$(git ls-files | grep -c '\.wasm$' || true)
[ "$WASM" -ge 1 ] || { echo "refusing to publish: no .wasm in the commit — the site would not convert" >&2; exit 1; }
[ -f .nojekyll ] || { echo "refusing to publish: .nojekyll missing — GitHub would drop _next/" >&2; exit 1; }

git push -q -f "$REMOTE" gh-pages
echo "published $(git ls-files | wc -l | tr -d ' ') files, $WASM wasm binary, to gh-pages"
