// @vitest-environment node
// B2 — new-lead notification email (lib/lead-notification-email.ts).
//
// Pins (#82 collapsed the #72 two-variant split back to a single send):
//   • ONE sendEmailDirect call per lead (email_kind 'lead_notification'),
//     addressed to every recipient — never a per-recipient loop. Everyone gets
//     the "Open this lead in Bee Hub" button, account or not.
//   • Global CC rides a visible CC (#81), dropped by the mute gate like everyone
//     else, its resolution failing never blocks the location send.
//   • The email body (html + text) includes the captured lead fields:
//     name, contact (email/phone), project type, request_details,
//     preferred_contact.
//   • Zero recipients (none at all) → NO send, no throw, sent:false /
//     recipientCount:0, and exactly one zero_recipients row.
//   • Category is NOT used to filter — a 'moving'/'organizing' recipient is
//     notified the same as an 'all' recipient (this send goes to everyone
//     subscribed).
//   • Duplicate emails collapse to ONE recipient on ONE send.
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
  it('mixed sources → ONE send, everyone on to:, button for all (accounts AND account-less)', async () => {
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

    // ONE message to everyone — the collapse (#82). A test that sees two sends
    // means the split didn't come out.
    expect(sendEmailDirectMock).toHaveBeenCalledTimes(1)
    const arg = sendEmailDirectMock.mock.calls[0][0]

    expect(arg.email_kind).toBe('lead_notification')
    // Hub users AND the account-less external, all on the same to: line,
    // regardless of category (no category filtering here).
    expect(arg.to).toEqual(
      expect.arrayContaining(['owner@biz.com', 'manager@biz.com', 'extra@biz.com']),
    )
    expect(arg.to).toHaveLength(3)
    expect(arg.cc).toBeUndefined()
    // The button reaches everyone, including the account-less external.
    expect(arg.html).toContain('Open this lead in Bee Hub')

    // Each address once — the notification_log grain (one row per address per
    // send, written in sendEmailDirect) depends on this.
    expect(new Set(arg.to).size).toBe(arg.to.length)

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

  it('a person in BOTH hub_users and externals gets exactly ONE email — one log row', async () => {
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

    // The external twin collapsed into the user entry → the address appears
    // once on the single send, so sendEmailDirect logs one row for it.
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

// ── #82: single send + identical footer line ────────────────────────────────
describe('notifyNewLead — single send + footer', () => {
  it('an account-less-only location still gets the button — plus the footer line, not the old #72 notice', async () => {
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
    expect(arg.email_kind).toBe('lead_notification')
    expect(arg.to).toEqual(expect.arrayContaining(['ext@biz.com', 'zoho@biz.com']))
    // The button reaches account-less recipients too — they hit a login they
    // can't pass, and that's accepted (#82). The deep link IS present.
    expect(arg.html).toContain('Open this lead in Bee Hub')
    expect(arg.html).toContain('/clients/lead-1')
    expect(arg.text).toContain('/clients/lead-1')
    // The identical footer line, html + text. (The html assertion avoids the
    // apostrophe — escapeHtml renders it as &#39;.)
    expect(arg.html).toContain('Contact the corporate office to get set up')
    expect(arg.text).toContain("Don't have Bee Hub access yet?")
    // The old #72 no-access notice is GONE.
    expect(arg.html).not.toContain('manage follow-up from Bee Hub')
    expect(arg.text).not.toContain("don't yet have a Bee Hub account")
  })

  it('the footer line is IDENTICAL for a hub_user recipient — no per-account conditional', async () => {
    resolveMock.mockResolvedValue([recip('owner@biz.com')])

    await notifyNewLead({
      location: LOCATION,
      lead: LEAD,
      baseUrl: 'https://hub.example.com',
    })

    const arg = sendEmailDirectMock.mock.calls[0][0]
    expect(arg.email_kind).toBe('lead_notification')
    // Same footer line as the account-less case above — it does not vary by
    // whether the recipient has an account. That sameness is what keeps this a
    // single send.
    expect(arg.html).toContain('Contact the corporate office to get set up')
    expect(arg.text).toContain("Don't have Bee Hub access yet?")
    // …and never the old #72 notice.
    expect(arg.html).not.toContain('manage follow-up from Bee Hub')
  })
})

describe('notifyNewLead — global CC', () => {
  it('global CC rides a visible CC on the ONE send — location recipients on to, never bcc', async () => {
    resolveMock.mockResolvedValue([recip('owner@biz.com'), ext('ext@biz.com')])
    resolveGlobalCcMock.mockResolvedValue([cc('hq@bmave.com')])

    await notifyNewLead({
      location: LOCATION,
      lead: LEAD,
      baseUrl: 'https://hub.example.com',
    })

    // ONE send now (#82) — both location recipients on to, global CC on cc.
    expect(sendEmailDirectMock).toHaveBeenCalledTimes(1)
    const arg = sendEmailDirectMock.mock.calls[0][0]
    expect(arg.email_kind).toBe('lead_notification')
    expect(arg.to).toEqual(expect.arrayContaining(['owner@biz.com', 'ext@biz.com']))
    expect(arg.to).toHaveLength(2)
    expect(arg.cc).toEqual(['hq@bmave.com'])
    expect(arg.bcc).toBeUndefined()
  })

  it('a global CC who IS an active hub_user still rides CC — one email, one row', async () => {
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
    // global_cc always rides cc, account or not — the address is not ALSO a
    // location recipient here, so it stays on cc.
    expect(arg.cc).toEqual(['hq@bmave.com'])
    expect(arg.bcc).toBeUndefined()
    expect(arg.html).toContain('Open this lead in Bee Hub')
  })

  it('both types at one location → ONE send, both addresses on to:, global CC on cc', async () => {
    // A hub_user + an external both ride the To line; two global CCs ride the
    // CC line. This is the both-types case: a test that sees two sends means
    // the collapse didn't land. One message → sendEmailDirect logs one row each.
    resolveMock.mockResolvedValue([recip('owner@biz.com'), ext('ext@biz.com')])
    resolveGlobalCcMock.mockResolvedValue([
      cc('hq-user@bmave.com', { hub_user_id: 'hu-1' }),
      cc('hq-plain@bmave.com'),
    ])

    const res = await notifyNewLead({
      location: LOCATION,
      lead: LEAD,
      baseUrl: 'https://hub.example.com',
    })

    expect(sendEmailDirectMock).toHaveBeenCalledTimes(1)
    const arg = sendEmailDirectMock.mock.calls[0][0]
    expect(arg.email_kind).toBe('lead_notification')
    expect(arg.to).toEqual(expect.arrayContaining(['owner@biz.com', 'ext@biz.com']))
    expect(arg.to).toHaveLength(2)
    expect(arg.cc).toEqual(expect.arrayContaining(['hq-user@bmave.com', 'hq-plain@bmave.com']))
    expect(arg.cc).toHaveLength(2)
    expect(arg.bcc).toBeUndefined()

    // Every address counted once, across to + cc.
    expect(res.recipientCount).toBe(4)
  })

  it('a global CC who is ALSO a location external collapses to ONE entry, addressed on to', async () => {
    resolveMock.mockResolvedValue([ext('hq@bmave.com')])
    resolveGlobalCcMock.mockResolvedValue([cc('hq@bmave.com', { hub_user_id: 'hu-1' })])

    const res = await notifyNewLead({
      location: LOCATION,
      lead: LEAD,
      baseUrl: 'https://hub.example.com',
    })

    // One person, one email. The location entry outranks the global CC, so the
    // address is addressed once — on To, never duplicated onto CC.
    expect(sendEmailDirectMock).toHaveBeenCalledTimes(1)
    const arg = sendEmailDirectMock.mock.calls[0][0]
    expect(arg.email_kind).toBe('lead_notification')
    expect(arg.to).toEqual(['hq@bmave.com'])
    expect(arg.cc).toBeUndefined()
    expect(arg.bcc).toBeUndefined()
    expect(res.recipientCount).toBe(1)
  })

  it('ONLY global CC → promoted onto to, cc undefined; no zero_recipients row', async () => {
    resolveMock.mockResolvedValue([])
    resolveGlobalCcMock.mockResolvedValue([cc('hq@bmave.com')])

    const res = await notifyNewLead({ location: LOCATION, lead: LEAD })

    expect(sendEmailDirectMock).toHaveBeenCalledTimes(1)
    const arg = sendEmailDirectMock.mock.calls[0][0]
    expect(arg.email_kind).toBe('lead_notification')
    // ONLY global CC → no location To line, so the cc list is promoted onto To
    // (Resend rejects an empty `to`). Nothing is left on cc.
    expect(arg.to).toEqual(['hq@bmave.com'])
    expect(arg.cc).toBeUndefined()
    expect(arg.bcc).toBeUndefined()
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
