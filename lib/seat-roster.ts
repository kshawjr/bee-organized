// lib/seat-roster.ts — issue 226 step 5.
//
// Seats as PEOPLE. Turns the three raw inputs an admin panel has — seat rows,
// outstanding invites, and the user roster — into one annotated list where
// every seat says who holds it, what it costs, and which of three states it
// is in.
//
// Pure. No I/O, no clock unless you pass one.

import { calculateOwnerSubtotal, type TierPrices, DEFAULT_TIER_PRICES } from './subscription-math'
import { invitableSeatIds, type SeatRow, type PendingInvite } from './seat-availability'

// ── The three states ──────────────────────────────────────────
//
//   held     someone is in the seat. seat.user_id resolves to a person.
//   invited  the seat is spoken for by an unaccepted invitation. Paid for,
//            nobody in it yet, but somebody has been asked.
//   empty    open, and NOBODY HAS BEEN ASKED. Paid for and idle.
//
// The third one is the one worth having. Rolled in with `invited` it reads as
// "waiting on someone", which is a story that ends by itself; on its own it
// reads as what it is — a seat being billed for that nobody is using and
// nobody is on their way to using. That is an admin action, not a wait.
export type SeatHolderState = 'held' | 'invited' | 'empty'

export type SeatRosterPerson = {
  id: string
  name: string | null
  email: string | null
}

export type SeatRosterEntry = {
  seatId: string
  tier: string
  state: SeatHolderState
  // Present when state === 'held'.
  holder: SeatRosterPerson | null
  // Present when state === 'invited' — who was asked, and when.
  invite: {
    id: string
    email: string | null
    fullName: string | null
    createdAt: string | null
    expiresAt: string | null
  } | null
  // What this seat costs PER YEAR, in whole dollars, at today's catalog
  // rates. This is the headline figure on the row.
  annualRate: number
  // What was actually charged when the seat was added, in CENTS, straight
  // off the row. Detail only — see below.
  proratedCostCents: number | null
  // Scheduled removals ride ALONGSIDE the state rather than replacing it: a
  // seat scheduled for removal is still held (or still empty) until it goes.
  scheduledRemovalAt: string | null
  isPrimary: boolean
}

// ── Why the annual rate is the headline, and prorated_cost is not ──
//
// prorated_cost is a HISTORICAL fact: what this seat cost for the remainder
// of the year it was bought in. A seat added a month before renewal carries a
// tiny figure that says nothing about what it costs to keep. Two identical
// manager seats bought eight months apart carry different numbers, and
// neither is "what this seat costs". Summing the column would not give the
// location's annual bill either.
//
// The annual rate answers the question the roster is actually asked — what am
// I paying for this person each year — and it sums to the location's total,
// because it is computed from the same co-owner rule the total is.
//
// THE CO-OWNER RULE. A location's SECOND owner seat bills at the MANAGER
// rate (lib/seat-plan's planBillingLines is where that is written down;
// calculateOwnerSubtotal is subscription-math's expression of the same
// thing). So per-seat rates cannot be a tier lookup: the first owner seat
// costs the owner rate, the second costs the manager rate, and any other
// tier costs its own. Allocation is by seat order, which is the order the
// server returns (added_at ascending) — the earliest owner seat is the one
// charged at the owner rate.
function annualRateFor(
  tier: string,
  ownerIndex: number,
  prices: TierPrices,
): number {
  if (tier !== 'owner') return prices[tier] ?? 0
  // calculateOwnerSubtotal(n) - calculateOwnerSubtotal(n-1) is the marginal
  // cost of the nth owner seat. Differencing rather than restating keeps the
  // rule in exactly one place.
  return (
    calculateOwnerSubtotal(ownerIndex + 1, prices) -
    calculateOwnerSubtotal(ownerIndex, prices)
  )
}

export function buildSeatRoster(args: {
  seats: SeatRow[]
  pendingInvites?: PendingInvite[]
  users?: Array<{ id?: string; name?: string | null; full_name?: string | null; email?: string | null }>
  prices?: TierPrices
  nowMs?: number
}): SeatRosterEntry[] {
  const {
    seats = [],
    pendingInvites = [],
    users = [],
    prices = DEFAULT_TIER_PRICES as unknown as TierPrices,
    nowMs = Date.now(),
  } = args

  const active = seats.filter((s) => (s as any).status ? (s as any).status === 'active' : true)

  const personById = new Map<string, SeatRosterPerson>()
  for (const u of users) {
    if (!u?.id) continue
    personById.set(String(u.id), {
      id: String(u.id),
      name: u.full_name ?? u.name ?? null,
      email: u.email ?? null,
    })
  }

  // Seats free to invite INTO. Its complement, among open seats, is the set
  // already spoken for by an invitation — the same positional allocation the
  // roster and the server gate already agree on (issue 216). Nothing in the
  // schema ties an invite to a specific row, so there is no better answer
  // than position, and inventing a different one here would be a third
  // implementation of the thing 216 collapsed into one.
  const invitable = invitableSeatIds(active, pendingInvites, nowMs)

  // Unaccepted, unexpired invites per tier, oldest first — matched to
  // reserved seats in the same order.
  const invitesByTier = new Map<string, PendingInvite[]>()
  for (const inv of pendingInvites || []) {
    if ((inv as any).accepted_at) continue
    const exp = (inv as any).invite_expires_at
    if (exp && new Date(exp).getTime() <= nowMs) continue
    const tier = String((inv as any).tier || '')
    if (!invitesByTier.has(tier)) invitesByTier.set(tier, [])
    invitesByTier.get(tier)!.push(inv)
  }
  // forEach rather than for…of over .values(): the tsconfig target predates
  // downlevelIteration, so iterating a Map iterator directly fails the build.
  invitesByTier.forEach((list) => {
    list.sort((a: any, b: any) =>
      String(a.created_at || '').localeCompare(String(b.created_at || '')))
  })
  const inviteCursor = new Map<string, number>()

  let ownerSeen = 0

  return active.map((seat) => {
    const tier = String(seat.tier || '')
    const annualRate = annualRateFor(tier, tier === 'owner' ? ownerSeen : 0, prices)
    if (tier === 'owner') ownerSeen += 1

    const base = {
      seatId: String(seat.id),
      tier,
      annualRate,
      proratedCostCents:
        typeof (seat as any).prorated_cost === 'number' ? (seat as any).prorated_cost : null,
      scheduledRemovalAt: (seat as any).scheduled_removal_at ?? null,
      isPrimary: !!(seat as any).is_primary,
    }

    if (seat.user_id) {
      return {
        ...base,
        state: 'held' as const,
        holder: personById.get(String(seat.user_id)) || {
          id: String(seat.user_id),
          name: null,
          email: null,
        },
        invite: null,
      }
    }

    // Open. Reserved by an invitation, or genuinely empty.
    if (!invitable.has(String(seat.id))) {
      const idx = inviteCursor.get(tier) ?? 0
      const inv: any = (invitesByTier.get(tier) || [])[idx] || null
      inviteCursor.set(tier, idx + 1)
      if (inv) {
        return {
          ...base,
          state: 'invited' as const,
          holder: null,
          invite: {
            id: String(inv.id),
            email: inv.email ?? null,
            fullName: inv.full_name ?? null,
            createdAt: inv.created_at ?? null,
            expiresAt: inv.invite_expires_at ?? null,
          },
        }
      }
    }

    return { ...base, state: 'empty' as const, holder: null, invite: null }
  })
}

// Convenience for the roster header: how many of each state.
export function tallySeatStates(
  entries: readonly SeatRosterEntry[],
): Record<SeatHolderState, number> {
  const tally: Record<SeatHolderState, number> = { held: 0, invited: 0, empty: 0 }
  for (const e of entries) tally[e.state] += 1
  return tally
}
