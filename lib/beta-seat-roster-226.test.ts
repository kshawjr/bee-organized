// lib/beta-seat-roster-226.test.ts — issue 226 step 5.
//
// Fort Lauderdale is the fixture throughout, because it is the location whose
// three seat rows produced four different answers on four surfaces (scout
// 215) and is therefore the shape most worth pinning: owner assigned, owner
// OPEN, manager OPEN, one unaccepted manager invite.

import { describe, it, expect } from 'vitest'
import { buildSeatRoster, tallySeatStates } from './seat-roster'
import { calculateSeatTotal } from './subscription-math'

const NOW = new Date('2026-08-14T12:00:00Z').getTime()
const PRICES = { owner: 550, manager: 400, light: 200, readonly: 0 }

const FTL_SEATS = [
  { id: 'own-1', tier: 'owner',   user_id: 'u1',  status: 'active', is_primary: true,  prorated_cost: 55000, added_at: '2026-08-14', scheduled_removal_at: null },
  { id: 'own-2', tier: 'owner',   user_id: null,  status: 'active', is_primary: false, prorated_cost: 40000, added_at: '2026-08-15', scheduled_removal_at: null },
  { id: 'mgr-1', tier: 'manager', user_id: null,  status: 'active', is_primary: false, prorated_cost: 40000, added_at: '2026-08-16', scheduled_removal_at: null },
] as any

const FTL_INVITES = [
  { id: 'inv-1', tier: 'manager', email: 'newhire@x.com', full_name: 'New Hire', accepted_at: null, created_at: '2026-08-13T10:00:00Z', invite_expires_at: '2099-01-01T00:00:00Z' },
] as any

const USERS = [{ id: 'u1', full_name: 'Lynette Ewy', email: 'lewy@x.com' }]

const roster = (over: any = {}) =>
  buildSeatRoster({ seats: FTL_SEATS, pendingInvites: FTL_INVITES, users: USERS, prices: PRICES, nowMs: NOW, ...over })

const byId = (id: string) => roster().find(e => e.seatId === id)!

describe('the three states', () => {
  it('held — someone is in the seat, resolved to a person', () => {
    const e = byId('own-1')
    expect(e.state).toBe('held')
    expect(e.holder).toEqual({ id: 'u1', name: 'Lynette Ewy', email: 'lewy@x.com' })
    expect(e.invite).toBeNull()
  })

  it('invited — spoken for by an unaccepted invitation, with the date', () => {
    const e = byId('mgr-1')
    expect(e.state).toBe('invited')
    expect(e.holder).toBeNull()
    expect(e.invite?.email).toBe('newhire@x.com')
    expect(e.invite?.createdAt).toBe('2026-08-13T10:00:00Z')
    expect(e.invite?.id).toBe('inv-1')
  })

  // The state that earns its place: paid for, nobody in it, nobody asked.
  it('empty — open and nobody has been invited', () => {
    const e = byId('own-2')
    expect(e.state).toBe('empty')
    expect(e.holder).toBeNull()
    expect(e.invite).toBeNull()
  })

  it('an empty seat still costs the full annual rate — it is not free', () => {
    expect(byId('own-2').annualRate).toBe(400)
  })

  it('tallies to the seat count', () => {
    const t = tallySeatStates(roster())
    expect(t).toEqual({ held: 1, invited: 1, empty: 1 })
    expect(t.held + t.invited + t.empty).toBe(FTL_SEATS.length)
  })

  it('distinguishes invited from empty at the same tier', () => {
    // Two open manager seats, one invite: the first is spoken for, the
    // second is not. Positional, matching the server gate (issue 216).
    const seats = [
      { id: 'm1', tier: 'manager', user_id: null, status: 'active' },
      { id: 'm2', tier: 'manager', user_id: null, status: 'active' },
    ] as any
    const r = buildSeatRoster({ seats, pendingInvites: FTL_INVITES, prices: PRICES, nowMs: NOW })
    expect(r.map(e => e.state)).toEqual(['invited', 'empty'])
  })
})

describe('what a seat costs', () => {
  // The rule that keeps getting restated wrong: the SECOND owner seat bills
  // at the manager rate.
  it('prices the first owner seat at the owner rate and the second at manager', () => {
    expect(byId('own-1').annualRate).toBe(550)
    expect(byId('own-2').annualRate).toBe(400)
  })

  it('prices a non-owner seat at its own tier rate', () => {
    expect(byId('mgr-1').annualRate).toBe(400)
  })

  it('sums to exactly what calculateSeatTotal says the location pays', () => {
    const sum = roster().reduce((n, e) => n + e.annualRate, 0)
    expect(sum).toBe(calculateSeatTotal([{ tier: 'owner', count: 2 }, { tier: 'manager', count: 1 }] as any, PRICES))
    expect(sum).toBe(1350)
  })

  it('prices a $0 tier at 0 rather than dropping the row', () => {
    const seats = [{ id: 'w1', tier: 'readonly', user_id: null, status: 'active' }] as any
    const r = buildSeatRoster({ seats, prices: PRICES, nowMs: NOW })
    expect(r).toHaveLength(1)
    expect(r[0].annualRate).toBe(0)
  })

  // prorated_cost is a historical fact about the year the seat was bought in,
  // not what the seat costs. It rides along for the row detail.
  it('carries prorated_cost separately, in cents, never as the rate', () => {
    const e = byId('own-2')
    expect(e.proratedCostCents).toBe(40000)
    expect(e.annualRate).toBe(400)         // dollars/yr
    expect(e.annualRate).not.toBe(e.proratedCostCents)
  })

  it('reports a missing prorated_cost as null rather than zero', () => {
    const seats = [{ id: 's', tier: 'manager', user_id: null, status: 'active' }] as any
    expect(buildSeatRoster({ seats, prices: PRICES, nowMs: NOW })[0].proratedCostCents).toBeNull()
  })
})

describe('edges', () => {
  it('ignores inactive seat rows', () => {
    const seats = [...FTL_SEATS, { id: 'gone', tier: 'manager', user_id: null, status: 'inactive' }] as any
    expect(buildSeatRoster({ seats, prices: PRICES, nowMs: NOW })).toHaveLength(3)
  })

  it('an expired invite does not reserve a seat', () => {
    const expired = [{ ...FTL_INVITES[0], invite_expires_at: '2020-01-01T00:00:00Z' }] as any
    const r = buildSeatRoster({ seats: FTL_SEATS, pendingInvites: expired, users: USERS, prices: PRICES, nowMs: NOW })
    expect(r.find(e => e.seatId === 'mgr-1')!.state).toBe('empty')
  })

  it('an accepted invite does not reserve a seat', () => {
    const accepted = [{ ...FTL_INVITES[0], accepted_at: '2026-08-14T00:00:00Z' }] as any
    const r = buildSeatRoster({ seats: FTL_SEATS, pendingInvites: accepted, users: USERS, prices: PRICES, nowMs: NOW })
    expect(r.find(e => e.seatId === 'mgr-1')!.state).toBe('empty')
  })

  it('a held seat whose user is missing from the roster still renders', () => {
    const r = buildSeatRoster({ seats: FTL_SEATS, pendingInvites: FTL_INVITES, users: [], prices: PRICES, nowMs: NOW })
    const held = r.find(e => e.seatId === 'own-1')!
    expect(held.state).toBe('held')
    expect(held.holder?.id).toBe('u1')
    expect(held.holder?.name).toBeNull()
  })

  // A scheduled removal is a modifier, not a fourth state — the seat is still
  // held (or still empty) until it actually goes.
  it('carries a scheduled removal alongside the state, not instead of it', () => {
    const seats = [{ ...FTL_SEATS[0], scheduled_removal_at: '2027-08-14' }] as any
    const e = buildSeatRoster({ seats, users: USERS, prices: PRICES, nowMs: NOW })[0]
    expect(e.state).toBe('held')
    expect(e.scheduledRemovalAt).toBe('2027-08-14')
  })

  it('handles no seats at all', () => {
    expect(buildSeatRoster({ seats: [] })).toEqual([])
    expect(tallySeatStates([])).toEqual({ held: 0, invited: 0, empty: 0 })
  })
})
