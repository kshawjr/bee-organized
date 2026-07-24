// scripts/report-seattle-vs-master.mjs
//
// READ-ONLY. §4 — side-by-side of Seattle's six custom templates against the
// corp master content for the same path slots, so Kevin can decide what (if
// anything) to offer them. NO WRITES, and none intended: Seattle's copy is
// theirs. Their steps are derived from Gen 1 but were rewritten by the owner.
//
// Usage: node scripts/report-seattle-vs-master.mjs [--full]
//   --full prints whole bodies instead of the first 3 lines.

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '')
}

const FULL = process.argv.includes('--full')
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
)
const out = (...a) => console.log(...a)
const snip = (s, n = 3) => {
  const t = String(s ?? '')
  if (FULL) return t
  const lines = t.split('\n').filter(Boolean).slice(0, n)
  return lines.join('\n') + (t.split('\n').filter(Boolean).length > n ? '\n   …' : '')
}

const { data: loc } = await db.from('locations')
  .select('id, name, default_drip_path, default_move_drip_path')
  .eq('name', 'Seattle').maybeSingle()
if (!loc) { console.error('Seattle not found'); process.exit(1) }

const { data: paths } = await db.from('drip_paths')
  .select('id, path_key, name, cloned_from_id')
  .eq('location_uuid', loc.id).order('path_key')

const { data: masters } = await db.from('drip_paths')
  .select('id, path_key, name').eq('is_master', true)
const masterByKey = new Map((masters ?? []).map(m => [m.path_key, m]))

const { data: allSteps } = await db.from('drip_path_steps')
  .select('drip_path_id, step_order, delay_days, channel, subject, body, master_template_id')
  .order('step_order')
const stepsFor = (id) => (allSteps ?? []).filter(s => s.drip_path_id === id)

const { data: tpls } = await db.from('templates')
  .select('id, legacy_id, name, subject, body, location_uuid, is_active')
const tplById = new Map((tpls ?? []).map(t => [t.id, t]))
const gen1 = (tpls ?? []).filter(t => /^t[1-9]$|^t[abcd][12]$/.test(t.legacy_id ?? ''))

out('═'.repeat(78))
out('SEATTLE — custom drip content vs. the corp masters      REPORT ONLY, NO WRITES')
out('═'.repeat(78))
out(`location: ${loc.name} (${loc.id})`)
out(`defaults: general=${loc.default_drip_path ?? '—'}  move=${loc.default_move_drip_path ?? '—'}`)

for (const p of paths ?? []) {
  const master = masterByKey.get(p.path_key)
  const isDefault = loc.default_drip_path === p.path_key || loc.default_move_drip_path === p.path_key
  out(`\n${'━'.repeat(78)}`)
  out(`PATH  ${p.path_key}  "${p.name}"${isDefault ? '   ← CURRENTLY THEIR DEFAULT (live)' : ''}`)
  out(`      cloned_from=${p.cloned_from_id ?? 'NULL (materialized by the old savePathToDb)'}`)
  out('━'.repeat(78))

  const theirs = stepsFor(p.id)
  const mine = master ? stepsFor(master.id) : []

  for (const s of theirs) {
    const m = mine.find(x => x.step_order === s.step_order)
    const tpl = s.master_template_id ? tplById.get(s.master_template_id) : null
    const theirSubject = s.subject ?? tpl?.subject ?? null
    const theirBody = s.body ?? tpl?.body ?? null

    out(`\n┌─ STEP ${s.step_order}  (+${s.delay_days}d, ${s.channel}) ${'─'.repeat(40)}`)
    out(`│ SEATTLE  source: ${s.body ? 'inline on the step' : tpl ? `template "${tpl.name}"${tpl.location_uuid ? ' (their own)' : ' (CORP ROW ⚠)'}` : 'NONE'}`)
    out(`│   subject: ${theirSubject ?? '—'}`)
    for (const l of snip(theirBody).split('\n')) out(`│   ${l}`)

    // Gen 1 lineage, reported precisely: SUBJECT match is exact-string; BODY
    // match needs a substantial shared opening paragraph (the "Hi {{first_name}},"
    // greeting is common to every template and proves nothing).
    const echoes = []
    for (const g of gen1) {
      const subjectSame = g.subject && theirSubject && g.subject.trim() === theirSubject.trim()
      const gPara = String(g.body ?? '').split('\n').filter(Boolean).find(l => l.trim().length > 60)
      const bodySame = gPara && theirBody && String(theirBody).includes(gPara.trim())
      if (subjectSame || bodySame) {
        echoes.push({ g, what: [subjectSame && 'subject', bodySame && 'body'].filter(Boolean).join(' + ') })
      }
    }
    for (const e of echoes) {
      out(`│   ⚠ GEN 1 LINEAGE: ${e.what} identical to ${e.g.legacy_id} "${e.g.name}"`)
    }

    out(`│`)
    out(`│ MASTER (${master?.path_key ?? '—'} step ${s.step_order})`)
    if (!m) { out('│   (master has no step at this position)') }
    else {
      out(`│   +${m.delay_days}d${m.delay_days !== s.delay_days ? `  ⚠ timing differs (theirs +${s.delay_days}d)` : ''}`)
      out(`│   subject: ${m.subject ?? '—'}`)
      for (const l of snip(m.body).split('\n')) out(`│   ${l}`)
    }
    out(`└${'─'.repeat(60)}`)
  }
  const extra = mine.filter(m => !theirs.some(s => s.step_order === m.step_order))
  for (const m of extra) out(`\n  (master has an extra step ${m.step_order} (+${m.delay_days}d) Seattle does not: "${m.subject}")`)
}

out(`\n${'═'.repeat(78)}`)
out('READING THIS')
out('═'.repeat(78))
out(`  · Seattle's steps resolve through their OWN location-owned templates.`)
out(`    Nothing of Kevin's is being displaced — this is not the Portland bug.`)
out(`  · "GEN 1 LINEAGE" flags where their text still matches a prototype row`)
out(`    verbatim, i.e. the parts they kept rather than rewrote.`)
out(`  · Recommendation stands: leave it. Their content, their defaults.`)
out(`    Offer the master side-by-side; let them cherry-pick. No writes here.`)
