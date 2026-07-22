# Deploying the Solio Reserve Companion

Production is **two hosts serving the same artifact** — literally the same
files since D78: one `dist/` is built from clean `main`, deployed to
Cloudflare, and force-pushed verbatim to the `gh-pages` branch for the mirror.

| Host | Role | URL | How it deploys |
|---|---|---|---|
| Cloudflare Pages | **Primary** (custom domain) | https://map.soliogamereserve.org (staging: solio-reserve-map.pages.dev) | `npm run deploy:prod` |
| GitHub Pages | Mirror / fallback | https://jfwatt87-cmyk.github.io/solio-reserve-companion/ | Same `npm run deploy:prod` run (pushes `gh-pages` + dispatches `.github/workflows/deploy.yml`, which publishes that branch verbatim — no rebuild) |

## The rules (hard-won — do not skip)

1. **A push is never a release.** Pushing to `main` deploys NOTHING (since D78
   the mirror no longer rebuilds on push). The only release path is
   `npm run deploy:prod`, and a release isn't done until BOTH hosts verify.
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
4. **Both hosts self-verify** in `deploy:prod`: it curls each host's
   `version.json` until it reports the released SHA (`PRIMARY VERIFIED` /
   `MIRROR VERIFIED`). A mismatch is **FATAL** — the script exits non-zero and
   the release is not done; fix the failing host and re-run `deploy:prod`
   until both verify (never tag a split release). Then load the site and
   confirm the change is visible. Custom-domain propagation can lag a few
   minutes behind pages.dev.
   `npm run test:roads` runs unconditionally inside `deploy:prod` (and must
   still pass locally before committing a regenerated roads.gis.ts).
5. **Tag every release**: `git tag release-YYYYMMDD-<shortsha> && git push --tags`.
   Tags are the rollback anchors.
6. **Never hand-edit or branch off `gh-pages`.** It is a machine-written
   artifact branch, force-pushed on every release; only `deploy:prod` writes it.

## Cache versions (two, deliberately independent)

- `SHELL_CACHE` in `public/sw.js` (`solio-shell-vN`) — bump on **every release**.
  Guests get the new app shell; their saved tile pyramid is untouched.
- `TILE_CACHE` in `public/sw.js` **and** `TILE_CACHE_TAG` in
  `src/lib/precache.ts` (`solio-tiles-vN`) — bump **both, only when the tile
  pyramid changes**. Phones then re-pull the ~12 MB map. The prebuild step
  fails the build if the two ever differ, and fails if tile bytes change
  without a bump (`tools/tiles.lock.json`).

## Runtime navigation flag

`public/nav-auth.json` (`{"navigation": true|false}`) is the revocable half of
the navigation gate (D78): shells re-check it whenever online and their stored
verdict expires after 72 h offline. It only matters once `NAV_ENABLED`
(src/data/reserve.ts) is true — but keep it `false` until Callan's go, and
flipping it to `false` + `deploy:prod` is the field kill-switch that works
without waiting for phones to update their cached shell.

## Release checklist

```
git checkout main && git pull --ff-only
# bump SHELL_CACHE in public/sw.js (and the tile pair if tiles changed)
git push                       # main must be on origin BEFORE deploying (guard checks)
npm run deploy:prod            # guards, builds ONCE, deploys Cloudflare,
                               # mirrors the same artifact, verifies BOTH hosts
git tag release-$(date +%Y%m%d)-$(git rev-parse --short HEAD) && git push --tags
```

Rollback: `git checkout <last-good-tag>` then run the same
`npx wrangler pages deploy` + gh-pages mirror steps by hand (or `git revert`
on main and `npm run deploy:prod` for a clean auditable rollback).
