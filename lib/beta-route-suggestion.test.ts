// @vitest-environment node
//
// lib/route-suggestion.ts — what the Slack card for a lead in Other says
// (stage 3 of the route suggestion). Kevin's decided design, pinned:
//   • the three closest hives, each a button with its miles
//   • "Leave in Other" on every card
//   • "Not in our service area" only when the nearest is MORE than 75 miles
//   • two closest within a few (5) miles → highlight neither; never auto-pick
//   • a claimed zip is certain: the claimant, no distance
// The four real places run on the real territory snapshot
// (lib/fixtures/zip-proximity-snapshot.json); the edges on small made-up maps.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const h = vi.hoisted(() => ({
  lead: null as any,
  leadError: null as any,
  proximityCalls: [] as any[],
}))
vi.mock('@/lib/supabase-service', () => ({
  supabaseService: {
    from: () => {
      const b: any = {}
      b.select = () => b
      b.eq = () => b
      b.in = () => b
      b.maybeSingle = async () => ({ data: h.lead, error: h.leadError })
      b.then = (res: any, rej: any) => Promise.resolve({ data: h.lead ? [h.lead] : [], error: h.leadError }).then(res, rej)
      return b
    },
  },
}))
// The map: both surfaces read suggestRoutesForLeads, which reads the map in one
// batch (nearestLocationsForZips). The real ranking runs over the snapshot.
vi.mock('@/lib/zip-proximity', async (orig) => {
  const real: any = await orig()
  return {
    ...real,
    nearestLocationsForZips: vi.fn(async (items: any[], limit: number) => {
      h.proximityCalls.push({ items, limit })
      return items.map((it) => real.rankNearestLocations({ zip: it.zip, leadState: it.state, coords: SNAP_COORDS(), claims: SNAP_CLAIMS(), limit }))
    }),
  }
})

import {
  buildRouteSuggestion,
  suggestRouteForLead,
  OUT_OF_AREA_MILES,
  NEAR_TIE_MILES,
  SUGGESTION_COUNT,
  type RouteSuggestion,
} from '@/lib/route-suggestion'
import { rankNearestLocations, type ClaimedZip, type ZipPoint } from '@/lib/zip-proximity'

const snap = JSON.parse(readFileSync(join(process.cwd(), 'lib/fixtures/zip-proximity-snapshot.json'), 'utf8'))
function SNAP_CLAIMS(): ClaimedZip[] { return snap.claims }
function SNAP_COORDS(): Map<string, ZipPoint> {
  return new Map(Object.entries(snap.coords as Record<string, [number, number, string | null, string[]]>)
    .map(([zip, [lat, lng, state, states]]) => [zip, { lat, lng, state, states }]))
}
const COORDS = SNAP_COORDS()
const slugOf = (name: string) => SNAP_CLAIMS().find((c) => c.name === name)!.slug

const suggest = (zip: unknown, state: unknown = null, claims: ClaimedZip[] = SNAP_CLAIMS(), coords = COORDS): RouteSuggestion =>
  buildRouteSuggestion(
    { id: 'lead-1', zip: zip as any, state: state as any },
    rankNearestLocations({ zip, leadState: state, coords, claims, limit: 60 }),
  )
const labels = (s: RouteSuggestion) => s.options.map((o) => o.label)

// Every card, whatever it says, keeps these promises.
const invariants = (s: RouteSuggestion) => {
  expect(s.showLeaveInOther).toBe(true)
  expect(s.options.filter((o) => o.highlighted).length).toBeLessThanOrEqual(1)
  expect(s.options.length).toBeLessThanOrEqual(SUGGESTION_COUNT)
  if (s.highlight) expect(s.options.find((o) => o.highlighted)!.slug).toBe(s.highlight)
  else expect(s.options.some((o) => o.highlighted)).toBe(false)
}

describe('the design constants are the decided ones', () => {
  it('three options, 75 miles, 5 miles', () => {
    expect([SUGGESTION_COUNT, OUT_OF_AREA_MILES, NEAR_TIE_MILES]).toEqual([3, 75, 5])
  })
})

// ═══ Kevin's four real places ══════════════════════════════════
describe('the four real places', () => {
  it('Beatrice NE 68310 — Lincoln is clearly closest: highlighted, in area', () => {
    const s = suggest('68310', 'NE')
    invariants(s)
    expect(s.kind).toBe('nearby')
    expect(labels(s)).toEqual(['Lincoln · 19 mi', 'Omaha · 60 mi', 'Kansas City · 131 mi'])
    expect(s.highlight).toBe(slugOf('Lincoln'))
    expect(s.showNotInServiceArea).toBe(false)
    expect(s.stateWarning).toBeNull()
  })

  it('Riverside CA 92503 — South Orange County and Temecula are 0.6 mi apart: highlight neither', () => {
    const s = suggest('92503', 'CA')
    invariants(s)
    expect(labels(s)).toEqual(['South Orange County · 17 mi', 'Temecula · 18 mi', 'San Diego · 33 mi'])
    expect(s.highlight).toBeNull()
    expect(s.noHighlightReason).toBe('near_tie')
    expect(s.showNotInServiceArea).toBe(false)
  })

  it('Schaumburg IL 60173 — nearest is 163 mi: "Not in our service area" shows, nothing highlighted', () => {
    const s = suggest('60173', 'IL')
    invariants(s)
    expect(labels(s)).toEqual(['Carmel · 163 mi', 'West St Louis · 268 mi', 'Omaha · 367 mi'])
    expect(s.showNotInServiceArea).toBe(true)
    expect(s.highlight).toBeNull()
    expect(s.noHighlightReason).toBe('too_far')
  })

  it('Estero FL 33928 — Miami 48, Sarasota 70: Miami highlighted, in area', () => {
    const s = suggest('33928', 'FL')
    invariants(s)
    expect(labels(s)).toEqual(['Miami · 48 mi', 'Sarasota · 70 mi', 'Fort Lauderdale · 82 mi'])
    expect(s.highlight).toBe(slugOf('Miami'))
    expect(s.showNotInServiceArea).toBe(false)
  })
})

// ═══ claimed zips: certain, no distance ════════════════════════
describe('a claimed zip is certain, not a guess', () => {
  it('89509 is on Reno\'s list → Reno only, no miles, highlighted', () => {
    const s = suggest('89509', 'NV')
    invariants(s)
    expect(s.kind).toBe('claimed')
    expect(s.options).toEqual([{ slug: 'loc_reno', name: 'Reno', lifecycle_status: 'onboarding', miles: null, label: 'Reno', highlighted: true }])
    expect(s.highlight).toBe('loc_reno')
    expect(s.showNotInServiceArea).toBe(false)
  })

  it('a claimed PO-box zip the Census lacks (02901) is still certain', () => {
    const s = suggest('02901', 'RI')
    expect(s.kind).toBe('claimed')
    expect(labels(s)).toEqual(['Rhode Island'])
    expect(s.highlight).toBe(slugOf('Rhode Island'))
  })

  it('a zip claimed by TWO → both shown, neither highlighted (a conflict corporate hasn\'t settled)', () => {
    const claims: ClaimedZip[] = [
      { zip: '80126', slug: 'loc_westdenver', name: 'West Denver', lifecycle_status: 'active' },
      { zip: '80126', slug: 'loc_denver', name: 'Denver', lifecycle_status: 'onboarding' },
    ]
    const coords = new Map<string, ZipPoint>([['80126', { lat: 39.5, lng: -105, state: 'CO', states: ['CO'] }]])
    const s = suggest('80126', 'CO', claims, coords)
    invariants(s)
    expect(s.kind).toBe('claimed')
    expect(labels(s)).toEqual(['Denver', 'West Denver'])
    expect(s.options.every((o) => o.miles === null)).toBe(true)
    expect(s.highlight).toBeNull()
    expect(s.noHighlightReason).toBe('conflict')
  })

  it('a claimed zip whose state disagrees still warns', () => {
    expect(suggest('89509', 'CA').stateWarning).toEqual({ leadState: 'CA', zip: '89509' })
  })
})

// ═══ no distance possible ═══════════════════════════════════════
// Kevin, 20 Oct 2026: "Not in our service area" sends an email telling the
// customer we don't serve them. A lead we can't place may be two miles from a
// hive, so the button appears ONLY after a measured distance past 75 miles.
describe('a lead with no usable zip NEVER gets "Not in our service area"', () => {
  it('no zip at all → the button is absent', () => {
    const s = suggest(null, 'NE')
    expect(s.kind).toBe('no_zip')
    expect(s.showNotInServiceArea).toBe(false)
    expect(s.options).toEqual([])
    expect(s.showLeaveInOther).toBe(true)
  })

  it('the same holds through the live call for a no-zip lead in Other', async () => {
    h.lead = { id: 'lead-nz', zip: null, state: 'NE', location_id: 'loc_other' }
    const s = await suggestRouteForLead('lead-nz')
    expect(s.kind).toBe('no_zip')
    expect(s.showNotInServiceArea).toBe(false)
  })

  it.each([['K1A 0B1'], ['9250'], ['11111']])('zip %j (unusable) → the button is absent', (zip) => {
    expect(suggest(zip).showNotInServiceArea).toBe(false)
  })

  it('the button only ever shows with a measured nearest distance over 75 miles', () => {
    const zips = ['68310', '92503', '60173', '33928', '89509', '02901', '11111', null, '', 'K1A 0B1']
    for (const z of zips) {
      const s = suggest(z)
      const measuredOver75 = s.kind === 'nearby' && s.options.length > 0 && s.options[0].miles! > OUT_OF_AREA_MILES
      expect(s.showNotInServiceArea).toBe(measuredOver75)
    }
  })
})

describe('when there is nothing to measure', () => {
  it.each([
    [null, 'no_zip'],
    ['', 'no_zip'],
    ['K1A 0B1', 'unreadable_zip'],   // a Canadian postcode
    ['9250', 'unreadable_zip'],
    ['11111', 'unknown_zip'],        // five digits the Census doesn't carry
  ])('zip %j → %s: no options, no out-of-area button, Leave in Other only', (zip, kind) => {
    const s = suggest(zip)
    invariants(s)
    expect(s.kind).toBe(kind)
    expect(s.options).toEqual([])
    expect(s.highlight).toBeNull()
    expect(s.showNotInServiceArea).toBe(false)
  })
})

// ═══ the edges ═════════════════════════════════════════════════
// A straight line north from (0,0): `mi` miles is mi/69.0933 degrees.
const DEG_PER_MILE = 1 / 69.09332
const line = (milesByName: Record<string, number>, status: Record<string, string> = {}) => {
  const coords = new Map<string, ZipPoint>([['00000', { lat: 0, lng: 0, state: 'XX', states: ['XX'] }]])
  const claims: ClaimedZip[] = []
  Object.entries(milesByName).forEach(([name, mi], i) => {
    const zip = String(10001 + i)
    coords.set(zip, { lat: mi * DEG_PER_MILE, lng: 0, state: 'XX', states: ['XX'] })
    claims.push({ zip, slug: `loc_${name.toLowerCase()}`, name, lifecycle_status: status[name] ?? 'active' })
  })
  return suggest('00000', null, claims, coords)
}

describe('the 75-mile line, measured as the button shows it', () => {
  it.each([
    [75.4, false],  // shows "75 mi" — in area
    [75.6, true],   // shows "76 mi" — out
    [74, false],
    [200, true],
  ])('nearest at %d mi → Not in our service area: %s', (mi, out) => {
    const s = line({ A: mi, B: mi + 50, C: mi + 90 })
    invariants(s)
    expect(s.showNotInServiceArea).toBe(out)
    if (out) expect(s.highlight).toBeNull()
  })
})

describe('the near-tie rule: within 5 miles → highlight neither', () => {
  it.each([
    [5.0, null],
    [5.04, null],   // 5.0 to the tenth — still a tie
    [4.2, null],
    [5.1, 'loc_a'],
    [5.3, 'loc_a'],
    [30, 'loc_a'],
  ])('second is %d mi further → highlight %j', (gap, hl) => {
    const s = line({ A: 20, B: 20 + gap, C: 70 })
    invariants(s)
    expect(s.highlight).toBe(hl)
    expect(s.noHighlightReason).toBe(hl ? null : 'near_tie')
  })

  it('a lone option (only one hive takes leads) is highlighted if in area', () => {
    const s = line({ A: 30, B: 40 }, { B: 'paused' })
    expect(labels(s)).toEqual(['A · 30 mi'])
    expect(s.highlight).toBe('loc_a')
  })

  it('under a mile reads "<1 mi"', () => {
    expect(labels(line({ A: 0.4, B: 30 }))[0]).toBe('A · <1 mi')
  })
})

describe('which hives may be suggested', () => {
  it('a paused hive is skipped and the next one moves up; it is reported', () => {
    const s = line({ A: 10, B: 20, C: 30, D: 40 }, { A: 'paused' })
    invariants(s)
    expect(labels(s)).toEqual(['B · 20 mi', 'C · 30 mi', 'D · 40 mi'])
    expect(s.skipped).toEqual(['loc_a'])
  })

  it('an onboarding hive IS suggested (they take leads since 20 Oct)', () => {
    const s = line({ A: 10, B: 40 }, { A: 'onboarding' })
    expect(s.options[0]).toMatchObject({ slug: 'loc_a', lifecycle_status: 'onboarding', highlighted: true })
  })

  it('no hive that takes leads at all → no options, and NO out-of-area button (nothing was measured)', () => {
    const s = line({ A: 10 }, { A: 'paused' })
    expect(s.options).toEqual([])
    expect(s.showNotInServiceArea).toBe(false)
  })

  it('every candidate paused, even far away → still no out-of-area button', () => {
    const s = line({ A: 300, B: 400 }, { A: 'paused', B: 'paused' })
    expect(s.showNotInServiceArea).toBe(false)
  })

  it('Beatrice with Lincoln paused → Omaha, Kansas City, Sioux Falls', () => {
    const claims = SNAP_CLAIMS().map((c) => (c.name === 'Lincoln' ? { ...c, lifecycle_status: 'paused' } : c))
    const s = suggest('68310', 'NE', claims)
    expect(labels(s)).toEqual(['Omaha · 60 mi', 'Kansas City · 131 mi', 'Sioux Falls · 210 mi'])
    expect(s.skipped).toEqual([slugOf('Lincoln')])
  })
})

describe('the lead\'s state against its zip', () => {
  it('Beatrice 68310 with state "IA" → a warning; the options still follow the zip', () => {
    const s = suggest('68310', 'IA')
    expect(s.stateWarning).toEqual({ leadState: 'IA', zip: '68310' })
    expect(labels(s)[0]).toBe('Lincoln · 19 mi')
  })

  it.each([['NE'], ['Nebraska'], [''], [null], ['Nebr.']])('state %j → no warning', (st) => {
    expect(suggest('68310', st).stateWarning).toBeNull()
  })
})

// ═══ the live call ═════════════════════════════════════════════
describe('suggestRouteForLead', () => {
  beforeEach(() => {
    h.lead = null
    h.leadError = null
    h.proximityCalls = []
  })

  it('a lead in Other → its card, reading 60 nearest so skips still leave three', async () => {
    h.lead = { id: 'lead-9', zip: '68310', state: 'NE', location_id: 'loc_other' }
    const s = await suggestRouteForLead('lead-9')
    expect(s.leadId).toBe('lead-9')
    expect(labels(s)).toEqual(['Lincoln · 19 mi', 'Omaha · 60 mi', 'Kansas City · 131 mi'])
    expect(h.proximityCalls).toEqual([{ items: [{ zip: '68310', state: 'NE' }], limit: 60 }])
  })

  it('a lead NOT in Other → refused, nothing measured', async () => {
    h.lead = { id: 'lead-9', zip: '68310', state: 'NE', location_id: 'loc_lincoln' }
    await expect(suggestRouteForLead('lead-9')).rejects.toThrow('is not in Other (it is at loc_lincoln)')
    expect(h.proximityCalls).toEqual([])
  })

  it('a lead that does not exist, or a failed read → throws', async () => {
    await expect(suggestRouteForLead('nope')).rejects.toThrow('lead nope not found')
    h.leadError = { message: 'down' }
    await expect(suggestRouteForLead('x')).rejects.toThrow('lead read failed: down')
  })
})
