// @vitest-environment node
//
// Turning the two Census files into zip_coords rows (lib/zip-coords-load.ts),
// and the migration + load script around them. The parsers are fed lines in
// the files' real formats: the 2025 Gazetteer is pipe-separated, earlier years
// tab-separated with padded columns; the relationship file starts with a BOM
// and has rows with no zip.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  parseGazetteer,
  parseZipStates,
  buildZipCoordRows,
  diffZipCoords,
  type ZipCoordRow,
} from '@/lib/zip-coords-load'
import { normalizeStateCode, STATE_BY_FIPS } from '@/lib/us-states'

const GAZ_2025 = [
  'GEOID|GEOIDFQ|ALAND|AWATER|ALAND_SQMI|AWATER_SQMI|INTPTLAT|INTPTLONG',
  '00601|860Z200US00601|166836450|798613|64.416|0.308|18.180555|-66.749961',
  '68310|860Z200US68310|559308495|6497871|215.95|2.509|40.249821|-96.74949',
].join('\n') + '\n'

const GAZ_2024_TABS = [
  'GEOID\tALAND\tAWATER\tALAND_SQMI\tAWATER_SQMI\tINTPTLAT\tINTPTLONG                                                                                                               ',
  '68310\t559308495\t6497871\t215.95\t2.509\t40.249821\t-96.74949                                                                                                                 ',
].join('\r\n')

const REL_HEADER = '\uFEFFOID_ZCTA5_20|GEOID_ZCTA5_20|NAMELSAD_ZCTA5_20|AREALAND_ZCTA5_20|AREAWATER_ZCTA5_20|MTFCC_ZCTA5_20|CLASSFP_ZCTA5_20|FUNCSTAT_ZCTA5_20|OID_COUNTY_20|GEOID_COUNTY_20|NAMELSAD_COUNTY_20|AREALAND_COUNTY_20|AREAWATER_COUNTY_20|MTFCC_COUNTY_20|CLASSFP_COUNTY_20|FUNCSTAT_COUNTY_20|AREALAND_PART|AREAWATER_PART'
const rel = (zip: string, county: string, land: number) =>
  `1|${zip}|ZCTA5 ${zip}|0|0|G6350|B5|S|2|${county}|X County|0|0|G4020|H1|A|${land}|0`

describe('parseGazetteer', () => {
  it('reads the 2025 pipe format', () => {
    const { points, report } = parseGazetteer(GAZ_2025)
    expect(report).toEqual({ rows: 2, kept: 2, rejected: [] })
    expect(points.get('68310')).toEqual({ lat: 40.249821, lng: -96.74949 })
    expect(points.get('00601')).toEqual({ lat: 18.180555, lng: -66.749961 }) // leading zeros kept
  })

  it('a file starting with a byte-order mark still finds GEOID', () => {
    const { points } = parseGazetteer('\uFEFF' + GAZ_2025)
    expect(points.get('68310')).toEqual({ lat: 40.249821, lng: -96.74949 })
  })

  it('reads the older tab format with padded columns and CRLF', () => {
    const { points, report } = parseGazetteer(GAZ_2024_TABS)
    expect(report.kept).toBe(1)
    expect(points.get('68310')).toEqual({ lat: 40.249821, lng: -96.74949 })
  })

  it('rejects and reports a bad zip, a missing or out-of-range coordinate, and a duplicate', () => {
    const text = [
      'GEOID|INTPTLAT|INTPTLONG',
      '6831|40|-96',
      '68311||-96',
      '68312|91|-96',
      '68313|40|-181',
      '68314|40|abc',
      '68315|40|-96',
      '68315|41|-96',
    ].join('\n')
    const { points, report } = parseGazetteer(text)
    expect(Array.from(points.keys())).toEqual(['68315'])
    expect(points.get('68315')).toEqual({ lat: 40, lng: -96 }) // the first one wins
    expect(report.rejected.map((r) => [r.line, r.reason])).toEqual([
      [2, 'bad zip "6831"'],
      [3, 'bad lat for 68311'],
      [4, 'bad lat for 68312'],
      [5, 'bad lng for 68313'],
      [6, 'bad lng for 68314'],
      [8, 'duplicate 68315'],
    ])
  })

  it('a file without the expected columns throws — never a silent empty load', () => {
    expect(() => parseGazetteer('ZIP|LAT|LON\n68310|40|-96')).toThrow('GEOID / INTPTLAT / INTPTLONG')
  })

  it('an empty file yields nothing', () => {
    expect(parseGazetteer('').points.size).toBe(0)
  })
})

describe('parseZipStates', () => {
  it('a zip in one state gets it; leading-zero county numbers work; rows with no zip are skipped', () => {
    const text = [REL_HEADER, '||||||||27590114112812|01003|Baldwin County|4117656199|1132956041|G4020|H1|A|339765765|927218265',
      rel('68310', '31067', 500), rel('00601', '72001', 10)].join('\n')
    const { states, unknownFips } = parseZipStates(text)
    expect(states.get('68310')).toEqual({ state: 'NE', states: ['NE'] })
    expect(states.get('00601')).toEqual({ state: 'PR', states: ['PR'] })
    expect(states.size).toBe(2)
    expect(unknownFips).toEqual([])
  })

  it('a zip across a state line: main state = most land (summed over counties), states = all, sorted', () => {
    const text = [REL_HEADER,
      rel('73949', '48421', 300), rel('73949', '40139', 200), rel('73949', '40025', 150)].join('\n')
    expect(parseZipStates(text).states.get('73949')).toEqual({ state: 'OK', states: ['OK', 'TX'] })
  })

  it('the states list is alphabetical even when the main state sorts last', () => {
    const text = [REL_HEADER, rel('73949', '48421', 900), rel('73949', '40139', 100)].join('\n')
    expect(parseZipStates(text).states.get('73949')).toEqual({ state: 'TX', states: ['OK', 'TX'] })
  })

  it('equal land in two states → the alphabetically first, so every load agrees', () => {
    const text = [REL_HEADER, rel('11111', '48001', 100), rel('11111', '40001', 100)].join('\n')
    expect(parseZipStates(text).states.get('11111')!.state).toBe('OK')
  })

  it('an unknown state number is skipped and reported', () => {
    const { states, unknownFips } = parseZipStates([REL_HEADER, rel('99999', '99001', 5)].join('\n'))
    expect(states.has('99999')).toBe(false)
    expect(unknownFips).toEqual(['99'])
  })

  it('a file without the expected columns throws', () => {
    expect(() => parseZipStates('A|B|C\n1|2|3')).toThrow('GEOID_ZCTA5_20')
  })
})

describe('buildZipCoordRows', () => {
  it('joins point + state, sorted by zip; a zip with no county gets no state', () => {
    const points = new Map([['68310', { lat: 40, lng: -96 }], ['00601', { lat: 18, lng: -66 }]])
    const states = new Map([['68310', { state: 'NE', states: ['NE'] }]])
    expect(buildZipCoordRows(points, states, 'census_gazetteer_2025')).toEqual([
      { zip: '00601', lat: 18, lng: -66, state: null, states: [], source: 'census_gazetteer_2025' },
      { zip: '68310', lat: 40, lng: -96, state: 'NE', states: ['NE'], source: 'census_gazetteer_2025' },
    ])
  })
})

describe('diffZipCoords — what a load would do', () => {
  const row = (zip: string, over: Partial<ZipCoordRow> = {}): ZipCoordRow =>
    ({ zip, lat: 40, lng: -96, state: 'NE', states: ['NE'], source: 'census_gazetteer_2024', ...over })

  it('sorts every zip into added / moved / source-only / unchanged / absent', () => {
    const existing = [row('10001'), row('10002'), row('10003'), row('10004'), row('10005'), row('10006', { states: ['NE', 'IA'] })]
    const incoming = [
      row('10001'),                                                  // unchanged
      row('10002', { source: 'census_gazetteer_2025' }),             // same point, newer file
      row('10003', { lat: 40.001 }),                                 // moved
      row('10004', { state: 'IA', states: ['IA'] }),                 // state changed
      row('10006', { states: ['IA', 'NE'] }),                        // same states, stored unsorted → unchanged
      row('10007'),                                                  // new
    ]
    const d = diffZipCoords(existing, incoming)
    expect(d.unchanged).toBe(2)
    expect(d.sourceOnly.map((r) => r.zip)).toEqual(['10002'])
    expect(d.moved.map((m) => m.after.zip)).toEqual(['10003', '10004'])
    expect(d.added.map((r) => r.zip)).toEqual(['10007'])
    expect(d.absentFromFile).toEqual(['10005'])
  })

  it('the main state flipping is a move, even when the list of states is the same', () => {
    const d = diffZipCoords([row('73949', { state: 'OK', states: ['OK', 'TX'] })], [row('73949', { state: 'TX', states: ['OK', 'TX'] })])
    expect(d.moved.map((m) => m.after.zip)).toEqual(['73949'])
  })

  it('a sub-microdegree wobble is not a move', () => {
    const d = diffZipCoords([row('10001')], [row('10001', { lat: 40.0000004 })])
    expect(d.moved).toEqual([])
    expect(d.unchanged).toBe(1)
  })

  it('a first load is all adds', () => {
    const d = diffZipCoords([], [row('10001'), row('10002')])
    expect(d.added).toHaveLength(2)
    expect(d.absentFromFile).toEqual([])
  })
})

describe('us-states', () => {
  it('maps every Census state number the zip file uses, including DC and Puerto Rico', () => {
    expect(Object.keys(STATE_BY_FIPS)).toHaveLength(56)
    expect(STATE_BY_FIPS['11']).toBe('DC')
    expect(STATE_BY_FIPS['72']).toBe('PR')
    expect(new Set(Object.values(STATE_BY_FIPS)).size).toBe(56)
  })

  it.each([
    ['CA', 'CA'], ['ca', 'CA'], [' Ca ', 'CA'], ['California', 'CA'], ['new  york', 'NY'],
    ['District of Columbia', 'DC'], ['Puerto Rico', 'PR'],
    ['Calif.', null], ['XX', null], ['', null], [null, null], [42, null], ['Ontario', null],
  ])('%j → %j', (raw, code) => {
    expect(normalizeStateCode(raw)).toBe(code)
  })
})

describe('the migration, its undo, and the script', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
  const mig = read('migrations/zip_coords.sql')
  const undo = read('migrations/zip_coords_undo.sql')
  const script = read('scripts/load-zip-coords.mjs')

  it('the table: zip primary key, checked coordinates, RLS on with no policy', () => {
    expect(mig).toContain('CREATE TABLE IF NOT EXISTS public.zip_coords')
    expect(mig).toMatch(/zip\s+text\s+PRIMARY KEY CHECK \(zip ~ '\^\[0-9\]\{5\}\$'\)/)
    expect(mig).toContain('CHECK (lat BETWEEN -90 AND 90)')
    expect(mig).toContain('CHECK (lng BETWEEN -180 AND 180)')
    expect(mig).toContain('ALTER TABLE public.zip_coords ENABLE ROW LEVEL SECURITY;')
    expect(mig).not.toMatch(/CREATE POLICY/i)
    expect(mig).toContain('STATUS: WRITTEN, NOT RUN.')
  })

  it('the undo drops exactly that table and nothing else', () => {
    const statements = undo.split('\n').filter((l) => l.trim() && !l.trim().startsWith('--'))
    expect(statements).toEqual(['DROP TABLE IF EXISTS public.zip_coords;'])
  })

  it('the script is a dry run unless --commit, never prunes unless --prune, and refuses a short file', () => {
    expect(script).toContain("const COMMIT = has('--commit')")
    expect(script).toContain("const PRUNE = has('--prune')")
    const exitBeforeWrite = script.indexOf("if (!COMMIT) {")
    const firstWrite = script.indexOf(".upsert(")
    expect(exitBeforeWrite).toBeGreaterThan(-1)
    expect(firstWrite).toBeGreaterThan(exitBeforeWrite)
    expect(script.indexOf('.delete(')).toBeGreaterThan(script.indexOf('if (PRUNE && diff.absentFromFile.length)'))
    expect(script).toContain('const MIN_ZIPS = 30000')
    // it runs the tested rules, not a copy of them
    expect(script).toContain("/lib/zip-coords-load.ts")
  })
})
