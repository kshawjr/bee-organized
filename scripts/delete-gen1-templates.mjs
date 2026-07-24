// scripts/delete-gen1-templates.mjs
//
// §F — DELETE the 17 quarantined Gen 1 prototype template rows.
//
// ── STATUS: HELD — DO NOT EXECUTE (Kevin, 2026-07-24) ──────────────────────
// Dry-run on 7/24 PASSED checks 1–3 but FAILED Check 4: seven templates rows
// carry cloned_from_id → a Gen 1 master. All 7 location customs in the table
// are Gen 1 descendants:
//   - 6 Seattle (created 7/23) — Seattle's live defaults, each wired into
//     exactly one drip_path_step; clones of tc1, td1, tb1, tb2, td2, t4
//   - 1 Palm Beach "How We Help (Copy)" (6/17, active, zero step refs) — t2
// Deleting would NOT break Seattle's sends (steps point at the clones, and
// cloned_from_id is ON DELETE SET NULL with no behavioral reader — the
// duplicate route writes it, the API echoes it, nothing resets-to-master).
// The cost is provenance-only. Kevin's call: leave the 17 quarantined —
// no operational benefit to deleting; it trades reversibility for tidiness
// in a table nobody browses. This script is retained as the review artifact
// so a future session doesn't re-derive the finding.
// ───────────────────────────────────────────────────────────────────────────
//
// Prerequisites (§E quarantine + §D Portland repair, both executed 7/23–24):
//   - all 17 rows sit at is_active=false (soaked)
//   - zero drip_path_steps reference them (Portland's last 3 moved inline)
//
// This is the irreversible step. Every check below must pass or the script
// aborts — including in --execute mode. Both FKs that point at templates
// (drip_path_steps.master_template_id, templates.cloned_from_id) are
// ON DELETE SET NULL, so a stray reference would be silently stranded
// rather than blocking the delete. That's why we count references
// ourselves and refuse on anything nonzero.
//
// The target list is EXPLICIT legacy_ids resolved to row UUIDs, never
// "has a legacy_id" — the 7 Gen 2 standalone masters ('welcome' + 6
// 'opp_*') also carry legacy_ids and are looked up BY legacy_id in
// lib/welcome-email.ts and lib/stage-emails.ts. Deleting one kills a
// live send path.
//
//   node scripts/delete-gen1-templates.mjs             # dry run (default)
//   node scripts/delete-gen1-templates.mjs --execute   # DELETES. No undo.

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '')
}

const EXECUTE = process.argv.includes('--execute')

// The 17. Nothing else. Ever. (Same list as quarantine-gen1-templates.mjs §E.)
const GEN1_LEGACY_IDS = [
  't1','t2','t3','t4','t5','t6','t7','t8','t9',
  'ta1','ta2','tb1','tb2','tc1','tc2','td1','td2',
]
// Explicit deny-list, asserted as a tripwire (same as §E).
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
const die = (m) => { console.error('\nABORT:', m); process.exit(1) }

out(EXECUTE ? '🔴 EXECUTE MODE — rows will be DELETED (irreversible)' : '🔵 DRY RUN — no writes')

// ── Check 1: resolve exactly 17 quarantined, corp-owned rows ─────────────────
const { data: rows, error } = await db
  .from('templates')
  .select('id, legacy_id, name, subject, type, is_active, location_uuid')
  .in('legacy_id', GEN1_LEGACY_IDS)
if (error) die(error.message)

out(`\n── CHECK 1: TARGETS (${rows.length}/${GEN1_LEGACY_IDS.length} found, all must be is_active=false) ──`)
for (const r of [...rows].sort((a, b) => a.legacy_id.localeCompare(b.legacy_id))) {
  out(`   ${r.legacy_id.padEnd(4)} active=${String(r.is_active).padEnd(5)} ${r.id}  ${r.name}`)
}
if (rows.length !== GEN1_LEGACY_IDS.length) {
  const missing = GEN1_LEGACY_IDS.filter(k => !rows.some(r => r.legacy_id === k))
  die(`expected 17 rows, found ${rows.length} (missing: ${missing.join(', ')}) — state changed since §E, re-audit`)
}
const dupCheck = new Set(rows.map(r => r.legacy_id))
if (dupCheck.size !== rows.length) die('duplicate legacy_id among targets — re-audit')
for (const r of rows) {
  if (r.location_uuid != null) die(`${r.legacy_id} is location-owned — refusing`)
  if (r.is_active !== false) die(`${r.legacy_id} is is_active=${r.is_active}, not quarantined — STOP`)
}
out('   ✅ all 17 present, corp-owned, quarantined')

const targetIds = rows.map(r => r.id)

// ── Check 2: Gen 2 tripwire — 7 rows, active, zero overlap ──────────────────
const { data: gen2, error: g2Err } = await db
  .from('templates').select('id, legacy_id, is_active').in('legacy_id', MUST_NEVER_TOUCH)
if (g2Err) die(g2Err.message)
out(`\n── CHECK 2: GEN 2 ROWS (must be 7, active, disjoint from targets) ──`)
for (const g of gen2 ?? []) out(`   ${g.legacy_id.padEnd(28)} active=${g.is_active}`)
if ((gen2 ?? []).length !== MUST_NEVER_TOUCH.length)
  die(`expected ${MUST_NEVER_TOUCH.length} Gen 2 rows, found ${(gen2 ?? []).length}`)
const g2Inactive = gen2.filter(g => !g.is_active)
if (g2Inactive.length) die(`Gen 2 rows inactive: ${g2Inactive.map(g => g.legacy_id).join(', ')}`)
const overlap = gen2.filter(g => targetIds.includes(g.id))
if (overlap.length) die(`target set overlaps Gen 2: ${overlap.map(o => o.legacy_id).join(', ')}`)
out('   ✅ 7/7 active, none in the delete set')

// ── Check 3: zero drip_path_steps references (FK is SET NULL — count, don't trust) ──
const { data: steps, error: sErr } = await db
  .from('drip_path_steps')
  .select('id, drip_path_id, step_order, master_template_id')
  .in('master_template_id', targetIds)
if (sErr) die(sErr.message)
out(`\n── CHECK 3: drip_path_steps referencing a target: ${(steps ?? []).length} ──`)
if ((steps ?? []).length) {
  for (const s of steps) out(`   step ${s.id} (path ${s.drip_path_id}, order ${s.step_order}) → ${s.master_template_id}`)
  die('live step references exist — deleting would strand them (SET NULL). Repair first.')
}
out('   ✅ zero references')

// ── Check 4: zero cloned_from_id descendants (also SET NULL) ────────────────
const { data: kids, error: kErr } = await db
  .from('templates')
  .select('id, legacy_id, name, location_uuid, cloned_from_id')
  .in('cloned_from_id', targetIds)
if (kErr) die(kErr.message)
out(`\n── CHECK 4: templates cloned from a target: ${(kids ?? []).length} ──`)
if ((kids ?? []).length) {
  for (const k of kids) out(`   ${k.id}  ${k.name} (loc ${k.location_uuid}) ← ${k.cloned_from_id}`)
  die('descendant clones exist — deleting would orphan their lineage. Review first.')
}
out('   ✅ zero descendants')

// ── What remains afterward ───────────────────────────────────────────────────
const { data: allRows, error: aErr } = await db
  .from('templates')
  .select('id, legacy_id, name, is_active, location_uuid')
if (aErr) die(aErr.message)
const remaining = allRows.filter(r => !targetIds.includes(r.id))
const remMasters = remaining.filter(r => r.location_uuid == null)
const remCustoms = remaining.filter(r => r.location_uuid != null)
out(`\n── TABLE AFTER DELETE ──`)
out(`   templates now: ${allRows.length} rows → after: ${remaining.length} rows`)
out(`   remaining masters (location_uuid NULL): ${remMasters.length}`)
for (const r of [...remMasters].sort((a, b) => String(a.legacy_id).localeCompare(String(b.legacy_id)))) {
  out(`      ${String(r.legacy_id ?? '—').padEnd(28)} active=${String(r.is_active).padEnd(5)} ${r.name}`)
}
out(`   remaining location customs: ${remCustoms.length}`)

out(`\n── SCOPE ──`)
out(`   DELETE templates rows: ${targetIds.length} (by explicit id)`)
out(`   Gen 2 rows touched: 0`)
out(`   drip_path_steps touched: 0`)
out(`   ⚠ irreversible — no undo flag on this script`)

if (!EXECUTE) {
  out('\n🔵 DRY RUN complete — nothing written.')
  process.exit(0)
}

// ── The delete ───────────────────────────────────────────────────────────────
const { data: deleted, error: dErr } = await db
  .from('templates')
  .delete()
  .in('id', targetIds)
  .select('legacy_id')
if (dErr) die(dErr.message)
out(`\n🔴 deleted ${deleted.length} rows: ${deleted.map(d => d.legacy_id).sort().join(', ')}`)
if (deleted.length !== targetIds.length)
  die(`expected ${targetIds.length} deletions, got ${deleted.length} — VERIFY TABLE STATE NOW`)

// ── Verify ───────────────────────────────────────────────────────────────────
const { data: post } = await db
  .from('templates').select('legacy_id, is_active')
  .in('legacy_id', [...GEN1_LEGACY_IDS, ...MUST_NEVER_TOUCH])
const gen1Left = (post ?? []).filter(p => GEN1_LEGACY_IDS.includes(p.legacy_id))
const gen2Left = (post ?? []).filter(p => MUST_NEVER_TOUCH.includes(p.legacy_id) && p.is_active)
out(`\n── VERIFY ──`)
out(`   Gen 1 rows remaining: ${gen1Left.length} (expect 0)`)
out(`   Gen 2 rows still active: ${gen2Left.length}/${MUST_NEVER_TOUCH.length} (expect 7)`)
if (gen1Left.length) out(`   ⚠ still present: ${gen1Left.map(p => p.legacy_id).join(', ')}`)
if (gen2Left.length !== MUST_NEVER_TOUCH.length) die('GEN 2 ROW COUNT WRONG AFTER DELETE — INVESTIGATE IMMEDIATELY')
out(!gen1Left.length ? '   ✅ clean' : '   ⚠ incomplete')
