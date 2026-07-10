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
echo "deploy:prod: NOW verify the GH mirror serves the same sha after pushing,"
echo "then tag: git tag release-$(date +%Y%m%d)-$sha && git push --tags"
