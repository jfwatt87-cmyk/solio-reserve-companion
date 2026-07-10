# Solio live-tracking server — Phase 2 scaffold (Module B)

**Status: scaffold. Not deployed, not scope** until Callan agrees Module B
(vault: "Phase 2 — Technical Spec" / "P2 Proposal — Skeleton").

One Cloudflare Worker + one KV namespace. No database, no user accounts.

v2 after adversarial review (gpt-5.6-sol, 2026-07-10). Design invariants —
see the header comment in `src/index.ts` for the full list:

- `POST /api/track` — ranger device reports lat/lng/heading; vehicle
  identity comes from the token (no spoofing), timestamp from the server;
  positions kept as a per-vehicle history ring, TTL 1 h.
- `GET /api/positions` — staff (Bearer token): live vehicles. Guests (no
  token): ONE prebuilt sanitised snapshot, edge-cached 30 s.
- `POST /api/admin` — manager (wrangler secret; Cloudflare Access in
  production): issue/revoke hashed 256-bit device tokens, set the dial.

**The rhino rule is an invariant**: guests only ever get `clampDial()` +
`buildGuestSnapshot()` output — BOTH delayed (≥15 min) AND coarsened
(≥500 m), time-bucketed, allow-listed DTO with daily-rotating ids; default
off; hostile settings clamp or fail closed. Tests:
`npx tsx server/src/filter.test.ts` (21 assertions incl. property sweep).

Known scaffold limits (fix at build time, documented by review): token
revocation + dial live in KV (≤60 s propagation; production = Durable
Object), no rate limiting yet, same-origin routing + SW exclusion for
`/api/*` to be wired in the client.

Costs, honestly: Workers Paid **$5/mo** is the budget line (naive polling
would be ~$45/mo; the snapshot design avoids it). Ambient-token trap:
always `env -u CLOUDFLARE_API_TOKEN npx wrangler ...`.
