// ═══════════════════════════════════════════════════════════════════════════
// Cleanup: remove lead_notification_externals rows whose email ALSO belongs to
// a hub_user at the same location — the CROSS-TABLE duplication the 2026-07-19
// Zoho seed created (39 rows in prod at time of writing). This is NOT the
// earlier same-table duplication (dedupe-notification-externals.mjs + the
// UNIQUE (location_id, email) index); no single-table constraint can catch a
// person who exists once per table.
//
// WHY THESE ROWS ARE REDUNDANT. An owner/manager hub_user is AUTO-INCLUDED by
// resolveLeadRecipients — their external twin adds nothing to the To line (the
// send path dedupes by email) but it DOES distort routing: the twin was seeded
// with category 'all', so under split notifications it matches every lead and
// the person can never be routed away from anything. The send-path twin
// collapse (filterRecipientsByProjectType) neutralizes that at runtime; this
// script removes the rows themselves so the management UI stops showing every
// owner twice.
//
// WHAT IT WILL **NOT** DELETE (flagged for review instead):
//   · a twin whose hub_user role is NOT owner/manager (e.g. lite_user) — that
//     person is NOT auto-notified, so the external row is the only thing
//     notifying them; deleting it would silence them.
//   · a twin whose category is not 'all' — someone edited it after seeding,
//     which may encode a real routing decision. Merge by hand, don't delete.
//
// ZOHO-OWNED vs ORPHANED. For every affected location the script asks Zoho
// whether the address is still on the Location's notification-contact list.
//   · Zoho-owned  — Zoho still lists it. Deleting is safe TODAY because these
//     locations have an owner/manager hub_user and are therefore entirely OUT
//     of top-up scope; and even if a location fell back into scope (lost every
//     owner/manager), the top-up's hub_user-email exclusion refuses any
//     address that still belongs to a hub_user there. The re-seed risk is the
//     narrow case where BOTH protections lapse: the location re-enters scope
//     AND the hub_user row is gone. If that's a flow you expect (offboarding
//     an owner), remove the address from Zoho too.
//   · orphaned    — Zoho no longer lists it; deletion is permanent.
//
// ALSO REPORTED (read-only, no action): external rows with NO email at all —
// Zoho contact names seeded with a null address. They are invisible in the UI
// and silently dropped at send; listed per location so Kevin can decide
// delete vs repair.
//
// Usage:  node scripts/cleanup-owner-duplicate-externals.mjs [--execute] [--env <path>]
//   DRY RUN BY DEFAULT — prints everything, writes NOTHING. --execute deletes
//   only the rows marked deletable, then independently re-reads the table to
//   verify the landed count. Same convention as the other backfill scripts.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')

const args = process.argv.slice(2)
const EXECUTE = args.includes('--execute')
const envArgIdx = args.indexOf('--env')
const envArg = envArgIdx !== -1 ? args[envArgIdx + 1] : null

// ── Env (before lib imports — supabase-service/zoho read config at module scope)
const envCandidates = [
  envArg && resolve(envArg),
  join(repoRoot, '.env.local'),
  // Worktrees don't inherit .env.local from the main checkout.
  '/Users/flightdeck/projects/clients/bee-organized/repo/.env.local',
].filter(Boolean)

const envPath = envCandidates.find((p) => existsSync(p))
if (!envPath) {
  console.error(`No env file found. Tried:\n  ${envCandidates.join('\n  ')}`)
  process.exit(1)
}
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/)
  if (!m) continue
  if (process.env[m[1]] === undefined) {
    process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
}

const REQUIRED = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ZOHO_API_BASE',
  'ZOHO_CLIENT_ID',
  'ZOHO_CLIENT_SECRET',
  'ZOHO_REFRESH_TOKEN',
]
const missing = REQUIRED.filter((k) => !process.env[k])
if (missing.length) {
  console.error(`Missing required env in ${envPath}: ${missing.join(', ')}`)
  process.exit(1)
}

// ── Imports (after env) — the REAL Zoho client, shared with the seed/cron ──
const { createClient } = await import('@supabase/supabase-js')
const { getZohoLocationNotificationContacts } = await import(join(repoRoot, 'lib/zoho.ts'))

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
)

// Mirrors RECIPIENT_INTERFACE_ROLES (lib/notification-recipients.ts): the
// roles the resolver auto-includes. Only a twin of one of THESE is redundant.
const INTERFACE_ROLES = ['owner', 'manager']

const lc = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '')
const fmtName = (r) => [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || null

console.log(`env: ${envPath}`)
console.log(`mode: ${EXECUTE ? 'EXECUTE (will DELETE)' : 'DRY RUN (writes nothing)'}\n`)

// ── Read everything ────────────────────────────────────────────────────────
const [extRes, userRes, locRes] = await Promise.all([
  supabase
    .from('lead_notification_externals')
    .select('id, location_id, first_name, last_name, email, phone, category, created_at')
    .order('location_id', { ascending: true })
    .order('email', { ascending: true }),
  supabase.from('hub_users').select('id, location_id, role, email, full_name'),
  supabase.from('locations').select('id, name, location_id'),
])
for (const [label, res] of [['externals', extRes], ['hub_users', userRes], ['locations', locRes]]) {
  if (res.error) {
    console.error(`${label} read failed: ${res.error.message}`)
    process.exit(1)
  }
}
const externals = extRes.data || []
const hubUsers = userRes.data || []
const locations = locRes.data || []
const locById = new Map(locations.map((l) => [l.id, l]))
const locLabel = (id) => {
  const l = locById.get(id)
  return l ? `${l.name || '(unnamed)'} [${l.location_id || id}]` : id
}

// hub_users grouped by location, keyed by lowercased email.
const usersByLoc = new Map()
for (const u of hubUsers) {
  if (!u.location_id || !lc(u.email)) continue
  if (!usersByLoc.has(u.location_id)) usersByLoc.set(u.location_id, new Map())
  const m = usersByLoc.get(u.location_id)
  // Several hub_users can share an address across roles; prefer showing the
  // interface-role match since that's what makes the twin redundant.
  const cur = m.get(lc(u.email))
  if (!cur || (!INTERFACE_ROLES.includes(cur.role) && INTERFACE_ROLES.includes(u.role))) {
    m.set(lc(u.email), u)
  }
}

// ── Classify ───────────────────────────────────────────────────────────────
const deletable = [] // twin of an owner/manager, category 'all' → safe to remove
const review = [] // twin, but role not auto-notified OR category was edited
const noEmail = [] // rows with no address at all (reported, untouched)

for (const e of externals) {
  const key = lc(e.email)
  if (!key) {
    noEmail.push(e)
    continue
  }
  const twin = usersByLoc.get(e.location_id)?.get(key)
  if (!twin) continue
  if (!INTERFACE_ROLES.includes(twin.role)) {
    review.push({ e, twin, reason: `hub_user role '${twin.role}' is NOT auto-notified — this row is what notifies them` })
  } else if (String(e.category ?? 'all') !== 'all') {
    review.push({ e, twin, reason: `category ${JSON.stringify(e.category)} was edited after seeding — merge by hand` })
  } else {
    deletable.push({ e, twin })
  }
}

// ── Zoho ownership check (read-only GETs, sequential like the cron) ────────
const affectedLocs = [...new Set(deletable.map((d) => d.e.location_id))]
const zohoByLoc = new Map() // location_id -> Set(lowercased emails) | null (fetch failed / no slug)
for (const locId of affectedLocs) {
  const slug = locById.get(locId)?.location_id
  if (!slug) {
    zohoByLoc.set(locId, null)
    continue
  }
  try {
    const contacts = await getZohoLocationNotificationContacts(slug)
    zohoByLoc.set(locId, new Set(contacts.map((c) => lc(c.email)).filter(Boolean)))
  } catch (err) {
    console.error(`  !! Zoho fetch failed for ${slug}: ${err?.message} — ownership will read 'unknown'`)
    zohoByLoc.set(locId, null)
  }
}
const zohoStatus = (locId, key) => {
  const set = zohoByLoc.get(locId)
  if (set === null || set === undefined) return 'unknown (Zoho unreadable)'
  return set.has(key) ? 'ZOHO-OWNED' : 'orphaned'
}

// ── Report: deletable ──────────────────────────────────────────────────────
console.log('═'.repeat(78))
console.log(`REDUNDANT TWINS — external row duplicates an owner/manager hub_user (${deletable.length})`)
console.log('═'.repeat(78))
let zohoOwnedCount = 0
let byLocPrev = null
for (const { e, twin } of deletable) {
  if (e.location_id !== byLocPrev) {
    byLocPrev = e.location_id
    console.log(`\n${locLabel(e.location_id)}`)
  }
  const z = zohoStatus(e.location_id, lc(e.email))
  if (z === 'ZOHO-OWNED') zohoOwnedCount++
  console.log(
    `  - ${(e.email || '').padEnd(38)} hub_user: ${twin.role.padEnd(8)} ${z}` +
      `   (ext id=${String(e.id).slice(0, 8)}, seeded ${String(e.created_at).slice(0, 10)})`,
  )
}
if (!deletable.length) console.log('  none found')

// ── Report: review-only ────────────────────────────────────────────────────
if (review.length) {
  console.log(`\n${'═'.repeat(78)}`)
  console.log(`FLAGGED FOR REVIEW — twins this script will NOT delete (${review.length})`)
  console.log('═'.repeat(78))
  for (const { e, twin, reason } of review) {
    console.log(`  - ${locLabel(e.location_id)}  ${e.email}  (role ${twin.role})`)
    console.log(`      ${reason}`)
  }
}

// ── Report: no-email rows (informational only) ─────────────────────────────
console.log(`\n${'═'.repeat(78)}`)
console.log(`NO-EMAIL EXTERNALS — invisible in the UI, silently dropped at send (${noEmail.length})`)
console.log('═'.repeat(78))
for (const e of noEmail) {
  console.log(
    `  - ${locLabel(e.location_id)}  name=${JSON.stringify(fmtName(e))} phone=${e.phone || '(none)'}` +
      ` cat=${JSON.stringify(e.category)} id=${String(e.id).slice(0, 8)} created=${String(e.created_at).slice(0, 10)}`,
  )
}
if (!noEmail.length) console.log('  none found')
console.log('  (reported only — this script never touches these rows)')

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(78)}`)
console.log('SUMMARY')
console.log('═'.repeat(78))
console.log(`externals total:                    ${externals.length}`)
console.log(`redundant twins (deletable):        ${deletable.length}`)
console.log(`  of which still listed in Zoho:    ${zohoOwnedCount}  (re-seed only if the location`)
console.log(`                                        re-enters top-up scope AND the hub_user is gone)`)
console.log(`flagged for review (NOT deleted):   ${review.length}`)
console.log(`no-email rows (reported only):      ${noEmail.length}`)

if (!deletable.length) {
  console.log('\nNothing to delete.')
  process.exit(0)
}

if (!EXECUTE) {
  console.log(
    '\nDRY RUN — nothing was deleted.\n' +
      'Review the rows above, then re-run with --execute to remove the redundant twins.',
  )
  process.exit(0)
}

// ── Execute ────────────────────────────────────────────────────────────────
console.log('\n--execute given — deleting…')
const before = await supabase
  .from('lead_notification_externals')
  .select('id', { count: 'exact', head: true })

let deleted = 0
const errors = []
for (const { e } of deletable) {
  const { error } = await supabase.from('lead_notification_externals').delete().eq('id', e.id)
  if (error) errors.push({ id: e.id, email: e.email, reason: error.message })
  else deleted++
}

const after = await supabase
  .from('lead_notification_externals')
  .select('id', { count: 'exact', head: true })

console.log(`\ndeleted (reported):   ${deleted}`)
console.log(`row count before:     ${before.count}`)
console.log(`row count after:      ${after.count}`)
const delta = (before.count ?? 0) - (after.count ?? 0)
console.log(`delta (independent):  ${delta}`)
if (errors.length) {
  console.log(`\ndelete errors (${errors.length}):`)
  for (const e of errors) console.log(`  ${e.email} (${e.id}): ${e.reason}`)
}
if (delta !== deleted) {
  console.error(`\n!! VERIFY MISMATCH: reported ${deleted} deleted but the table shrank by ${delta}.`)
  process.exit(1)
}
console.log('\nVerified: the table shrank by exactly the number of rows reported.')
