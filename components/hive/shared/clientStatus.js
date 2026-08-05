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
//   Settled    — issue 187: no won, no paid, but ≥1 engagement ON RECORD
//                (person.engagementCount) and none of them OPEN (the Active
//                check already passed). Every engagement is therefore a
//                Closed Lost one — a decision someone made — so AGE must
//                not re-derive them into New/Attempting and drop them back
//                into the Inbox. They settle to Nurturing (below), off the
//                front-of-funnel and uncounted by the nav badge, until
//                something new happens (see the two guards on that rule).
//   Attempting — none of the above AND a human reach_out touchpoint
//                within the last 30 days (being actively worked).
//   New        — none of the above AND created < 30 days ago.
//   Nurturing  — everyone else: inquired/imported, never booked or went
//                cold, OR settled-lost (issue 187). This is the marketable
//                pool (§5) — re-marketable, but not front-of-funnel work.
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

  // issue 187 — settled-lost. Reaching here already means not Active (no OPEN
  // engagement, else openClientIds returned above), not Client (no won), not
  // Past (no paid). So if the client has ANY engagement on record, every one
  // of them is a Closed Lost engagement — a decision someone made. Age must
  // not override that decision by re-deriving them into New/Attempting and
  // back into the Inbox/badge. Settle them into the Nurturing pool instead.
  // Two guards keep this closed-UNTIL-something-new, never closed-forever:
  //   · engagementCount is 0 for a lead that never had an engagement (a raw
  //     Inbox lead — untouched, still derives New/Attempting by age below).
  //   · a NEW or reopened engagement is OPEN, so it lands in openClientIds and
  //     returns 'Active' above, before this line ever runs.
  // (engagementCount is the hydration roll-up — the all-engagements sweep in
  // _hub-page.tsx, same durability profile as person.wonEngagements.)
  if ((Number(person.engagementCount) || 0) > 0) return 'Nurturing'

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
