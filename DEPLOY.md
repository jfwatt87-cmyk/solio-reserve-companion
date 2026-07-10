# Deploying the Solio Reserve Companion

Production is **two hosts serving the same artifact**:

| Host | Role | URL | How it deploys |
|---|---|---|---|
| Cloudflare Pages | **Primary** (custom domain) | https://map.soliogamereserve.org (staging: solio-reserve-map.pages.dev) | Manual: `npm run deploy:prod` |
| GitHub Pages | Mirror / fallback | https://jfwatt87-cmyk.github.io/solio-reserve-companion/ | Automatic on every push to `main` (`.github/workflows/deploy.yml`) |

## The rules (hard-won — do not skip)

1. **A push is never a release.** Merging/pushing to `main` auto-publishes the
   GitHub Pages *mirror*, but a release isn't done until the Cloudflare primary
   is deployed AND both hosts are verified live (step 4). Plan pushes to `main`
   accordingly — don't merge anything you're not prepared to release.
2. **Cloudflare deploys MUST unset `CLOUDFLARE_API_TOKEN`.** This machine has an
   ambient token for a *different* (personal) Cloudflare account; with it set,
   wrangler silently deploys to the wrong account instead of the Solio account
   (tech@solioranch.co.ke, project `solio-reserve-map`). `npm run deploy:prod`
   handles this; if you ever run wrangler by hand:
   `env -u CLOUDFLARE_API_TOKEN npx wrangler pages deploy dist --project-name solio-reserve-map`
3. **Deploy only a clean `main`.** `dist/` holds whatever was built last —
   including experiment branches. `npm run deploy:prod` refuses to run unless
   you're on `main`, the tree is clean, and you're in sync with `origin/main`,
   then rebuilds before deploying.
4. **Verify BOTH hosts after every release**: `curl -s <host>/version.json`
   must return the released commit SHA on map.soliogamereserve.org AND the
   github.io mirror (stamped by the postbuild step). Then load the site and
   confirm the change is visible. Custom-domain propagation can lag a few
   minutes behind pages.dev.
   Touched the road network? `npm run test:roads` must pass before committing
   a regenerated roads.gis.ts.
5. **Tag every release**: `git tag release-YYYYMMDD-<shortsha> && git push --tags`.
   Tags are the rollback anchors.

## Cache versions (two, deliberately independent)

- `SHELL_CACHE` in `public/sw.js` (`solio-shell-vN`) — bump on **every release**.
  Guests get the new app shell; their saved tile pyramid is untouched.
- `TILE_CACHE` in `public/sw.js` **and** `TILE_CACHE_TAG` in
  `src/lib/precache.ts` (`solio-tiles-vN`) — bump **both, only when the tile
  pyramid changes**. Phones then re-pull the ~12 MB map. The prebuild step
  fails the build if the two ever differ.

## Release checklist

```
git checkout main && git pull --ff-only
# bump SHELL_CACHE in public/sw.js (and the tile pair if tiles changed)
npm run deploy:prod            # guards, builds, deploys Cloudflare
git push                       # publishes the GH Pages mirror via Actions
# watch the Actions run; if infra-cancelled, re-run ONCE
# verify map.soliogamereserve.org AND the github.io mirror
git tag release-$(date +%Y%m%d)-$(git rev-parse --short HEAD) && git push --tags
```

Rollback: `git checkout <last-good-tag> && npm run build` then deploy that
build to Cloudflare the same way (and `git revert` on main for the mirror).
