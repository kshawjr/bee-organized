// @vitest-environment node
// The territory spreadsheet → Bee Hub mapping, and the migration that loads it.
//
// The failure to avoid is an import that SILENTLY DROPS A LOCATION. So:
//   • every one of the sheet's 54 columns is in SHEET_TO_BEE_HUB — mapped to
//     a Bee Hub name or explicitly null (unknown). No defaults.
//   • the migration's mapping VALUES are exactly SHEET_TO_BEE_HUB.
//   • the migration carries every one of the 1,608 sheet entries, per column
//     count for count — including the two unknown columns, so their exclusion
//     is visible in the SQL, not an absence.
//   • the migration's expected-pairs guard matches what the entries imply, so
//     a join that loses a row raises instead of committing.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { SHEET_TO_BEE_HUB, SHEET_COLUMN_ENTRY_COUNTS } from '@/lib/zip-territory-sheet'

const SQL = readFileSync(new URL('../migrations/location_zips.sql', import.meta.url), 'utf8')

// The 54 headers exactly as the sheet has them (trimmed), in sheet order.
const SHEET_HEADERS = [
  'Kansas City', 'Dallas', 'SF Bay', 'Oklahoma City', 'Miami', 'Omaha', 'Denver', 'Portland',
  'Seattle', 'San Diego', 'Scottsdale', 'Rhode Island', 'Orlando', 'Palm Beach', 'N. Houston',
  'Houston', 'New Orleans', 'Northwest AR', 'Central AR', 'Reno', 'Lincoln', 'Peoria',
  'New Braunfels', 'Tulsa', 'South OC', 'San Antonio', 'Carmel', 'South Valley', 'Chattanooga',
  'Temecula', 'Boston North Suburbs', 'Northern VA', 'Ft. Lauderdale', 'West Denver',
  'Philadelphia Western Suburbs', 'Las Vegas-Summerlin', 'Katy', 'Central Denver',
  'Northern Colorado', 'Northern Jersey Shore', 'North Pittsburgh', 'Northwest Austin', 'Sarasota',
  'Lafayette', 'Southeast Nashville', 'West St. Louis', 'Sioux Falls, SD', 'South Charlotte',
  'SW Austin', 'Lake Norman', 'Central Austin', 'Greensboro', 'West Raleigh', 'Connecticut',
]

// Parse the two VALUES lists out of the migration.
const blockAfter = (marker: string) => {
  const i = SQL.indexOf(marker)
  expect(i, `marker ${marker} in migration`).toBeGreaterThan(-1)
  const rest = SQL.slice(i + marker.length)
  return rest.slice(0, rest.indexOf('\n  )'))
}
const tuples = (block: string) =>
  Array.from(block.matchAll(/\('((?:[^']|'')+)',\s*(NULL|'((?:[^']|'')*)')\)/g)).map(m => [
    m[1].replace(/''/g, "'"),
    m[2] === 'NULL' ? null : m[3].replace(/''/g, "'"),
  ] as [string, string | null])

const SQL_MAP = new Map(tuples(blockAfter('WITH map(sheet, bee) AS (VALUES')))
const SQL_ENTRIES = tuples(blockAfter('entries(sheet, zip) AS (VALUES')) as [string, string][]

describe('every sheet column maps to a real location or is explicitly unknown', () => {
  it('54 columns, all in the mapping, nothing extra', () => {
    expect(SHEET_HEADERS).toHaveLength(54)
    expect(new Set(SHEET_HEADERS).size).toBe(54)
    expect(Object.keys(SHEET_TO_BEE_HUB).sort()).toEqual([...SHEET_HEADERS].sort())
    expect(Object.keys(SHEET_COLUMN_ENTRY_COUNTS).sort()).toEqual([...SHEET_HEADERS].sort())
  })

  it('exactly two unknown columns — Central AR and South Valley — and no invented location for them', () => {
    const unknown = Object.entries(SHEET_TO_BEE_HUB).filter(([, v]) => v === null).map(([k]) => k).sort()
    expect(unknown).toEqual(['Central AR', 'South Valley'])
  })

  it('52 mapped columns → 52 DISTINCT Bee Hub names (no two columns collapse into one)', () => {
    const names = Object.values(SHEET_TO_BEE_HUB).filter(Boolean)
    expect(names).toHaveLength(52)
    expect(new Set(names).size).toBe(52)
  })

  it('the renames Kevin confirmed', () => {
    expect(SHEET_TO_BEE_HUB['Northern VA']).toBe('Nova')
    expect(SHEET_TO_BEE_HUB['SF Bay']).toBe('San Francisco')
    expect(SHEET_TO_BEE_HUB['Sioux Falls, SD']).toBe('Sioux Falls')
    expect(SHEET_TO_BEE_HUB['Connecticut']).toBe('Connecticut Shoreline')
    expect(SHEET_TO_BEE_HUB['Philadelphia Western Suburbs']).toBe('Philadelphia Suburbs')
  })

  it('1,608 entries in all', () => {
    expect(Object.values(SHEET_COLUMN_ENTRY_COUNTS).reduce((a, b) => a + b, 0)).toBe(1608)
  })
})

describe('the migration matches the mapping and the sheet', () => {
  it('its mapping VALUES are exactly SHEET_TO_BEE_HUB', () => {
    expect(SQL_MAP.size).toBe(54)
    for (const [sheet, bee] of Object.entries(SHEET_TO_BEE_HUB)) {
      expect(SQL_MAP.has(sheet), sheet).toBe(true)
      expect(SQL_MAP.get(sheet), sheet).toBe(bee)
    }
  })

  it('carries every sheet entry, count for count per column (unknown columns included)', () => {
    expect(SQL_ENTRIES).toHaveLength(1608)
    const per: Record<string, number> = {}
    for (const [sheet] of SQL_ENTRIES) per[sheet] = (per[sheet] || 0) + 1
    expect(per).toEqual(SHEET_COLUMN_ENTRY_COUNTS)
  })

  it('every zip is five digits (leading zeros restored)', () => {
    for (const [, zip] of SQL_ENTRIES) expect(zip).toMatch(/^\d{5}$/)
    expect(SQL_ENTRIES).toContainEqual(['Rhode Island', '02801'])
    expect(SQL_ENTRIES).toContainEqual(['Connecticut', '06320'])
  })

  it('1,580 unique zips; unknown columns hold 22 + 22 of them', () => {
    expect(new Set(SQL_ENTRIES.map(([, z]) => z)).size).toBe(1580)
    const uniq = (col: string) => new Set(SQL_ENTRIES.filter(([s]) => s === col).map(([, z]) => z)).size
    expect(uniq('Central AR')).toBe(22)
    expect(uniq('South Valley')).toBe(22)
  })

  it('the load guard expects exactly the pairs the mapped entries imply (1,547)', () => {
    const pairs = new Set(
      SQL_ENTRIES.filter(([s]) => SHEET_TO_BEE_HUB[s]).map(([s, z]) => `${SHEET_TO_BEE_HUB[s]}|${z}`),
    )
    expect(pairs.size).toBe(1547)
    expect(SQL).toMatch(/IF n_wanted <> 1547 THEN\s+RAISE EXCEPTION/)
  })

  it('the 11 Denver conflicts are in the data, and nothing picks a winner', () => {
    const owners = new Map<string, Set<string>>()
    for (const [s, z] of SQL_ENTRIES) {
      const bee = SHEET_TO_BEE_HUB[s]
      if (!bee) continue
      if (!owners.has(z)) owners.set(z, new Set())
      owners.get(z)!.add(bee)
    }
    const conflicts = Array.from(owners.entries()).filter(([, o]) => o.size > 1)
      .map(([z, o]) => `${z}:${Array.from(o).sort().join('+')}`).sort()
    expect(conflicts).toEqual([
      '80010:Central Denver+Denver', '80126:Denver+West Denver', '80203:Central Denver+Denver',
      '80206:Central Denver+Denver', '80209:Central Denver+Denver', '80210:Central Denver+Denver',
      '80218:Central Denver+Denver', '80220:Central Denver+Denver', '80224:Central Denver+Denver',
      '80230:Central Denver+Denver', '80246:Central Denver+Denver',
    ])
    // Both claims load — the table's key is (zip, location), never zip alone.
    expect(SQL).toMatch(/UNIQUE \(zip, location_uuid\)/)
    expect(SQL).not.toMatch(/UNIQUE \(zip\)/)
  })

  it('refuses to load when a name does not resolve, and never targets loc_other', () => {
    expect(SQL).toMatch(/WHERE x\.cnt <> 1;\s+IF bad IS NOT NULL THEN\s+RAISE EXCEPTION/)
    expect(SQL.match(/location_id <> 'loc_other'/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('is marked NOT RUN', () => {
    expect(SQL).toContain('STATUS: WRITTEN, NOT RUN.')
  })
})
