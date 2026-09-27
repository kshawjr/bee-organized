// @vitest-environment node
//
// lib/resend.ts + lib/sendable-domains.ts — a From address on a domain we
// can't send from is the SENDER's setting (Test Location, 2026-09-27: "Home or
// Office Organizing" sent as kshawjr@gmail.com; Resend answered "The gmail.com
// domain is not verified…", and the drip engine wrote the client off).
//
// Pinned here:
//   · sendEmail re-labels Resend's refusal as SENDER_DOMAIN_UNVERIFIED, with
//     owner wording that names the address and the RIGHT Settings screen —
//     the job type's sender, or the location's Send From
//   · a bad RECIPIENT is untouched (still Resend's validation_error)
//   · which domains are sendable comes from Resend (or an env list), never a
//     hard-coded one — and "unknown" is reported as unknown
import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendMock = vi.hoisted(() => vi.fn())
const listMock = vi.hoisted(() => vi.fn())
vi.mock('resend', () => ({ Resend: class { emails = { send: sendMock }; domains = { list: listMock } } }))

// locations row for sendEmail's sender lookup
const locRow = vi.hoisted(() => ({ current: null as any }))
const fakeFrom = () => {
  const b: any = {}
  for (const m of ['select', 'eq', 'insert', 'update']) b[m] = () => b
  b.single = () => Promise.resolve({ data: locRow.current, error: null })
  b.maybeSingle = b.single
  b.then = (res: any, rej: any) => Promise.resolve({ data: null, error: null }).then(res, rej)
  return b
}
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: () => fakeFrom() } }))
vi.mock('./supabase-service', () => ({ supabaseService: { from: () => fakeFrom() } }))
vi.mock('@/lib/notification-log', () => ({ logNotificationFanout: vi.fn(async () => {}) }))
vi.mock('./notification-log', () => ({ logNotificationFanout: vi.fn(async () => {}) }))
const handlerMock = vi.hoisted(() => vi.fn(async () => null as any))
vi.mock('@/lib/project-type-handlers', () => ({ resolveHandlerForRawType: handlerMock }))
vi.mock('./project-type-handlers', () => ({ resolveHandlerForRawType: handlerMock }))

import { sendEmail } from '@/lib/resend'
import { SENDER_DOMAIN_UNVERIFIED, SENDER_DOMAIN_PREFIX } from '@/lib/sender-domain'
import { getSendableDomains, _resetSendableDomainsCache } from '@/lib/sendable-domains'

// Resend's exact words from Kevin's test send.
const RESEND_GMAIL = 'The gmail.com domain is not verified. Please, add and verify your domain on https://resend.com/domains'

const args = {
  locationId: 'loc-test', to: 'client@gmail.com', subject: 's', html: '<p>b</p>', email_kind: 'drip' as any,
}

beforeEach(() => {
  vi.clearAllMocks()
  locRow.current = { send_from_email: 'test@beeorganized.com', sender_name: 'Bee Test', reply_to_email: 'kevin@bmave.com' }
  handlerMock.mockResolvedValue(null)
  delete process.env.SENDABLE_EMAIL_DOMAINS
  process.env.RESEND_API_KEY = 're_test'
  _resetSendableDomainsCache()
})

describe('sendEmail — a From domain Resend refuses', () => {
  it('Test Location’s case: the job type sends as a Gmail handler → names the job type, the address, and New leads', async () => {
    handlerMock.mockResolvedValueOnce({ name: 'Kevin', email: 'kshawjr@gmail.com', reply_to: null, is_custom: false })
    sendMock.mockResolvedValueOnce({ data: null, error: { name: 'validation_error', statusCode: 403, message: RESEND_GMAIL } })

    const res: any = await sendEmail({ ...args, senderProjectType: 'Home or Office Organizing' })

    expect(sendMock.mock.calls[0][0].from).toBe('Kevin <kshawjr@gmail.com>')
    expect(res.success).toBe(false)
    expect(res.errorName).toBe(SENDER_DOMAIN_UNVERIFIED)
    expect(res.error.startsWith(SENDER_DOMAIN_PREFIX)).toBe(true)
    expect(res.error).toContain('kshawjr@gmail.com')
    expect(res.error).toContain('Home or Office Organizing')
    expect(res.error).toContain('Settings → New leads → Who handles what')
    expect(res.error).not.toMatch(/client/i)
    expect(res.error).not.toMatch(/contact support/i)
  })

  it('the location’s own Send From on a bad domain → names Settings → Emails', async () => {
    locRow.current = { ...locRow.current, send_from_email: 'owner@gmail.com' }
    sendMock.mockResolvedValueOnce({ data: null, error: { name: 'validation_error', statusCode: 403, message: RESEND_GMAIL } })

    const res: any = await sendEmail(args)

    expect(res.errorName).toBe(SENDER_DOMAIN_UNVERIFIED)
    expect(res.error).toContain('owner@gmail.com')
    expect(res.error).toContain('Send From Email in Settings → Emails')
    expect(res.error).not.toContain('New leads')
  })

  it('a bad RECIPIENT is left alone — still validation_error, so the drip engine stops that lead as before', async () => {
    sendMock.mockResolvedValueOnce({ data: null, error: { name: 'validation_error', statusCode: 422, message: 'Invalid `to` field.' } })
    const res: any = await sendEmail(args)
    expect(res.errorName).toBe('validation_error')
    expect(res.error).toBe('Invalid `to` field.')
  })

  it('a good send is untouched', async () => {
    sendMock.mockResolvedValueOnce({ data: { id: 'ok-1' }, error: null })
    expect(await sendEmail(args)).toEqual({ success: true, id: 'ok-1' })
  })
})

describe('an existing reply-to outside the new rule still sends', () => {
  it('Test Location’s kevin@bmave.com reply-to: the send goes out, reply-to intact', async () => {
    // exactly production's row today
    locRow.current = { send_from_email: 'test@beeorganized.com', sender_name: 'Bee Test', reply_to_email: 'kevin@bmave.com' }
    listMock.mockResolvedValue({ data: { data: [{ name: 'beeorganized.com', status: 'verified' }] }, error: null })
    sendMock.mockResolvedValueOnce({ data: { id: 'ok-bmave' }, error: null })

    const res = await sendEmail(args)

    expect(res).toEqual({ success: true, id: 'ok-bmave' })
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock.mock.calls[0][0].replyTo).toBe('kevin@bmave.com')
  })
})

describe('getSendableDomains — how the app knows (nothing hard-coded)', () => {
  it('asks Resend, keeping only VERIFIED domains', async () => {
    listMock.mockResolvedValueOnce({ data: { data: [
      { name: 'beeorganized.com', status: 'verified' },
      { name: 'mail.example.org', status: 'pending' },
      { name: 'Other-Verified.io', status: 'verified' },
    ] }, error: null })
    expect(await getSendableDomains()).toEqual(['beeorganized.com', 'other-verified.io'])
  })

  it('a sending-only key (restricted_api_key) → UNKNOWN (null), not a guess', async () => {
    listMock.mockResolvedValueOnce({ data: null, error: { name: 'restricted_api_key', message: 'This API key is restricted to only send emails' } })
    expect(await getSendableDomains()).toBeNull()
  })

  it('SENDABLE_EMAIL_DOMAINS overrides, without calling Resend', async () => {
    process.env.SENDABLE_EMAIL_DOMAINS = ' BeeOrganized.com , bmave.com '
    expect(await getSendableDomains()).toEqual(['beeorganized.com', 'bmave.com'])
    expect(listMock).not.toHaveBeenCalled()
  })

  it('cached: a second call within ten minutes does not call Resend again', async () => {
    listMock.mockResolvedValue({ data: { data: [{ name: 'beeorganized.com', status: 'verified' }] }, error: null })
    await getSendableDomains()
    await getSendableDomains()
    expect(listMock).toHaveBeenCalledTimes(1)
  })
})
