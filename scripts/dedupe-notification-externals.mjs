// ═══════════════════════════════════════════════════════════════════════════
// DRY RUN ONLY — analyze the lead_notification_externals duplication and emit
// the exact keep-one-per-group DELETE for Kevin to run in the Supabase SQL
// editor. This script WRITES NOTHING (read-only PostgREST GETs). It deliberately
// has NO --execute path: the cleanup is a STOP-gated production write, run in the
// SQL editor after review, in the required order (dedupe → then the unique-index
// migration, migrations/lead_notification_externals_unique.sql).
//
// What it does:
//   1. Groups every row by (location_id, lower(email)).
//   2. SAFETY VERIFY: confirms no duplicate group has DIFFERING category or name.
//      If any group differs, that is a MERGE decision, not a blind delete — the
//      script prints those groups and marks the run NOT SAFE.
//   3. Reports totals (before / to-delete / after) and per-location before→after.
//   4. Flags (does not act on) loc_scottsdale's angie@ external now that Angie is
//      an owner hub_user with the same address.
//   5. Prints the exact DELETE (ROW_NUMBER keep-newest, singleton-safe).
//
// Usage:  node scripts/dedupe-notification-externals.mjs
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, existsSync } from 'node:fs'

const envCandidates = [
  '.env.local',
  '/Users/flightdeck/projects/clients/bee-organized/repo/.env.local',
]
const envPath = envCandidates.find((p) => existsSync(p))
if (!envPath) {
  console.error(`No env file found. Tried:\n  ${envCandidates.join('\n  ')}`)
  process.exit(1)
}
const env = {}
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/)
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}
const URL = env.NEXT_PUBLIC_SUPABASE_URL
const KEY = env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }
async function get(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: H })
  if (!r.ok) throw new Error(`${r.status} ${await r.text()} for ${path}`)
  return r.json()
}

const fmtName = (r) => [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || null

console.log(`env: ${envPath}`)
console.log('mode: DRY RUN (writes nothing)\n')

const rows = await get(
  'lead_notification_externals?select=id,location_id,first_name,last_name,email,category,created_at&order=location_id,email,created_at',
)
const locs = await get('locations?select=id,name,location_id')
const locById = new Map(locs.map((l) => [l.id, l]))

// ── Group by (location_id, lower(email)) ───────────────────────────────────
const groups = new Map()
for (const r of rows) {
  const k = `${r.location_id}::${(r.email || '').trim().toLowerCase()}`
  if (!groups.has(k)) groups.set(k, [])
  groups.get(k).push(r)
}

// ── SAFETY VERIFY: differing category / name within a duplicate group ──────
const conflicts = []
for (const [k, grp] of groups) {
  if (grp.length < 2) continue
  const cats = new Set(grp.map((r) => String(r.category ?? '')))
  const names = new Set(grp.map((r) => (fmtName(r) || '').toLowerCase()))
  if (cats.size > 1 || names.size > 1) {
    conflicts.push({ k, grp, cats: [...cats], names: [...names] })
  }
}

console.log('═'.repeat(74))
console.log('SAFETY VERIFY — do any duplicate groups DIFFER in category or name?')
console.log('═'.repeat(74))
if (conflicts.length === 0) {
  console.log('OK — every duplicate group is internally identical in category AND name.')
  console.log('     A keep-one delete is safe (no merge decision needed).')
} else {
  console.log(`!! ${conflicts.length} group(s) DIFFER — these are MERGE decisions, NOT blind deletes:`)
  for (const c of conflicts) {
    const [locId, email] = c.k.split('::')
    const loc = locById.get(locId)
    console.log(`\n  ${loc?.location_id || locId} / ${email}`)
    if (c.cats.length > 1) console.log(`     categories: ${JSON.stringify(c.cats)}`)
    if (c.names.length > 1) console.log(`     names:      ${JSON.stringify(c.names)}`)
    for (const r of c.grp) {
      console.log(`       - id=${r.id.slice(0, 8)} name=${JSON.stringify(fmtName(r))} cat=${JSON.stringify(r.category)} created=${r.created_at}`)
    }
  }
  console.log('\n  STOP: resolve these merges before running the DELETE.')
}

// ── Keep-newest-per-group plan ─────────────────────────────────────────────
let deleteCount = 0
const perLoc = new Map() // locId -> { before, after }
for (const [k, grp] of groups) {
  const locId = k.split('::')[0]
  const s = perLoc.get(locId) || { before: 0, after: 0 }
  s.before += grp.length
  s.after += 1 // keep exactly one per group
  perLoc.set(locId, s)
  deleteCount += grp.length - 1
}

console.log(`\n${'═'.repeat(74)}`)
console.log('COUNTS')
console.log('═'.repeat(74))
console.log(`rows before:                 ${rows.length}`)
console.log(`distinct (location, email):  ${groups.size}`)
console.log(`rows to DELETE (dupes):       ${deleteCount}`)
console.log(`rows after:                  ${rows.length - deleteCount}`)

console.log(`\n${'═'.repeat(74)}`)
console.log('PER-LOCATION  before → after  (only locations with rows)')
console.log('═'.repeat(74))
const locRows = [...perLoc.entries()]
  .map(([locId, s]) => ({ slug: locById.get(locId)?.location_id || locId, name: locById.get(locId)?.name || '', ...s }))
  .sort((a, b) => b.before - a.before || a.slug.localeCompare(b.slug))
for (const l of locRows) {
  const flag = l.before !== l.after ? '  (dedup)' : ''
  console.log(`  ${l.slug.padEnd(20)} ${String(l.before).padStart(3)} → ${String(l.after).padStart(3)}${flag}`)
}

// ── Flag (do not act on) scottsdale angie@ vs the owner hub_user ───────────
console.log(`\n${'═'.repeat(74)}`)
console.log('FLAG (no action) — external now redundant with an interface user')
console.log('═'.repeat(74))
const scotts = locs.find((l) => l.location_id === 'loc_scottsdale')
if (scotts) {
  const owners = await get(
    `hub_users?select=email,role,created_at&location_id=eq.${scotts.id}&role=in.(owner,manager)`,
  )
  const ownerEmails = new Set(owners.map((u) => (u.email || '').toLowerCase()))
  const scottsExt = rows.filter((r) => r.location_id === scotts.id)
  const redundant = [
    ...new Set(
      scottsExt
        .filter((r) => ownerEmails.has((r.email || '').toLowerCase()))
        .map((r) => (r.email || '').toLowerCase()),
    ),
  ]
  if (redundant.length) {
    for (const email of redundant) {
      console.log(`  loc_scottsdale external ${email} is also an interface user (owner/manager hub_user).`)
    }
    console.log('  Harmless — the send path dedups user∪external by email — but Kevin may')
    console.log('  want the external dropped so the Settings list is not confusing. NOT deleted here.')
  } else {
    console.log('  none')
  }
} else {
  console.log('  (loc_scottsdale not found)')
}

// ── The exact DELETE (for the SQL editor) ──────────────────────────────────
console.log(`\n${'═'.repeat(74)}`)
console.log('PROPOSED DELETE — keep newest per (location_id, lower(email)); singleton-safe')
console.log('(run in the Supabase SQL editor AFTER the safety verify is OK; then run')
console.log(' migrations/lead_notification_externals_unique.sql)')
console.log('═'.repeat(74))
console.log(`
DELETE FROM public.lead_notification_externals x
USING (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY location_id, lower(email)
           ORDER BY created_at DESC, id DESC
         ) AS rn
  FROM public.lead_notification_externals
) d
WHERE x.id = d.id
  AND d.rn > 1;   -- rn = 1 (newest) always kept; a single-row group is never touched
`)
console.log(`Expected: ${rows.length} → ${rows.length - deleteCount} rows (${deleteCount} deleted).`)
if (conflicts.length) {
  console.log('\n!! NOT SAFE TO RUN YET — resolve the DIFFERING groups above first.')
  process.exit(2)
}
console.log('\nSafe to run (no differing groups). HOLD for Kevin\'s approval before executing.')
