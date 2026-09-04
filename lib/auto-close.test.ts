// @vitest-environment node
//
// lib/auto-close.ts + GET /api/cron/auto-close — the 35-day auto-close.
//
// Pins Kevin's rulings (2026-09-03):
//   · a 35-day enquiry with no exit closes: Closed Lost, reason "No response",
//     note says it closed automatically, title from the ENQUIRY month
//   · a reach-out inside 35 days spares it; a reopen spares it next run
//   · a request / quote / job after the enquiry, a Network move, or an
//     existing close after the enquiry → untouched (an exit, not a candidate)
//   · the transfer queue (loc_other), the test location, paused locations,
//     and a lead with a drip send due are skipped
//   · a close cannot send anything client-facing — pinned with a spy on
//     lib/resend AND on global fetch, with the REAL cancel helpers running
//   · dry-run writes nothing
//
// Mock: a recording query builder whose response comes from a per-test
// handler keyed on table + the recorded ops, so the same table can answer
// differently to different questions (touchpoints is asked three things).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => {
  type Op = [string, any[]]
  type Call = { table: string; ops: Op[] }
  type Handler = (table: string, ops: Op[]) => { data: any; error: any } | undefined
  const state = { handler: null as Handler | null, calls: [] as Call[] }
  const reset = () => { state.handler = null; state.calls = [] }
  const opArg = (ops: Op[], name: string) => ops.find(o => o[0] === name)?.[1]
  const hasOp = (ops: Op[], name: string, first?: any) =>
    ops.some(o => o[0] === name && (first === undefined || o[1][0] === first))
  const makeBuilder = (table: string) => {
    const call: Call = { table, ops: [] }
    state.calls.push(call)
    const resolve = () => {
      const r = state.handler?.(table, call.ops)
      return r ?? { data: null, error: null }
    }
    const b: any = {}
    for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'or', 'not', 'range', 'ilike', 'like', 'is', 'limit', 'order', 'lte', 'gte', 'in']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.maybeSingle = () => { call.ops.push(['maybeSingle', []]); return Promise.resolve(resolve()) }
    b.single = () => { call.ops.push(['single', []]); return Promise.resolve(resolve()) }
    b.then = (res: any, rej: any) => Promise.resolve(resolve()).then(res, rej)
    return b
  }
  const writes = () => state.calls.filter(c => c.ops.some(o => ['insert', 'update', 'upsert', 'delete'].includes(o[0])))
  return { state, reset, makeBuilder, opArg, hasOp, writes }
})

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
// The only two ways this codebase sends an email. Both must stay at zero.
const resendSpy = vi.hoisted(() => ({ sendEmail: vi.fn(), sendEmailDirect: vi.fn() }))
vi.mock('@/lib/resend', () => ({
  sendEmail: resendSpy.sendEmail,
  sendEmailDirect: resendSpy.sendEmailDirect,
  renderTemplate: vi.fn(),
}))

// writeSyncLog builds its own supabase-js client (lazy, inside its try/catch),
// so it is spied here rather than observed through the service mock.
const syncLogSpy = vi.hoisted(() => ({ writeSyncLog: vi.fn(async () => {}) }))
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: syncLogSpy.writeSyncLog }))

import { findStaleEnquiries, closeStaleEnquiry, enquiryTitle, closedNote, AUTO_CLOSE_REASON, AUTO_CLOSE_TOUCHPOINT_LABEL } from '@/lib/auto-close'
import { GET } from '@/app/api/cron/auto-close/route'
import { NextRequest } from 'next/server'

const NOW = new Date('2026-09-04T09:00:00.000Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400000).toISOString()

type Lead = {
  id: string; name?: string; location_id?: string; location_uuid?: string; created_at: string
  import_source?: string; is_junk?: boolean | null; archived_at?: string | null
  jobber_request_id?: string | null; jobber_job_id?: string | null
}
type World = {
  leads: Lead[]
  resubs?: { lead_id: string; occurred_at: string }[]
  reachOuts?: { lead_id: string; occurred_at: string }[]
  reopens?: { lead_id: string; occurred_at: string }[]
  requests?: { lead_id: string; requested_at?: string | null; created_at: string; engagement_id?: string | null }[]
  quotes?: { lead_id: string; created_at: string; engagement_id?: string | null }[]
  jobs?: { lead_id: string; created_at: string; engagement_id?: string | null }[]
  partners?: { customer_lead_id: string; is_customer: boolean }[]
  engagements?: { id: string; client_id: string; stage: string; closed_at?: string | null; founded_by?: string }[]
  drips?: { lead_id: string; paused_at?: string | null }[]
  locations?: { id: string; lifecycle_status?: string | null; subscription_status?: string | null }[]
}

const lead = (over: Partial<Lead> & { id: string; created_at: string }): Lead => ({
  name: `Person ${over.id}`,
  location_id: 'loc_nova',
  location_uuid: 'uuid-nova',
  import_source: 'manual',
  is_junk: false,
  archived_at: null,
  jobber_request_id: null,
  jobber_job_id: null,
  ...over,
})

/** Installs a handler that answers every read the scan makes from `w`. */
function world(w: World) {
  const inSet = (ops: any[], col: string) => new Set<string>((h.opArg(ops, 'in') ?? [col, []])[1])
  h.state.handler = (table, ops) => {
    const filterIn = <T extends Record<string, any>>(rows: T[], col: string) => {
      const set = inSet(ops, col)
      return rows.filter(r => set.has(String(r[col])))
    }
    switch (table) {
      case 'touchpoints': {
        const kind = ops.find(o => o[0] === 'eq' && o[1][0] === 'kind')?.[1][1]
        if (kind === 'system') return { data: w.resubs ?? [], error: null }
        if (kind === 'reach_out') return { data: filterIn(w.reachOuts ?? [], 'lead_id'), error: null }
        if (kind === 'stage_change') return { data: filterIn(w.reopens ?? [], 'lead_id'), error: null }
        return { data: [], error: null }
      }
      case 'leads': {
        if (h.hasOp(ops, 'eq', 'import_source')) {
          const cutoff = h.opArg(ops, 'lte')?.[1] as string
          return { data: w.leads.filter(l => l.import_source === 'manual' && l.created_at <= cutoff), error: null }
        }
        return { data: filterIn(w.leads, 'id'), error: null }
      }
      case 'service_requests': return { data: filterIn(w.requests ?? [], 'lead_id'), error: null }
      case 'quotes': return { data: filterIn(w.quotes ?? [], 'lead_id'), error: null }
      case 'jobs': return { data: filterIn(w.jobs ?? [], 'lead_id'), error: null }
      case 'partners': return { data: filterIn(w.partners ?? [], 'customer_lead_id'), error: null }
      case 'engagements': {
        if (h.hasOp(ops, 'insert')) return { data: { id: 'eng-new' }, error: null }
        if (h.hasOp(ops, 'update')) return { data: null, error: null }
        return { data: filterIn(w.engagements ?? [], 'client_id'), error: null }
      }
      case 'lead_drip_progress': {
        if (h.hasOp(ops, 'update')) return { data: null, error: null }
        return { data: filterIn(w.drips ?? [], 'lead_id'), error: null }
      }
      case 'locations': return { data: filterIn(w.locations ?? [{ id: 'uuid-nova' }], 'id'), error: null }
      default: return { data: null, error: null }
    }
  }
}

const scan = () => findStaleEnquiries({ now: NOW })

beforeEach(() => {
  h.reset()
  resendSpy.sendEmail.mockClear()
  resendSpy.sendEmailDirect.mockClear()
  syncLogSpy.writeSyncLog.mockClear()
  process.env.CRON_SECRET = 'test-secret'
})
afterEach(() => { vi.unstubAllGlobals() })

describe('findStaleEnquiries — who closes', () => {
  it('a 35-day enquiry with no exit is listed to close', async () => {
    world({ leads: [lead({ id: 'L1', created_at: daysAgo(36) })] })
    const r = await scan()
    expect(r.toClose.map(x => x.leadId)).toEqual(['L1'])
    expect(r.toClose[0].openEngagementIds).toEqual([])
    expect(r.toClose[0].enquiryAt).toBe(daysAgo(36))
    expect(r.spared).toEqual([])
  })

  it('under 35 days is not a candidate at all', async () => {
    world({ leads: [lead({ id: 'L1', created_at: daysAgo(34) })] })
    const r = await scan()
    expect(r.toClose).toEqual([])
    expect(r.spared).toEqual([])
  })

  it('a resubmission moves the enquiry date, and a Jobber client with a repeat form is an enquiry', async () => {
    world({
      leads: [
        lead({ id: 'L1', created_at: daysAgo(60) }),                                   // manual, form again 10 days ago
        lead({ id: 'J1', created_at: daysAgo(400), import_source: 'jobber_initial' }), // Jobber client, form again 40 days ago
      ],
      resubs: [{ lead_id: 'L1', occurred_at: daysAgo(10) }, { lead_id: 'J1', occurred_at: daysAgo(40) }],
      engagements: [{ id: 'e-old', client_id: 'J1', stage: 'Closed Lost', closed_at: daysAgo(300), founded_by: 'request' }],
    })
    const r = await scan()
    expect(r.toClose.map(x => x.leadId)).toEqual(['J1'])
    expect(r.toClose[0].enquiryAt).toBe(daysAgo(40))
    // The old close predates the new enquiry, so it is not an exit.
  })

  it('a reach-out inside 35 days spares it, and the clock runs from the reach-out', async () => {
    world({ leads: [lead({ id: 'L1', created_at: daysAgo(50) })], reachOuts: [{ lead_id: 'L1', occurred_at: daysAgo(20) }] })
    const r = await scan()
    expect(r.toClose).toEqual([])
    expect(r.spared).toEqual([expect.objectContaining({ leadId: 'L1', reason: 'reach_out_recent', ageDays: 20 })])
  })

  it('a reach-out older than 35 days does not spare it', async () => {
    world({ leads: [lead({ id: 'L1', created_at: daysAgo(80) })], reachOuts: [{ lead_id: 'L1', occurred_at: daysAgo(36) }] })
    const r = await scan()
    expect(r.toClose.map(x => x.leadId)).toEqual(['L1'])
    expect(r.toClose[0].lastActivityAt).toBe(daysAgo(36))
  })

  it('a reopen spares it on the next run (keyed on the Reopened touchpoint), and its open engagement is not closed', async () => {
    world({
      leads: [lead({ id: 'L1', created_at: daysAgo(90) })],
      engagements: [{ id: 'e1', client_id: 'L1', stage: 'Request', closed_at: null, founded_by: 'manual' }],
      reopens: [{ lead_id: 'L1', occurred_at: daysAgo(2) }],
    })
    const r = await scan()
    expect(r.toClose).toEqual([])
    expect(r.spared).toEqual([expect.objectContaining({ leadId: 'L1', reason: 'reopened_recent' })])
  })

  it('exits: a request, quote or job after the enquiry, a Network move, or a close after the enquiry → untouched', async () => {
    world({
      leads: [
        lead({ id: 'REQ', created_at: daysAgo(50) }),
        lead({ id: 'QUO', created_at: daysAgo(50) }),
        lead({ id: 'JOB', created_at: daysAgo(50) }),
        lead({ id: 'IDS', created_at: daysAgo(50), jobber_request_id: 'jr-1' }), // stamped id, no resubmission
        lead({ id: 'NET', created_at: daysAgo(50) }),
        lead({ id: 'CLO', created_at: daysAgo(50) }),
        lead({ id: 'OPEN', created_at: daysAgo(50) }),
      ],
      requests: [{ lead_id: 'REQ', requested_at: daysAgo(49), created_at: daysAgo(49) }],
      quotes: [{ lead_id: 'QUO', created_at: daysAgo(40) }],
      jobs: [{ lead_id: 'JOB', created_at: daysAgo(30) }],
      partners: [{ customer_lead_id: 'NET', is_customer: false }],
      engagements: [{ id: 'e-clo', client_id: 'CLO', stage: 'Closed Lost', closed_at: daysAgo(45), founded_by: 'manual' }],
    })
    const r = await scan()
    expect(r.toClose.map(x => x.leadId)).toEqual(['OPEN'])
    expect(r.spared).toEqual([])
  })

  it('a Network "add" (is_customer true) is not an exit; a bare Jobber client id is not an exit', async () => {
    world({
      leads: [lead({ id: 'ADD', created_at: daysAgo(50) }), lead({ id: 'CID', created_at: daysAgo(50) })],
      partners: [{ customer_lead_id: 'ADD', is_customer: true }],
    })
    const r = await scan()
    expect(r.toClose.map(x => x.leadId).sort()).toEqual(['ADD', 'CID'])
  })

  it('the transfer queue and the test location are dropped by slug before any exit is read', async () => {
    world({
      leads: [
        lead({ id: 'Q1', created_at: daysAgo(48), location_id: 'loc_other', location_uuid: 'uuid-other' }),
        lead({ id: 'T1', created_at: daysAgo(48), location_id: 'loc_test', location_uuid: 'uuid-test' }),
        lead({ id: 'L1', created_at: daysAgo(48) }),
      ],
    })
    const r = await scan()
    expect(r.toClose.map(x => x.leadId)).toEqual(['L1'])
    expect(r.spared).toEqual([])
    // Their ids never reach the chunked reads.
    const asked = h.state.calls.filter(c => c.table === 'service_requests').flatMap(c => (h.opArg(c.ops, 'in') ?? ['', []])[1])
    expect(asked).toEqual(['L1'])
  })

  it('a lead with no email and no phone still closes at 35 days (exit 4 keeps them out of the worklist, not out of the close)', async () => {
    world({ leads: [lead({ id: 'DARK', created_at: daysAgo(48), email: '', phone: null } as any)] })
    const r = await scan()
    expect(r.toClose.map(x => x.leadId)).toEqual(['DARK'])
  })

  it('junk and archived leads are never candidates', async () => {
    world({
      leads: [
        lead({ id: 'JUNK', created_at: daysAgo(48), is_junk: true }),
        lead({ id: 'ARCH', created_at: daysAgo(48), archived_at: daysAgo(1) }),
      ],
    })
    const r = await scan()
    expect(r.toClose).toEqual([])
  })

  it('a paused or inactive location is skipped', async () => {
    world({
      leads: [
        lead({ id: 'P1', created_at: daysAgo(48), location_id: 'loc_p', location_uuid: 'uuid-p' }),
        lead({ id: 'I1', created_at: daysAgo(48), location_id: 'loc_i', location_uuid: 'uuid-i' }),
        lead({ id: 'L1', created_at: daysAgo(48) }),
      ],
      locations: [
        { id: 'uuid-p', lifecycle_status: 'paused' },
        { id: 'uuid-i', subscription_status: 'inactive' },
        { id: 'uuid-nova', lifecycle_status: 'active', subscription_status: 'active' },
      ],
    })
    const r = await scan()
    expect(r.toClose.map(x => x.leadId)).toEqual(['L1'])
    expect(r.spared.map(s => [s.leadId, s.reason])).toEqual([['P1', 'location_paused'], ['I1', 'location_paused']])
  })

  it('a live, unpaused drip row (a send due) spares it; a paused row does not', async () => {
    world({
      leads: [lead({ id: 'DUE', created_at: daysAgo(48) }), lead({ id: 'PAUSED', created_at: daysAgo(48) })],
      drips: [{ lead_id: 'DUE', paused_at: null }, { lead_id: 'PAUSED', paused_at: daysAgo(10) }],
    })
    const r = await scan()
    expect(r.toClose.map(x => x.leadId)).toEqual(['PAUSED'])
    expect(r.spared).toEqual([expect.objectContaining({ leadId: 'DUE', reason: 'drip_send_due' })])
  })

  it('open Jobber work spares it; an open manual, childless engagement is listed to be closed', async () => {
    world({
      leads: [lead({ id: 'WORK', created_at: daysAgo(48) }), lead({ id: 'MAN', created_at: daysAgo(48) })],
      engagements: [
        { id: 'e-w', client_id: 'WORK', stage: 'Request', closed_at: null, founded_by: 'request' },
        { id: 'e-m', client_id: 'MAN', stage: 'Request', closed_at: null, founded_by: 'manual' },
      ],
    })
    const r = await scan()
    expect(r.toClose).toEqual([expect.objectContaining({ leadId: 'MAN', openEngagementIds: ['e-m'] })])
    expect(r.spared).toEqual([expect.objectContaining({ leadId: 'WORK', reason: 'open_jobber_work' })])
  })

  it('lists oldest activity first', async () => {
    world({ leads: [lead({ id: 'B', created_at: daysAgo(40) }), lead({ id: 'A', created_at: daysAgo(70) })] })
    const r = await scan()
    expect(r.toClose.map(x => x.leadId)).toEqual(['A', 'B'])
  })

  it('the scan writes nothing', async () => {
    world({ leads: [lead({ id: 'L1', created_at: daysAgo(48) })] })
    await scan()
    expect(h.writes()).toEqual([])
  })
})

describe('closeStaleEnquiry — what a close writes', () => {
  const ITEM = {
    leadId: 'L1', name: 'Ashley Devoto', locationId: 'loc_nova', locationUuid: 'uuid-nova',
    enquiryAt: '2026-07-27T02:02:36.000Z', lastActivityAt: '2026-07-29T01:49:21.000Z', ageDays: 37,
    openEngagementIds: [] as string[],
  }

  it('with no engagement: founds one already Closed Lost, reason "No response", note and title from the ENQUIRY month', async () => {
    world({ leads: [] })
    const r = await closeStaleEnquiry(ITEM, { now: NOW })
    expect(r).toEqual({ leadId: 'L1', engagementIds: ['eng-new'], founded: true })

    const ins = h.state.calls.find(c => c.table === 'engagements' && h.hasOp(c.ops, 'insert'))!
    const row = h.opArg(ins.ops, 'insert')![0]
    expect(row).toMatchObject({
      client_id: 'L1',
      location_uuid: 'uuid-nova',
      stage: 'Closed Lost',
      founded_by: 'manual',
      closed_reason: AUTO_CLOSE_REASON,
      closed_at: NOW.toISOString(),
      title: 'Enquiry – Jul 2026', // July, when she wrote in — not September, when this ran
    })
    expect(row.closed_note).toBe('Closed automatically: no response 35 days after the enquiry of 27 Jul 2026.')
    expect(row.closed_note).toMatch(/^Closed automatically/)
  })

  it('with an open manual engagement: closes it in place, founds nothing', async () => {
    world({ leads: [] })
    const r = await closeStaleEnquiry({ ...ITEM, openEngagementIds: ['e-open'] }, { now: NOW })
    expect(r).toEqual({ leadId: 'L1', engagementIds: ['e-open'], founded: false })
    const upd = h.state.calls.find(c => c.table === 'engagements' && h.hasOp(c.ops, 'update'))!
    expect(h.opArg(upd.ops, 'update')![0]).toMatchObject({ stage: 'Closed Lost', closed_reason: AUTO_CLOSE_REASON })
    expect(h.opArg(upd.ops, 'in')).toEqual(['id', ['e-open']])
    expect(h.state.calls.some(c => c.table === 'engagements' && h.hasOp(c.ops, 'insert'))).toBe(false)
  })

  it('writes nothing on the lead row except the welcome-email cancel: no stage, no junk, no dismiss', async () => {
    world({ leads: [] })
    await closeStaleEnquiry(ITEM, { now: NOW })
    const leadWrites = h.state.calls
      .filter(c => c.table === 'leads' && h.hasOp(c.ops, 'update'))
      .map(c => h.opArg(c.ops, 'update')![0])
    // cancelPendingWelcomeEmail is one of the wizard's three cancels and it
    // lives on the lead row. That is the ONLY lead write, and it only nulls
    // the schedule.
    expect(leadWrites).toEqual([{ welcome_email_scheduled_at: null }])
  })

  it('one stage_change touchpoint with no actor, pointing at the engagement', async () => {
    world({ leads: [] })
    await closeStaleEnquiry(ITEM, { now: NOW })
    const tps = h.state.calls.filter(c => c.table === 'touchpoints' && h.hasOp(c.ops, 'insert'))
    expect(tps).toHaveLength(1)
    expect(h.opArg(tps[0].ops, 'insert')![0]).toMatchObject({
      lead_id: 'L1', engagement_id: 'eng-new', kind: 'stage_change', user_id: null, label: AUTO_CLOSE_TOUCHPOINT_LABEL,
    })
  })

  it('fires the wizard\'s three cancels with reason closed_lost: drip stop, stage emails, welcome email', async () => {
    world({ leads: [] })
    await closeStaleEnquiry(ITEM, { now: NOW })
    const drip = h.state.calls.find(c => c.table === 'lead_drip_progress' && h.hasOp(c.ops, 'update'))!
    expect(h.opArg(drip.ops, 'update')![0]).toMatchObject({ stopped_reason: 'closed_lost' })
    const stage = h.state.calls.find(c => c.table === 'scheduled_stage_emails' && h.hasOp(c.ops, 'update'))!
    expect(h.opArg(stage.ops, 'update')![0]).toMatchObject({ cancelled_reason: 'closed_lost' })
    const welcome = h.state.calls.find(c => c.table === 'leads' && h.hasOp(c.ops, 'update'))
    // cancelPendingWelcomeEmail nulls the schedule on the lead — the ONE lead write, and it is a cancel.
    expect(welcome && h.opArg(welcome.ops, 'update')![0]).toEqual({ welcome_email_scheduled_at: null })
  })

  it('one sync_log row per close, tagged [engagement:auto-close]', async () => {
    world({ leads: [] })
    await closeStaleEnquiry(ITEM, { now: NOW })
    expect(syncLogSpy.writeSyncLog).toHaveBeenCalledTimes(1)
    const row = syncLogSpy.writeSyncLog.mock.calls[0][0] as any
    expect(row).toMatchObject({ location_id: 'loc_nova', entity_id: 'eng-new', entity_type: 'engagement', status: 'success' })
    expect(row.message).toMatch(/^\[engagement:auto-close\] Closed Lost reason=No response/)
  })

  it('NEVER sends anything client-facing: no lib/resend call, no network call, with the real cancel helpers running', async () => {
    const fetchSpy = vi.fn(async () => { throw new Error('network call during auto-close') })
    vi.stubGlobal('fetch', fetchSpy)
    world({ leads: [] })
    await closeStaleEnquiry(ITEM, { now: NOW })
    await closeStaleEnquiry({ ...ITEM, leadId: 'L2', openEngagementIds: ['e-open'] }, { now: NOW })
    expect(resendSpy.sendEmail).not.toHaveBeenCalled()
    expect(resendSpy.sendEmailDirect).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    // And the only tables written are the ones the close is allowed to touch
    // (sync_log goes through its own client, spied separately).
    const touched = Array.from(new Set(h.writes().map(c => c.table))).sort()
    expect(touched).toEqual(['engagements', 'lead_drip_progress', 'leads', 'scheduled_stage_emails', 'touchpoints'])
    expect(syncLogSpy.writeSyncLog).toHaveBeenCalledTimes(2)
  })

  it('title and note helpers use the enquiry month in UTC', () => {
    expect(enquiryTitle('2026-07-31T23:30:00.000Z')).toBe('Enquiry – Jul 2026')
    expect(enquiryTitle('2026-08-01T00:10:00.000Z')).toBe('Enquiry – Aug 2026')
    expect(closedNote('2026-07-18T12:00:00.000Z')).toBe('Closed automatically: no response 35 days after the enquiry of 18 Jul 2026.')
  })
})

describe('GET /api/cron/auto-close — the route', () => {
  const get = (qs = '', auth = 'Bearer test-secret') =>
    GET(new NextRequest(`http://test/api/cron/auto-close${qs}`, { headers: auth ? { authorization: auth } : {} }))

  it('refuses without CRON_SECRET configured, and without the right secret', async () => {
    delete process.env.CRON_SECRET
    expect((await get()).status).toBe(500)
    process.env.CRON_SECRET = 'test-secret'
    expect((await get('', 'Bearer wrong')).status).toBe(401)
    expect((await get('', '')).status).toBe(401)
    expect(h.writes()).toEqual([])
  })

  it('accepts ?secret= for a manual run', async () => {
    world({ leads: [] })
    const res = await get('?secret=test-secret&dry_run=1', '')
    expect(res.status).toBe(200)
  })

  it('dry_run=1 returns the list with names and writes NOTHING', async () => {
    world({ leads: [lead({ id: 'L1', name: 'Ashley Devoto', created_at: daysAgo(38) }), lead({ id: 'L2', created_at: daysAgo(50) })],
      reachOuts: [{ lead_id: 'L2', occurred_at: daysAgo(3) }] })
    const res = await get('?dry_run=1')
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.dry_run).toBe(true)
    expect(body.days).toBe(35)
    expect(body.would_close_count).toBe(1)
    expect(body.would_close[0]).toMatchObject({ leadId: 'L1', name: 'Ashley Devoto', locationId: 'loc_nova' })
    expect(body.spared[0]).toMatchObject({ leadId: 'L2', reason: 'reach_out_recent' })
    expect(body.remaining).toBe(0)
    expect(h.writes()).toEqual([])
    expect(resendSpy.sendEmail).not.toHaveBeenCalled()
  })

  it('live run closes the batch, reports each close, and honours limit', async () => {
    world({ leads: [lead({ id: 'A', created_at: daysAgo(70) }), lead({ id: 'B', created_at: daysAgo(40) })] })
    const res = await get('?limit=1')
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.dry_run).toBe(false)
    expect(body.closed_count).toBe(1)
    expect(body.closed[0]).toMatchObject({ lead_id: 'A', engagement_ids: ['eng-new'], founded: true })
    expect(body.remaining).toBe(1)
    expect(body.failed_count).toBe(0)
    const engInserts = h.state.calls.filter(c => c.table === 'engagements' && h.hasOp(c.ops, 'insert'))
    expect(engInserts).toHaveLength(1)
  })

  it('a failing close is reported and does not stop the batch', async () => {
    world({ leads: [lead({ id: 'A', created_at: daysAgo(70) }), lead({ id: 'B', created_at: daysAgo(40) })] })
    const base = h.state.handler!
    h.state.handler = (table, ops) => {
      if (table === 'engagements' && h.hasOp(ops, 'insert') && h.opArg(ops, 'insert')![0].client_id === 'A') {
        return { data: null, error: { message: 'insert exploded' } }
      }
      return base(table, ops)
    }
    const body = await (await get()).json()
    expect(body.failed).toEqual([expect.objectContaining({ lead_id: 'A', error: 'insert exploded' })])
    expect(body.closed.map((c: any) => c.lead_id)).toEqual(['B'])
  })
})
