// @vitest-environment node
//
// Network Phase 1 — the touchpoint writer grows a partner subject
// (lead XOR partner). THE pin this file exists for: the LEAD path is
// byte-identical to the pre-partner contract — same keys, same values, no
// partner_id key AT ALL (not even null) — so every existing lead-touchpoint
// write works unchanged before AND after migrations/network_phase1.sql.
//
// Pins:
//   A) lead insert payload: exact key set, no partner_id; reach_out bumps
//      leads.updated_at (the pre-existing side-effect, 1:1)
//   B) partner insert payload: partner_id present, NO lead_id key;
//      reach_out stamps partners.last_contacted_at (occurred_at when
//      backdated, now-ish otherwise) + updated_at
//   C) XOR: neither subject / both subjects → { ok:false }, and NO insert
//      is ever attempted
//   D) non-reach_out kinds run no side-effect for either subject
//   E) logCallTouchpoint (the Slack quick action) is untouched: lead-level
//      reach_out/call/'Reach-out'
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Recording supabaseService mock — chainable builder, call log per table.
const h = vi.hoisted(() => {
  type Call = { table: string; ops: [string, any[]][] }
  const state = { calls: [] as Call[], insertResp: { data: { id: 'tp-1' }, error: null as any } }
  const reset = () => { state.calls = []; state.insertResp = { data: { id: 'tp-1' }, error: null } }
  const makeBuilder = (table: string) => {
    const call: Call = { table, ops: [] }
    state.calls.push(call)
    const b: any = {}
    for (const m of ['select', 'insert', 'update', 'eq']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.single = () => { call.ops.push(['single', []]); return Promise.resolve(state.insertResp) }
    b.then = (res: any, rej: any) => Promise.resolve({ data: null, error: null }).then(res, rej)
    return b
  }
  return { state, reset, makeBuilder }
})

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.makeBuilder(t) } }))

import { insertTouchpoint, logCallTouchpoint } from '@/lib/touchpoints'

const opArg = (call: any, op: string) => call.ops.find((o: any[]) => o[0] === op)?.[1]?.[0]
const calls = (table: string) => h.state.calls.filter(c => c.table === table)

beforeEach(() => h.reset())

describe('A) lead path — byte-identical to the pre-partner contract', () => {
  it('insert payload carries the exact legacy key set and NO partner_id key', async () => {
    const res = await insertTouchpoint({
      lead_id: 'lead-1', location_uuid: 'loc-1', kind: 'reach_out',
      method: 'call', label: '  Reach-out  ', user_id: 'u1',
    })
    expect(res.ok).toBe(true)
    const insert = opArg(calls('touchpoints')[0], 'insert')
    expect(insert).toEqual({
      lead_id: 'lead-1', location_uuid: 'loc-1', kind: 'reach_out',
      label: 'Reach-out', method: 'call', status: null, drip_id: null,
      notes: null, user_id: 'u1',
    })
    // The load-bearing absence: pre-migration the column doesn't exist, so
    // even a null partner_id key would 500 every lead write.
    expect(Object.keys(insert)).not.toContain('partner_id')
  })

  it('engagement_id / occurred_at still ride only when present (conditional spread)', async () => {
    await insertTouchpoint({
      lead_id: 'lead-1', location_uuid: 'loc-1', kind: 'note', label: 'x',
      engagement_id: 'eng-1', occurred_at: '2026-07-01T00:00:00.000Z',
    })
    const insert = opArg(calls('touchpoints')[0], 'insert')
    expect(insert.engagement_id).toBe('eng-1')
    expect(insert.occurred_at).toBe('2026-07-01T00:00:00.000Z')
  })

  it('reach_out bumps leads.updated_at (and never touches partners)', async () => {
    await insertTouchpoint({ lead_id: 'lead-1', location_uuid: 'loc-1', kind: 'reach_out', label: 'x' })
    const leadUpdate = calls('leads')[0]
    expect(leadUpdate).toBeTruthy()
    expect(opArg(leadUpdate, 'update')).toHaveProperty('updated_at')
    expect(opArg(leadUpdate, 'eq' as any)).toBe('id')
    expect(calls('partners')).toHaveLength(0)
  })
})

describe('B) partner path', () => {
  it('insert payload carries partner_id and NO lead_id key', async () => {
    const res = await insertTouchpoint({
      partner_id: 'partner-1', location_uuid: 'loc-1', kind: 'reach_out',
      method: 'coffee', label: 'Coffee with Karen', user_id: 'u1',
    })
    expect(res.ok).toBe(true)
    const insert = opArg(calls('touchpoints')[0], 'insert')
    expect(insert.partner_id).toBe('partner-1')
    expect(Object.keys(insert)).not.toContain('lead_id')
    expect(insert.method).toBe('coffee')
  })

  it('reach_out stamps partners.last_contacted_at with the backdated occurred_at', async () => {
    await insertTouchpoint({
      partner_id: 'partner-1', location_uuid: 'loc-1', kind: 'reach_out',
      label: 'x', occurred_at: '2026-06-15T12:00:00.000Z',
    })
    const partnerUpdate = calls('partners')[0]
    expect(partnerUpdate).toBeTruthy()
    const patch = opArg(partnerUpdate, 'update')
    expect(patch.last_contacted_at).toBe('2026-06-15T12:00:00.000Z')
    expect(patch).toHaveProperty('updated_at')
    expect(calls('leads')).toHaveLength(0)
  })

  it('reach_out without occurred_at stamps last_contacted_at ≈ now', async () => {
    const before = Date.now()
    await insertTouchpoint({ partner_id: 'partner-1', location_uuid: 'loc-1', kind: 'reach_out', label: 'x' })
    const patch = opArg(calls('partners')[0], 'update')
    const stamped = new Date(patch.last_contacted_at).getTime()
    expect(stamped).toBeGreaterThanOrEqual(before)
    expect(stamped).toBeLessThanOrEqual(Date.now())
  })
})

describe('C) XOR — exactly one subject, enforced before any insert', () => {
  it('neither subject → ok:false, zero DB calls', async () => {
    const res = await insertTouchpoint({ location_uuid: 'loc-1', kind: 'note', label: 'x' } as any)
    expect(res).toEqual({ ok: false, error: 'exactly_one_subject_required' })
    expect(h.state.calls).toHaveLength(0)
  })
  it('both subjects → ok:false, zero DB calls', async () => {
    const res = await insertTouchpoint({
      lead_id: 'lead-1', partner_id: 'partner-1', location_uuid: 'loc-1', kind: 'note', label: 'x',
    })
    expect(res).toEqual({ ok: false, error: 'exactly_one_subject_required' })
    expect(h.state.calls).toHaveLength(0)
  })
})

describe('D) non-reach_out kinds run no side-effect', () => {
  it.each(['drip', 'system', 'stage_change', 'note'])('%s (lead + partner)', async (kind) => {
    await insertTouchpoint({ lead_id: 'lead-1', location_uuid: 'loc-1', kind, label: 'x' })
    await insertTouchpoint({ partner_id: 'partner-1', location_uuid: 'loc-1', kind, label: 'x' })
    expect(calls('leads')).toHaveLength(0)
    expect(calls('partners')).toHaveLength(0)
  })
})

describe('E) logCallTouchpoint (Slack quick action) unchanged', () => {
  it('lead-level reach_out/call/Reach-out', async () => {
    const res = await logCallTouchpoint({ leadId: 'lead-9', locationUuid: 'loc-1', userId: 'u1' })
    expect(res.ok).toBe(true)
    const insert = opArg(calls('touchpoints')[0], 'insert')
    expect(insert.lead_id).toBe('lead-9')
    expect(insert.kind).toBe('reach_out')
    expect(insert.method).toBe('call')
    expect(insert.label).toBe('Reach-out')
    expect(Object.keys(insert)).not.toContain('partner_id')
  })
})

describe('DB error stays fail-soft', () => {
  it('insert error → { ok:false, error }, no side-effect runs', async () => {
    h.state.insertResp = { data: null, error: { message: 'column "partner_id" does not exist' } }
    const res = await insertTouchpoint({ partner_id: 'p1', location_uuid: 'loc-1', kind: 'reach_out', label: 'x' })
    expect(res).toEqual({ ok: false, error: 'column "partner_id" does not exist' })
    expect(calls('partners')).toHaveLength(0) // no last_contacted_at stamp on a failed insert
  })
})
