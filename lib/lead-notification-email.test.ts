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
// #91 — location-scoped Bee Hub branch. Defaults to true (location IS on Bee
// Hub) so every pre-#91 test keeps seeing the button/branding unchanged; the
// no-access suite flips it to false.
const hasHubAccessMock = vi.hoisted(() => vi.fn(async () => true))
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
  locationHasActiveHubUser: hasHubAccessMock,
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
  hasHubAccessMock.mockReset()
  hasHubAccessMock.mockResolvedValue(true)
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

// ── #91: location-scoped Bee Hub vs non-hub variant ─────────────────────────
// The branch is on the LOCATION, not the recipient — so each lead is still ONE
// send, and everyone at one office gets the same email. Every test here asserts
// exactly one sendEmailDirect call.
describe('notifyNewLead — #91 location-scoped no-Bee-Hub variant', () => {
  // The #82 footer line and the product name — both must be ABSENT from the
  // non-hub variant, in html AND text.
  const FOOTER_LINE = 'Contact the corporate office to get set up'

  it('location WITH an active hub_user → Bee Hub email: button present, ONE send', async () => {
    hasHubAccessMock.mockResolvedValue(true)
    resolveMock.mockResolvedValue([recip('owner@biz.com')])

    const res = await notifyNewLead({
      location: LOCATION,
      lead: LEAD,
      baseUrl: 'https://hub.example.com',
    })

    expect(sendEmailDirectMock).toHaveBeenCalledTimes(1)
    const arg = sendEmailDirectMock.mock.calls[0][0]
    expect(arg.email_kind).toBe('lead_notification')
    expect(arg.fromName).toBe('Bee Hub')
    expect(arg.html).toContain('Open this lead in Bee Hub')
    expect(arg.html).toContain(FOOTER_LINE)
    expect(res.sent).toBe(true)
  })

  it('location with NONE → clean email: no button, and NO "Bee Hub" / footer line in html OR text, ONE send', async () => {
    hasHubAccessMock.mockResolvedValue(false)
    resolveMock.mockResolvedValue([
      ext('ext@biz.com'),
      recip('zoho@biz.com', { source: 'zoho', hub_user_id: null }),
    ])

    const res = await notifyNewLead({
      location: LOCATION,
      lead: LEAD,
      baseUrl: 'https://hub.example.com',
    })

    // ONE send — the branch is location-level, not two sends.
    expect(sendEmailDirectMock).toHaveBeenCalledTimes(1)
    const arg = sendEmailDirectMock.mock.calls[0][0]

    // Distinct email_kind so the notebook can tell the variants apart.
    expect(arg.email_kind).toBe('lead_notification_non_hub')
    // Signed as Bee Organized, not Bee Hub — including the visible From name.
    expect(arg.fromName).toBe('Bee Organized')

    for (const body of [arg.html, arg.text]) {
      // ZERO Bee Hub references anywhere.
      expect(body).not.toContain('Bee Hub')
      // No dead button, no deep link.
      expect(body).not.toContain('Open this lead')
      expect(body).not.toContain('/clients/lead-1')
      // The #82 footer line is gone.
      expect(body).not.toContain(FOOTER_LINE)
      // …but the lead details still made it through.
      expect(body).toContain('Jane Prospect')
    }
    // Subject carries no product name in either variant.
    expect(arg.subject).not.toContain('Bee Hub')
    // Still addressed and sent normally.
    expect(arg.to).toEqual(expect.arrayContaining(['ext@biz.com', 'zoho@biz.com']))
    expect(res.sent).toBe(true)
  })

  it('a location whose ONLY hub_user is inactive/disabled is treated as no-access', async () => {
    // The resolver (locationHasActiveHubUser) collapses is_active=false /
    // disabled_at-set to "no access" — its filter is pinned in
    // beta-lead-notification-recipients.test.ts. Here we assert notifyNewLead
    // honors a false result: the clean variant, one send.
    hasHubAccessMock.mockResolvedValue(false)
    resolveMock.mockResolvedValue([ext('ext@biz.com')])

    await notifyNewLead({
      location: LOCATION,
      lead: LEAD,
      baseUrl: 'https://hub.example.com',
    })

    expect(sendEmailDirectMock).toHaveBeenCalledTimes(1)
    const arg = sendEmailDirectMock.mock.calls[0][0]
    expect(arg.email_kind).toBe('lead_notification_non_hub')
    expect(arg.html).not.toContain('Bee Hub')
  })

  it('global CC at a no-access location → on cc, SAME (clean) body, ONE send', async () => {
    hasHubAccessMock.mockResolvedValue(false)
    resolveMock.mockResolvedValue([ext('ext@biz.com')])
    resolveGlobalCcMock.mockResolvedValue([cc('hq@bmave.com')])

    const res = await notifyNewLead({
      location: LOCATION,
      lead: LEAD,
      baseUrl: 'https://hub.example.com',
    })

    // Corporate CC does NOT get a second, Bee-Hub-branded send — that would be
    // two sends again. They ride cc on the ONE clean email.
    expect(sendEmailDirectMock).toHaveBeenCalledTimes(1)
    const arg = sendEmailDirectMock.mock.calls[0][0]
    expect(arg.email_kind).toBe('lead_notification_non_hub')
    expect(arg.to).toEqual(['ext@biz.com'])
    expect(arg.cc).toEqual(['hq@bmave.com'])
    expect(arg.html).not.toContain('Bee Hub')
    expect(res.recipientCount).toBe(2)
  })

  it('a hub-access read error falls SOFT to the clean variant (resolver returns false), send still succeeds', async () => {
    // locationHasActiveHubUser swallows internally and returns FALSE on error
    // (pinned in beta-lead-notification-recipients.test.ts). notifyNewLead then
    // sends the clean, Bee-Hub-free email — a failed lookup must not resurrect
    // the confusing message. The send still happens.
    hasHubAccessMock.mockResolvedValue(false)
    resolveMock.mockResolvedValue([recip('owner@biz.com')])

    const res = await notifyNewLead({ location: LOCATION, lead: LEAD, baseUrl: 'https://hub.example.com' })

    expect(sendEmailDirectMock).toHaveBeenCalledTimes(1)
    const arg = sendEmailDirectMock.mock.calls[0][0]
    expect(arg.email_kind).toBe('lead_notification_non_hub')
    expect(arg.html).not.toContain('Bee Hub')
    expect(res.sent).toBe(true)
  })

  it('a muted no-access location sends nothing — the hub-access lookup is never run', async () => {
    notificationsLiveMock.mockResolvedValue({ live: false, reason: 'muted' })

    const res = await notifyNewLead({ location: LOCATION, lead: LEAD })

    expect(sendEmailDirectMock).not.toHaveBeenCalled()
    // Gated FIRST — a muted location must not pay for the hub-access read.
    expect(hasHubAccessMock).not.toHaveBeenCalled()
    expect(res.muted).toBe(true)
  })

  it('zero recipients at a no-access location logs zero_recipients once, never sends', async () => {
    hasHubAccessMock.mockResolvedValue(false)
    resolveMock.mockResolvedValue([])

    const res = await notifyNewLead({ location: LOCATION, lead: LEAD })

    expect(sendEmailDirectMock).not.toHaveBeenCalled()
    expect(logNotificationMock).toHaveBeenCalledTimes(1)
    expect(logNotificationMock.mock.calls[0][0]).toMatchObject({
      send_status: 'zero_recipients',
    })
    expect(res.recipientCount).toBe(0)
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

// ── #86: resubmission variant (returning client) ────────────────────────────
// resubmission:true reframes the copy (subject / heading / intro / details
// label) and swaps the email_kind, but inherits EVERYTHING else — the gate, the
// #91 hub/non-hub branch, global CC placement, dedupe. These pins assert the new
// framing AND that each inherited behavior still holds on the resubmission path.
describe('notifyNewLead — #86 resubmission variant', () => {
  it('hub location → subject leads "Returning client:", heading/intro reframed, email_kind lead_resubmission', async () => {
    hasHubAccessMock.mockResolvedValue(true)
    resolveMock.mockResolvedValue([recip('owner@biz.com')])

    await notifyNewLead({
      location: LOCATION,
      lead: LEAD,
      baseUrl: 'https://hub.example.com',
      resubmission: true,
    })

    const arg = sendEmailDirectMock.mock.calls[0][0]
    // Name-first subject, "Returning client:" prefix so the framing survives
    // mobile truncation; still carries the name + location.
    expect(arg.subject).toBe('Returning client: Jane Prospect — Boulder')
    // Distinct kind so the notebook tells a returning-client alert from a new one.
    expect(arg.email_kind).toBe('lead_resubmission')
    for (const body of [arg.html, arg.text]) {
      expect(body).toContain('Returning client — new request for Boulder')
      expect(body).toContain('already in your list just submitted the website form again')
      expect(body).toContain('What they told us this time')
      // The submitted request is carried.
      expect(body).toContain('medically complex condition')
    }
    // Hub layer intact: button + Bee Hub branding still present on a hub location.
    expect(arg.html).toContain('Open this lead in Bee Hub')
    expect(arg.fromName).toBe('Bee Hub')
  })

  it('non-hub location → clean resubmission email: email_kind lead_resubmission_non_hub, ZERO Bee Hub refs, still reframed', async () => {
    hasHubAccessMock.mockResolvedValue(false)
    resolveMock.mockResolvedValue([recip('owner@biz.com')])

    await notifyNewLead({
      location: LOCATION,
      lead: LEAD,
      baseUrl: 'https://hub.example.com',
      resubmission: true,
    })

    const arg = sendEmailDirectMock.mock.calls[0][0]
    expect(arg.email_kind).toBe('lead_resubmission_non_hub')
    expect(arg.fromName).toBe('Bee Organized')
    expect(arg.subject).toBe('Returning client: Jane Prospect — Boulder')
    for (const body of [arg.html, arg.text]) {
      expect(body).not.toContain('Bee Hub')
      // Reframed copy is present even in the clean variant.
      expect(body).toContain('Returning client — new request for Boulder')
      expect(body).toContain('What they told us this time')
    }
    expect(arg.subject).not.toContain('Bee Hub')
  })

  it('a muted location on the resubmission path logs the muted row under lead_resubmission and never sends', async () => {
    notificationsLiveMock.mockResolvedValue({ live: false, reason: 'muted' })

    const res = await notifyNewLead({
      location: LOCATION,
      lead: LEAD,
      locationSlug: 'boulder-01',
      resubmission: true,
    })

    expect(sendEmailDirectMock).not.toHaveBeenCalled()
    expect(hasHubAccessMock).not.toHaveBeenCalled()
    expect(res.muted).toBe(true)
    // The muted row carries the resubmission base kind, so a muted resubmission
    // is distinguishable from a muted new-lead in the notebook.
    expect(logNotificationMock.mock.calls[0][0]).toMatchObject({
      channel: 'email',
      send_status: 'muted',
      email_kind: 'lead_resubmission',
    })
  })

  it('global CC still rides a visible CC on the resubmission send', async () => {
    resolveMock.mockResolvedValue([recip('owner@biz.com')])
    resolveGlobalCcMock.mockResolvedValue([cc('hq@bmave.com')])

    await notifyNewLead({
      location: LOCATION,
      lead: LEAD,
      baseUrl: 'https://hub.example.com',
      resubmission: true,
    })

    const arg = sendEmailDirectMock.mock.calls[0][0]
    expect(arg.email_kind).toBe('lead_resubmission')
    expect(arg.to).toEqual(['owner@biz.com'])
    expect(arg.cc).toEqual(['hq@bmave.com'])
    expect(arg.bcc).toBeUndefined()
  })

  it('the new-lead path is unchanged — default (no resubmission flag) keeps subject "New lead:" and email_kind lead_notification', async () => {
    resolveMock.mockResolvedValue([recip('owner@biz.com')])

    await notifyNewLead({ location: LOCATION, lead: LEAD, baseUrl: 'https://hub.example.com' })

    const arg = sendEmailDirectMock.mock.calls[0][0]
    expect(arg.subject).toBe('New lead: Jane Prospect — Boulder')
    expect(arg.email_kind).toBe('lead_notification')
    expect(arg.html).toContain('New lead for Boulder')
    expect(arg.html).not.toContain('Returning client')
  })
})

// ── #92: the captured address renders as one adaptive row ────────────────────
// The form collects a full address but zip-alone is the common case, so the row
// LABEL adapts (Zip / Location / Address) and OMITS entirely when nothing was
// collected. Asserted in BOTH html and text — the original #92 bug was that the
// address never reached either.
describe('notifyNewLead — #92 adaptive address row', () => {
  const bodies = () => {
    const arg = sendEmailDirectMock.mock.calls[0][0]
    return [arg.html as string, arg.text as string]
  }

  it('zip only → a "Zip: <zip>" row, no "Address"/"Location" label (html + text)', async () => {
    resolveMock.mockResolvedValue([recip('owner@biz.com')])
    await notifyNewLead({ location: LOCATION, lead: { ...LEAD, zip: '98101' } })
    for (const body of bodies()) {
      expect(body).toContain('Zip')
      expect(body).toContain('98101')
      expect(body).not.toContain('Location')
    }
    // Plain-text row reads exactly "Zip: 98101".
    expect(sendEmailDirectMock.mock.calls[0][0].text).toContain('Zip: 98101')
  })

  it('city + state + zip, no street → a "Location: City, ST zip" row', async () => {
    resolveMock.mockResolvedValue([recip('owner@biz.com')])
    await notifyNewLead({ location: LOCATION, lead: { ...LEAD, city: 'Seattle', state: 'WA', zip: '98101' } })
    expect(sendEmailDirectMock.mock.calls[0][0].text).toContain('Location: Seattle, WA 98101')
    for (const body of bodies()) expect(body).toContain('Seattle, WA 98101')
  })

  it('street + city + state + zip → an "Address: 123 Main St, City, ST zip" row', async () => {
    resolveMock.mockResolvedValue([recip('owner@biz.com')])
    await notifyNewLead({
      location: LOCATION,
      lead: { ...LEAD, address: '123 Main St', city: 'Seattle', state: 'WA', zip: '98101' },
    })
    expect(sendEmailDirectMock.mock.calls[0][0].text).toContain('Address: 123 Main St, Seattle, WA 98101')
  })

  it('no address fields → NO address row at all (not a dashed row)', async () => {
    resolveMock.mockResolvedValue([recip('owner@biz.com')])
    await notifyNewLead({ location: LOCATION, lead: LEAD })
    for (const body of bodies()) {
      expect(body).not.toContain('Zip:')
      expect(body).not.toContain('Location:')
      // No bare "Address" label leaked in (the "Email"/"Phone" rows still render).
      expect(body).not.toMatch(/\bAddress\b/)
    }
  })
})
