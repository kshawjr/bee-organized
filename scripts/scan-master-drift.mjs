// scripts/scan-master-drift.mjs
//
// READ-ONLY. Diffs the Gen 2 corp masters in production against their seed
// content in migrations/seed_master_drip_paths.sql:
//
//   * 7 standalone master templates (welcome + 6 opp_*) — name/subject/body
//   * 8 master drip_paths (is_master=true) — name, and each step's
//     subject/body/delay_days
//
// Also reports every OTHER master template row (location_uuid IS NULL) that
// the seed does not define, so nothing corp-scoped hides from the audit, and
// flags hub_users whose location_id is NULL (they slip the location-mismatch
// guard on /api/drip-paths/[id]).
//
// Writes nothing. Usage: node scripts/scan-master-drift.mjs

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

const SQL = readFileSync(new URL('../migrations/seed_master_drip_paths.sql', import.meta.url), 'utf8')
const out = (...a) => console.log(...a)

// ── Seed parsing ────────────────────────────────────────────────────────────
// Seed uses $tpl$…$tpl$ dollar-quoting for bodies and ''-escaped single
// quotes for the short literals (name/subject).
const unq = (s) => s.trim().replace(/^'|'$/g, '').replace(/''/g, "'")

// SECTION 1 — path_key → name
const seedPaths = new Map()
{
  const block = SQL.split('SECTION 1')[1].split('SECTION 2')[0]
  for (const m of block.matchAll(/\(\s*('(?:[^']|'')*')\s*,\s*('(?:[^']|'')*')\s*\)/g)) {
    seedPaths.set(unq(m[1]), unq(m[2]))
  }
}

// SECTION 2 — steps, keyed `${path_key}#${step_order}`
const seedSteps = new Map()
{
  const block = SQL.split('SECTION 2')[1].split('SECTION 3')[0]
  const re = /SELECT dp\.id,\s*(\d+),\s*(\d+),\s*'(\w+)',\s*('(?:[^']|'')*'),\s*\$tpl\$([\s\S]*?)\$tpl\$,\s*(true|false)\s*FROM drip_paths dp WHERE dp\.is_master = true AND dp\.path_key = ('(?:[^']|'')*')/g
  for (const m of block.matchAll(re)) {
    seedSteps.set(`${unq(m[7])}#${m[1]}`, {
      step_order: Number(m[1]),
      delay_days: Number(m[2]),
      channel: m[3],
      subject: unq(m[4]),
      body: m[5],
    })
  }
}

// SECTION 3 — templates, keyed legacy_id
const seedTemplates = new Map()
{
  const block = SQL.split('SECTION 3')[1]
  const re = /\(('(?:[^']|'')*'),\s*('(?:[^']|'')*'),\s*('(?:[^']|'')*'),\s*('(?:[^']|'')*'),\s*\n?\s*('(?:[^']|'')*'),\s*\n?\s*\$tpl\$([\s\S]*?)\$tpl\$\)/g
  for (const m of block.matchAll(re)) {
    seedTemplates.set(unq(m[1]), {
      name: unq(m[2]),
      type: unq(m[3]),
      tag: unq(m[4]),
      subject: unq(m[5]),
      body: m[6],
    })
  }
}

out('── SEED PARSE ─────────────────────────────────────────────')
out(`paths: ${seedPaths.size}  steps: ${seedSteps.size}  templates: ${seedTemplates.size}`)
if (seedPaths.size !== 8 || seedSteps.size !== 24 || seedTemplates.size !== 7) {
  out('!! parser did not recover the expected 8/24/7 — diff below is UNRELIABLE')
}
out(`templates parsed: ${[...seedTemplates.keys()].join(', ')}`)

// ── Diff helper ─────────────────────────────────────────────────────────────
function showDiff(label, seed, live) {
  if (seed === live) return false
  const s = seed ?? '(null)', l = live ?? '(null)'
  out(`    ✗ ${label}`)
  out(`        seed: ${JSON.stringify(s.length > 120 ? s.slice(0, 120) + '…' : s)}`)
  out(`        live: ${JSON.stringify(l.length > 120 ? l.slice(0, 120) + '…' : l)}`)
  if (s.length !== l.length) out(`        (len seed ${s.length} vs live ${l.length})`)
  return true
}

// ── 1. Master templates ─────────────────────────────────────────────────────
out('\n── 1. GEN 2 MASTER TEMPLATES (7) ──────────────────────────')
const { data: tpls, error: tErr } = await db
  .from('templates')
  .select('id, legacy_id, name, type, tag, subject, body, is_active, location_uuid, created_at, updated_at')
  .is('location_uuid', null)
if (tErr) { out('ERROR', tErr.message); process.exit(1) }

let tplDrift = 0
for (const [legacyId, seed] of seedTemplates) {
  const live = tpls.find(t => t.legacy_id === legacyId)
  if (!live) { out(`  ${legacyId}: MISSING FROM PROD`); tplDrift++; continue }
  const diffs = [
    showDiff('name', seed.name, live.name),
    showDiff('subject', seed.subject, live.subject),
    showDiff('body', seed.body, live.body),
    showDiff('tag', seed.tag, live.tag),
    live.is_active === false ? (out('    ✗ is_active = FALSE (quarantined?)'), true) : false,
  ].filter(Boolean).length
  const stamp = live.updated_at && live.updated_at !== live.created_at
    ? ` [updated_at ${live.updated_at} != created_at ${live.created_at}]` : ''
  out(`  ${diffs ? '✗ DRIFTED' : '✓ pristine'}  ${legacyId} — "${live.name}"${stamp}`)
  if (diffs) tplDrift++
}
out(`  → ${tplDrift}/7 drifted`)

out('\n  Other master rows (location_uuid IS NULL, not in seed):')
const seedIds = new Set(seedTemplates.keys())
for (const t of tpls.filter(t => !seedIds.has(t.legacy_id))) {
  out(`    ${t.legacy_id ?? '(no legacy_id)'} — "${t.name}" active=${t.is_active} subj=${JSON.stringify((t.subject || '').slice(0, 60))}`)
}

// ── 2. Master drip paths + steps ────────────────────────────────────────────
out('\n── 2. GEN 2 MASTER DRIP PATHS (8) ─────────────────────────')
const { data: paths, error: pErr } = await db
  .from('drip_paths')
  .select('id, path_key, name, is_active, is_default, is_master, location_uuid, created_at')
  .eq('is_master', true)
if (pErr) { out('ERROR', pErr.message); process.exit(1) }

const { data: steps, error: sErr } = await db
  .from('drip_path_steps')
  .select('id, drip_path_id, step_order, delay_days, channel, subject, body, master_template_id, is_active, updated_at')
  .in('drip_path_id', paths.map(p => p.id))
if (sErr) { out('ERROR', sErr.message); process.exit(1) }

let pathDrift = 0, stepDrift = 0
for (const [pathKey, seedName] of seedPaths) {
  const live = paths.find(p => p.path_key === pathKey)
  if (!live) { out(`  ${pathKey}: MISSING FROM PROD`); pathDrift++; continue }
  let d = 0
  if (showDiff('path name', seedName, live.name)) d++
  if (live.location_uuid != null) { out(`    ✗ location_uuid is NOT NULL (${live.location_uuid})`); d++ }
  const mine = steps.filter(s => s.drip_path_id === live.id).sort((a, b) => a.step_order - b.step_order)
  for (const s of mine) {
    const seedStep = seedSteps.get(`${pathKey}#${s.step_order}`)
    if (!seedStep) { out(`    ✗ step ${s.step_order}: EXTRA (not in seed)`); stepDrift++; continue }
    let sd = 0
    if (showDiff(`step ${s.step_order} subject`, seedStep.subject, s.subject)) sd++
    if (showDiff(`step ${s.step_order} body`, seedStep.body, s.body)) sd++
    if (seedStep.delay_days !== s.delay_days) {
      out(`    ✗ step ${s.step_order} delay_days: seed ${seedStep.delay_days} vs live ${s.delay_days}`); sd++
    }
    if (s.master_template_id != null) {
      out(`    ✗ step ${s.step_order} master_template_id NOT NULL (${s.master_template_id})`); sd++
    }
    if (sd) stepDrift++
  }
  const expected = [...seedSteps.keys()].filter(k => k.startsWith(pathKey + '#')).length
  if (mine.length !== expected) { out(`    ✗ step count: seed ${expected} vs live ${mine.length}`); d++ }
  out(`  ${d || mine.some(s => {
    const ss = seedSteps.get(`${pathKey}#${s.step_order}`)
    return !ss || ss.subject !== s.subject || ss.body !== s.body || ss.delay_days !== s.delay_days
  }) ? '✗ DRIFTED' : '✓ pristine'}  ${pathKey} — "${live.name}" (${mine.length} steps)`)
  if (d) pathDrift++
}
out(`  → ${pathDrift} path-level drifts, ${stepDrift} step-level drifts`)

out('\n  Master paths in prod not in seed:')
const seedKeys = new Set(seedPaths.keys())
for (const p of paths.filter(p => !seedKeys.has(p.path_key))) {
  out(`    ${p.path_key} — "${p.name}" loc=${p.location_uuid}`)
}

// ── 3. hub_users with NULL location_id ──────────────────────────────────────
out('\n── 3. NULL-LOCATION USERS (slip the location guard) ───────')
const { data: users, error: uErr } = await db
  .from('hub_users')
  .select('id, email, role, location_id, disabled_at')
if (uErr) { out('ERROR', uErr.message) }
else {
  const byRole = {}
  for (const u of users) byRole[u.role] = (byRole[u.role] || 0) + 1
  out(`  role counts: ${JSON.stringify(byRole)}`)
  const nulls = users.filter(u => u.location_id == null && !u.disabled_at)
  out(`  active users with location_id IS NULL: ${nulls.length}`)
  for (const u of nulls) out(`    ${u.role.padEnd(12)} ${u.email}`)
}

out('\nDone — read-only, nothing written.')
