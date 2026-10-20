// ═══════════════════════════════════════════════════════════════════════════
// LOAD ZIP COORDINATES — fills zip_coords (migrations/zip_coords.sql) from two
// US Census files. HELD. KEVIN RUNS THIS.
// DRY RUN BY DEFAULT: it reads both files and the current table, prints what
// it would add / move / leave, writes a report, and writes nothing to the
// database. --commit to apply.
//
// THE RULES are lib/zip-coords-load.ts (parseGazetteer, parseZipStates,
// buildZipCoordRows, diffZipCoords) — the tests pin them. In short: a zip's
// point is the Census internal point; its state is the one with most of its
// land; a malformed row is rejected and listed, never guessed at.
//
// THE FILES (download, unzip, pass the .txt paths):
//   Gazetteer:    https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/2025_Gaz_zcta_national.zip
//   Relationship: https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt
//
// WHAT IT WILL NOT DO:
//   · never deletes a zip that is in the table but not in the file, unless
//     --prune (a zip retired by the Census can still be on an old lead)
//   · never writes at all without --commit
//   · refuses to run if the Gazetteer yields fewer than 30,000 zips (a wrong
//     or truncated file), or the migration has not been run
//
// YEARLY UPDATE. Re-run with the new year's Gazetteer and --source
// census_gazetteer_<year>. The dry run says how many zips actually moved;
// a source-only change (same point, newer file) is counted separately.
//
// OUTPUT: <reports>/zip-coords-<dryrun|commit>-summary.json, plus
// …-moved.csv listing every zip whose point or state would change.
//
// Usage:
//   node scripts/load-zip-coords.mjs --gazetteer <file> --relationship <file>            # dry run
//   node scripts/load-zip-coords.mjs --gazetteer <file> --relationship <file> --commit   # apply
//   --source census_gazetteer_2025   (default)
//   --prune                          also delete zips no longer in the file
//   --env <path>                     default .env.local
//   --reports <dir>                  default ~/Projects/bee-organized-repair-reports/<today>
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve as resolvePath, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { installTsResolver } from './ts-alias-hook.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolvePath(HERE, '..')

const argv = process.argv.slice(2)
const has = (k) => argv.includes(k)
const val = (k, d = null) => {
  const withEq = argv.find((a) => a.startsWith(k + '='))
  if (withEq) return withEq.slice(k.length + 1)
  const i = argv.indexOf(k)
  return i > -1 && argv[i + 1] ? argv[i + 1] : d
}
const COMMIT = has('--commit')
const PRUNE = has('--prune')
const SOURCE = val('--source', 'census_gazetteer_2025')
const GAZ = val('--gazetteer')
const REL = val('--relationship')
const today = new Date().toISOString().slice(0, 10)
const REPORTS = val('--reports', join(homedir(), 'Projects', 'bee-organized-repair-reports', today))
const MIN_ZIPS = 30000

if (!GAZ || !REL) {
  console.error('Need --gazetteer <file> and --relationship <file>. See the header of this script.')
  process.exit(2)
}
if (!/^[a-z0-9_]+$/.test(SOURCE)) {
  console.error(`--source must be lowercase letters, digits and underscores (got ${SOURCE})`)
  process.exit(2)
}

const envPath = resolvePath(ROOT, val('--env', '.env.local'))
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

installTsResolver(ROOT)
const { createClient } = await import('@supabase/supabase-js')
const { parseGazetteer, parseZipStates, buildZipCoordRows, diffZipCoords } =
  await import(pathToFileURL(ROOT + '/lib/zip-coords-load.ts').href)

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// ── 1. the files ─────────────────────────────────────────────────────────────
const { points, report } = parseGazetteer(readFileSync(GAZ, 'utf8'))
const { states, unknownFips } = parseZipStates(readFileSync(REL, 'utf8'))
const rows = buildZipCoordRows(points, states, SOURCE)
const noState = rows.filter((r) => !r.state).map((r) => r.zip)
const multiState = rows.filter((r) => r.states.length > 1).length

console.log(`Gazetteer: ${report.rows} rows read, ${report.kept} kept, ${report.rejected.length} rejected`)
for (const r of report.rejected.slice(0, 20)) console.log(`  rejected line ${r.line}: ${r.reason}`)
console.log(`States: ${states.size} zips placed, ${multiState} cross a state line, ${noState.length} with no state` +
  (unknownFips.length ? `, unknown state numbers skipped: ${unknownFips.join(', ')}` : ''))
if (rows.length < MIN_ZIPS) {
  console.error(`REFUSING: only ${rows.length} zips — expected at least ${MIN_ZIPS}. Wrong or truncated file?`)
  process.exit(1)
}

// ── 2. the table as it is (paged — Supabase returns 1,000 rows at most) ──────
const existing = []
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb
    .from('zip_coords')
    .select('zip, lat, lng, state, states, source')
    .order('zip', { ascending: true })
    .range(from, from + 999)
  if (error) {
    console.error(`REFUSING: could not read zip_coords (${error.message}). Has migrations/zip_coords.sql been run?`)
    process.exit(1)
  }
  existing.push(...data)
  if (data.length < 1000) break
}

const diff = diffZipCoords(existing, rows)
console.log(`Table now: ${existing.length} zips`)
console.log(`Would add ${diff.added.length}, move ${diff.moved.length}, refresh source on ${diff.sourceOnly.length}, leave ${diff.unchanged} unchanged`)
console.log(`In the table but not the file: ${diff.absentFromFile.length}` + (PRUNE ? ' — WILL BE DELETED (--prune)' : ' — kept (no --prune)'))
for (const m of diff.moved.slice(0, 10)) {
  console.log(`  moved ${m.after.zip}: ${m.before.lat},${m.before.lng} ${m.before.state} → ${m.after.lat},${m.after.lng} ${m.after.state}`)
}

mkdirSync(REPORTS, { recursive: true })
const tag = COMMIT ? 'commit' : 'dryrun'
const summary = {
  ran_at: new Date().toISOString(), commit: COMMIT, prune: PRUNE, source: SOURCE, gazetteer: GAZ, relationship: REL,
  file_zips: rows.length, rejected: report.rejected, multi_state: multiState, no_state: noState, unknown_fips: unknownFips,
  table_before: existing.length, added: diff.added.length, moved: diff.moved.length, source_only: diff.sourceOnly.length,
  unchanged: diff.unchanged, absent_from_file: diff.absentFromFile,
}
writeFileSync(join(REPORTS, `zip-coords-${tag}-summary.json`), JSON.stringify(summary, null, 2))
writeFileSync(
  join(REPORTS, `zip-coords-${tag}-moved.csv`),
  'zip,lat_before,lng_before,state_before,lat_after,lng_after,state_after\n' +
    diff.moved.map((m) => [m.after.zip, m.before.lat, m.before.lng, m.before.state ?? '', m.after.lat, m.after.lng, m.after.state ?? ''].join(',')).join('\n'),
)
console.log(`Report: ${REPORTS}/zip-coords-${tag}-summary.json`)

if (!COMMIT) {
  console.log('DRY RUN — nothing written. Re-run with --commit to apply.')
  process.exit(0)
}

// ── 3. write: upsert everything that isn't unchanged, 500 at a time ──────────
const writeRows = [...diff.added, ...diff.moved.map((m) => m.after), ...diff.sourceOnly]
  .map((r) => ({ ...r, loaded_at: new Date().toISOString() }))
let written = 0
for (let i = 0; i < writeRows.length; i += 500) {
  const batch = writeRows.slice(i, i + 500)
  const { error } = await sb.from('zip_coords').upsert(batch, { onConflict: 'zip' })
  if (error) {
    console.error(`FAILED at batch starting ${batch[0].zip}: ${error.message}. ${written} rows were written before this; re-running is safe.`)
    process.exit(1)
  }
  written += batch.length
}
let pruned = 0
if (PRUNE && diff.absentFromFile.length) {
  for (let i = 0; i < diff.absentFromFile.length; i += 300) {
    const { error, count } = await sb.from('zip_coords').delete({ count: 'exact' }).in('zip', diff.absentFromFile.slice(i, i + 300))
    if (error) { console.error(`FAILED deleting: ${error.message}`); process.exit(1) }
    pruned += count ?? 0
  }
}
console.log(`WROTE ${written} rows${PRUNE ? `, deleted ${pruned}` : ''}.`)
