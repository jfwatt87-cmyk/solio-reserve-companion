#!/usr/bin/env bash
# Guarded production deploy to Cloudflare Pages (the PRIMARY host).
# See DEPLOY.md for the full release checklist (verify + tag afterwards).
set -euo pipefail

cd "$(dirname "$0")/.."

branch=$(git branch --show-current)
if [ "$branch" != "main" ]; then
  echo "deploy:prod: refusing — on branch '$branch', production deploys only from main." >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "deploy:prod: refusing — working tree not clean. Commit or stash first." >&2
  exit 1
fi
git fetch origin main --quiet
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "deploy:prod: refusing — local main is not in sync with origin/main." >&2
  exit 1
fi

echo "deploy:prod: building clean main ($(git rev-parse --short HEAD))…"
npm run build

# CLOUDFLARE_API_TOKEN on this machine belongs to a DIFFERENT account; with it
# set, wrangler deploys to the wrong place. Always unset it for this command.
echo "deploy:prod: deploying dist/ to Cloudflare Pages project solio-reserve-map…"
env -u CLOUDFLARE_API_TOKEN npx wrangler pages deploy dist --project-name solio-reserve-map

sha=$(git rev-parse --short HEAD)
echo
echo "deploy:prod: verifying the primary serves this build (version.json)…"
for i in 1 2 3; do
  live=$(curl -s --max-time 10 "https://map.soliogamereserve.org/version.json" | sed -n 's/.*"sha":"\([^"]*\)".*/\1/p')
  [ "$live" = "$sha" ] && break
  sleep 10
done
if [ "$live" = "$sha" ]; then
  echo "deploy:prod: PRIMARY VERIFIED — serving $live"
else
  echo "deploy:prod: WARNING — primary reports '$live', expected '$sha' (propagation lag? investigate before tagging)" >&2
fi

# Single-artifact mirror (D78): the GH Pages mirror must serve the EXACT files
# just deployed to Cloudflare — never a separate rebuild, which could differ.
# Push this dist/ verbatim to the gh-pages branch, then dispatch the publish
# workflow (which uploads that branch as-is).
echo
echo "deploy:prod: publishing the same artifact to the GH Pages mirror (gh-pages branch)…"
mirror_tmp=$(mktemp -d)
cp -R dist/. "$mirror_tmp/"
touch "$mirror_tmp/.nojekyll"
git -C "$mirror_tmp" init -q -b gh-pages
git -C "$mirror_tmp" add .
git -C "$mirror_tmp" -c user.name="solio-deploy" -c user.email="deploy@invalid" \
  commit -qm "mirror artifact ${sha}"
git -C "$mirror_tmp" push -f "$(git remote get-url origin)" gh-pages:gh-pages
rm -rf "$mirror_tmp"
gh workflow run deploy.yml --ref main
echo "deploy:prod: verifying the mirror serves the same artifact (this waits on Actions)…"
mirror=""
for i in $(seq 1 20); do
  sleep 15
  mirror=$(curl -s --max-time 10 "https://jfwatt87-cmyk.github.io/solio-reserve-companion/version.json?nocache=$(date +%s)" | sed -n 's/.*"sha":"\([^"]*\)".*/\1/p')
  [ "$mirror" = "$sha" ] && break
done
if [ "$mirror" = "$sha" ]; then
  echo "deploy:prod: MIRROR VERIFIED — serving $mirror (same artifact)"
else
  echo "deploy:prod: WARNING — mirror reports '$mirror', expected '$sha' (check the Actions run before tagging)" >&2
fi

echo
echo "deploy:prod: if BOTH hosts verified, tag: git tag release-$(date +%Y%m%d)-$sha && git push --tags"
