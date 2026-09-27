// @vitest-environment node
//
// Why a lead did or didn't start nurture emails — named, stored, surfaced.
// (lib/drip-enrol-outcome.ts, lib/drip-lifecycle.ts startDripForLead,
// PATCH /api/drip-paths/:id/steps, lib/failure-alerts kind 8.)
//
// THE CASE: Test Fornat (Test Location, 2026-09-27) was created with Drip
// ticked and never enrolled. Test Location's Moving copy holds ONE step,
// numbered 3; enrolment looked for step 1 exactly, logged "step 1 missing",
// and returned nothing. Silence was the bug — every exit here now names
// itself, and the headline tests were mutation-tested against a silent exit.
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
    for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'in', 'is', 'gt', 'lte', 'order', 'limit', 'not']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.maybeSingle = () => Promise.resolve(resp)
    b.single = () => Promise.resolve(resp)
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  const payloads = (t: string, m: string) =>
    state.calls.filter(c => c.table === t).flatMap(c => c.ops.filter(o => o[0] === m).map(o => o[1][0]))
  const opsFor = (t: string, m: string) =>
    state.calls.filter(c => c.table === t && c.ops.some(o => o[0] === m))
  return { state, reset, enqueue, makeBuilder, payloads, opsFor }
})

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.makeBuilder(t) } }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'owner-1' } } }) },
    from: () => {
      const b: any = {}
      b.select = () => b; b.eq = () => b
      b.single = async () => ({ data: { id: 'owner-1', role: 'owner', location_id: 'loc-test' } })
      return b
    },
  }),
}))
vi.mock('@/lib/welcome-email', () => ({ cancelPendingWelcomeEmail: vi.fn(async () => {}) }))

import { startDripForLead } from '@/lib/drip-lifecycle'
import {
  DRIP_ENROL_REASONS,
  DRIP_ENROL_KIND,
  SETUP_REASONS,
  dripEnrolReasonText,
  type DripEnrolReason,
} from '@/lib/drip-enrol-outcome'
import { renumberSteps } from '@/lib/drip-step-order'
import { PATCH as STEPS_PATCH } from '@/app/api/drip-paths/[id]/steps/route'
import { selectNewAlerts, fetchDripEnrolSetupFailures } from '@/lib/failure-alerts'

const LEAD = 'lead-fornat'
const LOC = 'loc-test'
const activeLoc = (over: any = {}) => ({
  id: LOC, timezone: 'Eastern Time (ET)', lifecycle_status: 'active',
  default_drip_path: 'organizing-a', default_move_drip_path: 'moving-a', ...over,
})
const moveLead = (over: any = {}) => ({ paused: false, marketing_opt_out: false, project_type: 'Moving/Relocation', ...over })

// Queue Test Fornat's exact path: Moving lead, active location, the location's
// own moving-a copy, whose steps are `steps`.
function queueTestFornat(steps: any[]) {
  h.enqueue('leads', moveLead())
  h.enqueue('locations', activeLoc())
  h.enqueue('lookups', { attrs: { drip_category: 'move' } })
  h.enqueue('drip_paths', { id: 'copy-moving-a' }) // location copy → hit
  h.enqueue('drip_path_steps', steps)
}
const outcomeWrites = () => h.payloads('leads', 'update')
const timeline = () => h.payloads('touchpoints', 'insert')

beforeEach(() => { h.reset(); vi.clearAllMocks() })

// ═══ 1. the structural fixes ═════════════════════════════════════════
describe('a sequence whose first step is numbered 3 still enrols', () => {
  it('Test Fornat’s exact case: enrols AT step 3, and records "enrolled"', async () => {
    queueTestFornat([{ step_order: 3, delay_days: 30 }])

    const res = await startDripForLead(LEAD, LOC)

    expect(res).toEqual({ enrolled: true })
    const ins = h.payloads('lead_drip_progress', 'insert')
    expect(ins).toHaveLength(1)
    expect(ins[0]).toMatchObject({ lead_id: LEAD, drip_path_id: 'copy-moving-a', current_step: 3 })
    // looked for the LOWEST step, not step_order = 1
    const stepCall = h.state.calls.find(c => c.table === 'drip_path_steps')!
    expect(stepCall.ops).toContainEqual(['order', ['step_order', { ascending: true }]])
    expect(stepCall.ops).toContainEqual(['limit', [1]])
    expect(stepCall.ops.some(([m, a]) => m === 'eq' && a[0] === 'step_order')).toBe(false)
    expect(outcomeWrites()[0]).toMatchObject({ drip_enrol_reason: null })
  })
})

describe('saving a sequence renumbers it from 1', () => {
  it('pure: [3] → [1]; [1,2,4] → [1,2,3] with 4→3 reported; already 1..n → untouched, no moves', () => {
    expect(renumberSteps([{ step_order: 3 }])).toEqual({ steps: [{ step_order: 1 }], moves: [[3, 1]] })
    const r = renumberSteps([{ step_order: 4, k: 'c' }, { step_order: 1, k: 'a' }, { step_order: 2, k: 'b' }] as any)
    expect(r.steps.map((s: any) => [s.k, s.step_order])).toEqual([['a', 1], ['b', 2], ['c', 3]])
    expect(r.moves).toEqual([[4, 3]])
    const same = [{ step_order: 1 }, { step_order: 2 }, { step_order: 3 }]
    expect(renumberSteps(same)).toEqual({ steps: same, moves: [] })
  })

  it('pure: a repeated number is renumbered but reports no move (ambiguous — leads left as they were)', () => {
    const r = renumberSteps([{ step_order: 2 }, { step_order: 2 }])
    expect(r.steps.map(s => s.step_order)).toEqual([1, 2])
    expect(r.moves).toEqual([])
  })

  const patch = (steps: any[]) => STEPS_PATCH(
    new Request('http://t', { method: 'PATCH', body: JSON.stringify({ steps }) }) as any,
    { params: { id: 'copy-moving-a' } },
  )
  const step = (n: number) => ({ step_order: n, delay_days: n * 5, channel: 'email', subject: `S${n}`, body: `B${n}` })

  it('the route saves Test Location’s single "step 3" as step 1', async () => {
    h.enqueue('drip_paths', { id: 'copy-moving-a', location_uuid: 'loc-test', is_master: false })
    h.enqueue('drip_path_steps', null) // delete
    h.enqueue('drip_path_steps', [{ id: 'n1', step_order: 1 }]) // insert…select

    const res = await patch([step(3)])

    expect(res.status).toBe(200)
    const inserted = h.payloads('drip_path_steps', 'insert')[0]
    expect(inserted.map((s: any) => s.step_order)).toEqual([1])
  })

  it('a lead mid-sequence moves WITH its step (4 → 3), so it never points at nothing', async () => {
    h.enqueue('drip_paths', { id: 'copy-moving-a', location_uuid: 'loc-test', is_master: false })
    h.enqueue('drip_path_steps', null)
    h.enqueue('drip_path_steps', [])

    await patch([step(1), step(2), step(4)])

    expect(h.payloads('drip_path_steps', 'insert')[0].map((s: any) => s.step_order)).toEqual([1, 2, 3])
    const mv = h.opsFor('lead_drip_progress', 'update')
    expect(mv).toHaveLength(1)
    expect(mv[0].ops).toContainEqual(['update', [{ current_step: 3 }]])
    expect(mv[0].ops).toContainEqual(['eq', ['current_step', 4]])
    expect(mv[0].ops).toContainEqual(['eq', ['drip_path_id', 'copy-moving-a']])
    expect(mv[0].ops).toContainEqual(['is', ['stopped_at', null]])
  })

  it('a sequence already numbered 1..n (every one in production but Test Location’s) is saved as sent, no lead moved', async () => {
    h.enqueue('drip_paths', { id: 'copy-organizing-a', location_uuid: 'loc-test', is_master: false })
    h.enqueue('drip_path_steps', null)
    h.enqueue('drip_path_steps', [])

    await patch([step(1), step(2), step(3)])

    expect(h.payloads('drip_path_steps', 'insert')[0].map((s: any) => s.step_order)).toEqual([1, 2, 3])
    expect(h.opsFor('lead_drip_progress', 'update')).toHaveLength(0)
  })
})

// ═══ 2. every early exit is named ═════════════════════════════════════
describe('each reason is returned by the right early exit', () => {
  const cases: [DripEnrolReason, () => void][] = [
    ['paused_import', () => { h.enqueue('leads', moveLead({ paused: true })) }],
    ['opted_out', () => { h.enqueue('leads', moveLead({ marketing_opt_out: true })) }],
    ['location_not_live', () => { h.enqueue('leads', moveLead()); h.enqueue('locations', activeLoc({ lifecycle_status: 'onboarding' })) }],
    ['no_default_path', () => {
      h.enqueue('leads', moveLead()); h.enqueue('locations', activeLoc({ default_drip_path: null, default_move_drip_path: null }))
      h.enqueue('lookups', { attrs: { drip_category: 'move' } })
    }],
    ['path_missing', () => {
      h.enqueue('leads', moveLead()); h.enqueue('locations', activeLoc()); h.enqueue('lookups', { attrs: { drip_category: 'move' } })
      h.enqueue('drip_paths', null); h.enqueue('drip_paths', null)
    }],
    ['path_has_no_first_email', () => { queueTestFornat([]) }],
    ['lookup_failed', () => { h.enqueue('leads', null, { message: 'connection reset' }) }],
  ]
  for (const [reason, setup] of cases) {
    it(`${reason}`, async () => {
      setup()
      const res = await startDripForLead(LEAD, LOC)
      expect(res.enrolled).toBe(false)
      expect((res as any).reason).toBe(reason)
      expect(h.payloads('lead_drip_progress', 'insert')).toHaveLength(0)
    })
  }

  it('the remaining lookups and the write fail as lookup_failed too — none of them silent', async () => {
    // location read fails
    h.enqueue('leads', moveLead()); h.enqueue('locations', null, { message: 'x' })
    expect(await startDripForLead(LEAD, LOC)).toMatchObject({ enrolled: false, reason: 'lookup_failed' })
    // progress insert fails (not a duplicate)
    h.reset(); queueTestFornat([{ step_order: 1, delay_days: 0 }]); h.enqueue('lead_drip_progress', null, { code: '42501', message: 'denied' })
    expect(await startDripForLead(LEAD, LOC)).toMatchObject({ enrolled: false, reason: 'lookup_failed' })
    // an already-enrolled lead (unique violation) is enrolled, not an error
    h.reset(); queueTestFornat([{ step_order: 1, delay_days: 0 }]); h.enqueue('lead_drip_progress', null, { code: '23505', message: 'dup' })
    expect(await startDripForLead(LEAD, LOC)).toEqual({ enrolled: true })
  })

  it('setup reasons carry the sequence the owner would recognise', async () => {
    queueTestFornat([])
    expect(await startDripForLead(LEAD, LOC)).toEqual({ enrolled: false, reason: 'path_has_no_first_email', sequence: 'Moving' })
  })

  it('all eight codes exist and are classified', () => {
    expect([...DRIP_ENROL_REASONS].sort()).toEqual([
      'drip_not_ticked', 'location_not_live', 'lookup_failed', 'no_default_path',
      'opted_out', 'path_has_no_first_email', 'path_missing', 'paused_import',
    ])
    expect(SETUP_REASONS.sort()).toEqual(['no_default_path', 'path_has_no_first_email', 'path_missing'])
    expect(DRIP_ENROL_KIND.lookup_failed).toBe('system')
    for (const r of ['drip_not_ticked', 'paused_import', 'opted_out', 'location_not_live'] as const) {
      expect(DRIP_ENROL_KIND[r]).toBe('by_design')
    }
  })
})

// ═══ 3. stored on the lead; 5. Timeline by kind ═════════════════════
describe('the reason is stored on the lead', () => {
  it('a failed enrol writes the code and a time; a later success clears the code', async () => {
    queueTestFornat([])
    await startDripForLead(LEAD, LOC)
    const w = outcomeWrites()[0]
    expect(w.drip_enrol_reason).toBe('path_has_no_first_email')
    expect(typeof w.drip_enrol_at).toBe('string')
    expect(Number.isNaN(Date.parse(w.drip_enrol_at))).toBe(false)

    h.reset()
    queueTestFornat([{ step_order: 1, delay_days: 0 }])
    await startDripForLead(LEAD, LOC)
    expect(outcomeWrites()[0].drip_enrol_reason).toBeNull()
  })

  it('a SETUP reason writes one Timeline entry naming it; a repeat of the same reason does not', async () => {
    queueTestFornat([])
    await startDripForLead(LEAD, LOC)
    expect(timeline()).toHaveLength(1)
    expect(timeline()[0].label).toBe(`Nurture emails didn’t start — ${dripEnrolReasonText('path_has_no_first_email', { sequence: 'Moving' })}`)
    expect(timeline()[0].label).toContain('Moving sequence has no emails')

    h.reset()
    queueTestFornat([])
    // the outcome recorder's read: the lead already carries this reason
    h.enqueue('leads', { drip_enrol_reason: 'path_has_no_first_email' })
    await startDripForLead(LEAD, LOC)
    expect(timeline()).toHaveLength(0)
  })

  it('a SYSTEM reason writes a Timeline entry too', async () => {
    h.enqueue('leads', null, { message: 'reset' })
    await startDripForLead(LEAD, LOC)
    expect(timeline()).toHaveLength(1)
    expect(timeline()[0].label).toContain('tap Activate to try again')
  })

  it('a BY-DESIGN reason writes no Timeline entry (card only)', async () => {
    h.enqueue('leads', moveLead({ paused: true }))
    await startDripForLead(LEAD, LOC)
    expect(outcomeWrites()[0].drip_enrol_reason).toBe('paused_import')
    expect(timeline()).toHaveLength(0)
  })

  it('never says "contact support", in any reason text', () => {
    for (const r of DRIP_ENROL_REASONS) {
      expect(dripEnrolReasonText(r, { sequence: 'Moving', locationName: 'Test Location' })).not.toMatch(/contact support/i)
    }
  })
})

// ═══ the alert: setup problem yes, by-design no ═══════════════════════
describe('a setup problem raises the alert; a by-design one does not', () => {
  const base = { events: [], importFailed: [], mismatches: [], locName: new Map(), sinceMs: 1000, cutoffMs: 10_000, nowMs: 20_000 }
  const locNameByUuid = new Map([['loc-test', 'Test Location']])

  it('setup → one alert naming the location, the count and the cause', () => {
    const items = selectNewAlerts({
      ...base, locNameByUuid,
      dripEnrolFailures: [{ location_uuid: 'loc-test', reason: 'path_has_no_first_email', first_at: new Date(5000).toISOString(), count: 3 }],
    })
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('drip_not_starting')
    expect(items[0].text).toContain('Test Location')
    expect(items[0].text).toContain('3 new leads')
    expect(items[0].text).toContain('has no emails in it')
  })

  it('by-design (or system) reasons never alert, even if handed in', () => {
    for (const reason of ['drip_not_ticked', 'paused_import', 'opted_out', 'location_not_live', 'lookup_failed'] as const) {
      const items = selectNewAlerts({
        ...base, locNameByUuid,
        dripEnrolFailures: [{ location_uuid: 'loc-test', reason, first_at: new Date(5000).toISOString(), count: 1 }],
      })
      expect(items, reason).toHaveLength(0)
    }
  })

  it('the fetcher asks ONLY for setup reasons, groups per location, and drops a location already alerted this week', async () => {
    const fake: any = { from: (t: string) => h.makeBuilder(t) }
    h.enqueue('leads', [
      { name: 'Test Fornat', location_uuid: 'loc-test', drip_enrol_reason: 'path_has_no_first_email', drip_enrol_at: '2026-09-27T04:09:28Z' },
      { name: 'Second', location_uuid: 'loc-test', drip_enrol_reason: 'path_has_no_first_email', drip_enrol_at: '2026-09-27T05:00:00Z' },
    ])
    h.enqueue('leads', []) // no prior failure this week
    const rows = await fetchDripEnrolSetupFailures(fake, '2026-09-27T04:00:00Z', '2026-09-27T06:00:00Z')
    expect(rows).toEqual([{ location_uuid: 'loc-test', reason: 'path_has_no_first_email', first_at: '2026-09-27T04:09:28Z', count: 2, lead_name: 'Test Fornat' }])
    const firstQuery = h.state.calls[0]
    expect(firstQuery.ops).toContainEqual(['in', ['drip_enrol_reason', SETUP_REASONS]])

    h.reset()
    h.enqueue('leads', [{ name: 'Third', location_uuid: 'loc-test', drip_enrol_reason: 'path_has_no_first_email', drip_enrol_at: '2026-09-28T04:00:00Z' }])
    h.enqueue('leads', [{ id: 'earlier' }]) // same location + reason, earlier this week → already alerted
    expect(await fetchDripEnrolSetupFailures(fake, '2026-09-28T03:00:00Z', '2026-09-28T05:00:00Z')).toEqual([])
  })

  it('before the migration (column missing) the fetcher returns nothing rather than failing the run', async () => {
    const fake: any = { from: (t: string) => h.makeBuilder(t) }
    h.enqueue('leads', null, { message: 'column leads.drip_enrol_reason does not exist' })
    expect(await fetchDripEnrolSetupFailures(fake, '2026-09-27T04:00:00Z', '2026-09-27T06:00:00Z')).toEqual([])
  })
})
