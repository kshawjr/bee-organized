// @vitest-environment node
//
// The returning-client sequence — the two stop hooks.
//
// The ordinary drips stop on leads.stage moves, junk, opt-out and bounces.
// None of those happen to a returning enquiry (the intake never writes
// leads.stage on a resubmission), so the returning sequence stops on what
// DOES happen to it:
//
//   · an owner logs a reach-out on the lead (lib/touchpoints.ts
//     insertTouchpoint — the in-app Log call, the Slack button and the
//     engagement panel all route through it)            → 'reach_out'
//   · the enquiry's engagement moves past Request via the Jobber derivation
//     (lib/engagements.ts maybeAdvanceEngagementStage)   → 'engagement_advanced'
//
// Both hooks call stopReturningSequenceForLead, which is scoped to the
// 'returning' path (pinned in beta-returning-drip-lifecycle.test.ts). Here
// @/lib/drip-lifecycle is mocked so only the WIRING is under test: when the
// hook fires, what it passes, and that it never fires for the wrong event.
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
    for (const m of ['select', 'insert', 'update', 'upsert', 'eq', 'neq', 'or', 'not', 'in', 'range', 'ilike', 'is', 'limit', 'order', 'lte']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.maybeSingle = () => { call.ops.push(['maybeSingle', []]); return Promise.resolve(resp) }
    b.single = () => { call.ops.push(['single', []]); return Promise.resolve(resp) }
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  return { state, reset, enqueue, makeBuilder }
})

const stopMock = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.makeBuilder(t) } }))
vi.mock('@/lib/drip-lifecycle', () => ({ stopReturningSequenceForLead: stopMock }))
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: vi.fn(async () => {}) }))
vi.mock('@/lib/lead-assignment', () => ({ resolveLeadAssignees: vi.fn(async () => []) }))
vi.mock('@/lib/jobber-import', () => ({ isUnbookedJobStatus: () => false }))

import { insertTouchpoint } from '@/lib/touchpoints'
import { maybeAdvanceEngagementStage } from '@/lib/engagements'

beforeEach(() => {
  h.reset()
  vi.clearAllMocks()
})

describe('a logged reach-out stops the returning sequence', () => {
  it('lead reach_out → stopReturningSequenceForLead(leadId, "reach_out"), after the touchpoint is written', async () => {
    h.enqueue('touchpoints', { id: 'tp-1', kind: 'reach_out' })
    h.enqueue('leads', null) // updated_at bump
    const r = await insertTouchpoint({
      lead_id: 'lead-natalie', location_uuid: 'loc-uuid-1', kind: 'reach_out',
      method: 'email', label: 'Reach-out', user_id: 'user-suzanne',
    })
    expect(r.ok).toBe(true)
    expect(stopMock).toHaveBeenCalledTimes(1)
    expect(stopMock).toHaveBeenCalledWith('lead-natalie', 'reach_out')
    // The touchpoint insert and the lead bump both precede the stop.
    expect(h.state.calls.map(c => c.table)).toEqual(['touchpoints', 'leads'])
  })

  it('a system touchpoint (e.g. the Webform resubmission marker itself) does NOT stop it', async () => {
    h.enqueue('touchpoints', { id: 'tp-2', kind: 'system' })
    await insertTouchpoint({
      lead_id: 'lead-natalie', location_uuid: 'loc-uuid-1', kind: 'system',
      method: 'system', label: 'Webform resubmission', user_id: null,
    })
    expect(stopMock).not.toHaveBeenCalled()
  })

  it('a drip send touchpoint does NOT stop it (the sequence must not stop itself)', async () => {
    h.enqueue('touchpoints', { id: 'tp-3', kind: 'drip' })
    await insertTouchpoint({
      lead_id: 'lead-natalie', location_uuid: 'loc-uuid-1', kind: 'drip',
      method: 'email', label: 'Drip: Good to hear from you again', user_id: null,
    })
    expect(stopMock).not.toHaveBeenCalled()
  })

  it('a partner reach-out is not a lead event', async () => {
    h.enqueue('touchpoints', { id: 'tp-4', kind: 'reach_out' })
    h.enqueue('partners', null)
    await insertTouchpoint({
      partner_id: 'partner-1', location_uuid: 'loc-uuid-1', kind: 'reach_out',
      method: 'call', label: 'Reach-out', user_id: 'user-1',
    })
    expect(stopMock).not.toHaveBeenCalled()
  })

  it('a failed touchpoint insert never reaches the stop', async () => {
    h.enqueue('touchpoints', null, { message: 'insert failed' })
    const r = await insertTouchpoint({
      lead_id: 'lead-natalie', location_uuid: 'loc-uuid-1', kind: 'reach_out',
      method: 'call', label: 'Reach-out', user_id: 'user-1',
    })
    expect(r.ok).toBe(false)
    expect(stopMock).not.toHaveBeenCalled()
  })
})

describe('the enquiry moving past Request stops the returning sequence', () => {
  const eng = (stage: string) => ({ id: 'eng-71ff', stage, closed_reason: null, client_id: 'lead-natalie' })

  it('Request → Estimate (a quote went out) → stop with "engagement_advanced"', async () => {
    h.enqueue('engagements', eng('Request'))
    h.enqueue('service_requests', [{ requested_at: '2026-09-01T20:06:00Z', created_at: '2026-09-01T20:06:00Z' }])
    h.enqueue('quotes', [{ status: 'sent', sent_at: '2026-09-02T10:00:00Z', approved_at: null, created_at: '2026-09-02T10:00:00Z' }])
    h.enqueue('jobs', [])
    h.enqueue('invoices', [])
    h.enqueue('engagements', null) // update ok

    const r = await maybeAdvanceEngagementStage('eng-71ff')
    expect(r).toEqual({ advanced: true, stage: 'Estimate' })
    expect(stopMock).toHaveBeenCalledWith('lead-natalie', 'engagement_advanced')
  })

  it('still at Request (nothing new on the records) → no advance, no stop', async () => {
    h.enqueue('engagements', eng('Request'))
    h.enqueue('service_requests', [{ requested_at: '2026-09-01T20:06:00Z', created_at: '2026-09-01T20:06:00Z' }])
    h.enqueue('quotes', [])
    h.enqueue('jobs', [])
    h.enqueue('invoices', [])
    h.enqueue('engagements', null)

    const r = await maybeAdvanceEngagementStage('eng-71ff')
    expect(r).toEqual({ advanced: false })
    expect(stopMock).not.toHaveBeenCalled()
  })

  it('an advance that does not START at Request (Estimate → Job in Progress) is not this hook\'s business', async () => {
    h.enqueue('engagements', eng('Estimate'))
    h.enqueue('service_requests', [])
    h.enqueue('quotes', [{ status: 'approved', sent_at: '2026-09-02T10:00:00Z', approved_at: '2026-09-03T10:00:00Z', created_at: '2026-09-02T10:00:00Z' }])
    h.enqueue('jobs', [{ status: 'scheduled', completed_at: null, scheduled_start: '2026-09-10T16:00:00Z', created_at: '2026-09-03T11:00:00Z' }])
    h.enqueue('invoices', [])
    h.enqueue('engagements', null)

    const r = await maybeAdvanceEngagementStage('eng-71ff')
    expect(r.advanced).toBe(true)
    expect(stopMock).not.toHaveBeenCalled()
  })

  it('a failed stage write never reaches the stop', async () => {
    h.enqueue('engagements', eng('Request'))
    h.enqueue('service_requests', [])
    h.enqueue('quotes', [{ status: 'sent', sent_at: '2026-09-02T10:00:00Z', approved_at: null, created_at: '2026-09-02T10:00:00Z' }])
    h.enqueue('jobs', [])
    h.enqueue('invoices', [])
    h.enqueue('engagements', null, { message: 'write failed' })

    const r = await maybeAdvanceEngagementStage('eng-71ff')
    expect(r).toEqual({ advanced: false })
    expect(stopMock).not.toHaveBeenCalled()
  })
})
