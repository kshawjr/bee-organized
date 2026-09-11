// components/hive/shared/dismissalFacts.js
// ─────────────────────────────────────────────────────────────
// PURE module — the SINGLE opinion on "what do we actually know about this
// lead's dismissal, and what are we allowed to say about it?", shared by the
// two surfaces that must word it identically: the Inbox's Dismissed rows
// (InboxScreen) and the line on the lead's own card (ClientProfile).
//
// WHY THIS IS ONE MODULE, not two inline copies: #89 and issue 119 were both
// same bug — two surfaces each inlining a rule, then drifting. A dismissal
// line that drifts is worse than a count that drifts, because the two halves
// would disagree about WHO did something to a real person's record.
//
// ─── THE DISPLAY RULE (Kevin, 2026-09-10) ────────────────────
// SHOW WHAT YOU KNOW, NEVER GUESS.
//
//   actor known    → "Dismissed by Andrea · 10 Sep, 7:05pm"
//   actor NOT known → "Dismissed 10 Sep"   ← date ALONE
//
// When the actor is unknown there is NO name, NO placeholder, NO "by system",
// NO "by unknown", and never a dangling "by". A person probably clicked it and
// we simply did not write that down; "by system" would be a guess presented as
// fact, which is worse than the blank. The date alone already answers the
// question that matters — Kevin did not know Courtney Grady had been dismissed
// AT ALL, and "Dismissed 10 Sep" answers that completely. The name is a
// nice-to-have. NEVER backfill a missing actor by inference: not from the
// lead's owner, not from its assignee, not from whoever happens to be logged
// in. See dismissalLine() — the fallback ladder is the enforcement.
//
// ─── WHY THE ACTOR IS OFTEN MISSING ──────────────────────────
// The dismiss BUTTON posts to /api/touchpoints, which hard-codes
// user_id: null for kind 'system'. So the button path has never recorded who
// clicked it — verified against prod 2026-09-10: all 84 dismiss touchpoints
// ever written carry a null author, zero exceptions. The two AUTOMATIC routes
// are the opposite: the no-coverage send inserts hubUser.id directly and the
// network referral passes caller.userId through the shared writer, so both DO
// carry a real actor. (The brief that commissioned this had it the other way
// round; the data settled it.) The touchpoints route now honours an explicit
// actor:'session' opt-in so NEW button dismissals record their actor and the
// display improves on its own over time — the historical ones stay blank
// forever, by design.
//
// ─── ROUTE ATTRIBUTION ───────────────────────────────────────
// Each route writes a touchpoint whose label is an app-owned constant, so the
// route IS distinguishable from the record — no guessing required. Verified
// against prod: all 159 currently-dismissed leads matched a touchpoint, none
// fell through. A label we don't recognise yields route null and the bare
// date, which is the honest answer rather than an invented one.
//
// ─── ZERO QUERY COST ─────────────────────────────────────────
// Everything here is derived from rows the caller ALREADY has: the lead's own
// inbox_dismissed_at column plus the touchpoints already joined onto it by the
// page sweep (which selects '*', so user_id rides along free). This module
// issues no fetch and requires no widened select — deliberately, because the
// Inbox renders a list and one lookup per row is exactly the N+1 this was
// forbidden to introduce.
// ─────────────────────────────────────────────────────────────

// The three write paths that set inbox_dismissed_at, by the touchpoint label
// each one writes. The button label is also the string InboxScreen posts —
// they must stay byte-identical, which is why it lives here and is imported
// there rather than typed twice.
export const DISMISS_BUTTON_LABEL = 'Dismissed from Inbox — nurturing continues'
export const NO_COVERAGE_LABEL = 'No coverage — mailing-list invite sent'

// A dismissal's touchpoint is written in the same request that stamps the
// column, so the two moments are seconds apart. The window is generous enough
// to absorb clock skew and a slow fire-and-forget POST, and tight enough that
// an OLD dismissal's touchpoint (from a dismiss that was since undone and
// re-done) can never be mistaken for the current one.
export const MATCH_WINDOW_MS = 2 * 60 * 1000

/**
 * Which write path does this touchpoint label belong to?
 * @returns 'button' | 'no_coverage' | 'network' | null (unrecognised)
 */
export function dismissRouteOfLabel(label) {
  if (!label) return null
  if (label === DISMISS_BUTTON_LABEL) return 'button'
  if (label === NO_COVERAGE_LABEL) return 'no_coverage'
  // The network labels embed the partner's name ("Moved to Network as Amy
  // McNeal — drips paused" / "Added to Network as Kat Morga"), so they are
  // matched by shape rather than equality.
  if (/^(Moved|Added) to Network as /.test(label)) return 'network'
  return null
}

/**
 * What do we know about this lead's CURRENT dismissal?
 *
 * @param dismissedAt  the lead's inbox_dismissed_at (ISO string or null)
 * @param touchpoints  the lead's touchpoint rows, any shape carrying
 *                     { kind, label, occurred_at } and OPTIONALLY user_id
 *                     (the page sweep's raw rows) or user_label (the client
 *                     profile route, which resolves names server-side).
 * @returns null when the lead is not dismissed, else
 *          { at, route, actorId, actorName } — actorId/actorName null when
 *          nothing was recorded, which is the common case for the button.
 */
export function describeDismissal(dismissedAt, touchpoints = []) {
  if (!dismissedAt) return null
  const atMs = new Date(dismissedAt).getTime()
  if (!Number.isFinite(atMs)) return null

  // The nearest recognised system touchpoint inside the window. Nearest (not
  // first) so a lead dismissed, restored and re-dismissed attributes to the
  // dismissal actually on the row, never to a stale one.
  let best = null
  let bestGap = Infinity
  for (const t of touchpoints || []) {
    if (!t) continue
    const kind = t.kind || t.type
    if (kind !== 'system') continue
    const route = dismissRouteOfLabel(t.label)
    if (!route) continue
    const tMs = new Date(t.occurred_at || 0).getTime()
    if (!Number.isFinite(tMs)) continue
    const gap = Math.abs(tMs - atMs)
    if (gap > MATCH_WINDOW_MS) continue
    if (gap < bestGap) { bestGap = gap; best = { t, route } }
  }

  return {
    at: dismissedAt,
    route: best ? best.route : null,
    // Both shapes are read because the two callers hydrate differently; an
    // absent author stays null and is NEVER substituted.
    actorId: best ? (best.t.user_id || null) : null,
    actorName: best ? (best.t.user_label || null) : null,
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// "10 Sep" — the date alone, the bare fallback.
//
// Composed by hand rather than through toLocaleDateString, deliberately: the
// locale APIs order the parts by the RUNTIME's locale ("Sep 10" under en-US),
// so the shape Kevin specified would silently become a different shape for
// some readers and the tests would pass or fail on the machine's settings.
// Day-then-month is the agreed form; it is the same for everybody.
export function formatDismissDate(iso) {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`
}

// "10 Sep, 7:05pm" — date and time, used only when we can name the actor.
// 12-hour for the same reason the date is hand-composed: a 24-hour locale
// would render "19:05" and drift from the agreed wording.
export function formatDismissDateTime(iso) {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  const h24 = d.getHours()
  const h = h24 % 12 === 0 ? 12 : h24 % 12
  const mins = String(d.getMinutes()).padStart(2, '0')
  return `${formatDismissDate(iso)}, ${h}:${mins}${h24 < 12 ? 'am' : 'pm'}`
}

/**
 * The one sentence every surface shows. THE fallback ladder — see the display
 * rule in the header. There is deliberately no branch that emits a name-shaped
 * placeholder; the only way to get a "by" is to genuinely have a person.
 *
 * @param facts       describeDismissal's return value
 * @param resolveName optional (actorId) => name|null, for callers holding a
 *                    roster (the Inbox has one already — locationUsers — so
 *                    resolving costs nothing). Returning null is fine and
 *                    falls through to the honest blank.
 */
export function dismissalLine(facts, resolveName = null) {
  if (!facts) return null
  const name =
    facts.actorName ||
    (facts.actorId && resolveName ? resolveName(facts.actorId) || null : null)

  if (name) return `Dismissed by ${name} · ${formatDismissDateTime(facts.at)}`

  // No actor on record. Say what actually happened where the record supports
  // distinguishing it — an automatic route is a FACT here (it is read off the
  // touchpoint label, not inferred), so naming it is not a guess. Everything
  // else, including every button dismissal, gets the bare date.
  const when = formatDismissDate(facts.at)
  if (facts.route === 'no_coverage') {
    return `Dismissed automatically when the no-coverage email was sent · ${when}`
  }
  if (facts.route === 'network') {
    return `Dismissed automatically when this lead moved to your Network · ${when}`
  }
  return `Dismissed ${when}`
}

/**
 * Is this lead still being nurtured while dismissed?
 *
 * The card tells the reader the lead is "still live and still receiving
 * emails" — which is TRUE of a dismissed lead (dismiss is deliberately not a
 * drip stop; the drip lifecycle never learns inbox_dismissed_at) but is FALSE
 * of a network MOVE, which sets paused alongside the dismissal. Saying emails
 * are still going out when they have been paused would be the same class of
 * error the display rule exists to prevent, so the claim is gated on the
 * lead's real state rather than on dismissal alone.
 */
export function stillNurturing(person) {
  if (!person) return false
  const paused = person.paused ?? person.isPaused ?? false
  return !paused
}
