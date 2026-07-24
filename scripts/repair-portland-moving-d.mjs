// scripts/repair-portland-moving-d.mjs
//
// §D — Reset Portland's materialized `moving-d` path to the corp master content.
//
// Portland's copy was created by the old savePathToDb(): a bare drip_paths row
// plus steps with subject/body NULL pointing at the Gen 1 prototype rows
// (t1 → td1 → t9). drip-send.ts resolves `step.subject ?? linkedTpl.subject`,
// so this path has been sending prototype copy since 7/13.
//
// The repair copies the master `moving-d` steps' subject/body INLINE onto the
// existing step rows and clears master_template_id, matching exactly what the
// clone route would have produced. Step ids are preserved (UPDATE, not
// delete+insert) so lead_drip_progress keeps pointing at live rows.
//
//   node scripts/repair-portland-moving-d.mjs             # dry run (default)
//   node scripts/repair-portland-moving-d.mjs --execute   # writes

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '')
}

const EXECUTE = process.argv.includes('--execute')
const PATH_KEY = 'moving-d'
const LOCATION_NAME = 'Portland'

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
)
const out = (...a) => console.log(...a)
const die = (m) => { console.error('ABORT:', m); process.exit(1) }

out(EXECUTE ? '🔴 EXECUTE MODE — writes will happen\n' : '🔵 DRY RUN — no writes\n')

// ── Resolve location + its copy ──────────────────────────────────────────────
const { data: loc } = await db
  .from('locations').select('id, name, default_move_drip_path, default_drip_path')
  .eq('name', LOCATION_NAME).maybeSingle()
if (!loc) die(`location "${LOCATION_NAME}" not found`)

const { data: copy } = await db
  .from('drip_paths')
  .select('id, path_key, name, location_uuid, is_master, cloned_from_id')
  .eq('location_uuid', loc.id).eq('path_key', PATH_KEY).maybeSingle()
if (!copy) die(`no ${PATH_KEY} copy for ${loc.name}`)
if (copy.is_master) die('refusing to touch a master row')

const { data: master } = await db
  .from('drip_paths').select('id, path_key, name')
  .eq('is_master', true).eq('path_key', PATH_KEY).maybeSingle()
if (!master) die(`no master for ${PATH_KEY}`)

const [{ data: copySteps }, { data: masterSteps }] = await Promise.all([
  db.from('drip_path_steps')
    .select('id, step_order, delay_days, channel, subject, body, master_template_id')
    .eq('drip_path_id', copy.id).order('step_order'),
  db.from('drip_path_steps')
    .select('step_order, delay_days, channel, subject, body, master_template_id')
    .eq('drip_path_id', master.id).order('step_order'),
])

// ── Preconditions ────────────────────────────────────────────────────────────
out(`location : ${loc.name} (${loc.id})`)
out(`copy     : ${copy.id}  cloned_from=${copy.cloned_from_id ?? 'NULL'}`)
out(`master   : ${master.id} "${master.name}"`)
out(`is this path the location's move default? ${loc.default_move_drip_path === PATH_KEY ? 'YES — it is live' : 'no'}`)
out(`steps    : copy ${copySteps.length} · master ${masterSteps.length}\n`)

if (copySteps.length !== masterSteps.length) {
  die(`step count mismatch (copy ${copySteps.length} vs master ${masterSteps.length}) — needs a hand-built plan`)
}
const orderMismatch = copySteps.some((s, i) => s.step_order !== masterSteps[i].step_order)
if (orderMismatch) die('step_order sequences differ — needs a hand-built plan')

// Refuse to clobber content an owner actually wrote.
const withOwnContent = copySteps.filter(s => s.body && String(s.body).trim() !== '')
if (withOwnContent.length) {
  die(`${withOwnContent.length} step(s) already carry inline content — this is not the NULL-bodied damage pattern, and overwriting would destroy owner-authored copy. Steps: ${withOwnContent.map(s => s.step_order).join(', ')}`)
}

// ── Live exposure ────────────────────────────────────────────────────────────
const { data: progress, error: progErr } = await db
  .from('lead_drip_progress')
  .select('id, lead_id, current_step, last_sent_at, next_send_at, completed_at, stopped_at, paused_at')
  .eq('drip_path_id', copy.id)
  .order('next_send_at', { ascending: true })
if (progErr) die(`lead_drip_progress query failed: ${progErr.message}`)

out('── live leads on this path ──')
if (!progress.length) out('   none')
for (const p of progress) {
  const state = p.stopped_at ? 'stopped' : p.completed_at ? 'completed' : p.paused_at ? 'paused' : 'ACTIVE'
  out(`   lead ${p.lead_id}`)
  out(`      ${state}  current_step=${p.current_step}  last_sent=${p.last_sent_at ?? '—'}`)
  out(`      next_send_at=${p.next_send_at ?? '—'}` +
      (state === 'ACTIVE' && p.next_send_at ? `  ← step ${p.current_step} fires then` : ''))
}
out('   NOTE: already-sent emails cannot be recalled. This repair only changes')
out('         what future steps send.\n')

// ── The diff ─────────────────────────────────────────────────────────────────
const { data: tpls } = await db.from('templates').select('id, legacy_id, name, subject')
const tplById = new Map((tpls ?? []).map(t => [t.id, t]))

const plan = copySteps.map((s, i) => {
  const m = masterSteps[i]
  return {
    id: s.id,
    step_order: s.step_order,
    before: {
      subject: s.subject,
      body: s.body,
      master_template_id: s.master_template_id,
      resolves_to: s.master_template_id ? tplById.get(s.master_template_id) : null,
      delay_days: s.delay_days,
    },
    after: {
      subject: m.subject,
      body: m.body,
      master_template_id: m.master_template_id ?? null,
      delay_days: m.delay_days,
    },
  }
})

out('── PER-STEP DIFF ──')
for (const p of plan) {
  const b = p.before, a = p.after
  out(`\nstep ${p.step_order}  (row ${p.id})`)
  out(`  BEFORE  subject=${b.subject ?? 'NULL'}  body=${b.body ?? 'NULL'}`)
  out(`          master_template_id=${b.master_template_id ?? 'NULL'}` +
      (b.resolves_to ? `  → SENDS "${b.resolves_to.legacy_id}" · ${b.resolves_to.name}` : ''))
  if (b.resolves_to) out(`          actual subject sent: ${b.resolves_to.subject}`)
  out(`  AFTER   subject=${JSON.stringify(a.subject)}`)
  out(`          body: ${String(a.body).split('\n')[0].slice(0, 90)}…  (${String(a.body).length} chars)`)
  out(`          master_template_id=NULL  (content is inline, matching a clone)`)
  out(`  delay_days ${b.delay_days} → ${a.delay_days}${b.delay_days === a.delay_days ? ' (unchanged)' : '  ⚠ CHANGES'}`)
}

out(`\n── ALSO ──`)
out(`  drip_paths.cloned_from_id: ${copy.cloned_from_id ?? 'NULL'} → ${master.id}`)
out(`  (so the row reads as a proper master clone and "Reset to master" behaves)`)

out(`\n── SCOPE ──`)
out(`  rows updated: ${plan.length} drip_path_steps + 1 drip_paths`)
out(`  Gen 1 template rows: NOT touched (still exist; §E quarantines them later)`)
out(`  Seattle: NOT touched`)
out(`  masters: NOT touched`)

if (!EXECUTE) {
  out('\n🔵 DRY RUN complete — nothing written. Re-run with --execute to apply.')
  process.exit(0)
}

// ── Execute ──────────────────────────────────────────────────────────────────
out('\n🔴 writing…')
let n = 0
for (const p of plan) {
  const { error } = await db
    .from('drip_path_steps')
    .update({
      subject: p.after.subject,
      body: p.after.body,
      master_template_id: null,
    })
    .eq('id', p.id)
  if (error) die(`step ${p.step_order} update failed: ${error.message}`)
  n++
  out(`   ✓ step ${p.step_order}`)
}
const { error: pErr } = await db
  .from('drip_paths').update({ cloned_from_id: master.id }).eq('id', copy.id)
if (pErr) die(`path update failed: ${pErr.message}`)
out(`   ✓ cloned_from_id set`)

// ── Verify ───────────────────────────────────────────────────────────────────
const { data: after } = await db
  .from('drip_path_steps')
  .select('step_order, subject, body, master_template_id')
  .eq('drip_path_id', copy.id).order('step_order')

out('\n── VERIFY ──')
let ok = true
for (let i = 0; i < after.length; i++) {
  const a = after[i], m = masterSteps[i]
  const match = a.subject === m.subject && a.body === m.body && a.master_template_id === null
  if (!match) ok = false
  out(`   step ${a.step_order}: ${match ? '✓ matches master' : '✗ MISMATCH'}`)
}
out(ok ? `\n✅ ${n} steps repaired and verified against the master.` : '\n❌ verification FAILED — inspect before trusting.')
