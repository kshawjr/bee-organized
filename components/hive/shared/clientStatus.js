// components/hive/shared/clientStatus.js
// ─────────────────────────────────────────────────────────────
// PURE module — client status DERIVATION (doc §2), resolving the open
// 'stored vs derived' question as DERIVED-for-now. When a stored
// client_status column lands (later step-4 item), THIS module is the
// single place to swap: readers keep calling deriveClientStatus.
//
// Inputs are what's already client-side: the mapped Person (leads row +
// joined children + the hydration-time Closed Won roll-up), the set of
// client_ids with OPEN engagements, and (optional) the set of client_ids
// with a Closed Won engagement — session-derived, so a close-as-Won this
// session flips the person to Client without a reload.
//
// RULES (checked in order):
//   no_contact — no email AND no phone. (True is_junk leads are already
//                excluded upstream — they live in the Recycle Bin, not
//                the directory — so this catches reachability, the §2
//                junk PRECONDITION, on not-yet-junked rows.)
//   Active     — ≥1 OPEN engagement (currently being worked — beats the
//                won-history read; when it closes they settle to Client
//                or back to the funnel).
//   Client     — ≥1 CLOSED WON engagement, ever. A won client is a
//                customer, not a lead being nurtured — this OUTRANKS the
//                whole nurture funnel (won > funnel > raw lead). Fed by
//                person.wonEngagements (hydration roll-up) OR the live
//                wonClientIds set, so it does NOT depend on the stored
//                client_status column or any backfill having run.
//   Past       — no won engagement AND paid history (paidAmount > 0).
//                CAVEAT: leads.paid_amount is a single-slot denorm (last
//                paid invoice / import roll-up), not a lifetime sum —
//                fine as an existence test, do not render it as an
//                exact lifetime without that caveat.
//   Attempting — none of the above AND a human reach_out touchpoint
//                within the last 30 days (being actively worked).
//   New        — none of the above AND created < 30 days ago.
//   Nurturing  — everyone else: inquired/imported, never booked or went
//                cold. This is the marketable pool (§5).
//
// KNOWN APPROXIMATION: a client whose engagements ALL closed as Lost (no
// paid history) falls through to Attempting/New/Nurturing by age+activity,
// which reads correctly on the board anyway.
//
// FUTURE (re-engage seam): person.wonEngagements carries { count, value,
// lastClosedAt } and person.jobs is already client-side — a "quiet won
// client" flag is one predicate over those (lastClosedAt/last job older
// than a threshold), NOT a new data path. Needs a quiet-threshold policy
// decision before building.
// ─────────────────────────────────────────────────────────────

export const CLIENT_STATUS_ORDER = ['New', 'Attempting', 'Nurturing', 'Active', 'Client', 'Past', 'no_contact']

const THIRTY_D = 30 * 24 * 60 * 60 * 1000

export function deriveClientStatus(person, openClientIds, nowMs = Date.now(), wonClientIds = null) {
  const email = (person.email || '').trim()
  const phone = (person.phone || '').trim()
  if (!email && !phone) return 'no_contact'

  if (openClientIds && openClientIds.has(person.id)) return 'Active'

  if ((wonClientIds && wonClientIds.has(person.id)) || (person.wonEngagements?.count > 0)) return 'Client'

  if ((Number(person.paidAmount) || 0) > 0) return 'Past'

  const lastReachOut = Math.max(0, ...(person.outreachTimeline || [])
    .filter(t => t.type === 'reach_out')
    .map(t => new Date(t.occurred_at || 0).getTime() || 0))
  if (lastReachOut > 0 && nowMs - lastReachOut < THIRTY_D) return 'Attempting'

  const created = person.created ? new Date(person.created).getTime() : 0
  if (created > 0 && nowMs - created < THIRTY_D) return 'New'

  return 'Nurturing'
}

// Display config for the directory: chip styleKey + label per status.
export const CLIENT_STATUS_META = {
  New:        { label: 'New',             styleKey: 'New' },
  Attempting: { label: 'Attempting',      styleKey: 'Attempting' },
  Nurturing:  { label: 'Nurturing',       styleKey: 'Nurturing' },
  Active:     { label: 'Active',          styleKey: 'Active' },
  Client:     { label: 'Client',          styleKey: 'Client' },
  Past:       { label: 'Past client',     styleKey: 'Past' },
  no_contact: { label: 'No contact info', styleKey: 'quiet' },
}
