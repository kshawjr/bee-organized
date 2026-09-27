// @vitest-environment node
//
// lib/resend.ts — a bad reply-to is the SENDER's setting, and every caller is
// told so. Dallas's two-address value is refused before Resend sees it; and if
// Resend itself refuses a reply-to, that rejection is re-labelled so it can
// never be read as a bad client address (Resend gives both the same 422
// validation_error).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendMock = vi.hoisted(() => vi.fn())
vi.mock('resend', () => ({ Resend: class { emails = { send: sendMock } } }))
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: vi.fn() } }))
vi.mock('./supabase-service', () => ({ supabaseService: { from: vi.fn() } }))
vi.mock('@/lib/notification-log', () => ({ logNotificationFanout: vi.fn(async () => {}) }))
vi.mock('./notification-log', () => ({ logNotificationFanout: vi.fn(async () => {}) }))
vi.mock('@/lib/project-type-handlers', () => ({ resolveHandlerForRawType: vi.fn(async () => null) }))
vi.mock('./project-type-handlers', () => ({ resolveHandlerForRawType: vi.fn(async () => null) }))

import { sendEmailDirect } from '@/lib/resend'
import { LOCATION_REPLY_TO_BROKEN, REPLY_TO_INVALID } from '@/lib/reply-to'

const base = {
  from: 'dknapp@beeorganized.com', fromName: 'Bee Dallas', to: 'client@example.com',
  subject: 's', html: '<p>b</p>', email_kind: 'drip' as any,
}

beforeEach(() => { vi.clearAllMocks() })

describe('sendEmailDirect — reply-to', () => {
  it('Dallas’s two-address reply-to is refused BEFORE Resend, labelled as the location’s setting', async () => {
    const res: any = await sendEmailDirect({ ...base, replyTo: 'jackie@beeorganized.com, dknapp@beeorganized.com' })
    expect(sendMock).not.toHaveBeenCalled()
    expect(res.success).toBe(false)
    expect(res.errorName).toBe(REPLY_TO_INVALID)
    expect(res.error.startsWith(LOCATION_REPLY_TO_BROKEN)).toBe(true)
    expect(res.error).not.toMatch(/invalid email address/i)
  })

  it('Resend’s own reply-to rejection is re-labelled — not left as validation_error', async () => {
    sendMock.mockResolvedValueOnce({ data: null, error: { name: 'validation_error', statusCode: 422, message: 'Invalid `reply_to` field. The email address needs to follow the `email@example.com` format.' } })
    const res: any = await sendEmailDirect({ ...base, replyTo: 'replies@beeorganized.com' })
    expect(res.errorName).toBe(REPLY_TO_INVALID)
    expect(res.error.startsWith(LOCATION_REPLY_TO_BROKEN)).toBe(true)
  })

  it('a bad RECIPIENT keeps Resend’s validation_error (the drip engine still stops that lead)', async () => {
    sendMock.mockResolvedValueOnce({ data: null, error: { name: 'validation_error', statusCode: 422, message: 'Invalid `to` field.' } })
    const res: any = await sendEmailDirect({ ...base, replyTo: 'replies@beeorganized.com' })
    expect(res.errorName).toBe('validation_error')
  })

  it('a valid reply-to sends normally', async () => {
    sendMock.mockResolvedValueOnce({ data: { id: 're-1' }, error: null })
    const res: any = await sendEmailDirect({ ...base, replyTo: 'dknapp@beeorganized.com' })
    expect(res).toEqual({ success: true, id: 're-1' })
    expect(sendMock.mock.calls[0][0].replyTo).toBe('dknapp@beeorganized.com')
  })
})
