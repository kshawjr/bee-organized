// @vitest-environment node
// Step 3 — the notifications_live gate, at the two send rails.
//
// THE RULE both rails enforce: notifications_live = true AND ≥1 recipient.
// The FLAG is what mutes a location, NOT its recipient list — all 44 onboarding
// locations already have seeded recipients from the earlier top-up. So the muted
// cases below deliberately hand the rail a FULL recipient list: a test that
// muted an empty location would pass for the wrong reason, and would keep
// passing if the gate were deleted.
//
// The reader itself is mocked here and pinned for real in notifications-live.test.ts.
// logSlackNotification's muted routing is pinned in notification-log-fire-safety.test.ts
// (it calls logNotification through a same-module reference, which mocking the
// module's export cannot observe).
//
// Pins:
//   • live → sends exactly as today.
//   • muted WITH recipients → NO send, and a send_status:'muted' row.
//   • the gate runs BEFORE recipient resolution (no Zoho lookup for the 44).
//   • a fail-closed read is recorded with its reason, so a missing column is
//     distinguishable from an intentional mute.
//   • muted → no Slack post, and the transport is never reached.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendEmailDirectMock = vi.hoisted(() =>
  vi.fn(async () => ({ success: true, id: 'email-abc' })),
)
const resolveRecipientsMock = vi.hoisted(() => vi.fn(async () => [] as any[]))
const logNotificationMock = vi.hoisted(() => vi.fn(async () => {}))
const gateMock = vi.hoisted(() => vi.fn(async () => ({ live: true }) as any))

vi.mock('@/lib/resend', () => ({ sendEmailDirect: sendEmailDirectMock }))
vi.mock('@/lib/notification-recipients', () => ({
  resolveLeadRecipients: resolveRecipientsMock,
}))
vi.mock('@/lib/notifications-live', () => ({ resolveNotificationsLive: gateMock }))
// Mocked to observe the muted row — and for the same hard reason the other node
// suites give: lib/notification-log imports lib/supabase-service, whose
// module-scope createClient() throws without env and would take the file down at
// import time.
vi.mock('@/lib/notification-log', () => ({
  logNotification: logNotificationMock,
  logSlackNotification: vi.fn(async () => {}),
}))
// slack-bot reads the location row through this; the gate is mocked above, so
// this only needs to exist, not behave.
vi.mock('@/lib/supabase-service', () => ({
  supabaseService: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
    }),
  },
}))

import { notifyNewLead } from '@/lib/lead-notification-email'
import { notifyNewLeadSlack } from '@/lib/slack-bot'

const LEAD = {
  id: 'lead-1',
  name: 'Jane Prospect',
  email: 'jane@example.com',
  phone: '(555) 111-2222',
  project_type: 'Moving',
  request_details: 'Need help packing.',
  preferred_contact: 'Text',
}
const LOCATION = { id: 'loc-uuid-1', name: 'Boulder' }

// A muted location WITH recipients — the shape of all 44. See the header.
const SEEDED = [
  { source: 'user', hub_user_id: 'u1', name: 'Owner', email: 'owner@biz.com', category: 'all' },
  { source: 'external', hub_user_id: null, name: 'Ops', email: 'ops@biz.com', category: 'all' },
]

beforeEach(() => {
  vi.clearAllMocks()
  sendEmailDirectMock.mockResolvedValue({ success: true, id: 'email-abc' })
  resolveRecipientsMock.mockResolvedValue(SEEDED)
  gateMock.mockResolvedValue({ live: true })
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('notifyNewLead — notifications_live gate', () => {
  it('a live location sends exactly as today', async () => {
    const res = await notifyNewLead({
      location: LOCATION, lead: LEAD, locationSlug: 'loc_portland',
    })
    expect(sendEmailDirectMock).toHaveBeenCalledTimes(1)
    expect(res).toMatchObject({ sent: true, recipientCount: 2 })
    expect(res.muted).toBeUndefined()
  })

  it('a muted location WITH recipients sends NO email, and the suppression is logged', async () => {
    gateMock.mockResolvedValue({ live: false, reason: 'muted' })

    const res = await notifyNewLead({
      location: LOCATION, lead: LEAD, locationSlug: 'loc_omaha',
    })

    expect(sendEmailDirectMock).not.toHaveBeenCalled()
    expect(res).toEqual({ sent: false, recipientCount: 0, muted: true })
    // Nothing failed, so there is nothing for a caller to warn about.
    expect(res.error).toBeUndefined()

    // The row IS the feature: silence that reads as intentional.
    expect(logNotificationMock).toHaveBeenCalledTimes(1)
    expect(logNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'email',
        send_status: 'muted',
        error: 'muted',
        lead_id: 'lead-1',
        location_id: 'loc-uuid-1',
        location_slug: 'loc_omaha',
        // The kind axis still says what it WAS; the status axis says what
        // happened to it. A muted row stays findable under its kind.
        email_kind: 'lead_notification',
      }),
    )
  })

  // Ordering, not just outcome: resolveLeadRecipients falls through to Zoho for
  // all 44 onboarding locations (none have hub_users owners). Gating after it
  // would fire that API call per lead to build a list we've already discarded.
  it('a muted location never resolves recipients — no Zoho lookup', async () => {
    gateMock.mockResolvedValue({ live: false, reason: 'muted' })
    await notifyNewLead({ location: LOCATION, lead: LEAD })
    expect(resolveRecipientsMock).not.toHaveBeenCalled()
  })

  it('a fail-closed read records WHY, so a missing column is not mistaken for a mute', async () => {
    gateMock.mockResolvedValue({
      live: false,
      reason: 'read_failed',
      error: 'column locations.notifications_live does not exist',
    })

    const res = await notifyNewLead({ location: LOCATION, lead: LEAD })

    expect(sendEmailDirectMock).not.toHaveBeenCalled()
    expect(res.muted).toBe(true)
    expect(logNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        send_status: 'muted',
        error: expect.stringContaining('read_failed: column locations.notifications_live'),
      }),
    )
  })
})

describe('notifyNewLeadSlack — notifications_live gate', () => {
  it('a muted location makes no post and never reaches the transport', async () => {
    gateMock.mockResolvedValue({ live: false, reason: 'muted' })
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as any)

    const res = await notifyNewLeadSlack({
      locationId: 'loc-uuid-1',
      locationName: 'Boulder',
      baseUrl: 'https://app.example.com',
      lead: { ...LEAD, source: 'web_form' },
    })

    expect(res.ok).toBe(false)
    expect(res.skipped).toBe('notifications_off')
    expect(res.mutedReason).toBe('muted')
    // Not merely "didn't post" — the location's Slack columns were never even read.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a fail-closed read carries its reason for the log', async () => {
    gateMock.mockResolvedValue({
      live: false, reason: 'read_failed', error: 'column does not exist',
    })
    const res = await notifyNewLeadSlack({
      locationId: 'loc-uuid-1', locationName: 'Boulder', lead: { ...LEAD, source: 'web_form' },
    })
    expect(res.skipped).toBe('notifications_off')
    expect(res.mutedReason).toBe('read_failed: column does not exist')
  })
})
