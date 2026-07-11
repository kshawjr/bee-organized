// scripts/scan-pause-drift.mjs
// ═══════════════════════════════════════════════════════════════════════════
// One-time drift scan for the two pause signals (2026-07 email-send-
// integrity pass): leads.paused (flag — chip, welcome-hold) vs
// lead_drip_progress.paused_at (row — what the cron obeys). The
// drip-pause/drip-resume endpoints historically wrote the row only, so
// the two can disagree. Both endpoints now sync the flag; this script
// finds and (optionally) repairs rows that diverged before the fix.
//
// Drift types:
//   A  flag=true,  row ACTIVE (paused_at NULL, not stopped/completed)
//      → chip says paused but the cron is still sending. Cause: old
//        drip-resume cleared the row without clearing the flag — the
//        operator's last intent was RESUME. Repair: flag → false.
//   B  flag=false, row PAUSED (paused_at NOT NULL, not stopped/completed)
//      → chip says active but the drip is paused. Cause: old drip-pause
//        stamped the row without setting the flag — last intent was
//        PAUSE. Repair: flag → true.
//
// Repair policy: THE ROW WINS. The row is what the cron actually obeyed,
// and both endpoints wrote the row on every click — the flag is the
// stale side in both drift types.
//
// Usage:
//   node scripts/scan-pause-drift.mjs [path/to/.env.local]      # report only
//   node scripts/scan-pause-drift.mjs --repair [path/to/.env]   # apply flag fixes
//
// Default is DRY RUN. --repair only touches leads.paused (never progress
// rows) and only for the exact ids the scan lists.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

const args = process.argv.slice(2)
const REPAIR = args.includes('--repair')
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

// Pull every non-terminal progress row with its lead's flag, then diff.
// lead_drip_progress is small (one row per enrolled lead per path) so a
// single ranged read is fine.
const { data: rows, error } = await sb
  .from('lead_drip_progress')
  .select('id, lead_id, paused_at, stopped_at, completed_at, leads!inner(id, name, paused, location_id, stage)')
  .is('stopped_at', null)
  .is('completed_at', null)
  .range(0, 9999)

if (error) {
  console.error('scan failed:', error.message)
  process.exit(1)
}

const typeA = [] // flag paused, row active  → repair flag → false
const typeB = [] // flag active, row paused  → repair flag → true

for (const r of rows ?? []) {
  const lead = Array.isArray(r.leads) ? r.leads[0] : r.leads
  if (!lead) continue
  const rowPaused = r.paused_at != null
  if (lead.paused === true && !rowPaused) typeA.push({ ...lead, progress_id: r.id })
  if (lead.paused === false && rowPaused) typeB.push({ ...lead, progress_id: r.id, paused_at: r.paused_at })
}

const show = (list) =>
  list.forEach(l => console.log(`  ${l.id}  ${l.location_id ?? '?'}  stage=${l.stage ?? '?'}  ${l.name ?? ''}`))

console.log(`scanned ${rows?.length ?? 0} non-terminal progress rows\n`)
console.log(`TYPE A — flag paused / row ACTIVE (cron still sending; repair: paused → false): ${typeA.length}`)
show(typeA)
console.log(`\nTYPE B — flag active / row PAUSED (chip lies "active"; repair: paused → true): ${typeB.length}`)
show(typeB)

if (!REPAIR) {
  if (typeA.length || typeB.length) {
    console.log('\nDry run — re-run with --repair to apply the flag fixes above (row state wins).')
  } else {
    console.log('\nNo drift found. Nothing to repair.')
  }
  process.exit(0)
}

let fixed = 0
for (const { list, value } of [{ list: typeA, value: false }, { list: typeB, value: true }]) {
  for (const l of list) {
    const { error: updErr } = await sb
      .from('leads')
      .update({ paused: value, updated_at: new Date().toISOString() })
      .eq('id', l.id)
    if (updErr) console.error(`  repair FAILED for ${l.id}: ${updErr.message}`)
    else fixed++
  }
}
console.log(`\nrepaired ${fixed}/${typeA.length + typeB.length} leads (flag reconciled to row state)`)
