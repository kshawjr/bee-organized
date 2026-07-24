// scripts/scan-seattle-td2-verbatim.mjs
//
// READ-ONLY. Establishes the facts behind the "Seattle renamed td2" claim before
// anything is proposed:
//   1. which of Seattle's templates is a BYTE-FOR-BYTE match to Gen 1 `td2`
//   2. which drip_path_steps reference it, on which path, default or not
//   3. which master path + step_order the slot corresponds to
//   4. live lead_drip_progress exposure on the referencing path
//   5. whether any of Seattle's OTHER templates is also a Gen 1 byte-match
//
// NO WRITES. Nothing here mutates.
//
// Usage: node scripts/scan-seattle-td2-verbatim.mjs

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '')
}

const GEN1_LEGACY_IDS = [
  't1','t2','t3','t4','t5','t6','t7','t8','t9',
  'ta1','ta2','tb1','tb2','tc1','tc2','td1','td2',
]

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
)
const out = (...a) => console.log(...a)
const die = (m) => { console.error('ABORT:', m); process.exit(1) }
const sha = (s) => createHash('sha256').update(String(s ?? ''), 'utf8').digest('hex').slice(0, 16)
// Byte-exact, no trimming, no normalization. NULL !== ''.
const same = (a, b) => a === b

out('═'.repeat(78))
out('SEATTLE — is one of the six a verbatim td2?        READ-ONLY, NO WRITES')
out('═'.repeat(78))

// ── Seattle + its paths ──────────────────────────────────────────────────────
const { data: loc } = await db.from('locations')
  .select('id, name, default_drip_path, default_move_drip_path, lifecycle_status, timezone')
  .eq('name', 'Seattle').maybeSingle()
if (!loc) die('Seattle not found')

out(`\nlocation  : ${loc.name} (${loc.id})`)
out(`lifecycle : ${loc.lifecycle_status}   tz=${loc.timezone ?? '—'}`)
out(`defaults  : general=${loc.default_drip_path ?? '—'}   move=${loc.default_move_drip_path ?? '—'}`)

// ── Gen 1 prototype rows ─────────────────────────────────────────────────────
const { data: gen1Rows, error: g1e } = await db.from('templates')
  .select('id, legacy_id, name, subject, body, location_uuid, is_active')
  .in('legacy_id', GEN1_LEGACY_IDS)
if (g1e) die(g1e.message)
const td2 = (gen1Rows ?? []).find(r => r.legacy_id === 'td2')
if (!td2) die('Gen 1 row td2 not found — cannot verify the claim')
if (td2.location_uuid != null) die('td2 is location-owned — that contradicts its Gen 1 status')

out(`\n── GEN 1 REFERENCE ROW ──`)
out(`   td2  id=${td2.id}`)
out(`        name    : ${td2.name}`)
out(`        is_active: ${td2.is_active}`)
out(`        subject : ${JSON.stringify(td2.subject)}`)
out(`        body    : ${String(td2.body ?? '').length} chars  sha=${sha(td2.body)}`)

// ── Seattle's own templates ──────────────────────────────────────────────────
const { data: seaTpls, error: stE } = await db.from('templates')
  .select('id, legacy_id, name, subject, body, location_uuid, is_active, created_at, updated_at')
  .eq('location_uuid', loc.id)
if (stE) die(stE.message)
out(`\n── SEATTLE-OWNED TEMPLATES (${seaTpls?.length ?? 0}) ──`)

// ── The byte-for-byte test against td2 ───────────────────────────────────────
const exact = (seaTpls ?? []).filter(t => same(t.subject, td2.subject) && same(t.body, td2.body))
const subjOnly = (seaTpls ?? []).filter(t => same(t.subject, td2.subject) && !same(t.body, td2.body))

for (const t of seaTpls ?? []) {
  const verdict = exact.includes(t) ? '★ EXACT td2 MATCH'
    : subjOnly.includes(t) ? '~ subject matches td2, body DIVERGED'
    : ''
  out(`   ${t.id}  ${verdict}`)
  out(`      name     : ${t.name}`)
  out(`      legacy_id: ${t.legacy_id ?? 'NULL'}   is_active=${t.is_active}`)
  out(`      subject  : ${JSON.stringify(t.subject)}`)
  out(`      body     : ${String(t.body ?? '').length} chars  sha=${sha(t.body)}`)
  out(`      updated  : ${t.updated_at ?? '—'}`)
}

out(`\n── VERDICT ──`)
if (subjOnly.length && !exact.length) {
  out(`   ⚠️  ${subjOnly.length} template(s) share td2's SUBJECT but the BODY has diverged.`)
  out(`      Per the abort rule this is NOT a clean verbatim copy — do not overwrite.`)
}
if (exact.length === 0) die('no Seattle template is a byte-for-byte td2 — STOP, the target has diverged or never existed')
if (exact.length > 1) die(`${exact.length} Seattle templates match td2 exactly — ambiguous target, needs a hand-built plan`)
const target = exact[0]
out(`   ✓ exactly one byte-for-byte match: ${target.id} "${target.name}"`)
out(`     subject identical (${td2.subject?.length ?? 0} chars) and body identical (${String(td2.body ?? '').length} chars)`)

// ── Other five: any OTHER Gen 1 byte-match? (report only, per scope) ─────────
out(`\n── OTHER SEATTLE TEMPLATES vs. ALL 17 GEN 1 ROWS (report only) ──`)
let otherMatches = 0
for (const t of seaTpls ?? []) {
  if (t.id === target.id) continue
  for (const g of gen1Rows ?? []) {
    if (same(t.subject, g.subject) && same(t.body, g.body)) {
      otherMatches++
      out(`   ⚠ "${t.name}" (${t.id}) is ALSO byte-identical to ${g.legacy_id} "${g.name}"`)
      out(`     REPORTED, NOT INCLUDED — Kevin scoped this task to the one.`)
    }
  }
}
if (!otherMatches) out(`   none — the other ${(seaTpls?.length ?? 1) - 1} are genuinely rewritten.`)

// ── Who references the target? ───────────────────────────────────────────────
const { data: refSteps, error: rsE } = await db.from('drip_path_steps')
  .select('id, drip_path_id, step_order, delay_days, channel, subject, body, master_template_id')
  .eq('master_template_id', target.id).order('step_order')
if (rsE) die(rsE.message)

const { data: allPaths } = await db.from('drip_paths')
  .select('id, path_key, name, location_uuid, is_master, cloned_from_id')
const pathById = new Map((allPaths ?? []).map(p => [p.id, p]))

out(`\n── DRIP_PATH_STEPS REFERENCING ${target.id} (${refSteps?.length ?? 0}) ──`)
if (!refSteps?.length) die('nothing references this template — replacing its content would change no sends; confirm the target first')

const referencingPathIds = new Set()
for (const s of refSteps) {
  const p = pathById.get(s.drip_path_id)
  const isDefault = p && (loc.default_drip_path === p.path_key || loc.default_move_drip_path === p.path_key)
  const foreign = p && p.location_uuid !== loc.id
  referencingPathIds.add(s.drip_path_id)
  out(`   step row ${s.id}`)
  out(`      path      : ${p?.path_key ?? '?'} "${p?.name ?? '?'}"  (${s.drip_path_id})`)
  out(`      owner     : ${p?.is_master ? 'MASTER ⚠' : p?.location_uuid === loc.id ? 'Seattle' : `OTHER LOCATION ⚠ ${p?.location_uuid}`}`)
  out(`      step_order: ${s.step_order}   delay=+${s.delay_days}d   channel=${s.channel}`)
  out(`      step-level subject: ${s.subject === null ? 'NULL (falls through to the template)' : JSON.stringify(s.subject)}`)
  out(`      step-level body   : ${s.body === null ? 'NULL (falls through to the template)' : `INLINE ${String(s.body).length} chars ⚠ template body is NOT what sends`}`)
  out(`      IS THIS PATH A SEATTLE DEFAULT? ${isDefault ? `YES — live (${loc.default_drip_path === p.path_key ? 'general' : 'move'})` : 'no'}`)
  if (foreign) out(`      ⚠⚠ this step belongs to a path Seattle does not own — OUT OF SCOPE`)
}

// ── Master correspondence ────────────────────────────────────────────────────
out(`\n── MASTER CORRESPONDENCE ──`)
const { data: masterSteps } = await db.from('drip_path_steps')
  .select('drip_path_id, step_order, delay_days, channel, subject, body')
  .order('step_order')

for (const pid of referencingPathIds) {
  const p = pathById.get(pid)
  const master = (allPaths ?? []).find(m => m.is_master && m.path_key === p?.path_key)
  out(`\n   Seattle path ${p?.path_key} → master ${master ? `${master.id} "${master.name}"` : 'NONE FOUND ⚠'}`)
  if (!master) continue
  for (const s of refSteps.filter(x => x.drip_path_id === pid)) {
    const m = (masterSteps ?? []).find(x => x.drip_path_id === master.id && x.step_order === s.step_order)
    out(`   master ${master.path_key} step_order ${s.step_order}: ${m ? 'present' : 'MISSING ⚠'}`)
    if (!m) continue
    out(`      delay  : master +${m.delay_days}d  vs Seattle +${s.delay_days}d${m.delay_days === s.delay_days ? '' : '   (delays are NOT being changed)'}`)
    out(`      subject: ${JSON.stringify(m.subject)}`)
    out(`      body   : ${String(m.body ?? '').length} chars  sha=${sha(m.body)}`)
  }
}

// ── Live exposure ────────────────────────────────────────────────────────────
out(`\n── LIVE lead_drip_progress ON THE REFERENCING PATH(S) ──`)
for (const pid of referencingPathIds) {
  const p = pathById.get(pid)
  const { data: prog, error: pe } = await db.from('lead_drip_progress')
    .select('id, lead_id, current_step, last_sent_at, next_send_at, completed_at, stopped_at, paused_at')
    .eq('drip_path_id', pid).order('next_send_at', { ascending: true })
  if (pe) die(`lead_drip_progress query failed: ${pe.message}`)
  const active = (prog ?? []).filter(r => !r.stopped_at && !r.completed_at && !r.paused_at)
  out(`\n   path ${p?.path_key}: ${prog?.length ?? 0} progress row(s), ${active.length} ACTIVE`)
  for (const r of prog ?? []) {
    const state = r.stopped_at ? 'stopped' : r.completed_at ? 'completed' : r.paused_at ? 'paused' : 'ACTIVE'
    const onTarget = refSteps.some(s => s.drip_path_id === pid && s.step_order === r.current_step)
    out(`      lead ${r.lead_id}  ${state}  current_step=${r.current_step}${onTarget ? '  ← SITTING ON THE TARGET STEP' : ''}`)
    out(`         last_sent=${r.last_sent_at ?? '—'}  next_send_at=${r.next_send_at ?? '—'}`)
  }
  const nextFire = active.map(r => r.next_send_at).filter(Boolean).sort()[0]
  out(`   next send on this path: ${nextFire ?? 'none scheduled'}`)
  if (nextFire) {
    const hrs = (new Date(nextFire) - new Date()) / 36e5
    out(`   → ${hrs < 0 ? `OVERDUE by ${Math.abs(hrs).toFixed(1)}h — the next hourly cron will send it` : `fires in ${hrs.toFixed(1)}h`}`)
  }
}

out(`\n${'═'.repeat(78)}`)
out('READ-ONLY SCAN COMPLETE — nothing was written.')
out('═'.repeat(78))
