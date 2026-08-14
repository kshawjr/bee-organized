// lib/beta-billing-state-226.test.ts — issue 226 step 2.
//
// The fixture below is the REAL production distribution, read read-only on
// 2026-08-14: 55 rows in the table, 26 active seats. Every count asserted here
// was verified against Supabase, not assumed. NOW is pinned to that date so
// the paid-through comparisons stay meaningful as the suite ages.
//
// The fixture is FIFTY-FOUR, not 55: loc_other ('Other') is a routing bucket
// and the elevated feed no longer selects it (issue 226 step 2). It is
// excluded here for the same reason, and a source-level test below pins the
// exclusion so the fixture and the query cannot drift apart.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  BILLING_STATES,
  BILLING_STATE_LABELS,
  classifyBillingState,
  tallyBillingStates,
  deriveSeatComposition,
  type BillingStateInput,
} from './billing-state'
import { calculateSeatTotal } from './subscription-math'

const NOW = new Date('2026-08-14T12:00:00Z')

// ── The real 54 ───────────────────────────────────────────────
// 20 active (19 direct + 1 corporate_sponsored), 34 onboarding — 35 in the
// table, minus loc_other. 15 of the active ones hold a Stripe subscription;
// 5 do not.

const ACTIVE_WITH_SUBSCRIPTION = [
  ['Boston', '2027-08-05'], ['Carmel', '2027-08-04'],
  ['Fort Lauderdale', '2027-08-14'], ['Kansas City', '2027-05-01'],
  ['Lake Norman', '2027-08-03'], ['North Jersey', '2027-08-05'],
  ['North Pittsburgh', '2027-08-10'], ['Northwest Arkansas', '2027-07-01'],
  ['Northwest Austin', '2027-08-12'], ['Palm Beach', '2027-05-01'],
  ['Sioux Falls', '2027-08-13'], ['South Charlotte', '2027-08-13'],
  ['Southeast Nashville', '2027-08-14'], ['Temecula', '2027-07-01'],
  ['West Raleigh', '2027-08-05'],
].map(([name, paid]) => ({
  name,
  lifecycle_status: 'active',
  subscription_status: 'active',
  payment_source: 'direct',
  paid_through_date: paid,
  stripe_subscription_id: `sub_${name.replace(/\W/g, '')}`,
}))

// The pre-Stripe cohort: active, direct, no Stripe customer and no
// subscription, carried by a future paid_through_date that corporate bought.
const PRE_STRIPE_COHORT = [
  ['Omaha', '2027-05-01'], ['Portland', '2027-07-01'],
  ['Scottsdale', '2027-05-01'], ['Seattle', '2027-05-01'],
].map(([name, paid]) => ({
  name,
  lifecycle_status: 'active',
  subscription_status: 'active',
  payment_source: 'direct',
  paid_through_date: paid,
  stripe_subscription_id: null,
}))

// Active, sponsored by corporate through 2030, no Stripe subscription by
// design. Correctly configured — the old Billing Snapshot mis-bucketed it.
const TEST_LOCATION = {
  name: 'Test Location',
  lifecycle_status: 'active',
  subscription_status: 'active',
  payment_source: 'corporate_sponsored',
  paid_through_date: '2030-01-01',
  stripe_subscription_id: null,
}

// 34 onboarding, once loc_other is out. TWO of them carry a future
// paid_through_date; the other 32 carry none. None holds a Stripe
// subscription. (The third such row in the table was 'Other' itself.)
const ONBOARDING_WITH_FUTURE_DATE = [
  ['Oklahoma City', 'direct', '2027-07-01'],
  ['San Antonio', 'direct', '2027-07-01'],
].map(([name, src, paid]) => ({
  name,
  lifecycle_status: 'onboarding',
  subscription_status: 'deferred',
  payment_source: src,
  paid_through_date: paid,
  stripe_subscription_id: null,
}))

const ONBOARDING_BARE = Array.from({ length: 32 }, (_, i) => ({
  name: `Onboarding ${i + 1}`,
  lifecycle_status: 'onboarding',
  subscription_status: 'deferred',
  payment_source: 'none',
  paid_through_date: null,
  stripe_subscription_id: null,
}))

const FLEET: (BillingStateInput & { name: string })[] = [
  ...ACTIVE_WITH_SUBSCRIPTION,
  ...PRE_STRIPE_COHORT,
  TEST_LOCATION,
  ...ONBOARDING_WITH_FUTURE_DATE,
  ...ONBOARDING_BARE,
]

const stateOf = (name: string) =>
  classifyBillingState(FLEET.find((l) => l.name === name)!, NOW)

describe('the fixture matches the production shape it claims to', () => {
  it('is 54 locations: 20 active, 34 onboarding — the table holds 55', () => {
    expect(FLEET).toHaveLength(54)
    expect(FLEET.filter((l) => l.lifecycle_status === 'active')).toHaveLength(20)
    expect(FLEET.filter((l) => l.lifecycle_status === 'onboarding')).toHaveLength(34)
  })

  it('contains no routing bucket — loc_other is excluded upstream', () => {
    expect(FLEET.find((l) => l.name === 'Other')).toBeUndefined()
  })

  // Pins change 2 to the query itself, so the fixture above cannot quietly
  // stop describing what the feed actually returns.
  it('the elevated locations feed excludes loc_other', () => {
    const src = readFileSync('app/_hub-page.tsx', 'utf8')
    // Scope to the elevated roster query, not the default-scope block above it
    // (which carries its own, unrelated .neq on the same column).
    const block = src.slice(
      src.indexOf('let initialLocations'),
      src.indexOf('const slackInviteById'),
    )
    expect(block).toContain(`.neq('location_id', LOC_OTHER_SLUG)`)
    expect(block).toContain('stripe_subscription_id')
  })

  it('has 15 Stripe subscriptions, all on active locations', () => {
    const withSub = FLEET.filter((l) => l.stripe_subscription_id)
    expect(withSub).toHaveLength(15)
    expect(withSub.every((l) => l.lifecycle_status === 'active')).toBe(true)
  })

  it('has no past_due location — the state exists, production has none', () => {
    expect(FLEET.filter((l) => l.subscription_status === 'past_due')).toHaveLength(0)
  })
})

describe('every location lands in exactly one state', () => {
  it('the tally sums to the row count', () => {
    const tally = tallyBillingStates(FLEET, NOW)
    const sum = Object.values(tally).reduce((a, b) => a + b, 0)
    expect(sum).toBe(FLEET.length)
    expect(sum).toBe(54)
  })

  it('classifies each location into one of the five declared states', () => {
    for (const loc of FLEET) {
      expect(BILLING_STATES).toContain(classifyBillingState(loc, NOW))
    }
  })

  it('reports the real distribution', () => {
    expect(tallyBillingStates(FLEET, NOW)).toEqual({
      payment_failed: 0,
      billing_normally: 15,
      owe_money_later: 5,
      active_not_billing: 0,
      not_live_yet: 34,
    })
  })

  it('keeps every key present, zeros included', () => {
    const tally = tallyBillingStates([], NOW)
    expect(Object.keys(tally).sort()).toEqual([...BILLING_STATES].sort())
    expect(Object.values(tally).every((n) => n === 0)).toBe(true)
  })

  it('labels every state', () => {
    for (const s of BILLING_STATES) {
      expect(BILLING_STATE_LABELS[s]).toBeTruthy()
    }
  })
})

// ── The overlap the ordering exists to fix ────────────────────
describe('owe_money_later vs active_not_billing', () => {
  it('puts the pre-Stripe cohort in owe_money_later', () => {
    for (const name of ['Omaha', 'Portland', 'Scottsdale', 'Seattle']) {
      expect(stateOf(name)).toBe('owe_money_later')
    }
  })

  it('keeps the pre-Stripe cohort OUT of active_not_billing', () => {
    for (const name of ['Omaha', 'Portland', 'Scottsdale', 'Seattle']) {
      expect(stateOf(name)).not.toBe('active_not_billing')
    }
  })

  it('puts the corporate-sponsored location in owe_money_later, not the alarm', () => {
    expect(stateOf('Test Location')).toBe('owe_money_later')
  })

  // The reason the ordering is not cosmetic. Scored as INDEPENDENT predicates
  // — the way the approved design first read — "active with no subscription"
  // captures all five, and the alarm bucket permanently contains the backlog.
  it('would collide if the buckets were scored independently', () => {
    const activeNoSub = FLEET.filter(
      (l) => l.lifecycle_status === 'active' && !l.stripe_subscription_id,
    )
    expect(activeNoSub).toHaveLength(5)
    // Ordered, every one of those five is claimed by owe_money_later first.
    expect(activeNoSub.every((l) => classifyBillingState(l, NOW) === 'owe_money_later')).toBe(true)
    expect(tallyBillingStates(FLEET, NOW).active_not_billing).toBe(0)
  })

  // active_not_billing being empty is the design working, not the bucket
  // being broken. It fills as prepaid terms expire — so prove it fires.
  it('fires when a prepaid term has actually lapsed', () => {
    const lapsed = { ...FLEET.find((l) => l.name === 'Omaha')! }
    expect(classifyBillingState(lapsed, new Date('2027-05-02T00:00:00Z')))
      .toBe('active_not_billing')
  })

  it('fires for an active location with no date at all', () => {
    expect(classifyBillingState(
      { lifecycle_status: 'active', subscription_status: 'active', stripe_subscription_id: null, paid_through_date: null },
      NOW,
    )).toBe('active_not_billing')
  })

  // isPaidThroughFuture compares strictly (issue 171): on the renewal day the
  // term is over, which is exactly when billing must resume.
  it('treats a paid_through_date of TODAY as lapsed, not future', () => {
    const today = { lifecycle_status: 'active', subscription_status: 'active', stripe_subscription_id: null, paid_through_date: '2026-08-14' }
    expect(classifyBillingState(today, NOW)).toBe('active_not_billing')
    expect(classifyBillingState({ ...today, paid_through_date: '2026-08-15' }, NOW)).toBe('owe_money_later')
  })
})

// ── A canceled subscription is not a live one ─────────────────
// The Stripe webhook writes subscription_status='canceled' and leaves
// stripe_subscription_id on the row. Keyed on the id alone, such a location
// fell to not_live_yet — a live franchise rendering as "Not live yet" beside
// a status column reading "Active". It needs no sixth state: both
// no-live-subscription buckets reach it correctly.
describe('canceled subscriptions', () => {
  const canceled = {
    lifecycle_status: 'active',
    subscription_status: 'canceled',
    stripe_subscription_id: 'sub_x',
    paid_through_date: null,
  }

  it('is the alarm when nothing covers it', () => {
    expect(classifyBillingState(canceled, NOW)).toBe('active_not_billing')
  })

  it('is a worklist item while a prepaid term still covers it', () => {
    expect(classifyBillingState({ ...canceled, paid_through_date: '2027-05-01' }, NOW))
      .toBe('owe_money_later')
  })

  it('never reads as billing_normally or not_live_yet', () => {
    for (const paid of [null, '2027-05-01', '2020-01-01']) {
      const state = classifyBillingState({ ...canceled, paid_through_date: paid }, NOW)
      expect(state).not.toBe('billing_normally')
      expect(state).not.toBe('not_live_yet')
    }
  })

  it("classifies the same as if the id had been cleared — the id isn't the signal", () => {
    expect(classifyBillingState(canceled, NOW))
      .toBe(classifyBillingState({ ...canceled, stripe_subscription_id: null }, NOW))
  })

  // The change is a no-op on production today: every one of the 15
  // subscriptions is 'active', so nothing moves bucket.
  it('changes nothing about the real distribution', () => {
    expect(tallyBillingStates(FLEET, NOW)).toEqual({
      payment_failed: 0,
      billing_normally: 15,
      owe_money_later: 5,
      active_not_billing: 0,
      not_live_yet: 34,
    })
  })
})

describe('order of precedence', () => {
  it('past_due wins over a live, otherwise-healthy subscription', () => {
    const loc = { ...FLEET.find((l) => l.name === 'Boston')!, subscription_status: 'past_due' }
    expect(classifyBillingState(loc, NOW)).toBe('payment_failed')
  })

  it('past_due wins over a future paid-through date', () => {
    const loc = { ...FLEET.find((l) => l.name === 'Omaha')!, subscription_status: 'past_due' }
    expect(classifyBillingState(loc, NOW)).toBe('payment_failed')
  })

  it('a live subscription wins over a future paid-through date', () => {
    expect(stateOf('Fort Lauderdale')).toBe('billing_normally')
    expect(stateOf('Kansas City')).toBe('billing_normally')
  })
})

describe('not_live_yet', () => {
  it('holds the 32 onboarding locations with no paid-through date', () => {
    expect(tallyBillingStates(ONBOARDING_BARE, NOW).not_live_yet).toBe(32)
  })

  // Kevin's decision, pinned. Bucket 3 carries a lifecycle condition, so an
  // onboarding location holding a prepaid future date reads as not-live
  // rather than as money owed. Oklahoma City and San Antonio are prepaid
  // franchises whose owners have not started onboarding — nothing is owed
  // until somebody is using the product.
  it('DOES hold onboarding locations that carry a future prepaid date', () => {
    for (const name of ['Oklahoma City', 'San Antonio']) {
      expect(stateOf(name)).toBe('not_live_yet')
    }
    expect(tallyBillingStates(ONBOARDING_WITH_FUTURE_DATE, NOW)).toMatchObject({
      owe_money_later: 0,
      not_live_yet: 2,
    })
  })

  // The lifecycle condition is the ONLY thing separating those two rows from
  // the pre-Stripe cohort — same missing subscription, same future date.
  // Flip the lifecycle and the same row becomes a worklist item.
  it('the lifecycle condition is what does the separating', () => {
    const okc = FLEET.find((l) => l.name === 'Oklahoma City')!
    expect(classifyBillingState(okc, NOW)).toBe('not_live_yet')
    expect(classifyBillingState({ ...okc, lifecycle_status: 'active' }, NOW))
      .toBe('owe_money_later')
  })

  it('handles an empty or field-less input without throwing', () => {
    expect(classifyBillingState({}, NOW)).toBe('not_live_yet')
    expect(tallyBillingStates([], NOW).not_live_yet).toBe(0)
  })
})

// ── Seat composition ──────────────────────────────────────────
// Real fleet: 26 active seat rows across 21 locations; 22 owner, 4 manager;
// 2 unassigned. Four distinct shapes, verified against production.

const SEAT_ROWS = [
  ...Array.from({ length: 18 }, (_, i) => ({ location_id: `solo-${i}`, tier: 'owner', user_id: 'u' })),
  // Fort Lauderdale — owner, owner (one unassigned), manager (unassigned).
  { location_id: 'ftl', tier: 'owner', user_id: 'u1' },
  { location_id: 'ftl', tier: 'owner', user_id: null },
  { location_id: 'ftl', tier: 'manager', user_id: null },
  // Kansas City — owner + two managers.
  { location_id: 'kc', tier: 'owner', user_id: 'u2' },
  { location_id: 'kc', tier: 'manager', user_id: 'u3' },
  { location_id: 'kc', tier: 'manager', user_id: 'u4' },
  // One owner + one manager.
  { location_id: 'pair', tier: 'owner', user_id: 'u5' },
  { location_id: 'pair', tier: 'manager', user_id: 'u6' },
]

describe('deriveSeatComposition', () => {
  it('matches the real fleet totals', () => {
    expect(SEAT_ROWS).toHaveLength(26)
    const { seatLinesByLocation, seatCountByLocation } = deriveSeatComposition(SEAT_ROWS)
    expect(Object.keys(seatLinesByLocation)).toHaveLength(21)
    expect(Object.values(seatCountByLocation).reduce((a, b) => a + b, 0)).toBe(26)

    const byTier: Record<string, number> = {}
    for (const lines of Object.values(seatLinesByLocation)) {
      for (const l of lines) byTier[l.tier] = (byTier[l.tier] || 0) + l.count
    }
    expect(byTier).toEqual({ owner: 22, manager: 4 })
  })

  it('counts UNASSIGNED seats — a paid, empty seat is still billed', () => {
    const { seatCountByLocation, seatLinesByLocation } = deriveSeatComposition(SEAT_ROWS)
    expect(seatCountByLocation.ftl).toBe(3)
    expect(seatLinesByLocation.ftl).toEqual([
      { tier: 'owner', count: 2 },
      { tier: 'manager', count: 1 },
    ])
  })

  it('emits calculateSeatTotal input directly — the co-owner rule holds', () => {
    const { seatLinesByLocation } = deriveSeatComposition(SEAT_ROWS)
    // owner × 2 + manager × 1 → 550 + 400 (co-owner at the manager rate) + 400
    expect(calculateSeatTotal(seatLinesByLocation.ftl as any)).toBe(1350)
    // owner × 1 + manager × 2 → 550 + 800
    expect(calculateSeatTotal(seatLinesByLocation.kc as any)).toBe(1350)
  })

  it('orders lines by the tier catalog, not by insertion', () => {
    const { seatLinesByLocation } = deriveSeatComposition([
      { location_id: 'x', tier: 'readonly' },
      { location_id: 'x', tier: 'manager' },
      { location_id: 'x', tier: 'owner' },
    ])
    expect(seatLinesByLocation.x.map((l) => l.tier)).toEqual(['owner', 'manager', 'readonly'])
  })

  it('keeps an unrecognised tier, sorted last, rather than dropping it', () => {
    const { seatLinesByLocation, seatCountByLocation } = deriveSeatComposition([
      { location_id: 'x', tier: 'zzz_future_tier' },
      { location_id: 'x', tier: 'owner' },
    ])
    expect(seatLinesByLocation.x.map((l) => l.tier)).toEqual(['owner', 'zzz_future_tier'])
    expect(seatCountByLocation.x).toBe(2)
  })

  it('omits a location with no seats rather than emitting an empty entry', () => {
    const { seatLinesByLocation, seatCountByLocation } = deriveSeatComposition([])
    expect(seatLinesByLocation).toEqual({})
    expect(seatCountByLocation).toEqual({})
  })

  it('skips rows missing a location_id or tier without throwing', () => {
    const { seatCountByLocation } = deriveSeatComposition([
      { location_id: null, tier: 'owner' },
      { location_id: 'x', tier: null },
      { location_id: 'x', tier: 'owner' },
    ])
    expect(seatCountByLocation).toEqual({ x: 1 })
  })
})
