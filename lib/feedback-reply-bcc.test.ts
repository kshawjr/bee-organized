// lib/feedback-reply-bcc.test.ts
//
// Kevin replies to owner reports and had no record of what went out:
// sendFeedbackReplyEmail sent to the owner only. Every email this module sends
// — the typed reply AND the "we fixed it" announcement (issue 236), which ride
// the same function — now carries a silent BCC to kevin@bmave.com.
//
// Pinned here:
//   1. the reply carries the bcc, and so does the Fixed announcement
//   2. the owner is still the only To, with no cc — the copy is invisible
//   3. a rejected copy address never costs the owner their reply: on a
//      validation_error / 422 the message is sent again without the copy
//   4. other failures are not retried (dropping the copy would not help)

import { describe, it, expect, vi, beforeEach } from 'vitest'

const direct = vi.hoisted(() => ({ fn: vi.fn() }))
vi.mock('@/lib/resend', () => ({ sendEmailDirect: direct.fn }))

import { sendFeedbackReplyEmail, FEEDBACK_REPLY_BCC } from '@/lib/feedback-reply-email'

const OWNER = 'lynette.ewy@example.com'
const reply = {
  to: OWNER,
  recipientName: 'Lynette Ewy',
  itemTitle: 'Initial email opens blank',
  itemType: 'bug',
  replyText: 'Fixed — the editor now shows your wording.',
  locationId: 'loc-kc',
}

beforeEach(() => {
  direct.fn.mockReset()
  direct.fn.mockResolvedValue({ success: true, id: 'msg-1' })
})

describe('feedback reply emails copy Kevin', () => {
  it('the copy address is kevin@bmave.com', () => {
    expect(FEEDBACK_REPLY_BCC).toBe('kevin@bmave.com')
  })

  it('a reply email carries the bcc', async () => {
    const res = await sendFeedbackReplyEmail(reply)
    expect(res.success).toBe(true)
    expect(direct.fn).toHaveBeenCalledTimes(1)
    expect(direct.fn.mock.calls[0][0].bcc).toEqual(['kevin@bmave.com'])
  })

  it('the owner is unchanged and still the only visible recipient', async () => {
    await sendFeedbackReplyEmail(reply)
    const call = direct.fn.mock.calls[0][0]
    expect(call.to).toBe(OWNER)
    expect(call.cc).toBeUndefined()
    expect([call.to].flat()).not.toContain('kevin@bmave.com')
    expect(call.replyTo).toBe('admin@beeorganized.com')
    expect(call.email_kind).toBe('feedback_reply')
  })

  it('the Fixed announcement (no reply text) carries the bcc too', async () => {
    await sendFeedbackReplyEmail({ ...reply, replyText: '', shipped: true })
    const call = direct.fn.mock.calls[0][0]
    expect(call.subject).toMatch(/^We fixed/)
    expect(call.bcc).toEqual(['kevin@bmave.com'])
    expect(call.to).toBe(OWNER)
  })

  it('when the owner IS the copy address, no duplicate bcc is added', async () => {
    await sendFeedbackReplyEmail({ ...reply, to: 'kevin@bmave.com' })
    expect(direct.fn.mock.calls[0][0].bcc).toBeUndefined()
  })
})

describe('a failure on the copy does not stop the reply', () => {
  it('a rejected copy address (validation_error) resends to the owner alone, and succeeds', async () => {
    direct.fn
      .mockResolvedValueOnce({ success: false, error: 'Invalid `bcc` field', errorName: 'validation_error', errorStatus: 422 })
      .mockResolvedValueOnce({ success: true, id: 'msg-2' })
    const res = await sendFeedbackReplyEmail(reply)
    expect(direct.fn).toHaveBeenCalledTimes(2)
    const second = direct.fn.mock.calls[1][0]
    expect(second.to).toBe(OWNER)
    expect(second.bcc).toBeUndefined()
    expect(second.subject).toBe(direct.fn.mock.calls[0][0].subject)
    expect(res).toMatchObject({ success: true, id: 'msg-2' })
  })

  it('a 422 without a typed name is treated the same way', async () => {
    direct.fn
      .mockResolvedValueOnce({ success: false, error: 'rejected', errorStatus: 422 })
      .mockResolvedValueOnce({ success: true, id: 'msg-3' })
    const res = await sendFeedbackReplyEmail(reply)
    expect(direct.fn).toHaveBeenCalledTimes(2)
    expect(res.success).toBe(true)
  })

  it('a failure that is not about the copy (rate limit) is reported, not retried', async () => {
    direct.fn.mockResolvedValueOnce({ success: false, error: 'Too many requests', errorName: 'rate_limit_exceeded', errorStatus: 429 })
    const res = await sendFeedbackReplyEmail(reply)
    expect(direct.fn).toHaveBeenCalledTimes(1)
    expect(res.success).toBe(false)
  })

  it('a thrown send still never throws out of the module', async () => {
    direct.fn.mockRejectedValueOnce(new Error('network down'))
    const res = await sendFeedbackReplyEmail(reply)
    expect(res).toMatchObject({ success: false, error: 'network down' })
  })
})
