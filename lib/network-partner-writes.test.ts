// @vitest-environment node
//
// lib/partner-writes — the partner update path (Network Phase 1 bug fix).
// Replaces App's fire-and-forget whole-object PATCH, whose two failure
// modes are the pins here:
//   · whole-object PATCH → concurrent editors clobbered each other's
//     untouched fields — now only the DIFF travels
//   · .catch(console.error) → a 4xx/5xx resolved "fine", so a failed save
//     sat on screen LOOKING saved — now it reverts + toasts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { computePartnerPatch, makeUpdatePartner } from '@/lib/partner-writes'

const UUID = '11111111-2222-4333-8444-555555555555'
const BASE = {
  id: UUID, name: 'Karen Martinez', title: 'Agent', stage: 'Building',
  tags: ['vip'], notes: [{ id: 'n1', text: 'hi' }],
}

describe('computePartnerPatch — minimal diff', () => {
  it('only changed fields travel', () => {
    expect(computePartnerPatch(BASE, { ...BASE, stage: 'Active Partner' }))
      .toEqual({ stage: 'Active Partner' })
  })
  it('deep-compares arrays/jsonb (no false positives, real changes caught)', () => {
    expect(computePartnerPatch(BASE, { ...BASE, tags: ['vip'] })).toEqual({})
    expect(computePartnerPatch(BASE, { ...BASE, notes: [{ id: 'n1', text: 'edited' }] }))
      .toEqual({ notes: [{ id: 'n1', text: 'edited' }] })
  })
  it('unknown/client-only keys never travel; restore rides through', () => {
    expect(computePartnerPatch(BASE, { ...BASE, isDeleted: true, locationId: 'x' })).toEqual({})
    expect(computePartnerPatch(BASE, { ...BASE, restore: true })).toEqual({ restore: true })
  })
})

describe('makeUpdatePartner', () => {
  let applied: any[]
  let toasts: any[]
  let fetchImpl: any
  const deps = () => ({
    getPartners: () => [BASE],
    applyRow: (row: any) => applied.push(row),
    setToast: (t: any) => toasts.push(t),
    fetchImpl,
  })

  beforeEach(() => { applied = []; toasts = [] })

  it('success: optimistic apply → PATCH of the diff only → reconcile with the server row', async () => {
    const serverRow = { ...BASE, stage: 'Active Partner', updated_at: 'server' }
    fetchImpl = vi.fn(async () => ({ ok: true, json: async () => serverRow }))
    const update = makeUpdatePartner(deps())
    const res = await update({ ...BASE, stage: 'Active Partner' })

    expect(res.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(`/api/partners/${UUID}`)
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ stage: 'Active Partner' }) // diff ONLY — no clobber
    expect(applied[0].stage).toBe('Active Partner') // optimistic
    expect(applied[1]).toEqual(serverRow)           // server reconcile
    expect(toasts).toHaveLength(0)
  })

  it('HTTP failure: reverts to the pre-edit row and toasts — never sits looking saved', async () => {
    fetchImpl = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }))
    const update = makeUpdatePartner(deps())
    const res = await update({ ...BASE, name: 'Renamed' })

    expect(res).toEqual({ ok: false, error: 'boom' })
    expect(applied[0].name).toBe('Renamed') // optimistic first (instant UI)
    expect(applied[1]).toEqual(BASE)        // then the revert
    expect(toasts).toHaveLength(1)
    expect(toasts[0].kind).toBe('error')
    expect(toasts[0].msg).toContain('boom')
  })

  it('network death: same revert + toast (the old .catch swallowed this too)', async () => {
    fetchImpl = vi.fn(async () => { throw new Error('offline') })
    const update = makeUpdatePartner(deps())
    const res = await update({ ...BASE, name: 'Renamed' })
    expect(res.ok).toBe(false)
    expect(applied[1]).toEqual(BASE)
    expect(toasts[0].msg).toContain('offline')
  })

  it('no-op diff skips the network entirely', async () => {
    fetchImpl = vi.fn()
    const update = makeUpdatePartner(deps())
    const res = await update({ ...BASE })
    expect(res).toEqual({ ok: true, saved: { ...BASE }, noop: true })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('local-only rows (non-uuid id) stay state-only — nothing to PATCH', async () => {
    fetchImpl = vi.fn()
    const update = makeUpdatePartner({ ...deps(), getPartners: () => [{ ...BASE, id: 'local-1' }] })
    const res = await update({ ...BASE, id: 'local-1', name: 'Local Edit' })
    expect(res.ok).toBe(true)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(applied).toHaveLength(1) // optimistic apply only
  })
})
