// @vitest-environment node
//
// #104 — Svix signature verification + event extraction for the Resend
// delivery webhook (lib/resend-webhook.ts). Pins the fail-closed posture and
// the terminal-vs-recorded classification the route depends on.

import { describe, it, expect, beforeEach } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  verifyResendSignature,
  parseSvixSignatures,
  extractResendEvent,
  deliveryStatusForEvent,
  isHardBounce,
  isComplaint,
} from './resend-webhook'

const SECRET = 'whsec_' + Buffer.from('resend-test-secret-abc123').toString('base64')

function sign(body: string, opts: { id?: string; ts?: number; secret?: string } = {}) {
  const id = opts.id ?? 'msg_2Kx'
  const ts = opts.ts ?? Math.floor(Date.now() / 1000)
  const secret = opts.secret ?? SECRET
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  const sig = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')
  return { id, ts, signature: `v1,${sig}` }
}

beforeEach(() => {
  process.env.RESEND_WEBHOOK_SECRET = SECRET
})

describe('verifyResendSignature — fail closed', () => {
  it('accepts a correctly signed body', () => {
    const body = '{"type":"email.delivered"}'
    const { id, ts, signature } = sign(body)
    expect(verifyResendSignature(body, { id, timestamp: String(ts), signature })).toBe(true)
  })

  it('rejects a tampered body (HMAC mismatch)', () => {
    const body = '{"type":"email.delivered"}'
    const { id, ts, signature } = sign(body)
    expect(
      verifyResendSignature(body + ' ', { id, timestamp: String(ts), signature }),
    ).toBe(false)
  })

  it('rejects when RESEND_WEBHOOK_SECRET is unset', () => {
    const body = '{"type":"email.delivered"}'
    const { id, ts, signature } = sign(body)
    delete process.env.RESEND_WEBHOOK_SECRET
    expect(verifyResendSignature(body, { id, timestamp: String(ts), signature })).toBe(false)
  })

  it('rejects a missing header (any of the three)', () => {
    const body = '{}'
    const { id, ts, signature } = sign(body)
    expect(verifyResendSignature(body, { id: null, timestamp: String(ts), signature })).toBe(false)
    expect(verifyResendSignature(body, { id, timestamp: null, signature })).toBe(false)
    expect(verifyResendSignature(body, { id, timestamp: String(ts), signature: null })).toBe(false)
  })

  it('rejects a stale timestamp (outside the 5-minute window)', () => {
    const body = '{}'
    const staleTs = Math.floor(Date.now() / 1000) - 6 * 60
    const { id, ts, signature } = sign(body, { ts: staleTs })
    expect(verifyResendSignature(body, { id, timestamp: String(ts), signature })).toBe(false)
  })

  it('verifies against ANY v1 entry (secret rotation → space-delimited list)', () => {
    const body = '{"type":"email.bounced"}'
    const good = sign(body)
    const bogus = 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
    // bogus first, real second — order must not matter.
    const signature = `${bogus} ${good.signature}`
    expect(
      verifyResendSignature(body, { id: good.id, timestamp: String(good.ts), signature }),
    ).toBe(true)
  })

  it('does not throw on a malformed signature encoding', () => {
    const body = '{}'
    const ts = Math.floor(Date.now() / 1000)
    expect(() =>
      verifyResendSignature(body, { id: 'x', timestamp: String(ts), signature: 'v1,@@@notbase64' }),
    ).not.toThrow()
  })
})

describe('parseSvixSignatures', () => {
  it('extracts only v1 entries, ignores other versions', () => {
    expect(parseSvixSignatures('v1,AAA v2,BBB v1,CCC')).toEqual(['AAA', 'CCC'])
  })
  it('returns [] for null / empty / malformed', () => {
    expect(parseSvixSignatures(null)).toEqual([])
    expect(parseSvixSignatures('')).toEqual([])
    expect(parseSvixSignatures('garbage-no-comma')).toEqual([])
  })
})

describe('extractResendEvent', () => {
  it('pulls type, messageId, bounceType from a bounce envelope', () => {
    const evt = extractResendEvent({
      type: 'email.bounced',
      data: { email_id: 're_9', bounce: { type: 'Permanent', subType: 'NoEmail' } },
    })
    expect(evt).toEqual({ type: 'email.bounced', messageId: 're_9', bounceType: 'Permanent' })
  })
  it('null messageId when data.email_id is absent', () => {
    const evt = extractResendEvent({ type: 'email.delivered', data: {} })
    expect(evt).toEqual({ type: 'email.delivered', messageId: null, bounceType: null })
  })
  it('returns null on a non-object / typeless envelope', () => {
    expect(extractResendEvent(null)).toBeNull()
    expect(extractResendEvent({ data: {} })).toBeNull()
  })
})

describe('deliveryStatusForEvent — matches the migration CHECK values', () => {
  it('maps the six tracked events', () => {
    expect(deliveryStatusForEvent('email.delivered')).toBe('delivered')
    expect(deliveryStatusForEvent('email.bounced')).toBe('bounced')
    expect(deliveryStatusForEvent('email.complained')).toBe('complained')
    expect(deliveryStatusForEvent('email.delivery_delayed')).toBe('deferred')
    expect(deliveryStatusForEvent('email.opened')).toBe('opened')
    expect(deliveryStatusForEvent('email.clicked')).toBe('clicked')
  })
  it('returns null for untracked events (email.sent / email.failed)', () => {
    expect(deliveryStatusForEvent('email.sent')).toBeNull()
    expect(deliveryStatusForEvent('email.failed')).toBeNull()
  })
})

describe('terminal classification', () => {
  it('Permanent bounce is hard; Transient / Undetermined are not', () => {
    expect(isHardBounce({ type: 'email.bounced', messageId: 'x', bounceType: 'Permanent' })).toBe(true)
    expect(isHardBounce({ type: 'email.bounced', messageId: 'x', bounceType: 'Transient' })).toBe(false)
    expect(isHardBounce({ type: 'email.bounced', messageId: 'x', bounceType: 'Undetermined' })).toBe(false)
  })
  it('complaint is terminal; delivered is not', () => {
    expect(isComplaint({ type: 'email.complained', messageId: 'x', bounceType: null })).toBe(true)
    expect(isComplaint({ type: 'email.delivered', messageId: 'x', bounceType: null })).toBe(false)
  })
})
