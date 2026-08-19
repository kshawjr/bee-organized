// scripts/retire-welcome-email.mjs
// ═══════════════════════════════════════════════════════════════════════════
// Issue 314 — cancel every Welcome Email that is still queued.
//
// Retiring the Welcome Email takes TWO actions, and doing only one leaves
// half of them firing:
//   1. CODE (shipped with this script): lib/drip-send.ts no longer calls
//      scheduleWelcomeEmail after step 1 succeeds. Stops NEW rows.
//   2. DATA (this script): leads that ALREADY carry a welcome_email_scheduled_at
//      with no welcome_email_sent_at. The code change does not move them — the
//      cron's Queue 2 picks them up on schedule regardless, and most of them
//      are already past due, so they go out on the next tick that reaches them.
//
// Scope — every pending welcome, with no exceptions:
//   welcome_email_scheduled_at IS NOT NULL AND welcome_email_sent_at IS NULL
//
// That predicate is deliberately wider than the cron's own query, which adds
// `.eq('paused', false)`. Paused leads are HELD, not cancelled: their welcome
// is still pending and fires on the first tick after the lead resumes. A sweep
// that mirrored the cron's filter would leave those behind to fire later, which
// is exactly the "half of them still firing" failure this script exists to
// prevent. Future-dated rows are in scope for the same reason.
//
// Already-SENT rows are history and are never touched.
//
// ── THE AUDIT ASYMMETRY, and the choice made here ────────────────────────
// The estimate-email sweep (ec04aee) could leave a trail in the data itself:
// scheduled_stage_emails has a cancelled_reason column, so those 80 rows still
// say WHY they stopped. leads has no such column. Nulling
// welcome_email_scheduled_at is therefore indistinguishable, forever, from a
// lead that was never scheduled at all.
//
// The other option was to tombstone welcome_email_sent_at instead — the idiom
// already used at lib/welcome-email.ts:155-159 for the no-email case. REJECTED.
// welcome_email_sent_at means "this client received the Welcome Email". Setting
// it on rows that were never sent would inflate the sent population from 56 to
// ~99 with no column able to tell the real ones from the tombstones, and it
// cannot be undone later because the distinguishing information is gone the
// moment it is written. These are COMMERCIAL emails carrying an unsubscribe
// record; "did this person actually receive it" is a question that can be asked
// in earnest, and the answer must stay correct.
//
// So: null the schedule, and put the audit trail in a file rather than in a
// column that would have to lie to hold it. Before any write, this script saves
// a JSON manifest of every affected row — id, lead, location, and the exact
// scheduled_at being cleared. That is strictly more than a cancelled_reason
// would have given: it names the individual rows, and it is enough to restore
// them exactly if this ever has to be reversed.
//
// The tombstone's one real advantage was blocking a re-schedule by an older
// deployment still in flight (scheduleWelcomeEmail skips rows with sent_at set).
// That is handled by SEQUENCING instead, and costs nothing: deploy the code
// first, then run this. With the writer gone there is no path that re-queues.
//
// Usage:
//   node scripts/retire-welcome-email.mjs [path/to/.env.local]
//       DRY RUN (default) — reports exactly what it would clear, writes nothing
//   node scripts/retire-welcome-email.mjs --execute [path/to/.env.local]
//       writes the manifest, then applies the cancellation
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

const args = process.argv.slice(2)
const EXECUTE = args.includes('--execute')
const envPath = args.filter(a => !a.startsWith('--'))[0] || '.env.local'

const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]
    })
)

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

// Pull the pending rows with enough context to make the report readable.
// Locations are fetched separately rather than embedded — leads carries both a
// text location_id and a uuid location_uuid, and the send path keys off
// location_uuid, so that is what is resolved here.
const { data: rows, error } = await sb
  .from('leads')
  .select('id, name, email, location_uuid, stage, paused, is_junk, marketing_opt_out, welcome_email_scheduled_at')
  .not('welcome_email_scheduled_at', 'is', null)
  .is('welcome_email_sent_at', null)
  .order('welcome_email_scheduled_at')
  .range(0, 9999)

if (error) {
  console.error('scan failed:', error.message)
  process.exit(1)
}

const live = rows ?? []

const { data: locRows } = await sb.from('locations').select('id, name')
const locName = Object.fromEntries((locRows ?? []).map(l => [l.id, l.name]))
const nameOf = r => locName[r.location_uuid] ?? String(r.location_uuid ?? '—')

console.log('═'.repeat(78))
console.log(EXECUTE ? 'EXECUTE — cancelling pending Welcome Emails' : 'DRY RUN — nothing will be written')
console.log('═'.repeat(78))
console.log(`\npending welcome rows in scope: ${live.length}\n`)

if (live.length === 0) {
  console.log('Nothing to do.')
  process.exit(0)
}

const now = new Date()
const day = d => new Date(d).toISOString().slice(0, 10)

// By location
const byLoc = {}
for (const r of live) {
  const l = nameOf(r)
  byLoc[l] = (byLoc[l] ?? 0) + 1
}
console.log('by location:')
for (const [l, n] of Object.entries(byLoc).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${l.padEnd(24)} ${n}`)
}

// Timing
const dates = live.map(r => new Date(r.welcome_email_scheduled_at)).sort((a, b) => a - b)
console.log(`\nscheduled_at range: ${day(dates[0])} → ${day(dates[dates.length - 1])}`)
const overdue = dates.filter(d => d < now).length
console.log(`already past due (would fire on a tick that reaches them): ${overdue}`)
console.log(`future-dated (not yet due): ${live.length - overdue}`)

// The states that would otherwise have been treated differently by the cron.
const paused = live.filter(r => r.paused === true).length
console.log(`\npaused — HELD by the cron, would fire on resume: ${paused}`)
console.log(`junk (send-time gate would cancel anyway):        ${live.filter(r => r.is_junk === true).length}`)
console.log(`opted out (send-time gate would cancel anyway):   ${live.filter(r => r.marketing_opt_out === true).length}`)
console.log(`no email on file (would tombstone as sent):       ${live.filter(r => !r.email || !String(r.email).trim()).length}`)

console.log('\n── every row ──')
console.log('scheduled'.padEnd(12), 'location'.padEnd(22), 'flags'.padEnd(8), 'lead')
for (const r of live) {
  const flags = [r.paused === true ? 'P' : '', r.is_junk === true ? 'J' : '', r.marketing_opt_out === true ? 'O' : ''].join('') || '—'
  console.log(
    day(r.welcome_email_scheduled_at).padEnd(12),
    nameOf(r).padEnd(22),
    flags.padEnd(8),
    r.name || r.email || r.id,
  )
}

if (!EXECUTE) {
  console.log(`\n${'─'.repeat(78)}`)
  console.log(`DRY RUN — no writes. ${live.length} rows would have`)
  console.log('welcome_email_scheduled_at set to NULL (welcome_email_sent_at left untouched).')
  console.log('Re-run with --execute to apply.')
  process.exit(0)
}

// ── execute ───────────────────────────────────────────────────────────────
// The manifest IS the audit trail — written BEFORE the first write, so a run
// that dies halfway still leaves a complete record of what was in scope.
const stamp = now.toISOString().replace(/[:.]/g, '-')
const manifestPath = `retire-welcome-email-${stamp}.json`
writeFileSync(manifestPath, JSON.stringify({
  issue: 314,
  action: 'welcome_email_scheduled_at → NULL',
  executed_at: now.toISOString(),
  row_count: live.length,
  note: 'leads has no cancelled_reason column; this file is the audit trail. '
      + 'To reverse, restore welcome_email_scheduled_at from rows[].welcome_email_scheduled_at by id.',
  rows: live.map(r => ({
    id: r.id,
    name: r.name,
    email: r.email,
    location_uuid: r.location_uuid,
    location_name: locName[r.location_uuid] ?? null,
    stage: r.stage,
    paused: r.paused,
    is_junk: r.is_junk,
    welcome_email_scheduled_at: r.welcome_email_scheduled_at,
  })),
}, null, 2))
console.log(`\nmanifest written: ${manifestPath}`)

// Update by the exact ids listed above, not by predicate — so what gets
// written is what was printed, even if a row changes state mid-run.
const ids = live.map(r => r.id)
let done = 0
for (let i = 0; i < ids.length; i += 100) {
  const batch = ids.slice(i, i + 100)
  const { error: upErr } = await sb
    .from('leads')
    .update({ welcome_email_scheduled_at: null })
    .in('id', batch)
    .is('welcome_email_sent_at', null)   // belt-and-braces: never clear one that just sent
    .not('welcome_email_scheduled_at', 'is', null)
  if (upErr) {
    console.error(`\nbatch ${i / 100 + 1} failed:`, upErr.message)
    console.error(`manifest at ${manifestPath} lists the full intended scope.`)
    process.exit(1)
  }
  done += batch.length
}

const { count: remaining } = await sb
  .from('leads')
  .select('id', { count: 'exact', head: true })
  .not('welcome_email_scheduled_at', 'is', null)
  .is('welcome_email_sent_at', null)

const { count: stillSent } = await sb
  .from('leads')
  .select('id', { count: 'exact', head: true })
  .not('welcome_email_sent_at', 'is', null)

console.log(`\ncleared ${done} rows.`)
console.log(`pending welcome rows remaining: ${remaining ?? 0} (expected 0)`)
console.log(`welcome_email_sent_at population: ${stillSent ?? 0} (expected UNCHANGED — this script never sets it)`)
