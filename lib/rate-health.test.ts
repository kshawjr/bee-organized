// @vitest-environment node
//
// Blank-rate digest visibility — fetchRateHealth (which active locations
// are on rate-quoting default paths with no rate) and the webhook-digest
// section it feeds. The condition is a STANDING problem: it un-suppresses
// quiet windows and stays in the headline until the rate is entered —
// silent-empty is the failure class this exists to retire.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const state = { rows: [] as any[], error: null as any }
  const builder = () => {
    const b: any = {}
    for (const m of ['select', 'eq', 'is', 'order', 'limit']) {
      b[m] = () => b
    }
    b.then = (res: any, rej: any) => Promise.resolve({ data: state.rows, error: state.error }).then(res, rej)
    return b
  }
  return { state, builder }
})

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: () => h.builder() },
}))

import { fetchRateHealth, isRateQuotingPathKey } from '@/lib/rate-health'
import { buildRateHealthSection, buildWebhookDigest } from '@/lib/webhook-digest'

beforeEach(() => { h.state.rows = []; h.state.error = null })

describe('isRateQuotingPathKey', () => {
  it('-a and -b quote the rate; -c and -d do not', () => {
    expect(isRateQuotingPathKey('organizing-a')).toBe(true)
    expect(isRateQuotingPathKey('organizing-b')).toBe(true)
    expect(isRateQuotingPathKey('moving-a')).toBe(true)
    expect(isRateQuotingPathKey('moving-b')).toBe(true)
    expect(isRateQuotingPathKey('organizing-c')).toBe(false)
    expect(isRateQuotingPathKey('moving-d')).toBe(false)
    expect(isRateQuotingPathKey(null)).toBe(false)
    expect(isRateQuotingPathKey(undefined)).toBe(false)
  })
})

describe('fetchRateHealth', () => {
  it('flags active locations on -a/-b defaults with a blank rate; rate set or C/D-only pass clean', () => {
    h.state.rows = [
      // Actively broken: rate-quoting default, no rate.
      { location_id: 'loc_seattle', name: 'Seattle', default_drip_path: 'organizing-b', default_move_drip_path: 'moving-b', rate_per_hour: null },
      // Rate set → healthy even on a rate-quoting path.
      { location_id: 'loc_kc', name: 'Kansas City', default_drip_path: 'organizing-a', default_move_drip_path: 'moving-c', rate_per_hour: '$95' },
      // C/D only → the blank rate is dormant, not a hold.
      { location_id: 'loc_portland', name: 'Portland', default_drip_path: 'organizing-d', default_move_drip_path: 'moving-d', rate_per_hour: null },
      // Whitespace counts as blank.
      { location_id: 'loc_test', name: 'Test Location', default_drip_path: 'organizing-c', default_move_drip_path: 'moving-a', rate_per_hour: '   ' },
    ]
    return fetchRateHealth().then(({ missingRate }) => {
      expect(missingRate.map(r => r.location_id)).toEqual(['loc_seattle', 'loc_test'])
      expect(missingRate[0].paths).toEqual(['organizing-b', 'moving-b'])
      expect(missingRate[1].paths).toEqual(['moving-a'])
    })
  })

  it('never throws — a read error degrades to an empty rollup', async () => {
    h.state.rows = null as any
    h.state.error = { message: 'boom' }
    await expect(fetchRateHealth()).resolves.toEqual({ missingRate: [] })
  })
})

describe('digest — blank-rate section', () => {
  it('healthy (no rows) → no lines, no problem flag', () => {
    expect(buildRateHealthSection({ missingRate: [] })).toEqual({ lines: [], missingCount: 0, hasProblems: false })
    expect(buildRateHealthSection(undefined).hasProblems).toBe(false)
  })

  it('a blank-rate location UN-SUPPRESSES a quiet window and drives the headline', () => {
    const digest = buildWebhookDigest({
      events: [],
      appUrl: 'https://app.test',
      rateHealth: { missingRate: [{ location_id: 'loc_seattle', name: 'Seattle', paths: ['organizing-b', 'moving-b'] }] },
    })
    expect(digest.suppressed).toBe(false)
    expect(digest.allClear).toBe(false)
    expect(digest.rateMissing).toBe(1)
    expect(digest.headline).toContain('1 location on rate-quoting paths with NO RATE (sends held)')
    expect(digest.text).toContain('Hourly rate missing')
    expect(digest.text).toContain('Seattle — organizing-b, moving-b')
  })

  it('healthy rate input leaves a quiet window suppressed and an active window all-clear', () => {
    const quiet = buildWebhookDigest({ events: [], appUrl: 'https://app.test', rateHealth: { missingRate: [] } })
    expect(quiet.suppressed).toBe(true)
    expect(quiet.rateMissing).toBe(0)
    expect(quiet.text).not.toContain('Hourly rate missing')
  })
})
