// @vitest-environment node
//
// The returning-client sequence (path_key 'returning') — lifecycle.
//
// A past client who fills in the website form again used to get nothing:
// every Jobber-imported client landed paused (the import must never mail
// thousands of people), and the merge path only enrols New/Attempting leads
// with no progress row. This suite pins the new enrolment and stop, and pins
// that the ORDINARY drip is untouched by them:
//
//   1) enrolReturningSequence IGNORES leads.paused (bypass) — the same lead
//      that startDripForLead refuses is enrolled on the 'returning' path.
//   2) it keeps every other gate: no email, opted out, location not active,
//      no path, already enrolled (UNIQUE violation).
//   3) isPastClient: Jobber-imported → yes; manual + closed engagement → yes;
//      manual + nothing closed (a new lead who submitted twice) → no.
//   4) stopReturningSequenceForLead stops ONLY rows on the 'returning' path
//      and does nothing when the lead has no live rows.
//
// Mock style: recording query-builder with per-table FIFO response queues
// (lib/drip-interface-active-gate.test.ts).
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
    for (const m of ['select', 'insert', 'update', 'upsert', 'eq', 'neq', 'or', 'not', 'range', 'ilike', 'is', 'limit', 'order', 'lte', 'in']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.maybeSingle = () => { call.ops.push(['maybeSingle', []]); return Promise.resolve(resp) }
    b.single = () => { call.ops.push(['single', []]); return Promise.resolve(resp) }
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  const callsFor = (t: string) => state.calls.filter(c => c.table === t)
  const opsOf = (call: { ops: [string, any[]][] }, m: string) => call.ops.filter(o => o[0] === m)
  const insertPayloads = (t: string) => callsFor(t).flatMap(c => opsOf(c, 'insert').map(o => o[1][0]))
  const updatePayloads = (t: string) => callsFor(t).flatMap(c => opsOf(c, 'update').map(o => o[1][0]))
  return { state, reset, enqueue, makeBuilder, callsFor, opsOf, insertPayloads, updatePayloads }
})

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
vi.mock('@/lib/resend', () => ({
  sendEmail: vi.fn(async () => ({ success: true, id: 're-1' })),
  renderTemplate: vi.fn((tpl: any) => ({ subject: tpl.subject ?? 's', body: tpl.body ?? 'b' })),
}))
vi.mock('@/lib/owner-resolution', () => ({
  getPrimaryOwnerForLocation: vi.fn(async () => null),
}))

import {
  startDripForLead,
  enrolReturningSequence,
  isPastClient,
  stopReturningSequenceForLead,
  RETURNING_PATH_KEY,
} from '@/lib/drip-lifecycle'

const LEAD = 'lead-natalie'
const LOC = 'loc-uuid-seattle'
const activeLoc = { id: LOC, timezone: 'America/Los_Angeles', lifecycle_status: 'active', default_drip_path: 'organizing-b', default_move_drip_path: null }

beforeEach(() => {
  h.reset()
  vi.clearAllMocks()
})

describe('1) the pause is bypassed for the returning sequence only', () => {
  it('startDripForLead refuses a paused (imported) lead — the ordinary drip is unchanged', async () => {
    h.enqueue('leads', { paused: true, marketing_opt_out: false, project_type: null })
    await startDripForLead(LEAD, LOC)
    expect(h.insertPayloads('lead_drip_progress')).toHaveLength(0)
    // Bails before the location read: paused is the first gate.
    expect(h.callsFor('locations')).toHaveLength(0)
  })

  it('enrolReturningSequence enrols that same paused lead on the returning path', async () => {
    h.enqueue('leads', { email: 'natalie@example.com', marketing_opt_out: false })
    h.enqueue('locations', activeLoc)
    h.enqueue('drip_paths', null)                    // location copy → none
    h.enqueue('drip_paths', { id: 'path-returning' }) // master → hit
    h.enqueue('drip_path_steps', { delay_days: 0 })
    h.enqueue('lead_drip_progress', null)            // insert ok

    const r = await enrolReturningSequence(LEAD, LOC)
    expect(r).toEqual({ enrolled: true })
    expect(h.insertPayloads('lead_drip_progress')).toEqual([
      expect.objectContaining({ lead_id: LEAD, drip_path_id: 'path-returning', current_step: 1 }),
    ])
    // The lead read never asks for `paused` — the bypass is structural, not a
    // flag that could be flipped back on by a widened select.
    const leadSelect = h.opsOf(h.callsFor('leads')[0], 'select')[0][1][0]
    expect(leadSelect).not.toMatch(/paused/)
  })

  it('resolves the LOCATION copy of the returning path first, master as fallback', async () => {
    h.enqueue('leads', { email: 'n@example.com', marketing_opt_out: false })
    h.enqueue('locations', activeLoc)
    h.enqueue('drip_paths', { id: 'path-returning-seattle-copy' })
    h.enqueue('drip_path_steps', { delay_days: 0 })
    h.enqueue('lead_drip_progress', null)

    await enrolReturningSequence(LEAD, LOC)
    expect(h.insertPayloads('lead_drip_progress')[0].drip_path_id).toBe('path-returning-seattle-copy')
    const pathCalls = h.callsFor('drip_paths')
    expect(pathCalls).toHaveLength(1)
    expect(h.opsOf(pathCalls[0], 'eq')).toEqual(expect.arrayContaining([
      ['eq', ['location_uuid', LOC]], ['eq', ['path_key', RETURNING_PATH_KEY]],
    ]))
  })
})

describe('2) every other gate still applies', () => {
  it('no email on record → no_email, nothing written', async () => {
    h.enqueue('leads', { email: '   ', marketing_opt_out: false })
    expect(await enrolReturningSequence(LEAD, LOC)).toEqual({ enrolled: false, reason: 'no_email' })
    expect(h.insertPayloads('lead_drip_progress')).toHaveLength(0)
  })

  it('opted out → opted_out, nothing written', async () => {
    h.enqueue('leads', { email: 'n@example.com', marketing_opt_out: true })
    expect(await enrolReturningSequence(LEAD, LOC)).toEqual({ enrolled: false, reason: 'opted_out' })
    expect(h.insertPayloads('lead_drip_progress')).toHaveLength(0)
  })

  it('location not active on the interface → location_not_active', async () => {
    h.enqueue('leads', { email: 'n@example.com', marketing_opt_out: false })
    h.enqueue('locations', { ...activeLoc, lifecycle_status: 'onboarding' })
    expect(await enrolReturningSequence(LEAD, LOC)).toEqual({ enrolled: false, reason: 'location_not_active' })
    expect(h.callsFor('drip_paths')).toHaveLength(0)
  })

  it('master not seeded yet → path_not_found, nothing written', async () => {
    h.enqueue('leads', { email: 'n@example.com', marketing_opt_out: false })
    h.enqueue('locations', activeLoc)
    h.enqueue('drip_paths', null)
    h.enqueue('drip_paths', null)
    expect(await enrolReturningSequence(LEAD, LOC)).toEqual({ enrolled: false, reason: 'path_not_found' })
    expect(h.insertPayloads('lead_drip_progress')).toHaveLength(0)
  })

  it('a second enrolment hits UNIQUE(lead_id, drip_path_id) → already_enrolled', async () => {
    h.enqueue('leads', { email: 'n@example.com', marketing_opt_out: false })
    h.enqueue('locations', activeLoc)
    h.enqueue('drip_paths', null)
    h.enqueue('drip_paths', { id: 'path-returning' })
    h.enqueue('drip_path_steps', { delay_days: 0 })
    h.enqueue('lead_drip_progress', null, { code: '23505', message: 'duplicate key' })
    expect(await enrolReturningSequence(LEAD, LOC)).toEqual({ enrolled: false, reason: 'already_enrolled' })
  })
})

describe('3) isPastClient — who counts as returning', () => {
  it('Jobber-imported (import_source != manual) → past client, no engagement read needed', async () => {
    h.enqueue('leads', { import_source: 'jobber_initial' })
    expect(await isPastClient(LEAD)).toBe(true)
    expect(h.callsFor('engagements')).toHaveLength(0)
  })

  it('manual lead WITH a closed engagement → past client', async () => {
    h.enqueue('leads', { import_source: 'manual' })
    h.enqueue('engagements', { id: 'eng-closed' })
    expect(await isPastClient(LEAD)).toBe(true)
    const eng = h.callsFor('engagements')[0]
    expect(h.opsOf(eng, 'in')[0][1]).toEqual(['stage', ['Closed Won', 'Closed Lost']])
  })

  it('manual lead with nothing closed (a new lead who submitted twice) → NOT a past client', async () => {
    h.enqueue('leads', { import_source: 'manual' })
    h.enqueue('engagements', null)
    expect(await isPastClient(LEAD)).toBe(false)
  })
})

describe('4) stopReturningSequenceForLead is scoped to the returning path', () => {
  it('no live progress rows → one read, no write', async () => {
    h.enqueue('lead_drip_progress', [])
    await stopReturningSequenceForLead(LEAD, 'reach_out')
    expect(h.callsFor('drip_paths')).toHaveLength(0)
    expect(h.updatePayloads('lead_drip_progress')).toHaveLength(0)
  })

  it('a live row on the returning path → stopped with the given reason', async () => {
    h.enqueue('lead_drip_progress', [{ id: 'prog-r', drip_path_id: 'path-returning' }])
    h.enqueue('drip_paths', [{ id: 'path-returning' }])
    h.enqueue('lead_drip_progress', null) // update ok
    await stopReturningSequenceForLead(LEAD, 'reach_out')
    const upd = h.updatePayloads('lead_drip_progress')
    expect(upd).toHaveLength(1)
    expect(upd[0]).toMatchObject({ stopped_reason: 'reach_out' })
    expect(upd[0].stopped_at).toBeTruthy()
    // The write is by row id, never by lead_id alone.
    const writeCall = h.callsFor('lead_drip_progress')[1]
    expect(h.opsOf(writeCall, 'in')[0][1]).toEqual(['id', ['prog-r']])
  })

  it('a live row on an ORDINARY path only → untouched (the returning stop never reaches it)', async () => {
    h.enqueue('lead_drip_progress', [{ id: 'prog-o', drip_path_id: 'path-organizing-b' }])
    h.enqueue('drip_paths', []) // none of those ids is the returning path
    await stopReturningSequenceForLead(LEAD, 'engagement_advanced')
    expect(h.updatePayloads('lead_drip_progress')).toHaveLength(0)
  })

  it('mixed rows → only the returning one is stopped', async () => {
    h.enqueue('lead_drip_progress', [
      { id: 'prog-o', drip_path_id: 'path-organizing-b' },
      { id: 'prog-r', drip_path_id: 'path-returning' },
    ])
    h.enqueue('drip_paths', [{ id: 'path-returning' }])
    h.enqueue('lead_drip_progress', null)
    await stopReturningSequenceForLead(LEAD, 'engagement_closed')
    const writeCall = h.callsFor('lead_drip_progress')[1]
    expect(h.opsOf(writeCall, 'in')[0][1]).toEqual(['id', ['prog-r']])
    expect(h.updatePayloads('lead_drip_progress')[0].stopped_reason).toBe('engagement_closed')
  })
})
