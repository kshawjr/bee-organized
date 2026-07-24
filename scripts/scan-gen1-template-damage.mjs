// scripts/scan-gen1-template-damage.mjs
//
// READ-ONLY. Maps the Gen 1 (prototype) email content blast radius.
//
//   Gen 1 = the 17 t*/ta*..td* rows seeded from BeeHub.jsx DEFAULT_TEMPLATES
//           (migrations/drips_infrastructure.sql, 5/23). Prototype copy.
//   Gen 2 = the 8 master drip_paths + their inline-body steps
//           (migrations/seed_master_drip_paths.sql, 5/24). Kevin's real copy.
//
// A location-owned drip_path step SENDS Gen 1 content when its subject/body
// are NULL and its master_template_id points at a legacy_id-bearing template
// row (drip-send.ts:195 — step.subject ?? linkedTpl.subject).
//
// Usage: node scripts/scan-gen1-template-damage.mjs

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '')
}

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
)

const out = (...a) => console.log(...a)

// ── 1. Template inventory ────────────────────────────────────────────────────
const { data: templates, error: tErr } = await db
  .from('templates')
  .select('id, legacy_id, name, type, tag, subject, location_uuid, created_at')
  .order('created_at', { ascending: true })
if (tErr) throw tErr

const gen1 = templates.filter(t => t.legacy_id && t.location_uuid == null)
const gen2Masters = templates.filter(t => !t.legacy_id && t.location_uuid == null)
const locCustoms = templates.filter(t => t.location_uuid != null)

out('═══ 1. TEMPLATE INVENTORY ═══')
out(`Gen 1 (legacy_id set, corp-owned): ${gen1.length}`)
for (const t of gen1) out(`   ${t.legacy_id.padEnd(5)} ${t.id}  ${t.name}`)
out(`\nGen 2 standalone masters (no legacy_id): ${gen2Masters.length}`)
for (const t of gen2Masters) out(`   ${t.tag ?? '-'} · ${t.name}  (${t.id})`)
out(`\nLocation-owned customs: ${locCustoms.length}`)

// ── 2. Paths + steps ─────────────────────────────────────────────────────────
const { data: locations, error: lErr } = await db
  .from('locations')
  .select('id, name, default_drip_path, default_move_drip_path')
if (lErr) throw lErr
const locName = new Map(locations.map(l => [l.id, l.name]))
const locRow = new Map(locations.map(l => [l.id, l]))

const { data: paths, error: pErr } = await db
  .from('drip_paths')
  .select('id, location_uuid, path_key, name, is_master, is_active, cloned_from_id, created_at')
  .order('created_at', { ascending: true })
if (pErr) throw pErr

const { data: steps, error: sErr } = await db
  .from('drip_path_steps')
  .select('id, drip_path_id, step_order, delay_days, channel, subject, body, master_template_id, is_active')
  .order('step_order', { ascending: true })
if (sErr) throw sErr

const tplById = new Map(templates.map(t => [t.id, t]))
const stepsByPath = new Map()
for (const s of steps) {
  if (!stepsByPath.has(s.drip_path_id)) stepsByPath.set(s.drip_path_id, [])
  stepsByPath.get(s.drip_path_id).push(s)
}

const masterPaths = paths.filter(p => p.is_master)
const copyPaths = paths.filter(p => !p.is_master)

out(`\n═══ 2. PATHS ═══`)
out(`Master paths: ${masterPaths.length}   Location copies: ${copyPaths.length}`)

// ── 3. Damage: which location path steps resolve to Gen 1 content ────────────
out(`\n═══ 3. PROD DAMAGE — location paths SENDING Gen 1 ═══`)

function classifyStep(s) {
  const tpl = s.master_template_id ? tplById.get(s.master_template_id) : null
  const hasInline = s.body != null && String(s.body).trim() !== ''
  if (hasInline) return { verdict: 'INLINE', tpl }
  if (!tpl) return { verdict: 'NO_BODY_SOURCE', tpl }
  if (tpl.legacy_id && tpl.location_uuid == null) return { verdict: 'GEN1', tpl }
  if (tpl.location_uuid != null) return { verdict: 'LOC_CUSTOM_TPL', tpl }
  return { verdict: 'GEN2_TPL', tpl }
}

const damaged = []
for (const p of copyPaths) {
  const ss = stepsByPath.get(p.id) ?? []
  const classified = ss.map(s => ({ s, ...classifyStep(s) }))
  const gen1Steps = classified.filter(c => c.verdict === 'GEN1')
  const loc = locRow.get(p.location_uuid)
  const isDefault =
    loc?.default_drip_path === p.path_key || loc?.default_move_drip_path === p.path_key
  const defaultFor = [
    loc?.default_drip_path === p.path_key ? 'general' : null,
    loc?.default_move_drip_path === p.path_key ? 'move' : null,
  ].filter(Boolean)

  out(`\n── ${locName.get(p.location_uuid) ?? p.location_uuid} / ${p.path_key} ──`)
  out(`   path id ${p.id}  cloned_from=${p.cloned_from_id ?? 'NULL (materialized, not cloned)'}  active=${p.is_active}`)
  out(`   DEFAULT: ${isDefault ? `YES → ${defaultFor.join(' + ')}` : 'no'}`)
  for (const c of classified) {
    const label = c.tpl ? `${c.tpl.legacy_id ?? '—'} "${c.tpl.name}"` : '(no template link)'
    out(`   step ${c.s.step_order} d+${String(c.s.delay_days).padStart(2)} ${c.verdict.padEnd(14)} ${label}`)
    if (c.verdict === 'GEN1') out(`      subj: ${c.tpl.subject}`)
    if (c.verdict === 'INLINE') out(`      subj: ${c.s.subject}`)
  }
  if (gen1Steps.length) {
    damaged.push({ loc: locName.get(p.location_uuid), locId: p.location_uuid, path: p.path_key, pathId: p.id, isDefault, defaultFor, gen1: gen1Steps.length, total: ss.length })
  }
}

out(`\n═══ 4. DAMAGE SUMMARY ═══`)
if (!damaged.length) out('   none')
for (const d of damaged) {
  out(`   ${d.isDefault ? '🔴 SENDING' : '⚪ dormant'}  ${d.loc} / ${d.path}  ${d.gen1}/${d.total} steps on Gen 1${d.isDefault ? ` (default: ${d.defaultFor.join('+')})` : ''}`)
}

// ── 5. Can the 17 Gen 1 rows be deleted? ─────────────────────────────────────
out(`\n═══ 5. GEN 1 REFERENCE COUNT (delete safety) ═══`)
const gen1Ids = new Set(gen1.map(t => t.id))
const refs = steps.filter(s => s.master_template_id && gen1Ids.has(s.master_template_id))
out(`drip_path_steps referencing a Gen 1 template: ${refs.length}`)
const byTpl = new Map()
for (const s of refs) {
  const k = tplById.get(s.master_template_id).legacy_id
  byTpl.set(k, (byTpl.get(k) ?? 0) + 1)
}
for (const [k, n] of [...byTpl].sort()) {
  const path = paths.find(p => p.id === refs.find(r => tplById.get(r.master_template_id).legacy_id === k).drip_path_id)
  out(`   ${k.padEnd(5)} ${n} step(s)  e.g. ${locName.get(path?.location_uuid) ?? 'master'} / ${path?.path_key}`)
}
const unreferenced = gen1.filter(t => !refs.some(r => r.master_template_id === t.id))
out(`Gen 1 rows with ZERO references (safe to drop today): ${unreferenced.length}/${gen1.length}`)
out(`   ${unreferenced.map(t => t.legacy_id).join(', ')}`)

// cloned_from_id on templates — does anything descend from Gen 1?
const derived = templates.filter(t => t.cloned_from_id && gen1Ids.has(t.cloned_from_id))
out(`Templates cloned_from a Gen 1 row: ${derived.length}`)

// ── 6. Location custom templates (Seattle case) ──────────────────────────────
out(`\n═══ 6. LOCATION-OWNED CUSTOM TEMPLATES ═══`)
for (const t of locCustoms) {
  out(`   ${locName.get(t.location_uuid) ?? t.location_uuid} · ${t.name} (${t.type})`)
  out(`      subj: ${t.subject ?? '—'}`)
  out(`      cloned_from: ${t.cloned_from_id ?? 'NULL'}${t.cloned_from_id && gen1Ids.has(t.cloned_from_id) ? '  ← GEN 1 DESCENDANT' : ''}`)
}

// ── 7. Live exposure: leads actively on a damaged path ───────────────────────
out(`\n═══ 7. LIVE EXPOSURE — leads mid-drip on a damaged path ═══`)
for (const d of damaged) {
  const { count, error } = await db
    .from('lead_drip_progress')
    .select('id', { count: 'exact', head: true })
    .eq('drip_path_id', d.pathId)
  if (error) { out(`   ${d.loc}/${d.path}: progress query failed — ${error.message}`); continue }
  out(`   ${d.loc}/${d.path}: ${count} lead_drip_progress row(s)`)
}
