// scripts/report-seattle-vs-master.mjs
//
// READ-ONLY. §4 — side-by-side of Seattle's six custom templates against the
// corp master content for the same path slots, so Kevin can decide what (if
// anything) to offer them. NO WRITES, and none intended: Seattle's copy is
// theirs. Their steps are derived from Gen 1 but were rewritten by the owner.
//
// The Gen 1 lineage flags are TIERED — byte-equality is the only signal allowed
// to say "identical", and the shared-line probe is reported separately as weak
// scaffold reuse. Read those labels literally before acting on them: an earlier
// version conflated the two and produced a false "verbatim td2" that nearly
// drove an overwrite of live owner-authored copy.
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

    // ── Gen 1 lineage ────────────────────────────────────────────────────────
    // Tiered, never conflated. The previous version called a body "identical"
    // when Seattle's body merely CONTAINED the first >60-char line of the
    // prototype's. That fires on a body genuinely rewritten around a kept emoji
    // bullet — and it did: "Seattle Organizing · Avail + Calendar + Phone" was
    // reported as a verbatim td2 when only its subject and one calendar bullet
    // matched. Acting on that would have overwritten an owner's live copy.
    //
    // Only byte equality may say "identical". The substring probe survives —
    // it is the one signal that catches a partial rewrite — but it is reported
    // separately, as scaffold reuse, and never as a copy.
    const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
    const echoes = []
    for (const g of gen1) {
      // Byte-exact, no trim. NULL is not a match for NULL — two empty fields
      // are not evidence of anything.
      const subjectExact = g.subject != null && theirSubject != null && g.subject === theirSubject
      const bodyExact = g.body != null && theirBody != null && g.body === theirBody
      // Middle tier: same text, reformatted.
      const bodyNorm = !bodyExact && g.body != null && theirBody != null
        && norm(g.body) === norm(theirBody)
      // WEAK: how much of the prototype's long-line scaffold survives verbatim.
      const longLines = String(g.body ?? '').split('\n')
        .map(l => l.trim()).filter(l => l.length > 60)
      const shared = longLines.filter(l => String(theirBody ?? '').includes(l)).length

      if (!subjectExact && !bodyExact && !bodyNorm && !shared) continue
      echoes.push({ g, subjectExact, bodyExact, bodyNorm, shared, ofLines: longLines.length })
    }
    for (const e of echoes) {
      const tag = `${e.g.legacy_id} "${e.g.name}"`
      if (e.subjectExact && e.bodyExact) {
        out(`│   ⛔ VERBATIM GEN 1: subject AND body byte-identical to ${tag}`)
        out(`│      → prototype copy wearing a local name. Nothing was rewritten.`)
        continue
      }
      if (e.subjectExact) out(`│   ⚠ SUBJECT byte-identical to ${tag} (body is NOT)`)
      if (e.bodyExact) out(`│   ⚠ BODY byte-identical to ${tag} (subject is NOT)`)
      if (e.bodyNorm) out(`│   ⚠ BODY identical to ${tag} except whitespace`)
      // Suppress the weak signal when a strong body verdict already covered it.
      if (e.shared && !e.bodyExact && !e.bodyNorm) {
        out(`│   · weak echo: ${e.shared}/${e.ofLines} long line(s) shared with ${tag}`)
        out(`│     scaffold reuse only — the body DIFFERS. Not grounds for a rewrite.`)
      }
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
out(`  · Gen 1 lineage is reported in tiers. Treat them as different claims:`)
out(`      ⛔ VERBATIM      subject AND body byte-identical — a prototype row,`)
out(`                      only renamed. The only tier that justifies a replace.`)
out(`      ⚠ byte-identical on ONE field, or identical but for whitespace.`)
out(`      · weak echo     shared long lines. Scaffold reuse. The body DIFFERS;`)
out(`                      this is what a partial rewrite looks like, and it is`)
out(`                      NOT grounds to overwrite anything.`)
out(`  · Recommendation stands: leave it. Their content, their defaults.`)
out(`    Offer the master side-by-side; let them cherry-pick. No writes here.`)
