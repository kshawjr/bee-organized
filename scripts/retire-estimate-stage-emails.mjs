// scripts/retire-estimate-stage-emails.mjs
// ═══════════════════════════════════════════════════════════════════════════
// Issue 240 — cancel the estimate follow-ups that are still queued.
//
// Retiring the estimate emails takes TWO actions, and doing only one leaves
// half of them firing:
//   1. CODE (already shipped): 'Estimate Sent' no longer schedules anything.
//      Stops NEW rows.
//   2. DATA (this script): rows already sitting in scheduled_stage_emails
//      with a future send_at. The code change does not move them — the cron
//      picks them up on send_at regardless.
//
// Scope — the four retired keys only:
//   opp_organizing_estimate_3d / _30d
//   opp_moving_estimate_3d     / _30d
// and only rows that are still live: sent_at IS NULL AND cancelled_at IS NULL.
// Already-sent rows are history and are never touched. The two closed-job
// keys (opp_closed_job_3mo / _12mo) are explicitly NOT in scope — those
// emails survive the retirement.
//
// Why not cancelStageEmails(): that helper is per-LEAD and cancels EVERY key
// for the lead. Pointing it at these leads would also cancel their pending
// closed-job follow-ups. This script is key-scoped instead.
//
// cancelled_reason is free text (no CHECK). Existing values in production are
// 'stage_changed' and 'no_email'; this adds 'estimate_emails_retired' so the
// sweep is distinguishable from an ordinary stage-change cancellation, and so
// it can be found again if it ever needs reversing (clear cancelled_at +
// cancelled_reason on exactly that label).
//
// Usage:
//   node scripts/retire-estimate-stage-emails.mjs [path/to/.env.local]
//       DRY RUN (default) — reports exactly what it would cancel, writes nothing
//   node scripts/retire-estimate-stage-emails.mjs --execute [path/to/.env]
//       applies the cancellation
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync } from 'fs'
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

const ESTIMATE_KEYS = [
  'opp_organizing_estimate_3d',
  'opp_organizing_estimate_30d',
  'opp_moving_estimate_3d',
  'opp_moving_estimate_30d',
]
const CANCEL_REASON = 'estimate_emails_retired'

// Pull the live rows with enough lead context to make the report readable.
const { data: rows, error } = await sb
  .from('scheduled_stage_emails')
  .select('id, lead_id, stage_email_key, send_at, leads!inner(name, email, location_id, stage)')
  .in('stage_email_key', ESTIMATE_KEYS)
  .is('sent_at', null)
  .is('cancelled_at', null)
  .order('send_at')
  .range(0, 9999)

if (error) {
  console.error('scan failed:', error.message)
  process.exit(1)
}

const live = rows ?? []
const lead = r => (Array.isArray(r.leads) ? r.leads[0] : r.leads) ?? {}

console.log('═'.repeat(74))
console.log(EXECUTE ? 'EXECUTE — cancelling pending estimate follow-ups' : 'DRY RUN — nothing will be written')
console.log('═'.repeat(74))
console.log(`\nlive rows in scope: ${live.length}\n`)

if (live.length === 0) {
  console.log('Nothing to do.')
  process.exit(0)
}

// By key
const byKey = {}
for (const r of live) byKey[r.stage_email_key] = (byKey[r.stage_email_key] ?? 0) + 1
console.log('by key:')
for (const k of ESTIMATE_KEYS) console.log(`  ${k.padEnd(30)} ${byKey[k] ?? 0}`)

// By location
const byLoc = {}
for (const r of live) {
  const l = lead(r).location_id ?? '(none)'
  byLoc[l] = (byLoc[l] ?? 0) + 1
}
console.log('\nby location:')
for (const [l, n] of Object.entries(byLoc).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${l.padEnd(24)} ${n}`)
}

// When they would have fired
const dates = live.map(r => new Date(r.send_at)).sort((a, b) => a - b)
const day = d => d.toISOString().slice(0, 10)
console.log(`\nsend_at range: ${day(dates[0])} → ${day(dates[dates.length - 1])}`)
const overdue = dates.filter(d => d < new Date()).length
console.log(`already past due (would fire on the next cron tick): ${overdue}`)

// Current stage of the leads — a lead that has moved on is the clearest case
const byStage = {}
for (const r of live) {
  const s = lead(r).stage ?? '(none)'
  byStage[s] = (byStage[s] ?? 0) + 1
}
console.log('\ncurrent stage of the affected leads:')
for (const [s, n] of Object.entries(byStage).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${s.padEnd(24)} ${n}`)
}

console.log('\n── every row ──')
console.log('send_at'.padEnd(12), 'location'.padEnd(22), 'key'.padEnd(30), 'lead')
for (const r of live) {
  const l = lead(r)
  const who = l.name || l.email || r.lead_id
  console.log(
    day(new Date(r.send_at)).padEnd(12),
    String(l.location_id ?? '—').padEnd(22),
    r.stage_email_key.padEnd(30),
    who,
  )
}

if (!EXECUTE) {
  console.log(`\n${'─'.repeat(74)}`)
  console.log(`DRY RUN — no writes. ${live.length} rows would be cancelled with`)
  console.log(`cancelled_reason='${CANCEL_REASON}'.`)
  console.log('Re-run with --execute to apply.')
  process.exit(0)
}

// ── execute ───────────────────────────────────────────────────────────────
// Update by the exact ids listed above, not by predicate — so what gets
// written is what was printed, even if a row changes state mid-run.
const ids = live.map(r => r.id)
const now = new Date().toISOString()
let done = 0
for (let i = 0; i < ids.length; i += 100) {
  const batch = ids.slice(i, i + 100)
  const { error: upErr } = await sb
    .from('scheduled_stage_emails')
    .update({ cancelled_at: now, cancelled_reason: CANCEL_REASON })
    .in('id', batch)
    .is('sent_at', null)      // belt-and-braces: never cancel one that just sent
    .is('cancelled_at', null)
  if (upErr) {
    console.error(`\nbatch ${i / 100 + 1} failed:`, upErr.message)
    process.exit(1)
  }
  done += batch.length
}

const { count: remaining } = await sb
  .from('scheduled_stage_emails')
  .select('id', { count: 'exact', head: true })
  .in('stage_email_key', ESTIMATE_KEYS)
  .is('sent_at', null)
  .is('cancelled_at', null)

console.log(`\ncancelled ${done} rows.`)
console.log(`live estimate rows remaining: ${remaining ?? 0} (expected 0)`)
