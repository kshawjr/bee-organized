// @vitest-environment node
//
// lib/lead-transfer.ts transferLead — the transfer, callable without a browser
// session (20 Oct 2026, stage 1 of the Slack route-suggestion feature).
//
// The web route's behaviour is pinned, unchanged, by the existing endpoint
// suites (beta-lead-transfer-endpoint, beta-transfer-any-lead-endpoint,
// transfer-slack-real-chain). This file pins what is NEW about the shared
// function, the parts a Slack caller will lean on:
//   • the actor's role is re-checked HERE — a non-admin actor is refused
//     before a single row is read, whoever called;
//   • WHO moved it is the actor passed in, stamped on the transfer touchpoint;
//   • a caller with no request origin still gets a working deep link from the
//     site-URL env, and with neither the link is simply null;
//   • the web route hands transferLead's status + body back unchanged.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  const state = {
    queue: [] as { table: string; resp: Resp }[],
    reads: [] as string[],
    inserts: [] as { table: string; arg: any }[],
    eqs: [] as { table: string; col: string; val: any }[],
  }
  const reset = () => { state.queue = []; state.reads = []; state.inserts = []; state.eqs = [] }
  const enqueue = (table: string, data: any, error: any = null) =>
    state.queue.push({ table, resp: { data, error } })
  const makeBuilder = (table: string) => {
    state.reads.push(table)
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0 ? state.queue.splice(idx, 1)[0].resp : { data: null, error: null }
    const b: any = {}
    for (const m of ['select', 'neq', 'or', 'not', 'is', 'in', 'order', 'limit', 'update', 'delete']) b[m] = () => b
    b.eq = (col: string, val: any) => { state.eqs.push({ table, col, val }); return b }
    b.insert = (arg: any) => { state.inserts.push({ table, arg }); return b }
    b.single = () => Promise.resolve(resp)
    b.maybeSingle = () => Promise.resolve(resp)
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  return { state, reset, enqueue, makeBuilder }
})

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.makeBuilder(t) } }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'web-user' } } })) },
    from: (t: string) => h.makeBuilder(t),
  })),
}))
vi.mock('@/lib/lead-notification-email', () => ({ notifyNewLead: vi.fn(async () => ({ sent: true, recipientCount: 1 })) }))
vi.mock('@/lib/notification-recipients', () => ({ locationHasOperationalStaff: vi.fn(async () => false) }))
vi.mock('@/lib/drip-lifecycle', () => ({ stopActiveDripsForLead: vi.fn(async () => {}), startDripForLead: vi.fn(async () => {}) }))
vi.mock('@/lib/slack-bot', () => ({ notifyNewLeadSlack: vi.fn(async () => ({ ok: true })) }))
vi.mock('@/lib/notification-log', () => ({ logSlackNotification: vi.fn(async () => {}) }))
vi.mock('@/lib/realtime-broadcast', () => ({ broadcastLeadMoved: vi.fn(async () => true) }))

import { transferLead } from '@/lib/lead-transfer'
import * as Shared from '@/lib/lead-transfer'
import { POST } from '@/app/api/leads/[id]/transfer/route'
import { notifyNewLead } from '@/lib/lead-notification-email'

const LEAD = {
  id: 'lead-1', name: 'Loujean Test', email: 'l@example.com', phone: null, project_type: 'Garage',
  request_details: null, preferred_contact: null, location_id: 'loc_other', location_uuid: 'other-uuid',
  jobber_client_id: null,
}
const DEST = { id: 'soc-uuid', name: 'South Orange County', location_id: 'loc_southorangecounty', lifecycle_status: 'onboarding' }

// A clean unrouted lead moving to an onboarding location (no drip path).
const arm = () => {
  h.enqueue('leads', LEAD)
  h.enqueue('locations', DEST)
  h.enqueue('leads', [{ id: 'lead-1' }]) // the move matched one row
}

const ENV_KEYS = ['NEXT_PUBLIC_SITE_URL', 'NEXT_PUBLIC_APP_URL'] as const
const savedEnv: Record<string, string | undefined> = {}
beforeEach(() => {
  h.reset()
  vi.clearAllMocks()
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k] }
})
afterEach(() => {
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k] }
})

describe('transferLead — the actor gate', () => {
  it.each([['owner'], ['manager'], ['lite_user'], ['viewer'], ['']])('a %j actor is refused 403 before anything is read', async (role) => {
    arm()
    const out = await transferLead({ leadId: 'lead-1', destinationLocationId: 'soc-uuid', reason: null, actor: { hubUserId: 'u-x', role } })
    expect(out).toEqual({ status: 403, body: { error: 'forbidden_admin_only' } })
    expect(h.state.reads).toEqual([])
    expect(notifyNewLead).not.toHaveBeenCalled()
  })

  it.each([['admin'], ['super_admin']])('an %s actor moves the lead', async (role) => {
    arm()
    const out = await transferLead({ leadId: 'lead-1', destinationLocationId: 'soc-uuid', reason: null, actor: { hubUserId: 'u-leslie', role } })
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ success: true, lead_id: 'lead-1', to: { uuid: 'soc-uuid', slug: 'loc_southorangecounty' } })
  })

  it('reads the lead by its id and the destination by the id passed in', async () => {
    arm()
    await transferLead({ leadId: 'lead-1', destinationLocationId: 'soc-uuid', reason: null, actor: { hubUserId: 'u', role: 'admin' } })
    expect(h.state.eqs[0]).toEqual({ table: 'leads', col: 'id', val: 'lead-1' })
    expect(h.state.eqs[1]).toEqual({ table: 'locations', col: 'id', val: 'soc-uuid' })
  })
})

describe('transferLead — who did it', () => {
  it('the actor passed in is stamped on the transfer touchpoint', async () => {
    arm()
    await transferLead({ leadId: 'lead-1', destinationLocationId: 'soc-uuid', reason: null, actor: { hubUserId: 'u-leslie', role: 'admin' } })
    const tp = h.state.inserts.find(i => i.table === 'touchpoints')!
    expect(tp.arg.user_id).toBe('u-leslie')
    expect(tp.arg.notes).toBe('Routed from loc_other to South Orange County')
  })

  it('a non-string reason counts as none (an unrouted lead needs none)', async () => {
    arm()
    const out = await transferLead({ leadId: 'lead-1', destinationLocationId: 'soc-uuid', reason: 42, actor: { hubUserId: 'u', role: 'admin' } })
    expect(out.status).toBe(200)
    expect(out.body.reason).toBeUndefined()
  })
})

describe('transferLead — the deep link without a browser', () => {
  const baseUrlSent = () => (vi.mocked(notifyNewLead).mock.calls[0][0] as any).baseUrl

  it('no origin and no env → null (the email simply has no button)', async () => {
    arm()
    await transferLead({ leadId: 'lead-1', destinationLocationId: 'soc-uuid', reason: null, actor: { hubUserId: 'u', role: 'admin' } })
    expect(baseUrlSent()).toBeNull()
  })

  it('the request origin is used when no env is set', async () => {
    arm()
    await transferLead({ leadId: 'lead-1', destinationLocationId: 'soc-uuid', reason: null, actor: { hubUserId: 'u', role: 'admin' }, requestOrigin: 'https://hive.example' })
    expect(baseUrlSent()).toBe('https://hive.example')
  })

  it('the site-URL env wins over the origin, trailing slash trimmed', async () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://beehive.beeorganized.com/'
    arm()
    await transferLead({ leadId: 'lead-1', destinationLocationId: 'soc-uuid', reason: null, actor: { hubUserId: 'u', role: 'admin' }, requestOrigin: 'https://hive.example' })
    expect(baseUrlSent()).toBe('https://beehive.beeorganized.com')
  })
})

describe('the web route is a thin door', () => {
  const post = (body: any) =>
    POST({ json: async () => body, nextUrl: { origin: 'https://req.example' } } as any, { params: Promise.resolve({ id: 'lead-1' }) })

  it('passes the signed-in user, the body and its origin, and sends the outcome back unchanged', async () => {
    h.enqueue('hub_users', { id: 'web-user', role: 'super_admin', location_id: null })
    const spy = vi.spyOn(Shared, 'transferLead').mockResolvedValue({ status: 418, body: { error: 'sentinel', x: 1 } })
    try {
      const res = await post({ destination_location_id: 'soc-uuid', reason: 'because' })
      expect(spy).toHaveBeenCalledWith({
        leadId: 'lead-1',
        destinationLocationId: 'soc-uuid',
        reason: 'because',
        actor: { hubUserId: 'web-user', role: 'super_admin' },
        requestOrigin: 'https://req.example',
      })
      expect(res.status).toBe(418)
      expect(await res.json()).toEqual({ error: 'sentinel', x: 1 })
    } finally {
      spy.mockRestore()
    }
  })

  it('a non-admin web user never reaches transferLead', async () => {
    h.enqueue('hub_users', { id: 'web-user', role: 'owner', location_id: 'x' })
    const spy = vi.spyOn(Shared, 'transferLead')
    try {
      const res = await post({ destination_location_id: 'soc-uuid' })
      expect(res.status).toBe(403)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})
