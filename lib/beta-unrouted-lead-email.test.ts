// @vitest-environment node
// Unrouted leads (loc_other) always reach a person — the email half.
//
// loc_other has no hub_users of its own (corporate's accounts carry no
// location), so the #91 lookup said "not on Bee Hub" and corporate got the
// clean email with no way into the lead — 30 of them in September alone, while
// Leslie routed every one IN Bee Hub. The gate now marks loc_other as the
// unrouted queue, and that picks the Bee Hub email: the button to the lead.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendEmailDirectMock = vi.hoisted(() =>
  vi.fn(async (_args: any) => ({ success: true, id: 'email-abc' })),
)
const resolveRecipientsMock = vi.hoisted(() => vi.fn(async () => [] as any[]))
const resolveGlobalCcMock = vi.hoisted(() => vi.fn(async () => [] as any[]))
const hasHubAccessMock = vi.hoisted(() => vi.fn(async () => false))
const gateMock = vi.hoisted(() => vi.fn(async () => ({ live: true }) as any))

vi.mock('@/lib/resend', () => ({ sendEmailDirect: sendEmailDirectMock }))
vi.mock('@/lib/notification-recipients', () => ({
  resolveLeadRecipients: resolveRecipientsMock,
  resolveGlobalCcRecipients: resolveGlobalCcMock,
  locationHasActiveHubUser: hasHubAccessMock,
}))
vi.mock('@/lib/notifications-live', () => ({ resolveNotificationsLive: gateMock }))
vi.mock('@/lib/notification-log', () => ({
  logNotification: vi.fn(async () => {}),
  logSlackNotification: vi.fn(async () => {}),
}))
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: () => ({}) } }))

import { notifyNewLead } from '@/lib/lead-notification-email'

const LEAD = {
  id: 'lead-9',
  name: 'Robin Unrouted',
  email: 'robin@example.com',
  phone: '(555) 222-3333',
  project_type: 'Moving',
  request_details: 'Two bedrooms.',
  preferred_contact: 'Email',
}
// The shape of loc_other today: one external (Leslie) + global CC.
const LESLIE = { source: 'external', hub_user_id: null, name: 'Leslie', email: 'leslie@beeorganized.com', category: 'all' }
const CC = { source: 'global_cc', hub_user_id: null, name: 'Ops', email: 'ops@beeorganized.com', category: 'all' }

beforeEach(() => {
  vi.clearAllMocks()
  sendEmailDirectMock.mockResolvedValue({ success: true, id: 'email-abc' })
  resolveRecipientsMock.mockResolvedValue([LESLIE])
  resolveGlobalCcMock.mockResolvedValue([CC])
  hasHubAccessMock.mockResolvedValue(false) // loc_other has no hub_users of its own
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('an unrouted lead emails corporate with the way into Bee Hub', () => {
  it('loc_other sends the Bee Hub email with the button, although it has no hub_users', async () => {
    gateMock.mockResolvedValue({ live: true, unroutedQueue: true })
    const res = await notifyNewLead({
      location: { id: 'uuid-other', name: 'Other' },
      lead: LEAD,
      baseUrl: 'https://hub.example.com',
      locationSlug: 'loc_other',
    })
    expect(res).toMatchObject({ sent: true, recipientCount: 2 })
    const args = sendEmailDirectMock.mock.calls[0][0]
    expect(args.email_kind).toBe('lead_notification')
    expect(args.to).toEqual(['leslie@beeorganized.com'])
    expect(args.html).toContain('https://hub.example.com/clients/lead-9')
    expect(args.text).toContain('Open this lead in Bee Hub: https://hub.example.com/clients/lead-9')
    // Decided by the gate — the hub_users lookup is not needed.
    expect(hasHubAccessMock).not.toHaveBeenCalled()
  })

  // Unchanged for franchise locations: an office with nobody on Bee Hub still
  // gets the clean email (#91).
  it('a franchise location with no hub_users still gets the clean email', async () => {
    gateMock.mockResolvedValue({ live: true })
    await notifyNewLead({
      location: { id: 'uuid-omaha', name: 'Omaha' },
      lead: LEAD,
      baseUrl: 'https://hub.example.com',
      locationSlug: 'loc_omaha',
    })
    const args = sendEmailDirectMock.mock.calls[0][0]
    expect(args.email_kind).toBe('lead_notification_non_hub')
    expect(args.html).not.toContain('/clients/lead-9')
    expect(hasHubAccessMock).toHaveBeenCalledWith('uuid-omaha')
  })
})
