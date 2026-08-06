// @vitest-environment node
//
// issue 206 (follow-up) — the timeline preview of a PENDING stage email shows
// the location's customized subject, not the master's.
//
// GET /api/leads/:id/timeline resolves the name + subject of pending
// scheduled_stage_emails from templates by legacy_id. Once the sender
// (lib/stage-emails.ts) prefers a location's fork, a master-only preview here
// would show a different subject than the one that actually sends — and owners
// watch this tab to see what's going out. This pins the fork-subject override:
//   - a location WITH an active fork → the fork's subject, master's name
//   - a location WITHOUT one → the master's subject (unchanged)
//   - the fork query is scoped to the location AND is_active = true
//
// Queued fake DB keyed by table (FIFO per table → the two `templates` reads
// resolve as [masters, forks]); auth is a mocked admin so the location scope
// check is bypassed.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  type Call = { table: string; ops: [string, any[]][] }
  const state = { queue: [] as { table: string; resp: Resp }[], calls: [] as Call[] }
  const reset = () => { state.queue = []; state.calls = [] }
  const enqueue = (table: string, data: any, error: any = null) =>
    state.queue.push({ table, resp: { data, error } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0 ? state.queue.splice(idx, 1)[0].resp : { data: null, error: null }
    const call: Call = { table, ops: [] }
    state.calls.push(call)
    const b: any = {}
    for (const m of ['select', 'insert', 'update', 'upsert', 'eq', 'or', 'not', 'range', 'ilike', 'is', 'limit', 'order', 'lte', 'in']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.maybeSingle = () => { call.ops.push(['maybeSingle', []]); return Promise.resolve(resp) }
    b.single = () => { call.ops.push(['single', []]); return Promise.resolve(resp) }
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  const callToTable = (table: string, n: number) =>
    state.calls.filter(c => c.table === table)[n]
  return { state, reset, enqueue, makeBuilder, callToTable }
})

const authUser = vi.hoisted(() => ({ current: { id: 'u1' } as any }))

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: authUser.current } })) },
    from: (t: string) => h.makeBuilder(t),
  })),
}))

import { GET } from '@/app/api/leads/[id]/timeline/route'

const LOC_UUID = 'loc-uuid-1'
const MASTER_ID = 'master-1'
const KEY = 'opp_closed_job_3mo'

// Auth (admin so the location-scope check is skipped) + the lead row.
function enqueueAuthAndLead() {
  h.enqueue('hub_users', { id: 'u1', role: 'super_admin', location_id: null })
  h.enqueue('leads', {
    id: 'lead-1', location_uuid: LOC_UUID, stage: 'Closed Won',
    snoozed_until: null, snoozed_note: null,
    welcome_email_scheduled_at: null, welcome_email_sent_at: null, created_at: '2026-01-01',
  })
  // One pending stage email carrying only its key.
  h.enqueue('scheduled_stage_emails', [{ id: 'sse-1', stage_email_key: KEY, send_at: '2026-05-01' }])
}

const req = new Request('http://localhost/api/leads/lead-1/timeline')
const ctx = { params: Promise.resolve({ id: 'lead-1' }) }

beforeEach(() => { h.reset(); vi.clearAllMocks() })

describe('issue 206 — timeline preview follows the location fork subject', () => {
  it('a location WITH an active fork previews the fork subject + master name', async () => {
    enqueueAuthAndLead()
    h.enqueue('templates', [{ id: MASTER_ID, legacy_id: KEY, name: 'Closed Job 3mo', subject: 'MASTER SUBJ' }])
    h.enqueue('templates', [{ subject: 'FORK SUBJ', cloned_from_id: MASTER_ID, updated_at: '2026-04-02' }])

    const res = await GET(req, ctx as any)
    const body = await res.json()

    const row = body.scheduled_stage_emails.find((r: any) => r.stage_email_key === KEY)
    expect(row.subject).toBe('FORK SUBJ')
    expect(row.template_name).toBe('Closed Job 3mo') // label stays the master's

    // Fork query is scoped to this location and to ACTIVE rows only.
    const forkCall = h.callToTable('templates', 1)
    expect(forkCall.ops).toContainEqual(['eq', ['location_uuid', LOC_UUID]])
    expect(forkCall.ops).toContainEqual(['eq', ['is_active', true]])
    expect(forkCall.ops).toContainEqual(['in', ['cloned_from_id', [MASTER_ID]]])
  })

  it('a location WITHOUT a fork previews the master subject (unchanged)', async () => {
    enqueueAuthAndLead()
    h.enqueue('templates', [{ id: MASTER_ID, legacy_id: KEY, name: 'Closed Job 3mo', subject: 'MASTER SUBJ' }])
    h.enqueue('templates', []) // no forks

    const res = await GET(req, ctx as any)
    const body = await res.json()

    const row = body.scheduled_stage_emails.find((r: any) => r.stage_email_key === KEY)
    expect(row.subject).toBe('MASTER SUBJ')
    expect(row.template_name).toBe('Closed Job 3mo')
  })

  it('when Duplicate was pressed twice, the newest active fork wins', async () => {
    enqueueAuthAndLead()
    h.enqueue('templates', [{ id: MASTER_ID, legacy_id: KEY, name: 'Closed Job 3mo', subject: 'MASTER SUBJ' }])
    // Ordered newest-first by the query; the first row for a master wins.
    h.enqueue('templates', [
      { subject: 'NEWEST FORK', cloned_from_id: MASTER_ID, updated_at: '2026-04-10' },
      { subject: 'older fork', cloned_from_id: MASTER_ID, updated_at: '2026-04-01' },
    ])

    const res = await GET(req, ctx as any)
    const body = await res.json()

    const row = body.scheduled_stage_emails.find((r: any) => r.stage_email_key === KEY)
    expect(row.subject).toBe('NEWEST FORK')
  })
})
