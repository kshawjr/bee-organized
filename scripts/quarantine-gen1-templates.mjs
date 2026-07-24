// scripts/quarantine-gen1-templates.mjs
//
// §E — Quarantine the 17 Gen 1 prototype template rows.
//
// Gen 1 = t1–t9 + ta1/ta2/tb1/tb2/tc1/tc2/td1/td2, seeded 5/23 by
// drips_infrastructure.sql from the hardcoded DEFAULT_TEMPLATES prototype copy.
//
// The list below is EXPLICIT and must stay that way. Keying on "has a
// legacy_id" would also catch the 7 Gen 2 standalone masters — 'welcome' and
// the 6 'opp_*' rows — which ARE load-bearing:
//   lib/welcome-email.ts  → .eq('legacy_id', 'welcome')
//   lib/stage-emails.ts   → .eq('legacy_id', row.stage_email_key)
// Flipping those dark would silently kill the 24h Welcome and every
// Opportunity-stage email.
//
// Quarantine = is_active:false. It hides the rows from the Templates tab
// (paired with the UI filter) but does NOT break sending: drip-send.ts joins
// templates by id without checking is_active. Fully reversible.
//
//   node scripts/quarantine-gen1-templates.mjs             # dry run (default)
//   node scripts/quarantine-gen1-templates.mjs --execute   # writes
//   node scripts/quarantine-gen1-templates.mjs --undo --execute

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '')
}

const EXECUTE = process.argv.includes('--execute')
const UNDO = process.argv.includes('--undo')
const TARGET_ACTIVE = UNDO ? true : false

// The 17. Nothing else. Ever.
const GEN1_LEGACY_IDS = [
  't1','t2','t3','t4','t5','t6','t7','t8','t9',
  'ta1','ta2','tb1','tb2','tc1','tc2','td1','td2',
]
// Explicit deny-list, asserted below as a tripwire.
const MUST_NEVER_TOUCH = [
  'welcome',
  'opp_closed_job_3mo','opp_closed_job_12mo',
  'opp_organizing_estimate_3d','opp_organizing_estimate_30d',
  'opp_moving_estimate_3d','opp_moving_estimate_30d',
]
for (const id of MUST_NEVER_TOUCH) {
  if (GEN1_LEGACY_IDS.includes(id)) {
    console.error(`ABORT: deny-listed Gen 2 id "${id}" appears in the target list`)
    process.exit(1)
  }
}

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
)
const out = (...a) => console.log(...a)
const die = (m) => { console.error('ABORT:', m); process.exit(1) }

out(EXECUTE ? '🔴 EXECUTE MODE — writes will happen' : '🔵 DRY RUN — no writes')
out(UNDO ? '↩️  UNDO: restoring is_active = true\n' : '🚧 quarantine: setting is_active = false\n')

// ── Resolve targets ──────────────────────────────────────────────────────────
const { data: rows, error } = await db
  .from('templates')
  .select('id, legacy_id, name, type, is_active, location_uuid')
  .in('legacy_id', GEN1_LEGACY_IDS)
if (error) die(error.message)

out(`── TARGETS (${rows.length}/${GEN1_LEGACY_IDS.length} found) ──`)
for (const r of rows.sort((a, b) => a.legacy_id.localeCompare(b.legacy_id))) {
  if (r.location_uuid != null) die(`${r.legacy_id} is location-owned — refusing`)
  out(`   ${r.legacy_id.padEnd(4)} is_active=${String(r.is_active).padEnd(5)} ${r.name}`)
}
const missing = GEN1_LEGACY_IDS.filter(k => !rows.some(r => r.legacy_id === k))
if (missing.length) out(`   (not present: ${missing.join(', ')})`)

// ── Tripwire: confirm the Gen 2 rows are NOT in the target set ───────────────
const { data: gen2 } = await db
  .from('templates').select('legacy_id, is_active').in('legacy_id', MUST_NEVER_TOUCH)
out(`\n── GEN 2 ROWS (must remain untouched & active) ──`)
for (const g of gen2 ?? []) out(`   ${g.legacy_id.padEnd(28)} is_active=${g.is_active}`)
const overlap = (gen2 ?? []).filter(g => rows.some(r => r.legacy_id === g.legacy_id))
if (overlap.length) die(`target set overlaps Gen 2: ${overlap.map(o => o.legacy_id).join(', ')}`)

// ── Live references — quarantine is display-only, but report them ────────────
const ids = new Set(rows.map(r => r.id))
const { data: steps } = await db
  .from('drip_path_steps')
  .select('id, drip_path_id, step_order, subject, body, master_template_id')
  .not('master_template_id', 'is', null)
const refs = (steps ?? []).filter(s => ids.has(s.master_template_id))

out(`\n── LIVE REFERENCES ──`)
if (!refs.length) {
  out('   none — no drip_path_step points at a Gen 1 row')
} else {
  const { data: paths } = await db.from('drip_paths').select('id, path_key, location_uuid, is_master')
  const { data: locs } = await db.from('locations').select('id, name')
  const locName = new Map((locs ?? []).map(l => [l.id, l.name]))
  const pById = new Map((paths ?? []).map(p => [p.id, p]))
  for (const s of refs) {
    const p = pById.get(s.drip_path_id)
    const byName = rows.find(r => r.id === s.master_template_id)?.legacy_id
    const nullBodied = !s.body
    out(`   ${locName.get(p?.location_uuid) ?? 'master'} / ${p?.path_key}  step ${s.step_order} → ${byName}` +
        (nullBodied ? '  ⚠ NULL-bodied: this step SENDS Gen 1 today' : '  (has inline body; template is a dead pointer)'))
  }
  out(`\n   Quarantine does NOT break these — drip-send.ts resolves the join`)
  out(`   without checking is_active. But a step in this list should be`)
  out(`   repaired (§D) before anyone considers DELETING the rows.`)
}

// ── The write ────────────────────────────────────────────────────────────────
const toChange = rows.filter(r => r.is_active !== TARGET_ACTIVE)
out(`\n── SCOPE ──`)
out(`   rows to flip is_active → ${TARGET_ACTIVE}: ${toChange.length}`)
out(`   already at target: ${rows.length - toChange.length}`)
out(`   Gen 2 rows touched: 0`)
out(`   drip_path_steps touched: 0`)
out(`   deletes: 0  (reversible: re-run with --undo --execute)`)

if (!EXECUTE) {
  out('\n🔵 DRY RUN complete — nothing written.')
  process.exit(0)
}
if (!toChange.length) { out('\nnothing to do'); process.exit(0) }

const { data: updated, error: uErr } = await db
  .from('templates')
  .update({ is_active: TARGET_ACTIVE })
  .in('id', toChange.map(r => r.id))
  .select('legacy_id, is_active')
if (uErr) die(uErr.message)

out(`\n🔴 updated ${updated.length} rows`)

// Verify, including that Gen 2 is still active.
const { data: check } = await db
  .from('templates').select('legacy_id, is_active')
  .in('legacy_id', [...GEN1_LEGACY_IDS, ...MUST_NEVER_TOUCH])
const badGen1 = check.filter(c => GEN1_LEGACY_IDS.includes(c.legacy_id) && c.is_active !== TARGET_ACTIVE)
const badGen2 = check.filter(c => MUST_NEVER_TOUCH.includes(c.legacy_id) && c.is_active !== true)
out(`\n── VERIFY ──`)
out(`   Gen 1 at is_active=${TARGET_ACTIVE}: ${check.filter(c => GEN1_LEGACY_IDS.includes(c.legacy_id)).length - badGen1.length}/${GEN1_LEGACY_IDS.length}`)
out(`   Gen 2 still active: ${check.filter(c => MUST_NEVER_TOUCH.includes(c.legacy_id) && c.is_active).length}/${MUST_NEVER_TOUCH.length}`)
if (badGen2.length) die(`GEN 2 ROWS WERE DEACTIVATED: ${badGen2.map(b => b.legacy_id).join(', ')} — UNDO IMMEDIATELY`)
out(badGen1.length ? `   ⚠ ${badGen1.length} Gen 1 rows did not flip` : '   ✅ clean')
