// @vitest-environment node
// B2 — new-lead notification email (lib/lead-notification-email.ts).
//
// Pins:
//   • A location with N recipients → EXACTLY ONE sendEmailDirect call whose
//     `to` carries all N emails (one message to all, never a per-recipient
//     loop).
//   • The email body (html + text) includes the captured lead fields:
//     name, contact (email/phone), project type, request_details,
//     preferred_contact.
//   • Zero recipients → NO send, no throw, sent:false / recipientCount:0.
//   • Category is NOT used to filter — a 'moving'/'organizing' recipient is
//     notified the same as an 'all' recipient (this send goes to everyone
//     subscribed).
//   • Duplicate emails across a user + external collapse to one To entry.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendEmailDirectMock = vi.hoisted(() =>
  vi.fn(async () => ({ success: true, id: 'email-abc' })),
)
const resolveMock = vi.hoisted(() => vi.fn(async () => [] as any[]))
const logNotificationMock = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('@/lib/resend', () => ({
  sendEmailDirect: sendEmailDirectMock,
}))
// notifyNewLead logs the two paths that never reach the resend layer (zero
// recipients / recipient-resolution failure) to the outbound-mail notebook.
// Mocked here for a hard reason, not just for isolation: lib/notification-log
// imports lib/supabase-service, which calls createClient() at MODULE SCOPE and
// THROWS "supabaseUrl is required" without env — which this node-env suite has
// none of. Unmocked, that throw happens at import time and takes down the whole
// file before a single test runs. Real write behavior is covered against a
// mocked client in lib/notification-log-fire-safety.test.ts.
vi.mock('@/lib/notification-log', () => ({
  logNotification: logNotificationMock,
}))
vi.mock('@/lib/notification-recipients', () => ({
  resolveLeadRecipients: resolveMock,
}))

import { notifyNewLead } from '@/lib/lead-notification-email'

const LEAD = {
  id: 'lead-1',
  name: 'Jane Prospect',
  email: 'jane@example.com',
  phone: '(555) 111-2222',
  project_type: 'Moving',
  request_details: 'I have a medically complex condition and need help packing.',
  preferred_contact: 'Text',
}
const LOCATION = { id: 'loc-uuid-1', name: 'Boulder' }

const recip = (email: string, over: any = {}) => ({
  source: 'user',
  hub_user_id: 'u-' + email,
  name: email.split('@')[0],
  email,
  category: 'all',
  ...over,
})

beforeEach(() => {
  sendEmailDirectMock.mockClear()
  sendEmailDirectMock.mockResolvedValue({ success: true, id: 'email-abc' })
  resolveMock.mockReset()
  logNotificationMock.mockClear()
})

describe('notifyNewLead', () => {
  it('sends exactly ONE email addressed to all 3 recipients', async () => {
    resolveMock.mockResolvedValue([
      recip('owner@biz.com'),
      recip('manager@biz.com', { category: 'moving' }),
      recip('extra@biz.com', { source: 'external', category: 'organizing' }),
    ])

    const res = await notifyNewLead({ location: LOCATION, lead: LEAD })

    // ONE message, not a loop.
    expect(sendEmailDirectMock).toHaveBeenCalledTimes(1)
    const arg = sendEmailDirectMock.mock.calls[0][0]
    expect(Array.isArray(arg.to)).toBe(true)
    // All three, regardless of category (no category filtering here).
    expect(arg.to).toEqual(
      expect.arrayContaining(['owner@biz.com', 'manager@biz.com', 'extra@biz.com']),
    )
    expect(arg.to).toHaveLength(3)
    expect(res.sent).toBe(true)
    expect(res.recipientCount).toBe(3)
  })

  it('includes the captured lead fields in the email body', async () => {
    resolveMock.mockResolvedValue([recip('owner@biz.com')])

    await notifyNewLead({ location: LOCATION, lead: LEAD, baseUrl: 'https://hub.example.com' })

    const { subject, html, text } = sendEmailDirectMock.mock.calls[0][0]
    expect(subject).toContain('Jane Prospect')
    expect(subject).toContain('Boulder')
    for (const body of [html, text]) {
      expect(body).toContain('Jane Prospect')
      expect(body).toContain('jane@example.com')
      expect(body).toContain('(555) 111-2222')
      expect(body).toContain('Moving')
      expect(body).toContain('medically complex condition')
      expect(body).toContain('Text')
    }
  })

  it('includes the "open this lead" deep-link button (html + text) when a baseUrl is given', async () => {
    resolveMock.mockResolvedValue([recip('owner@biz.com')])

    await notifyNewLead({ location: LOCATION, lead: LEAD, baseUrl: 'https://hub.example.com/' })

    const { html, text } = sendEmailDirectMock.mock.calls[0][0]
    // Trailing slash on baseUrl is trimmed → exactly one slash before /clients.
    expect(html).toContain('href="https://hub.example.com/clients/lead-1"')
    expect(html).toContain('Open this lead in Bee Hub')
    expect(text).toContain('https://hub.example.com/clients/lead-1')
  })

  it('omits the deep-link button when no baseUrl is available (email still sends)', async () => {
    resolveMock.mockResolvedValue([recip('owner@biz.com')])

    const res = await notifyNewLead({ location: LOCATION, lead: LEAD })

    const { html, text } = sendEmailDirectMock.mock.calls[0][0]
    expect(html).not.toContain('/clients/lead-1')
    expect(html).not.toContain('Open this lead in Bee Hub')
    expect(text).not.toContain('/clients/lead-1')
    expect(res.sent).toBe(true)
  })

  it('sends nothing (no error) when the location has zero recipients', async () => {
    resolveMock.mockResolvedValue([])

    const res = await notifyNewLead({ location: LOCATION, lead: LEAD })

    expect(sendEmailDirectMock).not.toHaveBeenCalled()
    expect(res.sent).toBe(false)
    expect(res.recipientCount).toBe(0)
    expect(res.error).toBeUndefined()
  })

  // ── outbound-mail notebook (migrations/notification_log.sql) ────────
  // sendEmailDirect logs every send at the resend layer, so notifyNewLead
  // logs ONLY the paths that return before reaching it. These two are
  // therefore the only rows this module is responsible for.
  it('zero recipients logs a zero_recipients row — the silent no-send stays visible', async () => {
    resolveMock.mockResolvedValue([])

    await notifyNewLead({ location: LOCATION, lead: LEAD, locationSlug: 'boulder-01' })

    expect(logNotificationMock).toHaveBeenCalledTimes(1)
    expect(logNotificationMock.mock.calls[0][0]).toMatchObject({
      channel: 'email',
      send_status: 'zero_recipients',
      email_kind: 'lead_notification',
      lead_id: 'lead-1',
      lead_name: 'Jane Prospect',
      location_id: 'loc-uuid-1',
      location_slug: 'boulder-01',
    })
  })

  it('a recipient-resolution failure logs a failed row (it never reaches the resend hook)', async () => {
    resolveMock.mockRejectedValue(new Error('recipients table exploded'))

    const res = await notifyNewLead({ location: LOCATION, lead: LEAD })

    expect(res.sent).toBe(false)
    expect(logNotificationMock).toHaveBeenCalledTimes(1)
    expect(logNotificationMock.mock.calls[0][0]).toMatchObject({
      channel: 'email',
      send_status: 'failed',
      error: 'recipients table exploded',
    })
  })

  it('a real send does NOT double-log here — it threads context to the resend hook instead', async () => {
    resolveMock.mockResolvedValue([recip('a@biz.com')])

    await notifyNewLead({ location: LOCATION, lead: LEAD, locationSlug: 'boulder-01' })

    // The row is written inside sendEmailDirect (one per recipient), so this
    // module must stay silent or every send would be logged twice.
    expect(logNotificationMock).not.toHaveBeenCalled()
    expect(sendEmailDirectMock.mock.calls[0][0]).toMatchObject({
      email_kind: 'lead_notification',
      lead_id: 'lead-1',
      lead_name: 'Jane Prospect',
      location_id: 'loc-uuid-1',
      location_slug: 'boulder-01',
    })
  })

  it('collapses a duplicate email (user + external same address) to one To entry', async () => {
    resolveMock.mockResolvedValue([
      recip('shared@biz.com'),
      recip('shared@biz.com', { source: 'external' }),
      recip('other@biz.com'),
    ])

    await notifyNewLead({ location: LOCATION, lead: LEAD })

    const arg = sendEmailDirectMock.mock.calls[0][0]
    expect(arg.to).toHaveLength(2)
    expect(arg.to).toEqual(expect.arrayContaining(['shared@biz.com', 'other@biz.com']))
  })

  it('reply-to is the prospect email when captured', async () => {
    resolveMock.mockResolvedValue([recip('owner@biz.com')])
    await notifyNewLead({ location: LOCATION, lead: LEAD })
    expect(sendEmailDirectMock.mock.calls[0][0].replyTo).toBe('jane@example.com')
  })

  it('reports a send failure as a non-throwing error result', async () => {
    resolveMock.mockResolvedValue([recip('owner@biz.com')])
    sendEmailDirectMock.mockResolvedValue({ success: false, error: 'resend down' })

    const res = await notifyNewLead({ location: LOCATION, lead: LEAD })
    expect(res.sent).toBe(false)
    expect(res.recipientCount).toBe(1)
    expect(res.error).toBe('resend down')
  })
})
