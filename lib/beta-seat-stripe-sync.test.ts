// @vitest-environment node
//
// applySeatDeltaToStripe (issue 161) — the seat ↔ Stripe subscription
// bridge. Pins the CRITICAL GUARDS:
//   • A non-paying payment_source NEVER reaches Stripe (no charge path).
//   • A location with no live subscription is a Stripe no-op — the
//     free-grant invite/seat path keeps working before any payment.
//   • On a Stripe location, an invite ADDS a line to the EXISTING
//     subscription (adjustSubscriptionSeatQuantity delta +1) rather than
//     creating a second subscription; removal decrements (delta −1).
//   • The seat-id-derived idempotency key rides through so a retry replays.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Recording supabase mock: per-table FIFO queue (grant-seat pattern).
const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  const state = { queue: [] as { table: string; resp: Resp }[] }
  const reset = () => { state.queue = [] }
  const enqueue = (table: string, data: any, error: any = null) =>
    state.queue.push({ table, resp: { data, error } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0 ? state.queue.splice(idx, 1)[0].resp : { data: null, error: null }
    const b: any = {}
    for (const m of ['select', 'eq', 'not', 'is', 'in', 'order', 'limit']) b[m] = () => b
    b.maybeSingle = () => Promise.resolve(resp)
    b.single = () => Promise.resolve(resp)
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  return { state, reset, enqueue, makeBuilder }
})

const adjust = vi.hoisted(() => ({ fn: vi.fn(async () => ({ quantity: 1, itemId: 'si_1', created: true, removed: false })) }))

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
vi.mock('@/lib/stripe', () => ({ stripeConfigured: () => true }))
vi.mock('@/lib/stripe-billing', () => ({ adjustSubscriptionSeatQuantity: adjust.fn }))

import { applySeatDeltaToStripe } from '@/lib/seat-stripe-sync'

const LOC = (over: any = {}) => ({
  id: 'loc-uuid', name: 'Test Territory', location_id: 'test-territory',
  subscription_status: 'active', payment_source: 'direct', paid_through_date: '2027-08-01',
  stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', ...over,
})

beforeEach(() => { h.reset(); adjust.fn.mockClear(); adjust.fn.mockResolvedValue({ quantity: 1, itemId: 'si_1', created: true, removed: false }) })

describe('applySeatDeltaToStripe — GUARD: non-paying never reaches Stripe', () => {
  it('prepaid_corporate → skipped, adjust NOT called', async () => {
    h.enqueue('locations', LOC({ payment_source: 'prepaid_corporate' }))
    const res = await applySeatDeltaToStripe({ locationId: 'loc-uuid', tier: 'manager', delta: 1, seatId: 'seat-9' })
    expect(res).toEqual({ applied: false, reason: 'non_paying' })
    expect(adjust.fn).not.toHaveBeenCalled()
  })
})

describe('applySeatDeltaToStripe — GUARD: free-grant door stays open pre-payment', () => {
  it('no stripe_subscription_id → Stripe no-op, adjust NOT called', async () => {
    h.enqueue('locations', LOC({ stripe_subscription_id: null }))
    const res = await applySeatDeltaToStripe({ locationId: 'loc-uuid', tier: 'manager', delta: 1, seatId: 'seat-9' })
    expect(res).toEqual({ applied: false, reason: 'no_subscription' })
    expect(adjust.fn).not.toHaveBeenCalled()
  })
})

describe('applySeatDeltaToStripe — add/remove on the EXISTING subscription', () => {
  it('invite (+1) adds a manager line to sub_1 with the tier price + seat idempotency key', async () => {
    h.enqueue('locations', LOC())
    h.enqueue('tier_prices', { id: 'manager', price_annual: 400, stripe_price_id: 'price_mgr' })
    const res = await applySeatDeltaToStripe({ locationId: 'loc-uuid', tier: 'manager', delta: 1, seatId: 'seat-42' })
    expect(res.applied).toBe(true)
    expect(adjust.fn).toHaveBeenCalledTimes(1)
    const arg = adjust.fn.mock.calls[0][0] as any
    expect(arg.subscriptionId).toBe('sub_1') // the SAME subscription, not a new one
    expect(arg.priceId).toBe('price_mgr')
    expect(arg.delta).toBe(1)
    expect(arg.idempotencyKey).toContain('seat-42')
    expect(arg.idempotencyKey).toContain('add')
  })

  it('removal (−1) decrements the tier line', async () => {
    h.enqueue('locations', LOC())
    h.enqueue('tier_prices', { id: 'manager', price_annual: 400, stripe_price_id: 'price_mgr' })
    await applySeatDeltaToStripe({ locationId: 'loc-uuid', tier: 'manager', delta: -1, seatId: 'seat-42' })
    const arg = adjust.fn.mock.calls[0][0] as any
    expect(arg.delta).toBe(-1)
    expect(arg.idempotencyKey).toContain('remove')
  })

  it('tier with no stripe_price_id → skipped (no_price), adjust NOT called', async () => {
    h.enqueue('locations', LOC())
    h.enqueue('tier_prices', { id: 'manager', price_annual: 400, stripe_price_id: null })
    const res = await applySeatDeltaToStripe({ locationId: 'loc-uuid', tier: 'manager', delta: 1, seatId: 'seat-42' })
    expect(res).toEqual({ applied: false, reason: 'no_price' })
    expect(adjust.fn).not.toHaveBeenCalled()
  })

  it('a Stripe failure is non-fatal — returns reason stripe_error, never throws', async () => {
    h.enqueue('locations', LOC())
    h.enqueue('tier_prices', { id: 'manager', price_annual: 400, stripe_price_id: 'price_mgr' })
    adjust.fn.mockRejectedValueOnce(new Error('card_declined'))
    const res = await applySeatDeltaToStripe({ locationId: 'loc-uuid', tier: 'manager', delta: 1, seatId: 'seat-42' })
    expect(res.applied).toBe(false)
    expect(res.reason).toBe('stripe_error')
  })
})
