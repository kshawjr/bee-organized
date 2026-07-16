// ═══════════════════════════════════════════════════════════════════════════
// Seed: move lead-notification recipients from Zoho INTO Bee Hub, by inserting
// each Zoho-resolving location's contacts into lead_notification_externals.
//
// WHY. resolveLeadRecipients (lib/notification-recipients.ts) prefers Bee Hub
// recipients and only falls back to reading Zoho when a location has NONE. The
// ~44 locations with no owner/manager hub_users therefore still resolve their
// new-lead emails live out of Zoho on every send. Zoho is being sunset, so
// those recipients have to become Bee Hub rows that the existing Settings →
// Communication UI can manage.
//
// ONE-WAY DOOR — READ THIS BEFORE --execute. Writing even ONE external row for
// a location flips it to interface-managed PERMANENTLY: Zoho is never read for
// it again, and from then on the list is whatever is in Bee Hub. That is the
// intent, but it means a wrong or short list doesn't self-heal from Zoho — only
// the nightly top-up (which ADDS but never removes) will touch it again. Hence
// the dry-run default: the rows are reviewed by a human before they land.
//
// SCOPE — locations with ZERO owner/manager hub_users, computed live. The
// locations that DO have them (loc_test, loc_portland, loc_nwarkansas,
// loc_palmbeach, loc_omaha, loc_temecula at time of writing) are EXCLUDED and
// must stay excluded: they already resolve via hub_users and never read Zoho,
// so seeding them wouldn't move them off Zoho — it would just ADD ~9 people to
// the live notification lists of the only active locations. Scope is derived,
// not hardcoded, so it tracks reality.
//
// IDEMPOTENT. Read-then-diff on (location, lowercased email): a contact Bee Hub
// already has is skipped, so a re-run inserts nothing. Safe to run twice.
// Additive only — never updates or deletes an existing row.
//
// This is the FIRST RUN of the same operation the nightly cron performs
// (app/api/cron/zoho-recipient-topup); both share lib/zoho-recipient-topup.ts,
// so what this prints is exactly what the cron would do.
//
// Usage:  node scripts/seed-notification-externals.mjs [--execute] [--env <path>]
//   DRY RUN BY DEFAULT: prints every row it WOULD insert, grouped by location,
//   with totals — and writes NOTHING. --execute performs the inserts, then
//   independently re-reads the table to verify the landed count.
//   --env <path> points at an env file (default: .env.local, then the main
//   checkout's copy, since worktrees don't inherit it).
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

// ── Env ────────────────────────────────────────────────────────────────────
// Loaded into process.env BEFORE importing lib/*, because lib/supabase-service
// and lib/zoho read their config at module scope.
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

// ── Imports (after env) ────────────────────────────────────────────────────
// The real lib modules, not a re-implementation: the Zoho fetch and the
// plan/commit logic are shared with the nightly cron so they can't drift.
const { createClient } = await import('@supabase/supabase-js')
const { getZohoLocationNotificationContacts } = await import(join(repoRoot, 'lib/zoho.ts'))
const { buildTopUpPlan, commitTopUpPlan } = await import(
  join(repoRoot, 'lib/zoho-recipient-topup.ts')
)

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
)

// ── Plan ───────────────────────────────────────────────────────────────────
console.log(`env: ${envPath}`)
console.log(`mode: ${EXECUTE ? 'EXECUTE (will WRITE)' : 'DRY RUN (writes nothing)'}\n`)
console.log('Resolving scope + fetching Zoho contacts (~2 API calls per location)…\n')

const plan = await buildTopUpPlan({
  supabase,
  fetchZohoContacts: getZohoLocationNotificationContacts,
})

const withRows = plan.locations.filter((l) => l.rows.length > 0)
const failed = plan.locations.filter((l) => l.error)

console.log('═'.repeat(74))
console.log('ROWS TO INSERT — grouped by location')
console.log('═'.repeat(74))
for (const lp of plan.locations) {
  if (!lp.rows.length && !lp.error && !lp.already) continue
  const head = `${lp.location.name || '(unnamed)'} [${lp.location.slug}]`
  if (lp.error) {
    console.log(`\n${head}\n  !! ZOHO FETCH FAILED — skipped: ${lp.error}`)
    continue
  }
  const notes = []
  if (lp.already) notes.push(`${lp.already} already in Bee Hub`)
  if (lp.unusable) notes.push(`${lp.unusable} opted-out/no-email`)
  console.log(`\n${head}${notes.length ? `  (${notes.join(', ')})` : ''}`)
  if (!lp.rows.length) {
    console.log('  — nothing to add')
    continue
  }
  for (const r of lp.rows) {
    const name = [r.first_name, r.last_name].filter(Boolean).join(' ') || '(no name)'
    console.log(`  + ${name.padEnd(26)} ${r.email.padEnd(34)} ${r.phone || '(no phone)'}`)
  }
}

console.log(`\n${'═'.repeat(74)}`)
console.log('SUMMARY')
console.log('═'.repeat(74))
console.log(`locations in scope (0 owner/manager hub_users): ${plan.locations.length}`)
console.log(`locations gaining rows:                         ${withRows.length}`)
console.log(`locations that failed the Zoho fetch:           ${failed.length}`)
console.log(`TOTAL ROWS TO INSERT:                           ${plan.rows.length}`)
console.log(
  `distinct emails:                                ${new Set(plan.rows.map((r) => r.email.toLowerCase())).size}`,
)

if (!plan.rows.length) {
  console.log('\nNothing to insert — Bee Hub already has every Zoho contact in scope.')
  process.exit(0)
}

if (!EXECUTE) {
  console.log(
    '\nDRY RUN — nothing was written.\n' +
      'Review the rows above, then re-run with --execute to insert them.',
  )
  process.exit(0)
}

// ── Execute ────────────────────────────────────────────────────────────────
console.log('\n--execute given — inserting…')
const before = await supabase
  .from('lead_notification_externals')
  .select('id', { count: 'exact', head: true })

const { inserted, errors } = await commitTopUpPlan({ supabase }, plan)

const after = await supabase
  .from('lead_notification_externals')
  .select('id', { count: 'exact', head: true })

console.log(`\ninserted (reported):  ${inserted}`)
console.log(`row count before:     ${before.count}`)
console.log(`row count after:      ${after.count}`)
console.log(`delta (independent):  ${(after.count ?? 0) - (before.count ?? 0)}`)
if (errors.length) {
  console.log(`\ninsert errors (${errors.length}):`)
  for (const e of errors) console.log(`  ${e.slug}: ${e.reason}`)
}
const delta = (after.count ?? 0) - (before.count ?? 0)
if (delta !== inserted) {
  console.error(
    `\n!! VERIFY MISMATCH: reported ${inserted} inserted but the table grew by ${delta}.`,
  )
  process.exit(1)
}
console.log('\nVerified: the table grew by exactly the number of rows reported.')
