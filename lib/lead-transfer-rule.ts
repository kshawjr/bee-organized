// lib/lead-transfer-rule.ts
// ─────────────────────────────────────────────────────────────
// WHO may move a lead between locations, WHICH leads may move, and WHEN a
// reason is owed. One source, so the route (the guard) and the card (the
// courtesy) cannot disagree. PURE: no React, no fetch, no supabase — safe in
// a browser bundle.
//
// WHO — corporate only (super_admin / admin), any lead, any location. An
// owner cannot move a lead out of their own location: which franchise a lead
// belongs to is a franchise matter, the same reasoning as the territory
// screen (lib/territory-access, Kevin 30 Sep 2026). Vocabulary is the RAW
// hub_users.role.
//
// WHICH — until 1 Oct 2026 the transfer was built for one job, emptying the
// unrouted queue, and a lead that already had a home could not be moved at
// all. It can now, with TWO exceptions, and they are the whole point of this
// file:
//
//   in_jobber       The lead has reached Jobber — a client id, a request, a
//                   quote, a job, an invoice, or a recorded send. Every
//                   location has its OWN Jobber account, so that record
//                   exists in the old location's Jobber and nowhere else. A
//                   moved lead would point "Open in Jobber" at an account the
//                   new location cannot open, the old account's updates would
//                   no longer find it, and its invoices and payments would
//                   sit at one location while the client sat at another.
//                   Measured 1 Oct 2026: 43,733 of 44,431 leads. They are
//                   CLIENTS of the location that serves them, not misrouted
//                   enquiries.
//
//   has_engagement  The lead has an engagement here, open or closed. An
//                   engagement carries its own location and is what the
//                   reports count, so moving the lead alone would split them,
//                   and moving both would rewrite one location's lost-deal
//                   numbers into another's. That is a ruling, not a default —
//                   so it is refused until Kevin makes it. Measured the same
//                   day: of 29 real not-in-Jobber leads sitting outside their
//                   zip's territory, 18 are held by this rule (every one a
//                   closed card, none open) and 11 are free to move.
//
// WHEN A REASON IS OWED — always, for a lead that already has a home. Routing
// a lead out of the unrouted queue needs none: that IS the reason. Taking a
// lead away from a location that had it is deliberate, and the record should
// say why.
// ─────────────────────────────────────────────────────────────

export const TRANSFER_ROLES = ['super_admin', 'admin'] as const

export function canTransferLeads(dbRole: string | null | undefined): boolean {
  return (TRANSFER_ROLES as readonly string[]).includes(dbRole ?? '')
}

// The unrouted holding pen. A literal, like the route's own — lib/hub-scope
// owns the constant but pulls server reads this file must not carry.
const UNROUTED_SLUG = 'loc_other'

export function transferNeedsReason(originSlug: string | null | undefined): boolean {
  return !!originSlug && originSlug !== UNROUTED_SLUG
}

export const TRANSFER_REASON_MAX = 500

export type TransferBlock = 'in_jobber' | 'has_engagement'

/**
 * Why this lead cannot move, or null when it can. in_jobber wins when both
 * are true — it is the harder fact and the one a person can do nothing about.
 */
export function transferBlockFor(facts: {
  inJobber: boolean
  engagementCount: number
}): TransferBlock | null {
  if (facts.inJobber) return 'in_jobber'
  if (facts.engagementCount > 0) return 'has_engagement'
  return null
}

// The route's error codes for the two refusals — the same strings the modal
// turns back into the sentences below.
export const TRANSFER_BLOCK_ERROR: Record<TransferBlock, string> = {
  in_jobber: 'lead_in_jobber',
  has_engagement: 'lead_has_engagement',
}

export const TRANSFER_BLOCK_COPY: Record<TransferBlock, { short: string; long: string }> = {
  in_jobber: {
    short: "Can't be moved — already in Jobber.",
    long: "This client is already in Jobber. Each location has its own Jobber account, so their record, requests and invoices live in this location's Jobber and can't follow them to another one.",
  },
  has_engagement: {
    short: "Can't be moved — has an engagement here.",
    long: "This lead has an engagement at this location, and an engagement is what the reports count. Moving the lead would leave that card behind or move one location's numbers into another's.",
  },
}

// Every refusal the transfer route can return, in words. Anything not listed
// falls through to the raw code — better an odd word than a wrong sentence.
const TRANSFER_ERROR_COPY: Record<string, string> = {
  lead_in_jobber: TRANSFER_BLOCK_COPY.in_jobber.long,
  lead_has_engagement: TRANSFER_BLOCK_COPY.has_engagement.long,
  reason_required: 'Say why this lead is moving — the reason is kept on its timeline.',
  reason_too_long: `Keep the reason under ${TRANSFER_REASON_MAX} characters.`,
  forbidden_admin_only: 'Only corporate can move a lead between locations.',
  already_at_destination: 'This lead is already at that location.',
  lead_changed: 'This lead changed while you were moving it. Close this and open it again.',
  destination_has_linked_duplicate: 'That location already has this person as a Jobber client.',
}

export function transferErrorCopy(code: string | null | undefined): string | null {
  if (!code) return null
  return TRANSFER_ERROR_COPY[code] || code
}
