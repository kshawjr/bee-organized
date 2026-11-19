// lib/network/bulk.ts — the rules for one bulk action (slice 6). What this pins:
//   · no bulk action without confirmed: true (asked once, for the whole lot)
//   · level and stage go on Referral partners only; anyone else is skipped
//     and named, never changed
//   · only contacts that really change are planned; nothing stored reads as
//     Potential / New Contact
//   · every contact must be live and at the location named, or nothing at all
//   · tags: only this location's Network tags; add skips who has it, remove
//     skips who does not
import { describe, it, expect } from 'vitest'
import { checkBulkRequest, planBulk, BULK_MAX, type BulkRow } from './bulk'

const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const TAG = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const row = (n: number, o: Partial<BulkRow> = {}): BulkRow => ({ id: id(n), name: `P${n}`, location_id: LOC, deleted_at: null, network_types: ['partner'], partner_level: 'referral', partner_stage: 'New Contact', ...o })
const req = (over: any = {}) => ({ location_id: LOC, ids: [id(1)], action: 'stage', value: 'Reaching Out', confirmed: true, ...over })

describe('the request', () => {
  it('is refused without the one confirmation, whatever else it says', () => {
    for (const confirmed of [undefined, false, 'yes', 1, null]) {
      expect(checkBulkRequest(req({ confirmed }))).toEqual({ ok: false, status: 428, error: 'needs_confirmation' })
    }
    expect(checkBulkRequest(req())).toMatchObject({ ok: true })
  })
  it('names a known action, a known value, and between 1 and the most at once', () => {
    expect(checkBulkRequest(req({ action: 'drip' }))).toMatchObject({ ok: false, error: 'action_unknown' })
    expect(checkBulkRequest(req({ action: 'mailchimp' }))).toMatchObject({ ok: false, error: 'action_unknown' })
    expect(checkBulkRequest(req({ action: 'follow_up' }))).toMatchObject({ ok: false, error: 'action_unknown' })
    expect(checkBulkRequest(req({ value: 'Somewhere' }))).toMatchObject({ ok: false, error: 'stage_unknown' })
    expect(checkBulkRequest(req({ action: 'level', value: 'gold' }))).toMatchObject({ ok: false, error: 'level_unknown' })
    expect(checkBulkRequest(req({ ids: [] }))).toMatchObject({ ok: false, error: 'pick_someone_first' })
    expect(checkBulkRequest(req({ ids: Array.from({ length: BULK_MAX + 1 }, (_, i) => id(i)) }))).toMatchObject({ ok: false, error: 'too_many_at_once' })
    expect(checkBulkRequest(req({ ids: ['x'] }))).toMatchObject({ ok: false, error: 'contact_not_found' })
  })
  it('a repeated id counts once', () => {
    const r = checkBulkRequest(req({ ids: [id(1), id(1), id(2)] }))
    expect(r.ok && r.ids).toEqual([id(1), id(2)])
  })
})

describe('level and stage', () => {
  it('twenty picked: one plan, the partners that change, the rest counted or named', () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(i + 1))
    rows[3] = row(4, { partner_stage: 'Reaching Out' }) // already there
    rows[7] = row(8, { network_types: ['vendor'], partner_level: null, partner_stage: null }) // not a partner
    rows[9] = row(10, { network_types: null }) // no type stored: Not sure yet
    const p = planBulk({ ids: rows.map((r) => r.id), action: 'stage', value: 'Reaching Out' }, { locationId: LOC, rows })
    if (!p.ok) throw new Error(p.error)
    expect(p.update).toEqual({ column: 'partner_stage', value: 'Reaching Out' })
    expect(p.changeIds).toHaveLength(17)
    expect(p.unchanged).toBe(1)
    expect(p.skipped).toEqual([{ id: id(8), name: 'P8', reason: 'not_a_referral_partner' }, { id: id(10), name: 'P10', reason: 'not_a_referral_partner' }])
  })
  it('nothing stored reads as Potential / New Contact, so setting that writes nothing', () => {
    const rows = [row(1, { partner_level: null, partner_stage: null })]
    const s = planBulk({ ids: [id(1)], action: 'stage', value: 'New Contact' }, { locationId: LOC, rows })
    const l = planBulk({ ids: [id(1)], action: 'level', value: 'potential' }, { locationId: LOC, rows })
    expect(s.ok && s.changeIds).toEqual([])
    expect(l.ok && l.changeIds).toEqual([])
  })
  it('one contact at another location, or gone, stops the whole action', () => {
    const rows = [row(1), row(2, { location_id: OTHER })]
    expect(planBulk({ ids: [id(1), id(2)], action: 'stage', value: 'Reaching Out' }, { locationId: LOC, rows })).toEqual({ ok: false, status: 422, error: 'not_all_at_this_location' })
    expect(planBulk({ ids: [id(1), id(3)], action: 'stage', value: 'Reaching Out' }, { locationId: LOC, rows })).toEqual({ ok: false, status: 404, error: 'contact_not_found' })
    expect(planBulk({ ids: [id(1)], action: 'stage', value: 'Reaching Out' }, { locationId: LOC, rows: [row(1, { deleted_at: '2026-11-01' })] })).toEqual({ ok: false, status: 404, error: 'contact_not_found' })
  })
})

describe('tags', () => {
  const rows = [row(1, { network_types: ['vendor'] }), row(2), row(3, { network_types: null })]
  const links = [{ partner_id: id(2), tag_lookup_id: TAG }]
  it('add: everyone who does not have it, any type', () => {
    const p = planBulk({ ids: rows.map((r) => r.id), action: 'tag_add', value: TAG }, { locationId: LOC, rows, links, allowedTagIds: [TAG] })
    expect(p).toMatchObject({ ok: true, changeIds: [id(1), id(3)], unchanged: 1, tagId: TAG, skipped: [] })
  })
  it('remove: only who has it', () => {
    const p = planBulk({ ids: rows.map((r) => r.id), action: 'tag_remove', value: TAG }, { locationId: LOC, rows, links, allowedTagIds: [TAG] })
    expect(p).toMatchObject({ ok: true, changeIds: [id(2)], unchanged: 2 })
  })
  it('a tag that is not on this location’s Network list is refused', () => {
    expect(planBulk({ ids: [id(1)], action: 'tag_add', value: TAG }, { locationId: LOC, rows, links, allowedTagIds: [] })).toEqual({ ok: false, status: 422, error: 'tag_not_on_network_here' })
  })
})
