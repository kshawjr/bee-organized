// lib/zip-coords-load.ts
// ─────────────────────────────────────────────────────────────
// Turns two US Census files into zip_coords rows (migrations/zip_coords.sql).
// Pure: no database, no network. scripts/load-zip-coords.mjs reads the files
// and writes the rows; this module is what it runs, and what the tests pin.
//
//   1. THE GAZETTEER (ZCTA "national" file, e.g. 2025_Gaz_zcta_national.txt):
//      one row per zip area — GEOID (the zip) and INTPTLAT / INTPTLONG, the
//      Census "internal point", a point guaranteed to sit inside the area.
//      That point IS the zip's coordinate. Pipe-separated since 2025, tab-
//      separated before; both are read.
//   2. THE ZIP-TO-COUNTY RELATIONSHIP FILE (tab20_zcta520_county20_natl.txt):
//      one row per (zip, county) overlap, with the land area of the overlap.
//      A county GEOID starts with its state's two-digit number, so this gives
//      each zip its states. The Gazetteer carries no state at all.
//
// A ZIP CROSSES STATE LINES SOMETIMES. `states` lists every state it touches;
// `state` is the one holding most of its land (ties: alphabetical, so a load
// is repeatable). A lead whose state is any of `states` does not disagree.
//
// WHAT A ZIP CODE IS NOT HERE. The Census draws areas for zips that have
// homes. PO-box-only and single-company zips (02901, 68501, 11111-style
// placeholders) have no area and are simply absent — a lead with one gets no
// distance suggestion. Measured 20 Oct 2026: 30 of 5,690 leads in a year
// (0.53%), 17 of them the fake zip 11111.
// ─────────────────────────────────────────────────────────────

import { STATE_BY_FIPS } from './us-states'

export type ZipCoordRow = {
  zip: string
  lat: number
  lng: number
  state: string | null
  states: string[]
  source: string
}

export type ParseReport = {
  rows: number      // data lines read
  kept: number
  rejected: { line: number; reason: string }[]
}

const ZIP_RE = /^\d{5}$/

const splitLines = (text: string): string[] =>
  text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim() !== '')

// Gazetteer → zip → [lat, lng]. A row that isn't a five-digit zip with a real
// coordinate is rejected and reported, never guessed at.
export function parseGazetteer(text: string): { points: Map<string, { lat: number; lng: number }>; report: ParseReport } {
  const lines = splitLines(text)
  const report: ParseReport = { rows: 0, kept: 0, rejected: [] }
  const points = new Map<string, { lat: number; lng: number }>()
  if (lines.length === 0) return { points, report }
  const delim = lines[0].includes('|') ? '|' : '\t'
  const header = lines[0].split(delim).map((h) => h.trim())
  const iZip = header.indexOf('GEOID')
  const iLat = header.indexOf('INTPTLAT')
  const iLng = header.indexOf('INTPTLONG')
  if (iZip < 0 || iLat < 0 || iLng < 0) {
    throw new Error(`gazetteer header is missing GEOID / INTPTLAT / INTPTLONG (got: ${header.join(', ')})`)
  }
  for (let n = 1; n < lines.length; n++) {
    report.rows++
    const cols = lines[n].split(delim).map((c) => c.trim())
    const zip = cols[iZip]
    const lat = Number(cols[iLat])
    const lng = Number(cols[iLng])
    if (!ZIP_RE.test(zip ?? '')) { report.rejected.push({ line: n + 1, reason: `bad zip ${JSON.stringify(zip)}` }); continue }
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || cols[iLat] === '') { report.rejected.push({ line: n + 1, reason: `bad lat for ${zip}` }); continue }
    if (!Number.isFinite(lng) || lng < -180 || lng > 180 || cols[iLng] === '') { report.rejected.push({ line: n + 1, reason: `bad lng for ${zip}` }); continue }
    if (points.has(zip)) { report.rejected.push({ line: n + 1, reason: `duplicate ${zip}` }); continue }
    points.set(zip, { lat, lng })
    report.kept++
  }
  return { points, report }
}

// Relationship file → zip → its states, main one first. Rows with no zip (the
// county parts no zip covers) are skipped; an unknown state number is skipped
// and counted.
export function parseZipStates(text: string): { states: Map<string, { state: string | null; states: string[] }>; unknownFips: string[] } {
  const lines = splitLines(text)
  const out = new Map<string, { state: string | null; states: string[] }>()
  const unknown = new Set<string>()
  if (lines.length === 0) return { states: out, unknownFips: [] }
  const header = lines[0].split('|').map((h) => h.trim())
  const iZip = header.indexOf('GEOID_ZCTA5_20')
  const iCounty = header.indexOf('GEOID_COUNTY_20')
  const iLand = header.indexOf('AREALAND_PART')
  if (iZip < 0 || iCounty < 0 || iLand < 0) {
    throw new Error(`relationship header is missing GEOID_ZCTA5_20 / GEOID_COUNTY_20 / AREALAND_PART (got: ${header.join(', ')})`)
  }
  const land = new Map<string, Map<string, number>>()
  for (let n = 1; n < lines.length; n++) {
    const cols = lines[n].split('|')
    const zip = (cols[iZip] ?? '').trim()
    if (!ZIP_RE.test(zip)) continue
    const fips = (cols[iCounty] ?? '').trim().slice(0, 2)
    const code = STATE_BY_FIPS[fips]
    if (!code) { unknown.add(fips); continue }
    const area = Number((cols[iLand] ?? '').trim()) || 0
    const byState = land.get(zip) ?? new Map<string, number>()
    byState.set(code, (byState.get(code) ?? 0) + area)
    land.set(zip, byState)
  }
  for (const [zip, byState] of Array.from(land.entries())) {
    const ranked = Array.from(byState.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    out.set(zip, { state: ranked[0]?.[0] ?? null, states: ranked.map(([s]) => s).sort() })
  }
  return { states: out, unknownFips: Array.from(unknown).sort() }
}

export function buildZipCoordRows(
  points: Map<string, { lat: number; lng: number }>,
  states: Map<string, { state: string | null; states: string[] }>,
  source: string,
): ZipCoordRow[] {
  return Array.from(points.entries())
    .map(([zip, p]) => {
      const s = states.get(zip)
      return { zip, lat: p.lat, lng: p.lng, state: s?.state ?? null, states: s?.states ?? [], source }
    })
    .sort((a, b) => a.zip.localeCompare(b.zip))
}

// What a load would do to the table. `changed` compares coordinates to the
// microdegree (about 10 cm) and the state fields exactly; `source` alone
// changing (a newer file, same point) is counted separately so a yearly
// reload reads as "N moved", not "33,000 changed".
export type ZipCoordDiff = {
  added: ZipCoordRow[]
  moved: { before: ZipCoordRow; after: ZipCoordRow }[]
  sourceOnly: ZipCoordRow[]  // same point and states, newer file — rewritten to restamp source
  unchanged: number
  absentFromFile: string[]   // in the table, not in the file — kept unless --prune
}

const sameStates = (a: string[], b: string[]) => a.length === b.length && a.every((s, i) => s === b[i])

export function diffZipCoords(existing: ZipCoordRow[], incoming: ZipCoordRow[]): ZipCoordDiff {
  const before = new Map(existing.map((r) => [r.zip, r]))
  const seen = new Set<string>()
  const diff: ZipCoordDiff = { added: [], moved: [], sourceOnly: [], unchanged: 0, absentFromFile: [] }
  for (const r of incoming) {
    seen.add(r.zip)
    const b = before.get(r.zip)
    if (!b) { diff.added.push(r); continue }
    const same =
      Math.abs(b.lat - r.lat) < 1e-6 && Math.abs(b.lng - r.lng) < 1e-6 &&
      b.state === r.state && sameStates([...(b.states || [])].sort(), r.states)
    if (!same) diff.moved.push({ before: b, after: r })
    else if (b.source !== r.source) diff.sourceOnly.push(r)
    else diff.unchanged++
  }
  diff.absentFromFile = existing.filter((r) => !seen.has(r.zip)).map((r) => r.zip).sort()
  return diff
}
