// lib/beta-email-steps-route.test.ts
//
// The step save (PATCH /api/drip-paths/:id/steps) carrying the 2026-10-30
// columns — pause, timing unit, button — through its DELETE-then-INSERT.
//
//   • a months/years timing survives a save, and the reload reads it back
//   • a paused email is written paused; step 1 can't be paused
//   • BEFORE a migration has run, a save that needs its column is refused
//     and NOTHING is deleted (the insert would fail after the delete and
//     wipe the location's sequence)
//   • before the migration, an ordinary save still works and names no new column
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
    for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'gt', 'or', 'not', 'range', 'ilike', 'is', 'limit', 'order', 'lte', 'in']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.maybeSingle = () => { call.ops.push(['maybeSingle', []]); return Promise.resolve(resp) }
    b.single = () => { call.ops.push(['single', []]); return Promise.resolve(resp) }
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  const callsFor = (t: string) => state.calls.filter(c => c.table === t)
  const updatePayloads = (t: string) =>
    callsFor(t).flatMap(c => c.ops.filter(o => o[0] === 'update').map(o => o[1][0]))
  return { state, reset, enqueue, makeBuilder, callsFor, updatePayloads }
})

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.makeBuilder(t) } }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'u1' } } })) },
    from: (t: string) => h.makeBuilder(t),
  })),
}))

import { PATCH as patchSteps } from '@/app/api/drip-paths/[id]/steps/route'
import { buildEmailList } from '@/components/BeeHub'

const LOC = 'loc-uuid-1'
const owner = { id: 'u1', role: 'owner', location_id: LOC }
const OWN_PATH = { id: 'p2', location_uuid: LOC, is_master: false }
const req = (body: any) => ({ json: async () => body }) as any
const s = (n: number, over: any = {}) => ({ step_order: n, delay_days: (n - 1) * 5, channel: 'email', subject: `S${n}`, body: 'b', ...over })
const deleted = () => h.state.calls.some(c => c.table === 'drip_path_steps' && c.ops.some(([m]) => m === 'delete'))
const inserted = () => h.callsFor('drip_path_steps').flatMap(c => c.ops.filter(o => o[0] === 'insert').map(o => o[1][0]))[0] as any[]
// The column probe: one drip_path_steps row read with '*'.
const MIGRATED = { id: 'x', is_paused: false, delay_unit: null, button_text: null, button_link: null }
const NOT_MIGRATED = { id: 'x' }

beforeEach(() => { h.reset(); vi.clearAllMocks() })

const save = async (steps: any[], probe: any) => {
  h.enqueue('hub_users', owner)
  h.enqueue('drip_paths', OWN_PATH)
  h.enqueue('drip_path_steps', [probe])
  return patchSteps(req({ steps }), { params: { id: 'p2' } })
}

describe('timing in months and years survives a save and a reload', () => {
  it('3 months is saved as day 90 with its unit', async () => {
    const res = await save([s(1), s(2), s(3, { delay_days: 90, delay_unit: 'months' })], MIGRATED)
    expect(res.status).toBe(200)
    const row3 = inserted().find(r => r.step_order === 3)
    expect(row3).toMatchObject({ delay_days: 90, delay_unit: 'months' })
    expect(inserted().find(r => r.step_order === 2).delay_unit).toBeNull()
  })

  it('the reload carries the unit back out, and the list reads "3 months later"', () => {
    const getRoute = readFileSync(join(process.cwd(), 'app/api/locations/[id]/drip-paths/route.ts'), 'utf8')
    expect(getRoute).toContain("delay_unit: (s as any).delay_unit ?? null,")
    const beehub = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')
    // The location's own steps are read back by loadLocationPaths, and the
    // save sends them back out through commitSteps — the unit must survive both.
    const fn = (name: string) => { const a = beehub.indexOf(name); return beehub.slice(a, beehub.indexOf('\n  }\n', a)) }
    expect(fn('async function loadLocationPaths()')).toContain('delayUnit: s.delay_unit ?? null,')
    expect(fn('async function commitSteps(')).toContain("delay_unit: s.delayUnit === 'months' || s.delayUnit === 'years' ? s.delayUnit : null,")
    // 30 days is the case that tells them apart: "A month later" as the owner
    // chose it, "Day 30" without the unit.
    const { newLead } = buildEmailList({
      pathSteps: { p: [
        { order: 1, type: 'email', delay_days: 0, subject: 'One', body: 'x' },
        { order: 2, type: 'email', delay_days: 30, delayUnit: 'months', subject: 'Two', body: 'x' },
        { order: 3, type: 'email', delay_days: 31, subject: 'Three', body: 'x' },
      ] },
      templates: [], pathKey: 'p',
    })
    expect(newLead.map((r: any) => r.when)).toEqual(['Right away', 'A month later', 'Day 31'])
  })
})

describe('the list orders emails by when they actually send', () => {
  it('the welcome (day 1) sits between the first email and day 5; a later day goes last', () => {
    const tpl = { id: 'welcome', dbId: 't1', legacyId: 'welcome', isMaster: true, subject: 'Welcome', body: 'w', isActive: true }
    const { newLead } = buildEmailList({
      pathSteps: { p: [
        { order: 1, type: 'email', delay_days: 0, subject: 'First', body: 'x' },
        { order: 2, type: 'email', delay_days: 5, subject: 'Day five', body: 'x' },
        { order: 3, type: 'email', delay_days: 30, subject: 'A month', body: 'x', delayUnit: 'months' },
      ] },
      templates: [tpl], pathKey: 'p',
    })
    expect(newLead.map((r: any) => r.subject)).toEqual(['First', 'Welcome', 'Day five', 'A month'])
  })
})

describe('Pause, through the save', () => {
  it('a paused email is written paused and keeps its place and number', async () => {
    const res = await save([s(1), s(2, { is_paused: true }), s(3)], MIGRATED)
    expect(res.status).toBe(200)
    expect(inserted().map(r => [r.step_order, r.is_paused, r.is_active])).toEqual([[1, false, true], [2, true, true], [3, false, true]])
  })

  it('step 1 cannot be paused — refused before anything is deleted', async () => {
    const res = await save([s(1, { is_paused: true }), s(2)], MIGRATED)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('first_email_always_sends')
    expect(deleted()).toBe(false)
  })
})

describe('before the migrations run', () => {
  it('pausing is refused untouched — nothing deleted', async () => {
    const res = await save([s(1), s(2, { is_paused: true })], NOT_MIGRATED)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'not_set_up_yet', columns: ['is_paused'] })
    expect(deleted()).toBe(false)
  })

  it('a months timing or a button is refused untouched too', async () => {
    const res = await save([s(1), s(2, { delay_days: 60, delay_unit: 'months', button_text: 'Book', button_link: '{{booking_link}}' })], NOT_MIGRATED)
    expect(res.status).toBe(409)
    expect((await res.json()).columns.sort()).toEqual(['button_link', 'button_text', 'delay_unit'])
    expect(deleted()).toBe(false)
  })

  it('an ordinary save still works, and the insert names no column that does not exist', async () => {
    const res = await save([s(1), s(2, { is_paused: false, delay_unit: null, button_text: null })], NOT_MIGRATED)
    expect(res.status).toBe(200)
    for (const r of inserted()) {
      for (const col of ['is_paused', 'delay_unit', 'button_text', 'button_link']) expect(r).not.toHaveProperty(col)
    }
  })
})
