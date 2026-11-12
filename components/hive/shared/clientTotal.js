// components/hive/shared/clientTotal.js
// ─────────────────────────────────────────────────────────────
// PURE module (zero imports) — how many clients a location has, the ONE way
// both Home's "Everyone" tile and the Client List arrive at it, so the two
// can never show different numbers for the same location.
//
//   total = the clients the page holds  +  the clients it does not
//
// `listedCount` is the page's own client list for the location (the same
// array the Client List bands). What it does not hold is `clientsCutoff
// .notListed`, counted on the server through the shared applyLeadActiveFilter
// (lib/hub-working-clients.ts): not junk, not archived — the population the
// Client List calls Everyone.
//
//   · a complete load  → nothing is missing: the total is listedCount.
//   · a cut-off load   → listedCount + notListed.
//   · a cut-off load whose server count failed → NULL. Not listedCount: a
//     short number that looks whole is the one thing this must never return.
// ─────────────────────────────────────────────────────────────

export function clientTotal({ listedCount = 0, leadsTruncated = false, clientsCutoff = null } = {}) {
  if (!leadsTruncated) return listedCount
  return typeof clientsCutoff?.notListed === 'number' ? listedCount + clientsCutoff.notListed : null
}
