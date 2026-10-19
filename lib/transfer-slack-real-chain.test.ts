// @vitest-environment node
//
// TRANSFER → SLACK, THE REAL CHAIN (19 Oct 2026).
//
// beta-transfer-any-lead-endpoint mocks notifyNewLeadSlack AND
// logSlackNotification, so it cannot see what the two do together. This file
// runs the transfer route through the REAL lib/slack-bot and the REAL
// lib/notification-log, mocking only the database, the notifications_live
// gate and fetch, and pins the one distinction that matters:
//
//   · a destination with NO Slack connected is a quiet skip — no warning on
//     the response, no notification_log row, no call to Slack
//   · a REAL failure (channel_not_found, a dead token) warns AND writes a
//     'failed' notification_log row
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => {
  const state = {
    slackRow: null as any,   // what the slack-bot locations read returns
    inserts: [] as Array<{ table: string; row: any }>,
  }
  const from = (table: string) => {
    let cols = ''
    let kind: 'select' | 'update' | 'insert' | 'delete' = 'select'
    let wantsCount = false
    let arg: any
    const answer = (): any => {
      if (kind === 'insert') { state.inserts.push({ table, row: arg }); return { data: null, error: null } }
      if (kind === 'update' && table === 'leads') return { data: [{ id: 'lead-1' }], error: null }
      if (kind === 'delete') return { data: [], error: null }
      if (kind !== 'select') return { data: null, error: null }
      if (table === 'hub_users') return { data: { id: 'u-corp', role: 'admin', location_id: null }, error: null }
      if (table === 'leads') return {
        data: {
          id: 'lead-1', name: 'Kim Terry', email: 'kim@email.com', phone: '5125550100',
          project_type: 'Moving', request_details: 'Moving next month', preferred_contact: 'Email',
          source: 'Website', zip: '78746',
          location_id: 'loc_centralaustin', location_uuid: 'central-uuid', assigned_to: null,
          jobber_client_id: null, jobber_request_id: null, jobber_quote_id: null, jobber_job_id: null,
          jobber_invoice_id: null, jobber_assessment_id: null, jobber_sync_status: null,
        },
        error: null,
      }
      if (table === 'locations') {
        // lib/slack-bot getSlackLocation reads the Slack columns.
        if (cols.includes('slack_')) return { data: state.slackRow, error: null }
        if (cols.includes('lifecycle_status')) {
          return { data: { id: 'sw-uuid', name: 'Southwest Austin', location_id: 'loc_swaustin', lifecycle_status: 'onboarding' }, error: null }
        }
        return { data: { name: 'Central Austin' }, error: null }
      }
      if (wantsCount) return { data: null, count: 0, error: null }
      return { data: null, error: null }
    }
    const b: any = {}
    b.select = (c?: any, opts?: any) => { if (typeof c === 'string') cols = c; if (opts?.count) wantsCount = true; return b }
    for (const m of ['eq', 'neq', 'is', 'in', 'not', 'or', 'order', 'limit']) b[m] = () => b
    b.update = (a: any) => { kind = 'update'; arg = a; return b }
    b.insert = (a: any) => { kind = 'insert'; arg = a; return b }
    b.delete = () => { kind = 'delete'; return b }
    b.single = () => Promise.resolve(answer())
    b.maybeSingle = () => Promise.resolve(answer())
    b.then = (res: any, rej: any) => Promise.resolve(answer()).then(res, rej)
    return b
  }
  return { state, from }
})

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.from(t) } }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'u-corp' } } })) },
    from: (t: string) => h.from(t),
  })),
}))
// The gate is pinned elsewhere (beta-notifications-live-gate); live here so
// the post reaches the transport.
vi.mock('@/lib/notifications-live', () => ({
  resolveNotificationsLive: vi.fn(async () => ({ live: true })),
}))
vi.mock('@/lib/slack-disconnect', () => ({
  disconnectSlackFromLocation: vi.fn(async () => ({ error: null })),
}))
vi.mock('@/lib/lead-notification-email', () => ({
  notifyNewLead: vi.fn(async () => ({ sent: true, recipientCount: 1 })),
}))
vi.mock('@/lib/notification-recipients', () => ({
  locationHasOperationalStaff: vi.fn(async () => false),
}))
vi.mock('@/lib/drip-lifecycle', () => ({
  stopActiveDripsForLead: vi.fn(async () => {}),
  startDripForLead: vi.fn(async () => ({ enrolled: true })),
}))
vi.mock('@/lib/realtime-broadcast', () => ({ broadcastLeadMoved: vi.fn(async () => true) }))

import { POST } from '@/app/api/leads/[id]/transfer/route'

const call = () =>
  POST(
    new Request('http://test/api/leads/lead-1/transfer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destination_location_id: 'sw-uuid', reason: 'Zip is theirs' }),
    }) as any,
    { params: Promise.resolve({ id: 'lead-1' }) },
  )
const slackRows = () => h.state.inserts.filter((i) => i.table === 'notification_log' && i.row.channel === 'slack')
const slackWarnings = (j: any) => (j.warnings ?? []).filter((w: string) => w.includes('slack'))
const CONNECTED = { slack_connected: true, slack_bot_token: 'xoxb-1', slack_channel_id: 'C1' }

let fetchSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  h.state.inserts = []
  h.state.slackRow = null
  fetchSpy = vi.spyOn(global, 'fetch')
})
afterEach(() => fetchSpy.mockRestore())

describe('destination with no Slack connected — quiet skip', () => {
  it.each([
    ['never connected', { slack_connected: false, slack_bot_token: null, slack_channel_id: null }],
    ['disconnected (flag off, stale token left)', { slack_connected: false, slack_bot_token: 'xoxb-old', slack_channel_id: 'C1' }],
    ['connected flag but no channel', { slack_connected: true, slack_bot_token: 'xoxb-1', slack_channel_id: null }],
  ])('%s → no warning, no notification_log row, Slack never called', async (_l, row) => {
    h.state.slackRow = row
    const res = await call()
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.success).toBe(true)
    expect(j.slack_posted).toBe(false)
    expect(slackWarnings(j)).toEqual([])
    expect(slackRows()).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('a real Slack failure — warns and logs', () => {
  it.each(['channel_not_found', 'not_in_channel', 'invalid_auth', 'token_revoked'])(
    '%s → warning on the response AND a failed notification_log row', async (slackError) => {
      h.state.slackRow = CONNECTED
      fetchSpy.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: false, error: slackError }) } as any)
      const res = await call()
      expect(res.status).toBe(200)
      const j = await res.json()
      expect(j.success).toBe(true)
      expect(j.slack_posted).toBe(false)
      expect(slackWarnings(j)).toEqual([`slack_notification_failed: ${slackError}`])
      expect(slackRows()).toHaveLength(1)
      expect(slackRows()[0].row).toMatchObject({
        channel: 'slack', send_status: 'failed', error: slackError,
        lead_id: 'lead-1', location_id: 'sw-uuid', location_slug: 'loc_swaustin',
      })
    })

  it('Slack HTTP 500 → warning and a failed row', async () => {
    h.state.slackRow = CONNECTED
    fetchSpy.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as any)
    const j = await (await call()).json()
    expect(slackWarnings(j)).toEqual(['slack_notification_failed: slack_http_500'])
    expect(slackRows()[0].row).toMatchObject({ send_status: 'failed', error: 'slack_http_500' })
  })

  it('a good post → no warning, one accepted row, posted to the destination channel', async () => {
    h.state.slackRow = CONNECTED
    fetchSpy.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) } as any)
    const j = await (await call()).json()
    expect(j.slack_posted).toBe(true)
    expect(slackWarnings(j)).toEqual([])
    expect(slackRows()).toHaveLength(1)
    expect(slackRows()[0].row).toMatchObject({ send_status: 'accepted', location_id: 'sw-uuid' })
    const body = JSON.parse((fetchSpy.mock.calls[0] as any[])[1].body)
    expect(body.channel).toBe('C1')
    expect(body.text).toBe('🔀 Lead moved to you (Southwest Austin)')
  })
})
