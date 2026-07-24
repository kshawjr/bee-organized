// scripts/scan-seattle-td2-context.mjs
//
// READ-ONLY companion to scan-seattle-td2-verbatim.mjs, which correctly ABORTS
// on divergence before printing the wiring. This prints the wiring + live
// exposure + Gen 1 cross-check anyway, so the STOP report is still complete.
// NO WRITES.

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
const TARGET = '59955ed5-ba2a-4837-b270-298b3e00b5a4'

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
)
const out = (...a) => console.log(...a)
const sha = (s) => createHash('sha256').update(String(s ?? ''), 'utf8').digest('hex').slice(0, 16)

const { data: loc } = await db.from('locations')
  .select('id, name, default_drip_path, default_move_drip_path, timezone')
  .eq('name', 'Seattle').maybeSingle()

const { data: seaTpls } = await db.from('templates')
  .select('id, name, subject, body, created_at, updated_at').eq('location_uuid', loc.id)
const { data: gen1Rows } = await db.from('templates')
  .select('id, legacy_id, name, subject, body').in('legacy_id', GEN1_LEGACY_IDS)

// ── Gen 1 cross-check across ALL six ────────────────────────────────────────
out('═'.repeat(78))
out('ALL SIX SEATTLE TEMPLATES vs. ALL 17 GEN 1 ROWS')
out('═'.repeat(78))
for (const t of seaTpls ?? []) {
  const exact = (gen1Rows ?? []).filter(g => g.subject === t.subject && g.body === t.body)
  const subjOnly = (gen1Rows ?? []).filter(g => g.subject === t.subject && g.body !== t.body)
  const bodyOnly = (gen1Rows ?? []).filter(g => g.body === t.body && g.subject !== t.subject)
  out(`\n"${t.name}"  (${t.id})`)
  out(`   created ${t.created_at}   updated ${t.updated_at}`)
  if (exact.length) out(`   ★ BYTE-IDENTICAL to Gen 1: ${exact.map(g => g.legacy_id).join(', ')}`)
  if (bodyOnly.length) out(`   ⚠ BODY byte-identical to Gen 1 (subject differs): ${bodyOnly.map(g => g.legacy_id).join(', ')}`)
  if (subjOnly.length) out(`   ~ subject only matches ${subjOnly.map(g => g.legacy_id).join(', ')} — body rewritten`)
  if (!exact.length && !bodyOnly.length && !subjOnly.length) out(`   ✓ no Gen 1 match on either field`)
}

// ── Wiring of the target ────────────────────────────────────────────────────
const { data: allPaths } = await db.from('drip_paths')
  .select('id, path_key, name, location_uuid, is_master, cloned_from_id')
const pathById = new Map((allPaths ?? []).map(p => [p.id, p]))

const { data: refSteps } = await db.from('drip_path_steps')
  .select('id, drip_path_id, step_order, delay_days, channel, subject, body, master_template_id')
  .eq('master_template_id', TARGET).order('step_order')

out('\n' + '═'.repeat(78))
out(`WIRING — drip_path_steps referencing the target ${TARGET}`)
out('═'.repeat(78))
out(`Seattle defaults: general=${loc.default_drip_path}  move=${loc.default_move_drip_path}  tz=${loc.timezone}`)
const refPathIds = new Set()
for (const s of refSteps ?? []) {
  const p = pathById.get(s.drip_path_id)
  refPathIds.add(s.drip_path_id)
  const isDefault = p && (loc.default_drip_path === p.path_key || loc.default_move_drip_path === p.path_key)
  out(`\n   step row ${s.id}`)
  out(`      path       : ${p?.path_key} "${p?.name}"  (${s.drip_path_id})`)
  out(`      owner      : ${p?.is_master ? 'MASTER ⚠' : p?.location_uuid === loc.id ? 'Seattle' : 'OTHER ⚠'}`)
  out(`      cloned_from: ${p?.cloned_from_id ?? 'NULL'}`)
  out(`      step_order ${s.step_order}   delay +${s.delay_days}d   channel ${s.channel}`)
  out(`      step.subject: ${s.subject === null ? 'NULL → template supplies it' : JSON.stringify(s.subject)}`)
  out(`      step.body   : ${s.body === null ? 'NULL → template supplies it' : `INLINE ${String(s.body).length} chars`}`)
  out(`      SEATTLE DEFAULT? ${isDefault ? `YES — LIVE (${loc.default_drip_path === p.path_key ? 'general/organizing' : 'move'})` : 'no'}`)
}
if (!refSteps?.length) out('   (nothing references it)')

// ── Master correspondence ───────────────────────────────────────────────────
const { data: masterSteps } = await db.from('drip_path_steps')
  .select('drip_path_id, step_order, delay_days, channel, subject, body').order('step_order')

out('\n' + '═'.repeat(78))
out('MASTER CORRESPONDENCE (what a replacement WOULD have used)')
out('═'.repeat(78))
for (const pid of refPathIds) {
  const p = pathById.get(pid)
  const master = (allPaths ?? []).find(m => m.is_master && m.path_key === p?.path_key)
  out(`\nSeattle ${p?.path_key} → master ${master ? `"${master.name}" (${master.id})` : 'NONE ⚠'}`)
  if (!master) continue
  for (const s of (refSteps ?? []).filter(x => x.drip_path_id === pid)) {
    const m = (masterSteps ?? []).find(x => x.drip_path_id === master.id && x.step_order === s.step_order)
    out(`   step_order ${s.step_order}: ${m ? '' : 'MASTER HAS NO SUCH STEP ⚠'}`)
    if (!m) continue
    out(`      master delay +${m.delay_days}d (Seattle +${s.delay_days}d)`)
    out(`      master subject: ${JSON.stringify(m.subject)}`)
    out(`      master body (${String(m.body ?? '').length} chars, sha=${sha(m.body)}):`)
    out('      ' + '┄'.repeat(66))
    for (const l of String(m.body ?? '').split('\n')) out(`      ${l}`)
    out('      ' + '┄'.repeat(66))
  }
}

// ── Live exposure ───────────────────────────────────────────────────────────
out('\n' + '═'.repeat(78))
out('LIVE lead_drip_progress ON THE REFERENCING PATH(S)')
out('═'.repeat(78))
for (const pid of refPathIds) {
  const p = pathById.get(pid)
  const { data: prog } = await db.from('lead_drip_progress')
    .select('id, lead_id, current_step, last_sent_at, next_send_at, completed_at, stopped_at, paused_at')
    .eq('drip_path_id', pid).order('next_send_at', { ascending: true })
  const active = (prog ?? []).filter(r => !r.stopped_at && !r.completed_at && !r.paused_at)
  out(`\npath ${p?.path_key}: ${prog?.length ?? 0} row(s), ${active.length} ACTIVE`)
  for (const r of prog ?? []) {
    const state = r.stopped_at ? 'stopped' : r.completed_at ? 'completed' : r.paused_at ? 'paused' : 'ACTIVE'
    const onTarget = (refSteps ?? []).some(s => s.drip_path_id === pid && s.step_order === r.current_step)
    out(`   lead ${r.lead_id}  ${state}  step=${r.current_step}${onTarget ? '  ← ON THE TARGET STEP' : ''}`)
    out(`      last_sent=${r.last_sent_at ?? '—'}  next_send_at=${r.next_send_at ?? '—'}`)
  }
  const nextFire = active.map(r => r.next_send_at).filter(Boolean).sort()[0]
  out(`   next send: ${nextFire ?? 'none scheduled'}`)
  if (nextFire) {
    const hrs = (new Date(nextFire) - new Date()) / 36e5
    out(`   → ${hrs < 0 ? `OVERDUE by ${Math.abs(hrs).toFixed(1)}h` : `fires in ${hrs.toFixed(1)}h`}`)
  }
}
out(`\nnow: ${new Date().toISOString()}`)
out('\nREAD-ONLY — nothing written.')
