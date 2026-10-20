// @vitest-environment node
//
// lib/zip-proximity.ts — the N closest locations to a lead's zip, measured to
// each location's NEAREST CLAIMED ZIP (stage 2 of the Slack route suggestion).
//
// A. Kevin's four real cases, on a snapshot of the real territory list and the
//    real Census points (lib/fixtures/zip-proximity-snapshot.json, 20 Oct
//    2026). Two pins per case, on purpose:
//      · THE RANKING — which three locations, in which order. This is the real
//        check: it must survive a yearly Census refresh that nudges the miles.
//      · THE MILES — the Census straight-line figures (Kevin: these win over
//        his pip-package numbers), to a tenth of a mile.
// B. The cases the brief named: a zip the Census lacks, a zip claimed by two
//    locations, a zip whose state disagrees with the lead's.
// C. The live read pages past Supabase's 1,000-row cap and refuses to answer
//    from a failed read.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const db = vi.hoisted(() => ({
  claims: [] as any[],
  coords: [] as any[],
  calls: [] as { table: string; range?: [number, number]; inZips?: string[]; countAsked?: boolean }[],
  failTable: null as string | null,
  // Supabase's max_rows: the most rows ONE request returns, whatever it asks.
  cap: 1000,
  // Test hooks for a database that misbehaves.
  dropCountFor: null as string | null, // this table returns no count at all
  shortAfterFirstPage: false, // territory pages after the first come back empty
  countOverride: null as number | null, // territory count that disagrees with the rows
}))
vi.mock('@/lib/supabase-service', () => ({
  supabaseService: {
    from: (table: string) => {
      const call: any = { table }
      db.calls.push(call)
      const b: any = {}
      b.select = (_cols: string, opts?: any) => { call.countAsked = opts?.count === 'exact'; return b }
      b.order = () => b
      b.range = (a: number, z: number) => { call.range = [a, z]; return b }
      b.in = (_c: string, v: string[]) => { call.inZips = v; return b }
      b.then = (res: any, rej: any) => {
        if (db.failTable === table) return Promise.resolve({ data: null, error: { message: 'down' }, count: null }).then(res, rej)
        let matching: any[]
        let data: any[]
        if (table === 'location_zips') {
          matching = db.claims
          const [a, z] = call.range ?? [0, Number.MAX_SAFE_INTEGER]
          data = matching.slice(a, Math.min(z + 1, a + db.cap))
          if (db.shortAfterFirstPage && a > 0) data = []
        } else {
          matching = db.coords.filter((r) => (call.inZips ?? []).includes(r.zip))
          data = matching.slice(0, db.cap)
        }
        let count: number | null = call.countAsked && db.dropCountFor !== table ? matching.length : null
        if (table === 'location_zips' && count !== null && db.countOverride !== null) count = db.countOverride
        return Promise.resolve({ data, error: null, count }).then(res, rej)
      }
      return b
    },
  },
}))

import {
  rankNearestLocations,
  nearestLocationsForZip,
  nearestLocationsForZips,
  readAllClaims,
  haversineMiles,
  checkLeadState,
  type ClaimedZip,
  type ZipPoint,
} from '@/lib/zip-proximity'

const snap = JSON.parse(readFileSync(join(process.cwd(), 'lib/fixtures/zip-proximity-snapshot.json'), 'utf8'))
const CLAIMS: ClaimedZip[] = snap.claims
const COORDS = new Map<string, ZipPoint>(
  Object.entries(snap.coords as Record<string, [number, number, string | null, string[]]>)
    .map(([zip, [lat, lng, state, states]]) => [zip, { lat, lng, state, states }]),
)
const rank = (zip: unknown, leadState?: unknown, limit = 3) =>
  rankNearestLocations({ zip, leadState, coords: COORDS, claims: CLAIMS, limit })
const okResult = (zip: string, leadState?: unknown) => {
  const r = rank(zip, leadState)
  if (r.status !== 'ok') throw new Error(`expected ok for ${zip}, got ${r.status}`)
  return r
}

// ═══ A. Kevin's four cases ═══════════════════════════════════════
const CASES: Array<[string, string, Array<[string, number, string]>]> = [
  // zip, place,       [location, Census miles, measured to]
  ['68310', 'Beatrice NE',   [['Lincoln', 19.29, '68301'], ['Omaha', 60.21, '68037'], ['Kansas City', 131.09, '66226']]],
  ['92503', 'Riverside CA',  [['South Orange County', 17.32, '92679'], ['Temecula', 17.88, '92530'], ['San Diego', 32.61, '92055']]],
  ['60173', 'Schaumburg IL', [['Carmel', 162.78, '46069'], ['West St Louis', 267.94, '63119'], ['Omaha', 367.13, '51544']]],
  ['33928', 'Estero FL',     [['Miami', 47.66, '34141'], ['Sarasota', 70.09, '34241'], ['Fort Lauderdale', 82.21, '33332']]],
]

describe('A. the ranking — which three, in which order (survives a Census refresh)', () => {
  it.each(CASES)('%s %s', (zip, _place, expected) => {
    expect(okResult(zip).nearest.map((n) => n.name)).toEqual(expected.map(([name]) => name))
  })
})

describe('A. the miles — Census straight-line, to a tenth of a mile', () => {
  it.each(CASES)('%s %s', (zip, _place, expected) => {
    const got = okResult(zip).nearest
    expected.forEach(([name, miles, via], i) => {
      expect(got[i].name).toBe(name)
      expect(got[i].miles).toBeCloseTo(miles, 1)
      expect(got[i].via_zip).toBe(via)
    })
  })

  it('the distance is great-circle miles: one degree of latitude ≈ 69.09', () => {
    expect(haversineMiles({ lat: 40, lng: -96 }, { lat: 41, lng: -96 })).toBeCloseTo(69.09, 1)
    expect(haversineMiles({ lat: 40, lng: -96 }, { lat: 40, lng: -96 })).toBe(0)
  })

  it('measures to the NEAREST claimed zip, never the middle of the territory', () => {
    // Miami's territory centre is ~98 miles from Estero; its nearest zip, 34141, is 47.7.
    const miami = okResult('33928').nearest.find((n) => n.name === 'Miami')!
    expect(miami.miles).toBeLessThan(50)
  })

  it('the real list has 152 claimed zips the Census does not carry; they are counted, not guessed', () => {
    expect(okResult('68310').unmeasuredClaims).toBe(152)
  })

  it('three come back when no limit is given', () => {
    const r = rankNearestLocations({ zip: '68310', coords: COORDS, claims: CLAIMS }) as any
    expect(r.nearest.map((n: any) => n.name)).toEqual(['Lincoln', 'Omaha', 'Kansas City'])
  })

  it('limit decides how many come back', () => {
    expect(okResult('68310').nearest).toHaveLength(3)
    expect((rank('68310', null, 5) as any).nearest.map((n: any) => n.name).slice(0, 4))
      .toEqual(['Lincoln', 'Omaha', 'Kansas City', 'Sioux Falls'])
    expect((rank('68310', null, 0) as any).nearest).toEqual([])
  })
})

// ═══ B. the named cases ══════════════════════════════════════════
describe('B. zips that are not a plain point', () => {
  it.each([[undefined], [null], [''], ['  ']])('no zip %j → missing, no distances', (z) => {
    expect(rank(z)).toEqual({ status: 'missing', zip: null })
  })

  it.each([['6831'], ['abcde'], ['683100']])('malformed %j → malformed, no distances', (z) => {
    expect(rank(z)).toEqual({ status: 'malformed', zip: null })
  })

  it('ZIP+4 is read as its five digits', () => {
    expect(okResult('68310-1234' as any).zip).toBe('68310')
  })

  it('a zip the Census does not carry (11111) → unknown_zip, no distances, nobody claims it', () => {
    expect(rank('11111')).toEqual({ status: 'unknown_zip', zip: '11111', claimedBy: [] })
  })

  it('an unknown zip that IS claimed still says who claims it (no map needed for that)', () => {
    // 02901 is a Providence PO-box zip on Rhode Island's list, with no Census area.
    const r = rank('02901')
    expect(r.status).toBe('unknown_zip')
    expect((r as any).claimedBy.map((c: any) => c.name)).toEqual(['Rhode Island'])
  })

  it('a zip claimed by ONE location → claimedBy names it, and it is first at 0 miles via that zip', () => {
    const r = okResult('89509')
    expect(r.claimedBy).toEqual([{ slug: 'loc_reno', name: 'Reno', lifecycle_status: 'onboarding' }])
    expect(r.nearest[0]).toMatchObject({ name: 'Reno', miles: 0, via_zip: '89509' })
  })

  it('a zip claimed by TWO locations → both named, both at 0 miles, alphabetical — never a pick', () => {
    const claims: ClaimedZip[] = [
      { zip: '80126', slug: 'loc_westdenver', name: 'West Denver', lifecycle_status: 'active' },
      { zip: '80126', slug: 'loc_denver', name: 'Denver', lifecycle_status: 'onboarding' },
      { zip: '80202', slug: 'loc_centraldenver', name: 'Central Denver', lifecycle_status: 'active' },
    ]
    const coords = new Map<string, ZipPoint>([
      ['80126', { lat: 39.544, lng: -104.966, state: 'CO', states: ['CO'] }],
      ['80202', { lat: 39.752, lng: -104.998, state: 'CO', states: ['CO'] }],
    ])
    const r = rankNearestLocations({ zip: '80126', coords, claims }) as any
    expect(r.claimedBy.map((c: any) => c.name)).toEqual(['Denver', 'West Denver'])
    expect(r.nearest.map((n: any) => [n.name, n.miles])).toEqual([['Denver', 0], ['West Denver', 0], ['Central Denver', expect.any(Number)]])
    expect(r.nearest[2].miles).toBeGreaterThan(14)
  })

  it('a location appears once, at its nearest zip, however many zips it claims', () => {
    const names = (rank('68310', null, 52) as any).nearest.map((n: any) => n.slug)
    expect(new Set(names).size).toBe(names.length)
  })

  it('loc_other is never a location, even if a row names it', () => {
    const claims = [...CLAIMS, { zip: '68310', slug: 'loc_other', name: 'Other', lifecycle_status: 'onboarding' }]
    const r = rankNearestLocations({ zip: '68310', coords: COORDS, claims }) as any
    expect(r.claimedBy).toEqual([])
    expect(r.nearest.map((n: any) => n.slug)).not.toContain('loc_other')
  })

  it('equal distances sort by name, so the order is repeatable', () => {
    const p = { lat: 0, lng: 0, state: 'XX', states: ['XX'] }
    const coords = new Map<string, ZipPoint>([['00001', p], ['00002', { ...p, lat: 1 }], ['00003', { ...p, lat: -1 }]])
    const claims: ClaimedZip[] = [
      { zip: '00002', slug: 'loc_z', name: 'Zed', lifecycle_status: 'active' },
      { zip: '00003', slug: 'loc_a', name: 'Alpha', lifecycle_status: 'active' },
    ]
    const r = rankNearestLocations({ zip: '00001', coords, claims }) as any
    expect(r.nearest.map((n: any) => n.name)).toEqual(['Alpha', 'Zed'])
    expect(r.nearest[0].miles).toBe(r.nearest[1].miles)
  })
})

describe('B. the lead\'s state against the zip\'s', () => {
  it.each([
    ['NE', 'match', 'NE'],
    [' ne ', 'match', 'NE'],
    ['Nebraska', 'match', 'NE'],
    ['IA', 'mismatch', 'IA'],
    ['Iowa', 'mismatch', 'IA'],
    ['Nebr.', 'unreadable', null],
    ['Ontario', 'unreadable', null],
    ['', 'no_lead_state', null],
    [null, 'no_lead_state', null],
  ])('Beatrice 68310 with state %j → %s', (state, check, code) => {
    const r = okResult('68310', state)
    expect(r.stateCheck).toBe(check)
    expect(r.leadState).toBe(code)
    // a disagreement is REPORTED, never used to drop or reorder locations
    expect(r.nearest.map((n) => n.name)).toEqual(['Lincoln', 'Omaha', 'Kansas City'])
  })

  it('a zip across a state line agrees with every state it touches (73949: OK + TX)', () => {
    expect(okResult('73949', 'TX').stateCheck).toBe('match')
    expect(okResult('73949', 'OK').stateCheck).toBe('match')
    expect(okResult('73949', 'KS').stateCheck).toBe('mismatch')
  })

  it('a zip with no state on file says so rather than calling it a match', () => {
    expect(checkLeadState('NE', { lat: 0, lng: 0, state: null, states: [] })).toEqual({ stateCheck: 'no_zip_state', leadState: 'NE' })
    expect(checkLeadState('NE', { lat: 0, lng: 0, state: 'NE', states: [] })).toEqual({ stateCheck: 'match', leadState: 'NE' })
  })
})

// ═══ C. the live read ════════════════════════════════════════════
const asDbClaims = (claims: ClaimedZip[]) =>
  claims.map((c) => ({ zip: c.zip, location: { location_id: c.slug, name: c.name, lifecycle_status: c.lifecycle_status } }))
const asDbCoords = () =>
  Array.from(COORDS.entries()).map(([zip, p]) => ({ zip, lat: p.lat, lng: p.lng, state: p.state, states: p.states }))

describe('C. nearestLocationsForZip — the database read', () => {
  beforeEach(() => {
    db.claims = asDbClaims(CLAIMS)
    db.coords = asDbCoords()
    db.calls = []
    db.failTable = null
    db.cap = 1000
    db.dropCountFor = null
    db.shortAfterFirstPage = false
    db.countOverride = null
  })

  // Kevin's rule (20 Oct 2026): a silent truncation must break a test, not a
  // customer's routing. This is that test, against the real 1,535-row list.
  it('reads back EVERY claimed row: 1,535 rows, 1,535 claimed — none lost to the 1,000-row cap', async () => {
    const got = await readAllClaims()
    expect(CLAIMS.length).toBe(1535)
    expect(got.length).toBe(CLAIMS.length)
    expect(new Set(got.map((c) => `${c.zip}|${c.slug}`)).size).toBe(new Set(CLAIMS.map((c) => `${c.zip}|${c.slug}`)).size)
    expect(new Set(got.map((c) => c.zip))).toEqual(new Set(CLAIMS.map((c) => c.zip)))
  })

  it('still reads every row when the cap is LOWER than the page size (no "short page = the end")', async () => {
    db.cap = 400
    const got = await readAllClaims()
    expect(got.length).toBe(1535)
    expect(db.calls.filter((c) => c.table === 'location_zips').length).toBe(4) // 400 + 400 + 400 + 335
  })

  it('a territory read that comes back short THROWS, naming how much it got', async () => {
    db.shortAfterFirstPage = true
    await expect(readAllClaims()).rejects.toThrow('location_zips read short: got 1000 of 1535 territory rows')
    await expect(nearestLocationsForZip('68310')).rejects.toThrow('read short')
  })

  it.each([['location_zips'], ['zip_coords']])('a %s read with no row count THROWS — without it a short read is invisible', async (t) => {
    db.dropCountFor = t
    await expect(nearestLocationsForZip('68310')).rejects.toThrow(`${t} read failed: no row count came back`)
  })

  it('rows and count that disagree (the list changed mid-read) THROW rather than answer', async () => {
    db.countOverride = 900
    await expect(readAllClaims()).rejects.toThrow('location_zips read short: got 1000 of 900 territory rows')
  })

  it('a territory row with no location THROWS — a dropped row is a short read too', async () => {
    db.claims = asDbClaims(CLAIMS)
    db.claims[5] = { zip: db.claims[5].zip, location: null }
    await expect(readAllClaims()).rejects.toThrow(`zip ${db.claims[5].zip} came back with no location`)
  })

  it('every read asks the database for the true count', async () => {
    await nearestLocationsForZip('68310')
    expect(db.calls.length).toBeGreaterThan(0)
    expect(db.calls.every((c) => c.countAsked)).toBe(true)
  })

  it('a coordinates read cut short by the cap THROWS rather than passing real zips off as unknown', async () => {
    db.cap = 1000
    // Fine at 1000: no chunk asks for more than 300.
    await expect(nearestLocationsForZip('68310')).resolves.toMatchObject({ status: 'ok' })
    // A cap of 50: the territory list still pages whole (50 at a time), but a
    // 300-zip coordinates chunk with ~270 matching rows gets only 50 back.
    db.cap = 50
    db.claims = asDbClaims(CLAIMS).slice(0, 600)
    await expect(readAllClaims()).resolves.toHaveLength(600)
    await expect(nearestLocationsForZip('68310')).rejects.toThrow(/zip_coords read short: got 50 of \d+ rows for 300 zips/)
  })

  it('a claimed zip the Census lacks is NOT a short read (count and rows agree)', async () => {
    const r = await nearestLocationsForZip('68310')
    expect((r as any).unmeasuredClaims).toBe(152)
  })

  it('pages the 1,535-row territory list past the 1,000-row cap and gets the same answer as the snapshot', async () => {
    const r = await nearestLocationsForZip('33928', 'FL')
    const pages = db.calls.filter((c) => c.table === 'location_zips')
    expect(pages.map((p) => p.range)).toEqual([[0, 999], [1000, 1999]])
    expect(r).toEqual(okResult('33928', 'FL'))
  })

  it('reads coordinates in chunks of at most 300 zips, the lead\'s own included', async () => {
    await nearestLocationsForZip('68310')
    const reads = db.calls.filter((c) => c.table === 'zip_coords')
    expect(reads.length).toBeGreaterThan(1)
    expect(Math.max(...reads.map((c) => c.inZips!.length))).toBeLessThanOrEqual(300)
    expect(reads.flatMap((c) => c.inZips!)).toContain('68310')
  })

  it('the batch: results line up with the leads, the map is read ONCE for all of them', async () => {
    const out = await nearestLocationsForZips([{ zip: '68310', state: 'NE' }, { zip: null }, { zip: '33928' }, { zip: '89509' }], 3)
    expect(out.map((r) => r.status)).toEqual(['ok', 'missing', 'ok', 'ok'])
    expect((out[0] as any).nearest[0].name).toBe('Lincoln')
    expect((out[2] as any).nearest[0].name).toBe('Miami')
    expect((out[3] as any).claimedBy[0].name).toBe('Reno')
    expect(out[0]).toEqual(okResult('68310', 'NE'))
    expect(db.calls.filter((c) => c.table === 'location_zips')).toHaveLength(2) // the two pages of the territory list, once
  })

  it('the batch with no usable zip reads nothing at all', async () => {
    const out = await nearestLocationsForZips([{ zip: null }, { zip: 'abc' }])
    expect(out.map((r) => r.status)).toEqual(['missing', 'malformed'])
    expect(db.calls).toEqual([])
  })

  it('a missing or malformed zip reads nothing', async () => {
    expect(await nearestLocationsForZip('')).toEqual({ status: 'missing', zip: null })
    expect(await nearestLocationsForZip('123')).toEqual({ status: 'malformed', zip: null })
    expect(db.calls).toEqual([])
  })

  it.each([['location_zips'], ['zip_coords']])('a failed %s read throws — never a suggestion from half a map', async (t) => {
    db.failTable = t
    await expect(nearestLocationsForZip('68310')).rejects.toThrow(`${t} read failed`)
  })
})
