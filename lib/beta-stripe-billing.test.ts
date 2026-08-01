// @vitest-environment node
//
// adjustSubscriptionSeatQuantity proration timing (issue 161, Kevin's call).
// Pins:
//   • ADD (delta > 0) invoices immediately: proration_behavior='always_invoice'
//     on both the new-line create and the quantity-increase update.
//   • REMOVE (delta < 0) stays on 'create_prorations' (credit at next invoice)
//     for both the quantity-decrease update and the drop-to-zero delete.
//   • The seat-id idempotency key rides through every call.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const stripe = vi.hoisted(() => ({
  subscriptions: { retrieve: vi.fn() },
  subscriptionItems: {
    create: vi.fn(async (p: any) => ({ id: 'si_new', quantity: p.quantity })),
    update: vi.fn(async (id: string, p: any) => ({ id, quantity: p.quantity })),
    del: vi.fn(async () => ({})),
  },
}))

vi.mock('@/lib/stripe', () => ({ getStripe: () => stripe }))

import { adjustSubscriptionSeatQuantity } from '@/lib/stripe-billing'

const subWith = (items: any[]) => ({ id: 'sub_1', items: { data: items } })
const mgr = (qty: number) => ({ id: 'si_mgr', price: { id: 'price_mgr' }, quantity: qty })

beforeEach(() => {
  vi.clearAllMocks()
  stripe.subscriptionItems.create.mockImplementation(async (p: any) => ({ id: 'si_new', quantity: p.quantity }))
  stripe.subscriptionItems.update.mockImplementation(async (id: string, p: any) => ({ id, quantity: p.quantity }))
})

describe('adjustSubscriptionSeatQuantity — ADD invoices immediately', () => {
  it('increasing an existing line updates with always_invoice', async () => {
    stripe.subscriptions.retrieve.mockResolvedValue(subWith([mgr(1)]))
    await adjustSubscriptionSeatQuantity({ subscriptionId: 'sub_1', priceId: 'price_mgr', delta: 1, idempotencyKey: 'bh_seat_add_seat-1' })
    expect(stripe.subscriptionItems.update).toHaveBeenCalledTimes(1)
    const [id, params, opts] = stripe.subscriptionItems.update.mock.calls[0] as any
    expect(id).toBe('si_mgr')
    expect(params).toMatchObject({ quantity: 2, proration_behavior: 'always_invoice' })
    expect(opts).toMatchObject({ idempotencyKey: 'bh_seat_add_seat-1' })
  })

  it('the first seat of a new tier is created with always_invoice', async () => {
    stripe.subscriptions.retrieve.mockResolvedValue(subWith([mgr(1)])) // no light line yet
    await adjustSubscriptionSeatQuantity({ subscriptionId: 'sub_1', priceId: 'price_light', delta: 1, idempotencyKey: 'bh_seat_add_seat-9' })
    expect(stripe.subscriptionItems.create).toHaveBeenCalledTimes(1)
    const [params] = stripe.subscriptionItems.create.mock.calls[0] as any
    expect(params).toMatchObject({ subscription: 'sub_1', price: 'price_light', quantity: 1, proration_behavior: 'always_invoice' })
  })
})

describe('adjustSubscriptionSeatQuantity — REMOVE credits next invoice (unchanged)', () => {
  it('decreasing a line updates with create_prorations', async () => {
    stripe.subscriptions.retrieve.mockResolvedValue(subWith([mgr(2)]))
    await adjustSubscriptionSeatQuantity({ subscriptionId: 'sub_1', priceId: 'price_mgr', delta: -1, idempotencyKey: 'bh_seat_remove_seat-1' })
    const [, params] = stripe.subscriptionItems.update.mock.calls[0] as any
    expect(params).toMatchObject({ quantity: 1, proration_behavior: 'create_prorations' })
    expect(stripe.subscriptionItems.create).not.toHaveBeenCalled()
  })

  it('removing the last seat deletes the line with create_prorations', async () => {
    stripe.subscriptions.retrieve.mockResolvedValue(subWith([mgr(1)]))
    const res = await adjustSubscriptionSeatQuantity({ subscriptionId: 'sub_1', priceId: 'price_mgr', delta: -1, idempotencyKey: 'bh_seat_remove_seat-1' })
    expect(res.removed).toBe(true)
    const [id, params] = stripe.subscriptionItems.del.mock.calls[0] as any
    expect(id).toBe('si_mgr')
    expect(params).toMatchObject({ proration_behavior: 'create_prorations' })
  })
})
