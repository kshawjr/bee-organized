// @vitest-environment node
// lib/zip-routing — the rule, pure. Every non-match is loc_other; exactly one
// active location is the only way a zip picks a franchise.
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: () => { throw new Error('no DB in pure tests') } } }))

import {
  decideZipRoute,
  normalizeZip,
  zipRouteToken,
  ZIP_FALLBACK_SLUG,
  ROUTE_ONLY_TO_ACTIVE,
  zipDecides,
  routeLogToken,
} from '@/lib/zip-routing'

const row = (location_id: string, lifecycle_status: string | null = 'active') => ({ location_id, lifecycle_status })

describe('normalizeZip', () => {
  it.each([
    ['19373', '19373'],
    [' 19373 ', '19373'],
    ['19373-1234', '19373'],
    ['193731234', '19373'],
    [19373, '19373'],
    ['02801', '02801'],
  ])('%j → %j', (raw, want) => expect(normalizeZip(raw)).toBe(want))

  it.each([['1937'], [2801], ['19373*'], ['abcde'], ['193733'], [''], [null], [undefined], [{}]])(
    '%j → null (never re-padded or guessed)',
    (raw) => expect(normalizeZip(raw)).toBeNull(),
  )
})

describe('decideZipRoute', () => {
  it('exactly one active location → that location', () => {
    expect(decideZipRoute('19373', [row('loc_phillysuburbs')])).toEqual({
      slug: 'loc_phillysuburbs', reason: 'matched', zip: '19373', candidates: ['loc_phillysuburbs'],
    })
  })

  it('two locations claim it → loc_other, no winner picked, both named', () => {
    const d = decideZipRoute('80126', [row('loc_westdenver'), row('loc_denver')])
    expect(d).toEqual({ slug: ZIP_FALLBACK_SLUG, reason: 'conflict', zip: '80126', candidates: ['loc_denver', 'loc_westdenver'] })
  })

  it('no row → loc_other (unmatched)', () => {
    expect(decideZipRoute('99999', [])).toMatchObject({ slug: ZIP_FALLBACK_SLUG, reason: 'unmatched', zip: '99999' })
  })

  it.each([[undefined], [null], [''], ['   ']])('missing %j → loc_other (missing)', (z) => {
    expect(decideZipRoute(z, [row('loc_x')])).toMatchObject({ slug: ZIP_FALLBACK_SLUG, reason: 'missing' })
  })

  it('malformed → loc_other even if rows were passed', () => {
    expect(decideZipRoute('1937', [row('loc_x')])).toMatchObject({ slug: ZIP_FALLBACK_SLUG, reason: 'malformed' })
  })

  it('the only claimant is not live → loc_other with it as the candidate (switch is on)', () => {
    expect(ROUTE_ONLY_TO_ACTIVE).toBe(true)
    for (const status of ['onboarding', 'paused', null]) {
      expect(decideZipRoute('89506', [row('loc_reno', status)])).toEqual({
        slug: ZIP_FALLBACK_SLUG, reason: 'not_live', zip: '89506', candidates: ['loc_reno'],
      })
    }
  })

  it('a row pointing at loc_other is never a target', () => {
    expect(decideZipRoute('12345', [row('loc_other')])).toMatchObject({ reason: 'unmatched', slug: ZIP_FALLBACK_SLUG })
  })

  it('duplicate rows for the SAME location are one claimant, not a conflict', () => {
    expect(decideZipRoute('33404', [row('loc_palmbeach'), row('loc_palmbeach')])).toMatchObject({ reason: 'matched', slug: 'loc_palmbeach' })
  })
})

describe('zipRouteToken', () => {
  it('names the reason, and candidates only when a person has to choose', () => {
    expect(zipRouteToken(decideZipRoute('19373', [row('loc_a')]))).toBe(' routed_by=zip zip_route=matched')
    expect(zipRouteToken(decideZipRoute('80203', [row('loc_b'), row('loc_a')]))).toBe(' routed_by=zip zip_route=conflict zip_candidates=loc_a,loc_b')
  })
})

// ── THE ZIP WINS (30 Sep 2026) ───────────────────────────────────
describe('zipDecides — the zip decides whenever there is one', () => {
  it.each([
    ['19373', 'loc_portland', true],   // a zip beats a sent location
    ['9720', 'loc_portland', true],    // even a malformed one (→ loc_other)
    ['19373', null, true],
    [undefined, null, true],           // nothing at all → zip path → loc_other 'missing'
    [undefined, 'loc_portland', false], // NO zip → the sent location decides
    ['   ', 'loc_portland', false],
    [null, 'loc_portland', false],
  ])('zip %s, sent %s → zip decides: %s', (zip, sent, expected) => {
    expect(zipDecides(zip, sent as string | null)).toBe(expected)
  })
})

describe('routeLogToken — both locations on every row', () => {
  it('flags a disagreement', () => {
    const d = decideZipRoute('78746', [{ location_id: 'loc_swaustin', lifecycle_status: 'active' }])
    expect(routeLogToken(d, 'loc_centralaustin')).toBe(
      ' routed_by=zip zip_route=matched zip_loc=loc_swaustin sent_loc=loc_centralaustin sent_overridden=true',
    )
  })
  it('no flag when they agree, none when nothing was sent', () => {
    const d = decideZipRoute('78746', [{ location_id: 'loc_swaustin', lifecycle_status: 'active' }])
    expect(routeLogToken(d, 'loc_swaustin')).not.toContain('sent_overridden')
    expect(routeLogToken(d, null)).toContain('sent_loc=none')
    expect(routeLogToken(d, null)).not.toContain('sent_overridden')
  })
  it('a no-zip lead says the sent location decided', () => {
    expect(routeLogToken(null, 'loc_portland')).toBe(' routed_by=sent_no_zip sent_loc=loc_portland')
  })
})
