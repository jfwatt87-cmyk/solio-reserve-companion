# Solio live-tracking server — Phase 2 scaffold (Module B)

**Status: scaffold. Not deployed, not scope** until Callan agrees Module B
(vault: "Phase 2 — Technical Spec" / "P2 Proposal — Skeleton").

One Cloudflare Worker + one KV namespace. No database, no user accounts.

- `POST /api/track` — ranger/manager device reports a vehicle position
  (Bearer device-token). Server assigns the timestamp; positions expire
  after 1 h.
- `GET /api/positions` — anyone; response filtered **server-side** by role.
  Guests get whatever the guest dial allows: `off` (default) / `delayed` /
  `coarse` (1 km grid, heading stripped) / `live`.
- `POST /api/admin` — manager only: issue/revoke device tokens, set the dial.

**The rhino rule is `filterForRole()` in `src/index.ts`** — the single
enforcement point, covered by `src/filter.test.ts`
(`npx tsx server/src/filter.test.ts`). Guests default to seeing nothing.

Costs: free tier at Solio scale (polling, ≤10 vehicles); worst case
Workers paid $5/mo. Remember the ambient-token trap: always
`env -u CLOUDFLARE_API_TOKEN npx wrangler ...`.
