// @vitest-environment node
//
// New Client Drip selection by project type (Configure audit gap: the
// Project Types picklist carries a Move/Organizing tag
// (lookups.attrs.drip_category), and each location configures BOTH a
// default_drip_path (organizing) and default_move_drip_path (moving) — but
// startDripForLead ignored the tag and always enrolled default_drip_path,
// so a Move lead and an Organizing lead got the same drip.)
//
// Pins:
//   — Move-tagged project_type → the location's default_move_drip_path is
//     the path_key looked up (both the location-copy and master queries).
//   — Organizing-tagged project_type → default_drip_path.
//   — Untagged / unknown project_type → falls back to default_drip_path
//     (resolveDripCategory defaults to 'general').
//   — Move-tagged but the location never configured a move path → falls
//     back to default_drip_path rather than enrolling nothing.
//   — Suppression intact: a paused (imported / not-yet-activated) lead
//     enrolls NOTHING regardless of project_type — no locations, lookups,
//     or lead_drip_progress touch happens.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── chainable supabaseService mock (per-table FIFO queue + call recording),
//    same shape as beta-invoice-update-webhook.test.ts. ────────────────────
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
  // Every path_key passed to a drip_paths .eq('path_key', …) lookup.
  const dripPathKeys = () =>
    state.calls
      .filter(c => c.table === 'drip_paths')
      .flatMap(c => c.ops.filter(o => o[0] === 'eq' && o[1][0] === 'path_key').map(o => o[1][1]))
  // Tables that got a builder created for them (i.e. were queried at all).
  const tablesTouched = () => state.calls.map(c => c.table)
  // The payload of the last lead_drip_progress insert, if any.
  const progressInsert = () => {
    const call = [...state.calls].reverse().find(c =>
      c.table === 'lead_drip_progress' && c.ops.some(o => o[0] === 'insert'))
    return call?.ops.find(o => o[0] === 'insert')?.[1][0] as Record<string, any> | undefined
  }
  return { state, reset, enqueue, makeBuilder, dripPathKeys, tablesTouched, progressInsert }
})

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))

import { startDripForLead } from '@/lib/drip-lifecycle'

const LEAD_ID = 'lead-1'
const LOC_UUID = 'loc-uuid-1'

// Queue the happy-path responses in call order for a given lead row +
// location config + project-type tag. drip_paths location-copy always
// returns null (falls through to the master), master returns a path.
function seedHappyPath(opts: {
  leadRow: Record<string, any>
  location: Record<string, any>
  dripCategory: 'move' | 'general' | null // null = project_type not found in lookups
}) {
  const { leadRow, location, dripCategory } = opts
  h.enqueue('leads', leadRow)                       // paused / opt-out / project_type
  h.enqueue('locations', { id: LOC_UUID, timezone: 'UTC', ...location })
  // resolveDripCategory → lookups (only queried when project_type is set)
  if (leadRow.project_type) {
    h.enqueue('lookups', dripCategory ? { attrs: { drip_category: dripCategory } } : null)
  }
  h.enqueue('drip_paths', null)                     // location-copy → miss
  h.enqueue('drip_paths', { id: 'path-db-1' })      // master → hit
  h.enqueue('drip_path_steps', { delay_days: 0 })   // step 1
  h.enqueue('lead_drip_progress', null)             // insert ok
}

beforeEach(() => {
  h.reset()
  vi.clearAllMocks()
})

describe('New Client Drip selection by project_type tag', () => {
  it('Move-tagged project_type → enrolls default_move_drip_path', async () => {
    seedHappyPath({
      leadRow: { paused: false, marketing_opt_out: false, project_type: 'Move Out' },
      location: { default_drip_path: 'organizing-c', default_move_drip_path: 'moving-c' },
      dripCategory: 'move',
    })

    await startDripForLead(LEAD_ID, LOC_UUID)

    // Every drip_paths lookup used the MOVE path_key.
    expect(h.dripPathKeys()).toEqual(['moving-c', 'moving-c'])
    expect(h.dripPathKeys()).not.toContain('organizing-c')
    // And a progress row was actually inserted.
    expect(h.progressInsert()).toMatchObject({ lead_id: LEAD_ID, drip_path_id: 'path-db-1', current_step: 1 })
  })

  it('Organizing-tagged project_type → enrolls default_drip_path', async () => {
    seedHappyPath({
      leadRow: { paused: false, marketing_opt_out: false, project_type: 'Kitchen' },
      location: { default_drip_path: 'organizing-c', default_move_drip_path: 'moving-c' },
      dripCategory: 'general',
    })

    await startDripForLead(LEAD_ID, LOC_UUID)

    expect(h.dripPathKeys()).toEqual(['organizing-c', 'organizing-c'])
    expect(h.dripPathKeys()).not.toContain('moving-c')
    expect(h.progressInsert()).toMatchObject({ drip_path_id: 'path-db-1' })
  })

  it('untagged / unknown project_type → falls back to default_drip_path', async () => {
    // project_type present but not found in the lookups table (dripCategory
    // null → resolveDripCategory returns 'general').
    seedHappyPath({
      leadRow: { paused: false, marketing_opt_out: false, project_type: 'Something Custom' },
      location: { default_drip_path: 'organizing-c', default_move_drip_path: 'moving-c' },
      dripCategory: null,
    })

    await startDripForLead(LEAD_ID, LOC_UUID)

    expect(h.dripPathKeys()).toEqual(['organizing-c', 'organizing-c'])
  })

  it('null project_type → organizing default, lookups never queried', async () => {
    seedHappyPath({
      leadRow: { paused: false, marketing_opt_out: false, project_type: null },
      location: { default_drip_path: 'organizing-c', default_move_drip_path: 'moving-c' },
      dripCategory: null,
    })

    await startDripForLead(LEAD_ID, LOC_UUID)

    expect(h.tablesTouched()).not.toContain('lookups') // short-circuits on null
    expect(h.dripPathKeys()).toEqual(['organizing-c', 'organizing-c'])
  })

  it('Move-tagged but no move path configured → falls back to default_drip_path', async () => {
    seedHappyPath({
      leadRow: { paused: false, marketing_opt_out: false, project_type: 'Move Out' },
      location: { default_drip_path: 'organizing-c', default_move_drip_path: null },
      dripCategory: 'move',
    })

    await startDripForLead(LEAD_ID, LOC_UUID)

    // Move category, but move path unset → organizing default rather than
    // enrolling nothing.
    expect(h.dripPathKeys()).toEqual(['organizing-c', 'organizing-c'])
    expect(h.progressInsert()).toMatchObject({ drip_path_id: 'path-db-1' })
  })
})

describe('suppression intact', () => {
  it('paused (imported / not-activated) lead → enrolls NOTHING, ignores project_type', async () => {
    // Only the leads row is consulted; startDrip returns before touching
    // locations / lookups / drip_paths / lead_drip_progress.
    h.enqueue('leads', { paused: true, marketing_opt_out: false, project_type: 'Move Out' })

    await startDripForLead(LEAD_ID, LOC_UUID)

    expect(h.tablesTouched()).toEqual(['leads'])
    expect(h.progressInsert()).toBeUndefined()
    expect(h.dripPathKeys()).toEqual([])
  })

  it('marketing_opt_out lead → enrolls NOTHING', async () => {
    h.enqueue('leads', { paused: false, marketing_opt_out: true, project_type: 'Move Out' })

    await startDripForLead(LEAD_ID, LOC_UUID)

    expect(h.tablesTouched()).toEqual(['leads'])
    expect(h.progressInsert()).toBeUndefined()
  })

  it('no default paths configured at all → enrolls NOTHING (owner has not set up)', async () => {
    h.enqueue('leads', { paused: false, marketing_opt_out: false, project_type: 'Kitchen' })
    h.enqueue('locations', { id: LOC_UUID, timezone: 'UTC', default_drip_path: null, default_move_drip_path: null })
    h.enqueue('lookups', { attrs: { drip_category: 'general' } })

    await startDripForLead(LEAD_ID, LOC_UUID)

    expect(h.tablesTouched()).not.toContain('drip_paths')
    expect(h.progressInsert()).toBeUndefined()
  })
})
