// components/hive/shared/jobberSendPoll.js
// ─────────────────────────────────────────────────────────────
// PURE helpers for the after-Send-to-Jobber engagement poll (issue 155).
//
// THE GAP: a card leaves the Inbox only once its engagements set carries a
// non-terminal engagement whose client_id === lead.id. A Send to Jobber
// founds that engagement server-side via the Jobber webhook — an INSERT that
// lands ~11s after the send (median; p90 22s; max 125s, measured over 41 real
// sends). Engagements realtime is UPDATE-only by design, and the focus
// sweep's reconcileServerRows drops any row not already known — so NO client
// path surfaces a brand-new engagement. Without help the row sits in the
// Inbox, stale, until a full reload.
//
// THE FIX (targeted, NOT a realtime-INSERT rebuild): after a send, HiveShell
// polls the same ?open=1 set the focus sweep already fetches until the
// founded engagement appears, then injects it into sessionEngagements — the
// exact seam NewClientSheet's onFounded uses to make a card appear without a
// reload. The moment it lands the row derives Active and leaves on its own,
// and the badge + board correct themselves from the same injection.
//
// This module is the PURE, React-free heart of that loop (same rationale as
// engagementRevalidate.js): the reconcile decision and the poll cadence are
// unit-testable in isolation; HiveShell owns only the timer + fetch + state.
// Zero imports — safe in any bundle (§8.5 pure-module rule).
// ─────────────────────────────────────────────────────────────

// Hard cap on how long we poll one send. p90 lands at 22s, so 90s sits well
// past the realistic tail while stopping short of the measured 125s extreme —
// beyond the cap we settle to a calm, non-error state and let SSR-on-next-load
// be the backstop, rather than ever spinning forever.
export const SEND_POLL_CAP_MS = 90_000

// Two-phase cadence, chosen against the real landing distribution: 34% land
// under 8s and p90 by 22s, but the tail runs to two minutes. A tight 3s
// cadence for the first 30s catches essentially the whole realistic
// distribution within one interval of the actual landing; after 30s only the
// rare long tail remains, so we relax to 9s to spare the enrichment-heavy
// open-set endpoint the cost of polling every 3s all the way to the cap.
const FAST_PHASE_MS = 30_000
const FAST_INTERVAL_MS = 3_000
const SLOW_INTERVAL_MS = 9_000

// Delay until the next poll, given how long this send has been pending. Pure
// so the cadence is pinnable in a test (fast early, slow in the tail).
export function pollDelayForElapsed(elapsedMs) {
  return elapsedMs >= FAST_PHASE_MS ? SLOW_INTERVAL_MS : FAST_INTERVAL_MS
}

// Reconcile one poll tick.
//
//   pending   [{ clientId, startedAt }]  — sends awaiting their engagement
//   openRows  the ?open=1 board rows this tick fetched
//   nowMs     current epoch ms (passed in so this stays pure/testable)
//   capMs     give-up threshold (defaults to SEND_POLL_CAP_MS)
//
// Returns { injects, stillPending, settled }:
//   injects      founded engagement rows to push into sessionEngagements —
//                each is a full board-shape row, so the board renders it and
//                the Inbox derivation drops its lead in the same pass
//   stillPending sends whose engagement hasn't appeared and haven't capped —
//                keep polling these
//   settled      clientIds that hit the cap without their engagement landing —
//                stop polling, show the calm "being created…" close (never an
//                error: the send genuinely succeeded)
//
// A matched send leaves BOTH injects (this tick) and pending (it is neither in
// stillPending nor settled), so the loop stops for it. That is the whole
// "stops on match" / "stops at cap" contract, expressed as pure data.
export function reconcileSentPolls(pending, openRows, nowMs, capMs = SEND_POLL_CAP_MS) {
  const rows = Array.isArray(openRows) ? openRows : []
  const injects = []
  const stillPending = []
  const settled = []
  for (const entry of pending || []) {
    if (!entry || !entry.clientId) continue
    const match = rows.find(r => r && r.id && r.client_id === entry.clientId)
    if (match) { injects.push(match); continue }
    if (nowMs - entry.startedAt >= capMs) { settled.push(entry.clientId); continue }
    stillPending.push(entry)
  }
  return { injects, stillPending, settled }
}
