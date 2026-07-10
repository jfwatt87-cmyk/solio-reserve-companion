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

echo
echo "deploy:prod: done. NOW: verify map.soliogamereserve.org (and the GH mirror"
echo "after pushing), then tag: git tag release-$(date +%Y%m%d)-$(git rev-parse --short HEAD) && git push --tags"
