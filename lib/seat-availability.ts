// lib/seat-availability.ts
// ─────────────────────────────────────────────────────────────
// issue 216 — the ONE answer to "is there a seat free at this tier?"
//
// THE BUG THIS EXISTS TO KILL: three surfaces asked that question three
// different ways and got three different answers about the same three rows.
// On a live location the roster drew two ghost rows captioned "Paid for and
// ready", the seat card said "1 available" twice, and the invite modal —
// opened from one of those very rows — said none were available and offered
// to sell another. The roster and the card counted unassigned seats; the
// modal subtracted outstanding invites, which is what the server does. The
// modal was right and the two surfaces the owner sees first were wrong.
//
// A seat held by an unaccepted invite is PAID FOR but NOT SEATABLE:
// /api/hub_users/invite counts the same pending invites and 409s
// `no_available_seats`. So "available" has to mean "seatable today"
// everywhere, or a surface is writing a cheque the API won't honour.
//
// These functions are the single definition, and they mirror the server gate
// exactly — same per-tier scope, same expiry rule, same subtraction. The
// SeatsContext in BeeHub delegates to them; nothing else may re-derive it.
// ─────────────────────────────────────────────────────────────

export type SeatRow = {
  id: string
  tier: string
  user_id?: string | null
  status?: string | null
  scheduled_removal_at?: string | null
}

export type PendingInvite = {
  tier: string
  accepted_at?: string | null
  invite_expires_at?: string | null
}

export type TierSeatCounts = {
  total: number
  assigned: number
  /** Seatable TODAY — pending invites already subtracted. */
  available: number
  scheduled: number
  /** Paid seats held by an outstanding invite. */
  pending: number
}

// A seat counts toward the pool while it is active. Rows created before the
// status column existed are treated as active, matching the original filters.
function isActive(s: SeatRow): boolean {
  return s.status === 'active' || !s.status
}

// Open = active, unassigned, and not already on its way out. A seat with a
// scheduled removal is deliberately NOT open: seating someone there hands
// them a login that dies on the removal date, and both the server gate and
// the accept route refuse it.
export function isOpenSeat(s: SeatRow): boolean {
  return isActive(s) && !s.user_id && !s.scheduled_removal_at
}

export function openSeatsAtTier(seats: SeatRow[], tier: string): SeatRow[] {
  return (seats || []).filter((s) => s.tier === tier && isOpenSeat(s))
}

// Outstanding invites that still reserve a seat at this tier.
//
// An EXPIRED invite can never be accepted — the accept route 410s it — so it
// must not reserve a seat forever. A null expiry means non-expiring. Same
// rule as the `invite_expires_at.is.null,invite_expires_at.gt.now` filter in
// /api/hub_users/invite.
export function pendingInviteCount(
  pendingInvites: PendingInvite[],
  tier: string,
  nowMs: number = Date.now(),
): number {
  return (pendingInvites || []).filter(
    (p) =>
      p.tier === tier &&
      !p.accepted_at &&
      (!p.invite_expires_at || new Date(p.invite_expires_at).getTime() > nowMs),
  ).length
}

// How many seats at a tier an invite could be sent against right now.
// This is the number the server will agree with.
export function availableSeatsForTier(
  seats: SeatRow[],
  pendingInvites: PendingInvite[],
  tier: string,
  nowMs: number = Date.now(),
): number {
  return Math.max(
    0,
    openSeatsAtTier(seats, tier).length - pendingInviteCount(pendingInvites, tier, nowMs),
  )
}

// WHICH individual seats are invitable.
//
// Open seats and outstanding invites are both fungible within a tier — no
// column ties an invite to a specific row — so the allocation is positional:
// with N open seats and P pending invites at a tier, the first P rows are
// spoken for and the remaining N−P are free. Returning the SET rather than a
// count is what lets the roster mark the right rows as reserved instead of
// silently dropping one a paying owner can see.
export function invitableSeatIds(
  seats: SeatRow[],
  pendingInvites: PendingInvite[],
  nowMs: number = Date.now(),
): Set<string> {
  const ids = new Set<string>()
  const tiers = new Set((seats || []).map((s) => s.tier))
  tiers.forEach((tier) => {
    const open = openSeatsAtTier(seats, tier)
    const reserved = Math.min(open.length, pendingInviteCount(pendingInvites, tier, nowMs))
    open.slice(reserved).forEach((s) => ids.add(s.id))
  })
  return ids
}

// Per-tier pool summary for the billing card and the roster.
//
// `available` is pending-aware for the reason at the top of this file.
// `pending` rides alongside so a surface can EXPLAIN a paid-but-reserved
// seat rather than appearing to lose one: subtracting silently would match
// the server's number while hiding a seat the owner is paying for, which is
// a different lie, not a fix.
export function seatCountsByTier(
  seats: SeatRow[],
  pendingInvites: PendingInvite[],
  nowMs: number = Date.now(),
): Record<string, TierSeatCounts> {
  const acc: Record<string, TierSeatCounts> = {}
  for (const s of seats || []) {
    if (!isActive(s)) continue
    acc[s.tier] = acc[s.tier] || { total: 0, assigned: 0, available: 0, scheduled: 0, pending: 0 }
    acc[s.tier].total++
    if (s.scheduled_removal_at) acc[s.tier].scheduled++
    if (s.user_id) acc[s.tier].assigned++
    else if (!s.scheduled_removal_at) acc[s.tier].available++
  }
  for (const tier of Object.keys(acc)) {
    const reserved = Math.min(acc[tier].available, pendingInviteCount(pendingInvites, tier, nowMs))
    acc[tier].pending = reserved
    acc[tier].available -= reserved
  }
  return acc
}

// Seat ROWS free to invite into, across every tier.
export function availableSeatRows(
  seats: SeatRow[],
  pendingInvites: PendingInvite[],
  nowMs: number = Date.now(),
): SeatRow[] {
  const invitable = invitableSeatIds(seats, pendingInvites, nowMs)
  return (seats || []).filter((s) => invitable.has(s.id))
}
