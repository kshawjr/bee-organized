// @vitest-environment node
//
// Posting Other's card (lib/slack-bot notifyNewLeadSlack) and the no-coverage
// close moved out of its route (lib/lead-no-coverage.ts).
//   • A new lead in OTHER posts the route-suggestion card, not the plain one.
//   • If the suggestion fails, Other still gets a card — never silence.
//   • A franchise location's card is unchanged (Log call, no route buttons).
//   • closeLeadAsNoCoverage re-checks the actor's role and stamps who did it;
//     the web route hands its result back unchanged.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  webRole: 'super_admin',
  gate: { live: true, unroutedQueue: true } as any,
  slackLoc: { slack_connected: true, slack_bot_token: 'xoxb-other', slack_channel_id: 'C-OTHER' } as any,
  suggestion: null as any,
  suggestError: null as any,
  posts: [] as any[],
  leadRow: null as any,
  updates: [] as any[],
  inserts: [] as any[],
  reads: [] as string[],
}))

vi.mock('@/lib/notifications-live', () => ({ resolveNotificationsLive: vi.fn(async () => h.gate) }))
vi.mock('@/lib/slack-disconnect', () => ({ disconnectSlackFromLocation: vi.fn(async () => ({ error: null })) }))
vi.mock('@/lib/supabase-service', () => ({
  supabaseService: {
    from: (table: string) => {
      h.reads.push(table)
      const b: any = {}
      for (const m of ['select', 'eq']) b[m] = () => b
      b.update = (arg: any) => { h.updates.push({ table, arg }); return b }
      b.insert = (arg: any) => { h.inserts.push({ table, arg }); return b }
      const res = () => (table === 'locations' ? { data: h.slackLoc, error: null } : table === 'leads' ? { data: h.leadRow, error: null } : { data: null, error: null })
      b.maybeSingle = async () => res()
      b.single = async () => res()
      b.then = (r: any, j: any) => Promise.resolve(res()).then(r, j)
      return b
    },
  },
}))
vi.mock('@/lib/route-suggestion', () => ({
  suggestRouteForLead: vi.fn(async () => { if (h.suggestError) throw h.suggestError; return h.suggestion }),
}))
vi.mock('@/lib/no-coverage-email', () => ({
  sendNoCoverageEmail: vi.fn(async () => ({ success: true })),
  firstNameOf: () => 'Jess',
}))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'web-user' } } }) },
    from: () => { const b: any = {}; b.select = () => b; b.eq = () => b; b.single = async () => ({ data: { id: 'web-user', role: h.webRole, location_id: null }, error: null }); return b },
  })),
}))

vi.mock('@/lib/other-card-sync', () => ({ recordOtherCard: vi.fn(async () => {}) }))
vi.mock('@/lib/no-coverage-guard', async (orig) => {
  const real: any = await orig()
  return { ...real, checkNoCoverage: vi.fn(async () => ({ kind: 'clear', zip: '60173', nearest: { slug: 'loc_carmel', name: 'Carmel', miles: 163 } })) }
})

import { notifyNewLeadSlack } from '@/lib/slack-bot'
import { recordOtherCard } from '@/lib/other-card-sync'
import { closeLeadAsNoCoverage } from '@/lib/lead-no-coverage'
import * as NoCoverage from '@/lib/lead-no-coverage'
import { POST as NO_COVERAGE_POST } from '@/app/api/leads/[id]/no-coverage/route'
import { sendNoCoverageEmail } from '@/lib/no-coverage-email'

const LEAD = { id: 'lead-1', name: 'Jessica Example', email: 'j@example.com', phone: null, project_type: 'Garage', request_details: null, preferred_contact: null, zip: '33928' }
const SUGGESTION = {
  leadId: 'lead-1', kind: 'nearby', zip: '33928',
  options: [
    { slug: 'loc_miami', name: 'Miami', lifecycle_status: 'onboarding', miles: 48, label: 'Miami · 48 mi', highlighted: true },
    { slug: 'loc_sarasota', name: 'Sarasota', lifecycle_status: 'active', miles: 70, label: 'Sarasota · 70 mi', highlighted: false },
  ],
  highlight: 'loc_miami', noHighlightReason: null, showNotInServiceArea: false, showLeaveInOther: true, stateWarning: null, skipped: [],
}
const posted = () => h.posts[0]
const actionIds = () => posted().attachments[0].blocks.filter((b: any) => b.type === 'actions').flatMap((b: any) => b.elements.map((e: any) => e.action_id))

beforeEach(() => {
  vi.clearAllMocks()
  h.gate = { live: true, unroutedQueue: true }
  h.suggestion = SUGGESTION
  h.suggestError = null
  h.posts = []
  h.updates = []
  h.inserts = []
  h.reads = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => { h.posts.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ ok: true }) } as any }))
})

describe('posting the card', () => {
  it('a new lead in Other → the route-suggestion card, to Other\'s channel', async () => {
    const res = await notifyNewLeadSlack({ locationId: 'uuid-other', locationName: 'Other', lead: LEAD, baseUrl: 'https://hive.example' })
    expect(res).toEqual({ ok: true })
    expect(posted().channel).toBe('C-OTHER')
    expect(posted().text).toBe('📍 New lead in Other — needs a hive')
    expect(actionIds()).toEqual(['route_accept_0', 'route_accept_1', 'route_leave', undefined])
    expect(JSON.stringify(posted())).not.toContain('log_call')
  })

  it('Slack returns the message id → it comes back on the result and Other\'s card is recorded', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => { h.posts.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ ok: true, ts: '1729.0001', channel: 'C-OTHER' }) } as any }))
    const res = await notifyNewLeadSlack({ locationId: 'uuid-other', locationName: 'Other', lead: LEAD, baseUrl: null })
    expect(res).toEqual({ ok: true, ts: '1729.0001', channel: 'C-OTHER' })
    expect(recordOtherCard).toHaveBeenCalledWith({ leadId: 'lead-1', locationUuid: 'uuid-other', channelId: 'C-OTHER', messageTs: '1729.0001' })
  })

  it('a franchise card is never recorded, even with a message id', async () => {
    h.gate = { live: true }
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => { h.posts.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ ok: true, ts: '1729.0002', channel: 'C-X' }) } as any }))
    await notifyNewLeadSlack({ locationId: 'uuid-miami', locationName: 'Miami', lead: LEAD, baseUrl: null })
    expect(recordOtherCard).not.toHaveBeenCalled()
  })

  it('a failed post is never recorded', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: false, error: 'channel_not_found' }) }) as any))
    await notifyNewLeadSlack({ locationId: 'uuid-other', locationName: 'Other', lead: LEAD, baseUrl: null })
    expect(recordOtherCard).not.toHaveBeenCalled()
  })

  it('the suggestion failing still posts a card (Leave in Other + a plain line) — never silence', async () => {
    h.suggestError = new Error('zip_coords read failed')
    const res = await notifyNewLeadSlack({ locationId: 'uuid-other', locationName: 'Other', lead: LEAD, baseUrl: null })
    expect(res).toEqual({ ok: true })
    expect(actionIds()).toEqual(['route_leave'])
    expect(JSON.stringify(posted())).toContain("couldn't work out a suggestion")
  })

  it('a franchise location keeps the ordinary card: Log call, no route buttons, no suggestion read', async () => {
    h.gate = { live: true }
    h.slackLoc = { slack_connected: true, slack_bot_token: 'xoxb-x', slack_channel_id: 'C-X' }
    await notifyNewLeadSlack({ locationId: 'uuid-miami', locationName: 'Miami', lead: LEAD, baseUrl: null })
    expect(actionIds()).toEqual(['log_call'])
    const { suggestRouteForLead } = await import('@/lib/route-suggestion')
    expect(suggestRouteForLead).not.toHaveBeenCalled()
    h.slackLoc = { slack_connected: true, slack_bot_token: 'xoxb-other', slack_channel_id: 'C-OTHER' }
  })

  it('a muted location posts nothing and reads no suggestion', async () => {
    h.gate = { live: false, reason: 'muted' }
    const res = await notifyNewLeadSlack({ locationId: 'uuid-x', locationName: 'X', lead: LEAD })
    expect(res.skipped).toBe('notifications_off')
    expect(h.posts).toEqual([])
  })

  it('Other with no Slack connected → skipped quietly, as today', async () => {
    h.slackLoc = { slack_connected: false, slack_bot_token: null, slack_channel_id: null }
    const res = await notifyNewLeadSlack({ locationId: 'uuid-other', locationName: 'Other', lead: LEAD })
    expect(res).toEqual({ ok: false, skipped: 'not_connected' })
    expect(h.posts).toEqual([])
    h.slackLoc = { slack_connected: true, slack_bot_token: 'xoxb-other', slack_channel_id: 'C-OTHER' }
  })
})

describe('closeLeadAsNoCoverage — the shared close', () => {
  beforeEach(() => {
    h.leadRow = { id: 'lead-1', name: 'Jessica Example', first_name: 'Jessica', email: 'j@example.com', city: 'Schaumburg', state: 'IL', location_id: 'loc_other', location_uuid: 'uuid-other', inbox_dismissed_at: null, marketing_consented_at: null }
  })

  it.each([['owner'], ['manager'], ['']])('a %j actor is refused 403 before anything is read or sent', async (role) => {
    const out = await closeLeadAsNoCoverage({ leadId: 'lead-1', actor: { hubUserId: 'u', role } })
    expect(out).toEqual({ status: 403, body: { error: 'forbidden_admin_only' } })
    expect(h.reads).toEqual([])
    expect(sendNoCoverageEmail).not.toHaveBeenCalled()
  })

  it('an admin actor: sends, dismisses, and stamps who did it on the timeline', async () => {
    const out = await closeLeadAsNoCoverage({ leadId: 'lead-1', actor: { hubUserId: 'hu-leslie', role: 'admin' } })
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ success: true, sent: true, to: 'j@example.com', dismissed: true })
    expect(h.inserts.find((i) => i.table === 'touchpoints')!.arg.user_id).toBe('hu-leslie')
    expect(h.updates.some((u) => u.arg.inbox_dismissed_at)).toBe(true)
  })

  it('the mailing-list link uses the request origin when no site URL is set', async () => {
    const saved = [process.env.NEXT_PUBLIC_SITE_URL, process.env.NEXT_PUBLIC_APP_URL]
    delete process.env.NEXT_PUBLIC_SITE_URL; delete process.env.NEXT_PUBLIC_APP_URL
    try {
      await closeLeadAsNoCoverage({ leadId: 'lead-1', actor: { hubUserId: 'u', role: 'admin' }, requestOrigin: 'https://req.example' })
      expect((vi.mocked(sendNoCoverageEmail).mock.calls[0][0] as any).optInUrl).toMatch(/^https:\/\/req\.example\/mailing-list\/[0-9a-f]{48}$/)
    } finally {
      if (saved[0] !== undefined) process.env.NEXT_PUBLIC_SITE_URL = saved[0]
      if (saved[1] !== undefined) process.env.NEXT_PUBLIC_APP_URL = saved[1]
    }
  })

  it.each([
    [{ confirmed_out_of_range: true }, true],
    [{ confirmed_out_of_range: 'yes' }, false],
    [{}, false],
    [null, false],
  ])('the web route passes body %j as confirmedOutOfRange=%s (only a real true confirms)', async (body, flag) => {
    const spy = vi.spyOn(NoCoverage, 'closeLeadAsNoCoverage').mockResolvedValue({ status: 200, body: { success: true } })
    try {
      await NO_COVERAGE_POST({ nextUrl: { origin: 'https://req.example' }, json: async () => body } as any, { params: Promise.resolve({ id: 'lead-1' }) })
      expect(spy.mock.calls[0][0].confirmedOutOfRange).toBe(flag)
    } finally {
      spy.mockRestore()
    }
  })

  it('an unreadable body is "not confirmed", not an error', async () => {
    const spy = vi.spyOn(NoCoverage, 'closeLeadAsNoCoverage').mockResolvedValue({ status: 200, body: { success: true } })
    try {
      const res = await NO_COVERAGE_POST({ nextUrl: { origin: 'x' }, json: async () => { throw new Error('bad json') } } as any, { params: Promise.resolve({ id: 'lead-1' }) })
      expect(res.status).toBe(200)
      expect(spy.mock.calls[0][0].confirmedOutOfRange).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  it('a non-corporate web user never reaches closeLeadAsNoCoverage', async () => {
    h.webRole = 'owner'
    const spy = vi.spyOn(NoCoverage, 'closeLeadAsNoCoverage')
    try {
      const res = await NO_COVERAGE_POST({ nextUrl: { origin: 'https://req.example' } } as any, { params: Promise.resolve({ id: 'lead-1' }) })
      expect(res.status).toBe(403)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
      h.webRole = 'super_admin'
    }
  })

  it('the web route passes the signed-in user and its origin, and sends the outcome back unchanged', async () => {
    const spy = vi.spyOn(NoCoverage, 'closeLeadAsNoCoverage').mockResolvedValue({ status: 418, body: { error: 'sentinel' } })
    try {
      const res = await NO_COVERAGE_POST({ nextUrl: { origin: 'https://req.example' }, json: async () => ({}) } as any, { params: Promise.resolve({ id: 'lead-1' }) })
      expect(spy).toHaveBeenCalledWith({ leadId: 'lead-1', actor: { hubUserId: 'web-user', role: 'super_admin' }, requestOrigin: 'https://req.example', confirmedOutOfRange: false })
      expect(res.status).toBe(418)
      expect(await res.json()).toEqual({ error: 'sentinel' })
    } finally {
      spy.mockRestore()
    }
  })
})
