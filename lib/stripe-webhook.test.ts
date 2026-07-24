// @vitest-environment node
//
// Stripe webhook verification + extraction — pins the security contract:
//   • Signature verify is fail-closed: missing secret, missing header,
//     stale timestamp, wrong secret, malformed header all reject.
//   • A correctly signed payload (Stripe's t=…,v1=… scheme over
//     `${t}.${rawBody}`) verifies, including the rotation case where a
//     stale v1 rides alongside a valid one.
//   • extractCheckoutSession pulls exactly the fields the route maps on
//     (client_reference_id → location, metadata.tier → tier) and
//     tolerates expanded payment_intent objects.

import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  parseStripeSignatureHeader,
  verifyStripeSignature,
  extractCheckoutSession,
  deriveSeatQuantity,
  isUuid,
} from './stripe-webhook'

const SECRET = 'whsec_test_secret_for_unit_tests'

function signedHeader(rawBody: string, opts: { secret?: string; ageSec?: number; extraV1?: string } = {}) {
  const t = Math.floor(Date.now() / 1000) - (opts.ageSec ?? 0)
  const sig = createHmac('sha256', opts.secret ?? SECRET)
    .update(`${t}.${rawBody}`, 'utf8')
    .digest('hex')
  return opts.extraV1 ? `t=${t},v1=${opts.extraV1},v1=${sig}` : `t=${t},v1=${sig}`
}

describe('verifyStripeSignature', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' })

  beforeEach(() => { process.env.STRIPE_WEBHOOK_SECRET = SECRET })
  afterEach(() => { delete process.env.STRIPE_WEBHOOK_SECRET })

  it('accepts a correctly signed payload', () => {
    expect(verifyStripeSignature(body, signedHeader(body))).toBe(true)
  })

  it('accepts when a valid v1 rides alongside a stale one (secret rotation)', () => {
    expect(verifyStripeSignature(body, signedHeader(body, { extraV1: 'deadbeef'.repeat(8) }))).toBe(true)
  })

  it('rejects when STRIPE_WEBHOOK_SECRET is unset (fail-closed)', () => {
    delete process.env.STRIPE_WEBHOOK_SECRET
    expect(verifyStripeSignature(body, signedHeader(body))).toBe(false)
  })

  it('rejects a missing header', () => {
    expect(verifyStripeSignature(body, null)).toBe(false)
  })

  it('rejects the wrong secret', () => {
    expect(verifyStripeSignature(body, signedHeader(body, { secret: 'whsec_wrong' }))).toBe(false)
  })

  it('rejects a tampered body', () => {
    expect(verifyStripeSignature(body + 'x', signedHeader(body))).toBe(false)
  })

  it('rejects a stale timestamp (replay window)', () => {
    expect(verifyStripeSignature(body, signedHeader(body, { ageSec: 6 * 60 }))).toBe(false)
  })

  it('rejects malformed headers', () => {
    expect(verifyStripeSignature(body, 't=notanumber,v1=abc')).toBe(false)
    expect(verifyStripeSignature(body, 'v1=abc')).toBe(false)
    expect(verifyStripeSignature(body, 't=123')).toBe(false)
    expect(verifyStripeSignature(body, '')).toBe(false)
  })
})

describe('parseStripeSignatureHeader', () => {
  it('parses t and multiple v1 entries', () => {
    const parsed = parseStripeSignatureHeader('t=1700000000,v1=aaa,v1=bbb,v0=legacy')
    expect(parsed).toEqual({ timestamp: 1700000000, signatures: ['aaa', 'bbb'] })
  })
  it('returns null without t or v1', () => {
    expect(parseStripeSignatureHeader('v1=aaa')).toBeNull()
    expect(parseStripeSignatureHeader('t=1700000000')).toBeNull()
    expect(parseStripeSignatureHeader(null)).toBeNull()
  })
})

describe('extractCheckoutSession', () => {
  const base = {
    id: 'evt_123',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_abc',
        payment_intent: 'pi_123',
        client_reference_id: '6f9619ff-8b86-4d01-b42d-00c04fc964ff',
        metadata: { tier: 'manager' },
        amount_total: 40000,
        currency: 'usd',
        payment_status: 'paid',
        customer_details: { email: 'owner@example.com' },
      },
    },
  }

  it('extracts the mapping fields', () => {
    const s = extractCheckoutSession(base)
    expect(s).toMatchObject({
      eventId: 'evt_123',
      eventType: 'checkout.session.completed',
      sessionId: 'cs_test_abc',
      paymentIntentId: 'pi_123',
      clientReferenceId: '6f9619ff-8b86-4d01-b42d-00c04fc964ff',
      tier: 'manager',
      amountTotal: 40000,
      paymentStatus: 'paid',
      customerEmail: 'owner@example.com',
    })
  })

  it('tolerates an expanded payment_intent object', () => {
    const evt = structuredClone(base) as any
    evt.data.object.payment_intent = { id: 'pi_expanded' }
    expect(extractCheckoutSession(evt)?.paymentIntentId).toBe('pi_expanded')
  })

  it('nulls missing optional fields instead of throwing', () => {
    const s = extractCheckoutSession({ id: 'evt_1', type: 'x', data: { object: { id: 'cs_1' } } })
    expect(s).toMatchObject({ sessionId: 'cs_1', tier: null, clientReferenceId: null, amountTotal: null })
  })

  it('returns null for non-event shapes', () => {
    expect(extractCheckoutSession(null)).toBeNull()
    expect(extractCheckoutSession({})).toBeNull()
    expect(extractCheckoutSession({ id: 'evt', type: 't' })).toBeNull()
  })
})

describe('deriveSeatQuantity', () => {
  it('divides amount_total by the per-seat price for quantity-adjustable links', () => {
    expect(deriveSeatQuantity(40000, 40000)).toEqual({ quantity: 1, uneven: false })
    expect(deriveSeatQuantity(120000, 40000)).toEqual({ quantity: 3, uneven: false })
    expect(deriveSeatQuantity(5000 * 4, 5000)).toEqual({ quantity: 4, uneven: false })
  })

  it('caps at 50 (mirrors /api/seats bulk sanity guard)', () => {
    expect(deriveSeatQuantity(100 * 100, 100)).toEqual({ quantity: 50, uneven: false })
  })

  it('flags uneven division and falls back to 1 seat', () => {
    expect(deriveSeatQuantity(41000, 40000)).toEqual({ quantity: 1, uneven: true })
  })

  it('defaults to 1 quietly when amount or price is missing/zero', () => {
    expect(deriveSeatQuantity(null, 40000)).toEqual({ quantity: 1, uneven: false })
    expect(deriveSeatQuantity(40000, null)).toEqual({ quantity: 1, uneven: false })
    expect(deriveSeatQuantity(0, 40000)).toEqual({ quantity: 1, uneven: false })
    expect(deriveSeatQuantity(40000, 0)).toEqual({ quantity: 1, uneven: false })
  })
})

describe('isUuid', () => {
  it('accepts a v4 uuid and rejects junk', () => {
    expect(isUuid('6f9619ff-8b86-4d01-b42d-00c04fc964ff')).toBe(true)
    expect(isUuid('not-a-uuid')).toBe(false)
    expect(isUuid(null)).toBe(false)
  })
})
