// components/hive/shared/clientStatus.js
// ─────────────────────────────────────────────────────────────
// PURE module — client status DERIVATION (doc §2), resolving the open
// 'stored vs derived' question as DERIVED-for-now. When a stored
// client_status column lands (later step-4 item), THIS module is the
// single place to swap: readers keep calling deriveClientStatus.
//
// Inputs are what's already client-side: the mapped Person (leads row +
// joined children) and the set of client_ids with OPEN engagements.
//
// RULES (checked in order):
//   no_contact — no email AND no phone. (True is_junk leads are already
//                excluded upstream — they live in the Recycle Bin, not
//                the directory — so this catches reachability, the §2
//                junk PRECONDITION, on not-yet-junked rows.)
//   Active     — ≥1 OPEN engagement.
//   Past       — no open engagements AND paid history (paidAmount > 0).
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
// KNOWN APPROXIMATION: 'no engagements ever' (the doc's New/Past
// precondition) can't be checked client-side — only OPEN engagements
// ship. A client whose engagements ALL closed as Lost (no paid history)
// falls through to Attempting/New/Nurturing by age+activity, which reads
// correctly on the board anyway. The stored-status swap fixes this.
// ─────────────────────────────────────────────────────────────

export const CLIENT_STATUS_ORDER = ['New', 'Attempting', 'Nurturing', 'Active', 'Past', 'no_contact']

const THIRTY_D = 30 * 24 * 60 * 60 * 1000

export function deriveClientStatus(person, openClientIds, nowMs = Date.now()) {
  const email = (person.email || '').trim()
  const phone = (person.phone || '').trim()
  if (!email && !phone) return 'no_contact'

  if (openClientIds && openClientIds.has(person.id)) return 'Active'

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
  Past:       { label: 'Past client',     styleKey: 'Past' },
  no_contact: { label: 'No contact info', styleKey: 'quiet' },
}
