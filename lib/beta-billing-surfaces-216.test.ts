// @vitest-environment node
//
// issue 216 — the pure halves of six independent billing-surface defects.
// The component-level halves live in beta-billing-surfaces-216.test.tsx.
//
//   B — seat availability was computed three ways. lib/seat-availability is
//       now the single definition, and it must agree with the server gate in
//       /api/hub_users/invite (unassigned active seats minus unexpired,
//       unaccepted invites at the SAME tier).
//   D — the billing summary priced seats with a flat tier × price reduce and
//       skipped the co-owner rule, reading $1,500 where the truth is $1,350.
//   F — the Billing Snapshot bucketed payment_source with keys that do not
//       exist in the database.
import { describe, it, expect } from 'vitest'
import {
  seatCountsByTier,
  availableSeatsForTier,
  availableSeatRows,
  invitableSeatIds,
  pendingInviteCount,
  isOpenSeat,
} from '@/lib/seat-availability'
import {
  calculateSeatTotal,
  bucketByPaymentSource,
  DEFAULT_TIER_PRICES,
} from '@/lib/subscription-math'

const NOW = new Date('2026-08-14T18:00:00Z').getTime()

// The live Fort Lauderdale shape that produced the report: one claimed owner
// seat, one OPEN owner seat (the paid co-owner seat), one OPEN manager seat,
// and one unaccepted manager invite holding that manager seat.
const FTL_SEATS = [
  { id: 'own-assigned', tier: 'owner', user_id: 'u1', status: 'active', scheduled_removal_at: null },
  { id: 'own-open', tier: 'owner', user_id: null, status: 'active', scheduled_removal_at: null },
  { id: 'mgr-open', tier: 'manager', user_id: null, status: 'active', scheduled_removal_at: null },
]
const FTL_INVITES = [
  { tier: 'owner', accepted_at: '2026-08-14T13:08:39Z', invite_expires_at: '2026-08-21T13:07:59Z' },
  { tier: 'manager', accepted_at: null, invite_expires_at: '2026-08-21T16:28:22Z' },
]

// ── B — one definition of availability ────────────────────────────────
describe('issue 216 B — seat availability is pending-aware everywhere', () => {
  it('the manager seat held by an unaccepted invite is NOT available', () => {
    expect(availableSeatsForTier(FTL_SEATS, FTL_INVITES, 'manager', NOW)).toBe(0)
  })

  it('the open owner seat IS available — its invite was accepted', () => {
    expect(availableSeatsForTier(FTL_SEATS, FTL_INVITES, 'owner', NOW)).toBe(1)
  })

  it('seatCountsByTier reports the same availability the modal and server do', () => {
    const c = seatCountsByTier(FTL_SEATS, FTL_INVITES, NOW)
    // The card used to say "1 available" for manager while the modal said 0.
    expect(c.manager.available).toBe(0)
    expect(c.manager.pending).toBe(1)
    expect(c.manager.total).toBe(1)
    expect(c.owner).toEqual({ total: 2, assigned: 1, available: 1, scheduled: 0, pending: 0 })
  })

  it('a reserved seat is still counted as PAID — total is unchanged', () => {
    const c = seatCountsByTier(FTL_SEATS, FTL_INVITES, NOW)
    // Subtracting it from `total` would hide a seat the owner pays for.
    expect(c.manager.total).toBe(1)
    expect(c.manager.available + c.manager.pending).toBe(1)
  })

  it('the roster can tell WHICH row is reserved, not just how many', () => {
    const invitable = invitableSeatIds(FTL_SEATS, FTL_INVITES, NOW)
    expect(invitable.has('own-open')).toBe(true)
    expect(invitable.has('mgr-open')).toBe(false)
    // an assigned seat is never invitable
    expect(invitable.has('own-assigned')).toBe(false)
  })

  it('availableSeatRows returns only the invitable rows', () => {
    expect(availableSeatRows(FTL_SEATS, FTL_INVITES, NOW).map(s => s.id)).toEqual(['own-open'])
  })

  it('an EXPIRED invite stops reserving its seat', () => {
    const expired = [{ tier: 'manager', accepted_at: null, invite_expires_at: '2026-08-01T00:00:00Z' }]
    expect(availableSeatsForTier(FTL_SEATS, expired, 'manager', NOW)).toBe(1)
    expect(pendingInviteCount(expired, 'manager', NOW)).toBe(0)
  })

  it('a null expiry is treated as non-expiring, matching the server filter', () => {
    const forever = [{ tier: 'manager', accepted_at: null, invite_expires_at: null }]
    expect(pendingInviteCount(forever, 'manager', NOW)).toBe(1)
    expect(availableSeatsForTier(FTL_SEATS, forever, 'manager', NOW)).toBe(0)
  })

  it('invites at another tier never reserve this tier’s seats', () => {
    const otherTier = [{ tier: 'readonly', accepted_at: null, invite_expires_at: null }]
    expect(availableSeatsForTier(FTL_SEATS, otherTier, 'manager', NOW)).toBe(1)
  })

  it('a seat scheduled for removal is not open, and not counted available', () => {
    const seats = [{ id: 's1', tier: 'manager', user_id: null, status: 'active', scheduled_removal_at: '2027-08-14' }]
    expect(isOpenSeat(seats[0])).toBe(false)
    expect(availableSeatsForTier(seats, [], 'manager', NOW)).toBe(0)
    expect(seatCountsByTier(seats, [], NOW).manager.available).toBe(0)
    expect(seatCountsByTier(seats, [], NOW).manager.scheduled).toBe(1)
  })

  it('an inactive seat is out of the pool entirely', () => {
    const seats = [{ id: 's1', tier: 'manager', user_id: null, status: 'inactive', scheduled_removal_at: null }]
    expect(availableSeatsForTier(seats, [], 'manager', NOW)).toBe(0)
    expect(seatCountsByTier(seats, [], NOW).manager).toBeUndefined()
  })

  it('more pending invites than open seats never yields a negative count', () => {
    const many = [
      { tier: 'manager', accepted_at: null, invite_expires_at: null },
      { tier: 'manager', accepted_at: null, invite_expires_at: null },
      { tier: 'manager', accepted_at: null, invite_expires_at: null },
    ]
    expect(availableSeatsForTier(FTL_SEATS, many, 'manager', NOW)).toBe(0)
    expect(seatCountsByTier(FTL_SEATS, many, NOW).manager.available).toBe(0)
    expect(invitableSeatIds(FTL_SEATS, many, NOW).has('mgr-open')).toBe(false)
  })
})

// ── D — the co-owner rule owns seat pricing ───────────────────────────
describe('issue 216 D — the billing summary honours the co-owner rule', () => {
  // The exact expression the Settings header now evaluates.
  const summaryTotal = (counts: Record<string, { total: number }>, prices = DEFAULT_TIER_PRICES) =>
    calculateSeatTotal(
      Object.entries(counts).map(([tier, c]) => ({ tier: tier as any, count: c?.total || 0 })),
      prices,
    )

  it('owner + co-owner + manager reads $1,350, not $1,500', () => {
    const counts = seatCountsByTier(FTL_SEATS, FTL_INVITES, NOW)
    // The old flat reduce: 550*2 + 400 = 1500.
    const flat = Object.entries(counts).reduce(
      (sum, [tier, c]) => sum + (DEFAULT_TIER_PRICES as any)[tier] * (c?.total || 0), 0,
    )
    expect(flat).toBe(1500)
    expect(summaryTotal(counts as any)).toBe(1350)
  })

  it('the 2nd owner seat bills at the manager rate', () => {
    expect(summaryTotal({ owner: { total: 1 } })).toBe(550)
    expect(summaryTotal({ owner: { total: 2 } })).toBe(950) // 550 + 400
  })

  it('the summary matches what the seat row already stores as prorated_cost', () => {
    // Fort Lauderdale's open owner seat carries prorated_cost = 40000 cents —
    // the manager rate. The screen and the database now agree.
    const coOwnerAnnual = summaryTotal({ owner: { total: 2 } }) - summaryTotal({ owner: { total: 1 } })
    expect(coOwnerAnnual).toBe(DEFAULT_TIER_PRICES.manager)
  })

  it('non-owner tiers are unaffected — flat multiply is still correct there', () => {
    expect(summaryTotal({ manager: { total: 3 } })).toBe(1200)
  })
})

// ── F — snapshot buckets match the database ───────────────────────────
describe('issue 216 F — Billing Snapshot buckets the real payment_source values', () => {
  // The production distribution scout 215 measured: 55 locations.
  const PROD = [
    ...Array(19).fill({ payment_source: 'direct' }),
    ...Array(3).fill({ payment_source: 'direct' }),
    ...Array(31).fill({ payment_source: 'none' }),
    { payment_source: 'prepaid_corporate' },
    { payment_source: 'corporate_sponsored' },
  ]

  it('corporate flavours no longer collapse into "none"', () => {
    const b = bucketByPaymentSource(PROD)
    expect(b.prepaid_corporate).toBe(1)
    expect(b.corporate_sponsored).toBe(1)
    expect(b.direct).toBe(22)
    expect(b.none).toBe(31)
    // The card previously read 22 direct / 33 "not configured".
    expect(b.none).not.toBe(33)
  })

  it('every location is still counted exactly once', () => {
    const b = bucketByPaymentSource(PROD)
    expect(b.prepaid_corporate + b.corporate_sponsored + b.direct + b.none).toBe(PROD.length)
  })

  it('null, missing and unrecognised sources fall to "none"', () => {
    const b = bucketByPaymentSource([
      { payment_source: null },
      {},
      { payment_source: 'something_new' },
    ])
    expect(b.none).toBe(3)
  })

  it('an empty fleet reports all zeroes rather than throwing', () => {
    expect(bucketByPaymentSource([])).toEqual({
      prepaid_corporate: 0, corporate_sponsored: 0, direct: 0, none: 0,
    })
  })
})
