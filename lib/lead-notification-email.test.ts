// @vitest-environment node
// B2 — new-lead notification email (lib/lead-notification-email.ts).
//
// Pins:
//   • TWO VARIANTS, up to two sendEmailDirect calls per lead — the with-button
//     email (email_kind 'lead_notification') to hub-account recipients, the
//     no-button email + notice line ('lead_notification_no_access') to
//     everyone else. Each variant is ONE message to its whole partition, never
//     a per-recipient loop, and the partitions are address-disjoint.
//   • Global CC rides BCC on the matching variant (button iff the address has
//     an active account), is dropped by the mute gate like everyone else, and
//     its resolution failing never blocks the location send.
//   • The email body (html + text) includes the captured lead fields:
//     name, contact (email/phone), project type, request_details,
//     preferred_contact.
//   • Zero recipients across BOTH variants → NO send, no throw,
//     sent:false / recipientCount:0. ONE empty partition is normal and mints
//     no zero_recipients row.
//   • Category is NOT used to filter — a 'moving'/'organizing' recipient is
//     notified the same as an 'all' recipient (this send goes to everyone
//     subscribed).
//   • Duplicate emails collapse to ONE recipient on ONE send, the with-button
//     one when any colliding identity can open the record.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendEmailDirectMock = vi.hoisted(() =>
  vi.fn(async () => ({ success: true, id: 'email-abc' })),
)
const resolveMock = vi.hoisted(() => vi.fn(async () => [] as any[]))
const resolveGlobalCcMock = vi.hoisted(() => vi.fn(async () => [] as any[]))
const logNotificationMock = vi.hoisted(() => vi.fn(async () => {}))
// Every test in THIS file is about a location that is cleared to send, so the
// gate defaults to live and stays out of the way. Mocked for the same hard
// reason as notification-log below — lib/notifications-live imports
// lib/supabase-service, whose module-scope createClient() throws without env.
// The gate's own behavior is pinned in beta-notifications-live-gate.test.ts.
const notificationsLiveMock = vi.hoisted(() =>
  vi.fn(async () => ({ live: true }) as any),
)

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
  resolveGlobalCcRecipients: resolveGlobalCcMock,
}))
vi.mock('@/lib/notifications-live', () => ({
  resolveNotificationsLive: notificationsLiveMock,
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
// External/zoho rows carry no hub_user_id — mirror that so rank() is exercised
// against the real shape.
const ext = (email: string, over: any = {}) =>
  recip(email, { source: 'external', hub_user_id: null, ...over })
const cc = (email: string, over: any = {}) => ({
  source: 'global_cc',
  hub_user_id: null,
  name: 'HQ',
  email,
  category: 'all',
  ...over,
})

beforeEach(() => {
  sendEmailDirectMock.mockClear()
  sendEmailDirectMock.mockResolvedValue({ success: true, id: 'email-abc' })
  resolveMock.mockReset()
  resolveGlobalCcMock.mockReset()
  resolveGlobalCcMock.mockResolvedValue([])
  logNotificationMock.mockClear()
  notificationsLiveMock.mockClear()
  notificationsLiveMock.mockResolvedValue({ live: true })
})

describe('notifyNewLead', () => {
  it('splits mixed sources into TWO sends — button variant to hub accounts, no-access to the rest', async () => {
    resolveMock.mockResolvedValue([
      recip('owner@biz.com'),
      recip('manager@biz.com', { category: 'moving' }),
      ext('extra@biz.com', { category: 'organizing' }),
    ])

    const res = await notifyNewLead({
      location: LOCATION,
      lead: LEAD,
      baseUrl: 'https://hub.example.com',
    })

    // One message PER VARIANT, never a per-recipient loop.
    expect(sendEmailDirectMock).toHaveBeenCalledTimes(2)
    const [buttonSend, plainSend] = sendEmailDirectMock.mock.calls.map((c: any) => c[0])

    expect(buttonSend.email_kind).toBe('lead_notification')
    // Both users regardless of category (no category filtering here).
    expect(buttonSend.to).toEqual(
      expect.arrayContaining(['owner@biz.com', 'manager@biz.com']),
    )
    expect(buttonSend.to).toHaveLength(2)
    expect(buttonSend.html).toContain('Open this lead in Bee Hub')

    expect(plainSend.email_kind).toBe('lead_notification_no_access')
    expect(plainSend.to).toEqual(['extra@biz.com'])
    expect(plainSend.html).not.toContain('Open this lead in Bee Hub')

    // Address-disjoint partitions — the notification_log grain (one row per
    // address per send, written in sendEmailDirect) depends on this.
    const all = [...buttonSend.to, ...plainSend.to]
    expect(new Set(all).size).toBe(all.length)

    expect(res.sent).toBe(true)
    expect(res.recipientCount).toBe(3)
  })

  it('dedupes recipients CASE-INSENSITIVELY, keeping the first-seen casing', async () => {
    // A hub_user and an external row can share an address under different casing.
    // The To line must carry it once — not twice — while preserving how it reads.
    resolveMock.mockResolvedValue([
      recip('Owner@Biz.com'),
      recip('owner@biz.com', { source: 'external' }), // same address, lower-cased
      recip('other@biz.com'),
    ])

    const res = await notifyNewLead({ location: LOCATION, lead: LEAD })

    const arg = sendEmailDirectMock.mock.calls[0][0]
    expect(arg.to).toHaveLength(2) // collapsed to 2 distinct addresses
    expect(arg.to).toContain('Owner@Biz.com') // first-seen original casing preserved
    expect(arg.to).toContain('other@biz.com')
    expect(arg.to).not.toContain('owner@biz.com') // the case-variant duplicate dropped
    expect(res.recipientCount).toBe(2)
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

  it('a person in BOTH hub_users and externals gets exactly ONE email — the with-button one', async () => {
    resolveMock.mockResolvedValue([
      recip('shared@biz.com'),
      ext('shared@biz.com'),
      recip('other@biz.com'),
    ])

    await notifyNewLead({
      location: LOCATION,
      lead: LEAD,
      baseUrl: 'https://hub.example.com',
    })

    // The external twin collapsed into the user entry → the no-access
    // partition emptied → ONE send, the button variant.
    expect(sendEmailDirectMock).toHaveBeenCalledTimes(1)
    const arg = sendEmailDirectMock.mock.calls[0][0]
    expect(arg.email_kind).toBe('lead_notification')
    expect(arg.to).toHaveLength(2)
    expect(arg.to).toEqual(expect.arrayContaining(['shared@biz.com', 'other@biz.com']))
    expect(arg.html).toContain('Open this lead in Bee Hub')
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

// ── #72: the no-access variant + global CC ──────────────────────────────────
describe('notifyNewLead — two variants', () => {
  it('an account-less-only location gets ONE no-access send: no button, notice line present', async () => {
    resolveMock.mockResolvedValue([
      ext('ext@biz.com'),
      recip('zoho@biz.com', { source: 'zoho', hub_user_id: null }),
    ])

    await notifyNewLead({
      location: LOCATION,
      lead: LEAD,
      baseUrl: 'https://hub.example.com',
    })

    expect(sendEmailDirectMock).toHaveBeenCalledTimes(1)
    const arg = sendEmailDirectMock.mock.calls[0][0]
    expect(arg.email_kind).toBe('lead_notification_no_access')
    expect(arg.to).toEqual(expect.arrayContaining(['ext@biz.com', 'zoho@biz.com']))
    // No button, no deep link — even though a baseUrl WAS available. The
    // target sits behind requireAuth; for these recipients it is a dead end.
    expect(arg.html).not.toContain('Open this lead in Bee Hub')
    expect(arg.html).not.toContain('/clients/lead-1')
    expect(arg.text).not.toContain('/clients/lead-1')
    // The added line, html + text. (The html assertion avoids apostrophes —
    // escapeHtml renders them as &#39;.)
    expect(arg.html).toContain('manage follow-up from Bee Hub')
    expect(arg.text).toContain("don't yet have a Bee Hub account")
    // The with-button variant's copy stays notice-free — pinned from the other
    // side by the body test above (it asserts specific fields, and this line
    // never appears there).
  })

  it('the with-button variant carries NO notice line', async () => {
    resolveMock.mockResolvedValue([recip('owner@biz.com')])

    await notifyNewLead({
      location: LOCATION,
      lead: LEAD,
      baseUrl: 'https://hub.example.com',
    })

    const arg = sendEmailDirectMock.mock.calls[0][0]
    expect(arg.email_kind).toBe('lead_notification')
    expect(arg.html).not.toContain('manage follow-up from Bee Hub')
    expect(arg.text).not.toContain('Bee Hub account')
  })

  it('one variant failing still reports the other as sent — with the error attached', async () => {
    resolveMock.mockResolvedValue([recip('owner@biz.com'), ext('ext@biz.com')])
    sendEmailDirectMock
      .mockResolvedValueOnce({ success: true, id: 'email-1' })
      .mockResolvedValueOnce({ success: false, error: 'resend down' })

    const res = await notifyNewLead({ location: LOCATION, lead: LEAD })

    expect(res.sent).toBe(true)
    expect(res.emailId).toBe('email-1')
    expect(res.error).toBe('resend down')
    expect(res.recipientCount).toBe(2)
  })
})

describe('notifyNewLead — global CC', () => {
  it('an account-less global CC rides BCC on the no-access send', async () => {
    resolveMock.mockResolvedValue([recip('owner@biz.com'), ext('ext@biz.com')])
    resolveGlobalCcMock.mockResolvedValue([cc('hq@bmave.com')])

    await notifyNewLead({
      location: LOCATION,
      lead: LEAD,
      baseUrl: 'https://hub.example.com',
    })

    expect(sendEmailDirectMock).toHaveBeenCalledTimes(2)
    const [buttonSend, plainSend] = sendEmailDirectMock.mock.calls.map((c: any) => c[0])
    // Never on the franchise To line.
    expect(buttonSend.to).toEqual(['owner@biz.com'])
    expect(buttonSend.bcc).toBeUndefined()
    expect(plainSend.to).toEqual(['ext@biz.com'])
    expect(plainSend.bcc).toEqual(['hq@bmave.com'])
  })

  it('a global CC who IS an active hub_user rides BCC on the BUTTON send — still one email', async () => {
    resolveMock.mockResolvedValue([recip('owner@biz.com')])
    resolveGlobalCcMock.mockResolvedValue([cc('hq@bmave.com', { hub_user_id: 'hu-1' })])

    await notifyNewLead({
      location: LOCATION,
      lead: LEAD,
      baseUrl: 'https://hub.example.com',
    })

    expect(sendEmailDirectMock).toHaveBeenCalledTimes(1)
    const arg = sendEmailDirectMock.mock.calls[0][0]
    expect(arg.email_kind).toBe('lead_notification')
    expect(arg.to).toEqual(['owner@biz.com'])
    expect(arg.bcc).toEqual(['hq@bmave.com'])
    expect(arg.html).toContain('Open this lead in Bee Hub')
  })

  it('a global CC who is ALSO a location external collapses to ONE entry, upgraded by their account', async () => {
    resolveMock.mockResolvedValue([ext('hq@bmave.com')])
    resolveGlobalCcMock.mockResolvedValue([cc('hq@bmave.com', { hub_user_id: 'hu-1' })])

    const res = await notifyNewLead({
      location: LOCATION,
      lead: LEAD,
      baseUrl: 'https://hub.example.com',
    })

    // One person, one email — the with-button one (their account wins), and
    // with no franchise To line left to protect, the BCC-only list is promoted
    // onto To (Resend requires a non-empty `to`).
    expect(sendEmailDirectMock).toHaveBeenCalledTimes(1)
    const arg = sendEmailDirectMock.mock.calls[0][0]
    expect(arg.email_kind).toBe('lead_notification')
    expect(arg.to).toEqual(['hq@bmave.com'])
    expect(arg.bcc).toBeUndefined()
    expect(res.recipientCount).toBe(1)
  })

  it('a location with ZERO recipients of its own still sends to global CC — and logs no zero_recipients row', async () => {
    resolveMock.mockResolvedValue([])
    resolveGlobalCcMock.mockResolvedValue([cc('hq@bmave.com')])

    const res = await notifyNewLead({ location: LOCATION, lead: LEAD })

    expect(sendEmailDirectMock).toHaveBeenCalledTimes(1)
    const arg = sendEmailDirectMock.mock.calls[0][0]
    expect(arg.email_kind).toBe('lead_notification_no_access')
    expect(arg.to).toEqual(['hq@bmave.com'])
    expect(res.sent).toBe(true)
    expect(logNotificationMock).not.toHaveBeenCalled()
  })

  it('the global lookup REJECTING never blocks the location send', async () => {
    resolveMock.mockResolvedValue([recip('owner@biz.com')])
    resolveGlobalCcMock.mockRejectedValue(new Error('global cc exploded'))

    const res = await notifyNewLead({ location: LOCATION, lead: LEAD })

    expect(sendEmailDirectMock).toHaveBeenCalledTimes(1)
    expect(sendEmailDirectMock.mock.calls[0][0].to).toEqual(['owner@biz.com'])
    expect(res.sent).toBe(true)
    expect(res.error).toBeUndefined()
  })

  it('a muted location sends nothing to anyone — global CC included', async () => {
    notificationsLiveMock.mockResolvedValue({ live: false, reason: 'muted' })
    resolveGlobalCcMock.mockResolvedValue([cc('hq@bmave.com')])

    const res = await notifyNewLead({ location: LOCATION, lead: LEAD })

    expect(sendEmailDirectMock).not.toHaveBeenCalled()
    expect(resolveGlobalCcMock).not.toHaveBeenCalled()
    expect(res.muted).toBe(true)
  })
})
