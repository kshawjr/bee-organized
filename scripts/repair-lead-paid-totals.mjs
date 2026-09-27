// ═══════════════════════════════════════════════════════════════════════════
// Repair: leads.paid_amount = the sum of the person's paid invoices
// (2026-09-27 — companion to lib/lead-paid-total.ts)
//
// Usage:  node scripts/repair-lead-paid-totals.mjs                 (dry run)
//         node scripts/repair-lead-paid-totals.mjs --execute       (writes)
//         node scripts/repair-lead-paid-totals.mjs --undo <report.run.json>
//         [--env <path>]   default .env.local
//
// THE DEFECT. The INVOICE webhook and the import OVERWROTE leads.paid_amount
// with whichever invoice was paid last, so the stored "lifetime paid" was one
// invoice (and a -$92.58 refund read as -$92.58 lifetime). Both writers now
// recompute the sum; this puts every existing row right once.
//
// THE NUMBER comes from lib/lead-paid-total.ts sumPaidInvoices — the same
// function the webhook and the import now call — loaded through
// ts-alias-hook, so the repair cannot disagree with the writers.
//
// WHAT IT WRITES. leads.paid_amount only, and only where it differs from the
// sum by more than a cent. Each write is guarded on the value this run read,
// so a row the webhook updated in between is skipped, not clobbered. No
// route, no drip, no email, no Jobber write; the only trigger on leads bumps
// updated_at. One sync_log summary row per location (not one per person).
//
// REVERSIBLE. The run report holds every row's before-value; --undo restores
// them, guarded on the value this run wrote.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { installTsResolver } from './ts-alias-hook.mjs'

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const val = (k, d = null) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : d }
const EXECUTE = argv.includes('--execute')
const UNDO = val('--undo')

const envPath = resolvePath(process.cwd(), val('--env', '.env.local'))
if (!existsSync(envPath)) { console.error(`missing env file at ${envPath}`); process.exit(1) }
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  if (!line.includes('=') || line.trim().startsWith('#')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  if (!(k in process.env)) process.env[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
}
const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SB_URL || !SB_KEY) { console.error('missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1) }

installTsResolver(ROOT)
const { sumPaidInvoices } = await import(pathToFileURL(ROOT + '/lib/lead-paid-total.ts').href)

async function sb(path, opts = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  })
  if (!res.ok) throw new Error(`PostgREST ${res.status} ${path.slice(0, 120)}: ${(await res.text()).slice(0, 300)}`)
  const text = await res.text(); return text ? JSON.parse(text) : null
}
async function sbAll(base) {
  const out = []
  for (let from = 0; ; from += 1000) {
    const page = await sb(`${base}${base.includes('?') ? '&' : '?'}order=id&offset=${from}&limit=1000`)
    out.push(...page); if (page.length < 1000) break
  }
  return out
}
async function sbIn(table, select, col, ids) {
  const out = []
  for (let i = 0; i < ids.length; i += 150) out.push(...await sbAll(`${table}?select=${select}&${col}=in.(${ids.slice(i, i + 150).join(',')})`))
  return out
}
const nowIso = () => new Date().toISOString()
const num = v => (v == null ? null : Number(v))
const same = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 0.005)
// PostgREST guard on the value a row held when read.
const guard = v => (v == null ? 'paid_amount=is.null' : `paid_amount=eq.${v}`)

async function sideEffectSnapshot(leadIds) {
  const count = async (table) => (await sbIn(table, 'id', 'lead_id', leadIds)).length
  return {
    lead_drip_progress: await count('lead_drip_progress'),
    scheduled_stage_emails: await count('scheduled_stage_emails'),
    notification_log: await count('notification_log'),
  }
}
function assertNoDrift(before, after) {
  const drifted = Object.keys(before).filter(k => before[k] !== after[k])
  if (drifted.length) {
    console.error(`✗ SIDE-EFFECT COUNTER DRIFT: ${drifted.map(k => `${k} ${before[k]}→${after[k]}`).join(', ')} — investigate`)
    process.exitCode = 2
  } else console.log(`side-effect counters unchanged on the affected people: ${JSON.stringify(after)}`)
}

if (UNDO) {
  const run = JSON.parse(readFileSync(UNDO, 'utf8'))
  if (run.mode !== 'execute') { console.error('--undo takes a report from an --execute run'); process.exit(1) }
  const leadIds = run.changes.map(c => c.lead_id)
  const before = await sideEffectSnapshot(leadIds)
  let reverted = 0
  for (const c of run.changes) {
    const rows = await sb(`leads?id=eq.${c.lead_id}&${guard(c.after)}`, { method: 'PATCH', body: JSON.stringify({ paid_amount: c.before }), headers: { Prefer: 'return=representation' } })
    if (rows?.length) reverted++
    else console.log(`  skipped ${c.lead_id}: paid_amount changed since the run`)
  }
  console.log(`reverted ${reverted}/${run.changes.length}`)
  assertNoDrift(before, await sideEffectSnapshot(leadIds))
  process.exit()
}

console.log(`repair-lead-paid-totals — ${EXECUTE ? '⚠ EXECUTE (writes to prod)' : 'DRY RUN (no writes)'}\n`)

const locations = await sbAll('locations?select=id,name,location_id')
const locName = Object.fromEntries(locations.map(l => [l.id, l.name]))
const locSlug = Object.fromEntries(locations.map(l => [l.id, l.location_id]))

const invoices = await sbAll('invoices?select=id,lead_id,status,total,paid_amount&lead_id=not.is.null')
const invBy = {}
for (const i of invoices) (invBy[i.lead_id] ||= []).push(i)
// Every lead that has an invoice, or a stored total with no invoice behind it.
const stored = await sbAll('leads?select=id,name,email,phone,paid_amount,is_junk,location_uuid&paid_amount=not.is.null')
const storedIds = new Set(stored.map(s => s.id))
const invLeadIds = Object.keys(invBy).filter(id => !storedIds.has(id))
const leads = [...stored, ...await sbIn('leads', 'id,name,email,phone,paid_amount,is_junk,location_uuid', 'id', invLeadIds)]

const changes = []
for (const l of leads) {
  const before = num(l.paid_amount)
  const after = sumPaidInvoices(invBy[l.id] || [])
  if (!same(before, after)) changes.push({ l, before, after })
}

// ── status projection — only the Past-client test reads the total ─────────
const changedIds = changes.map(c => c.l.id)
const engs = await sbIn('engagements', 'client_id,stage', 'client_id', changedIds)
const open = new Set(), won = new Set()
for (const e of engs) { if (e.stage === 'Closed Won') won.add(e.client_id); else if (e.stage !== 'Closed Lost') open.add(e.client_id) }
const status = (l, paid) => {
  if (!(l.email || '').trim() && !(l.phone || '').trim()) return 'No contact'
  if (open.has(l.id)) return 'Active'
  if (won.has(l.id)) return 'Client'
  return (paid || 0) > 0 ? 'Past client' : 'Nurturing'
}
const moves = {}, moveList = []
for (const c of changes) {
  if (c.l.is_junk === true) continue
  const b = status(c.l, c.before), a = status(c.l, c.after)
  if (b !== a) { const k = `${b} → ${a}`; moves[k] = (moves[k] || 0) + 1; moveList.push({ lead_id: c.l.id, name: c.l.name, loc: locName[c.l.location_uuid], move: k, before: c.before, after: c.after }) }
}

// ── shapes ──────────────────────────────────────────────────────────────────
const shape = c => {
  if (c.after == null) return 'stored total but no paid invoice → cleared'
  if (c.before == null) return 'never filled in → set to the sum'
  if (c.before < 0) return 'negative (a refund was the last paid invoice) → sum'
  if (c.before < c.after) return 'too low (last invoice only) → sum'
  return 'too high → sum'
}
const shapes = {}
for (const c of changes) shapes[shape(c)] = (shapes[shape(c)] || 0) + 1
const negSums = changes.filter(c => (c.after ?? 0) < 0).length

console.log(`leads read: ${leads.length} · invoices read: ${invoices.length}`)
console.log(`→ WOULD CHANGE paid_amount on ${changes.length} people`)
for (const [k, n] of Object.entries(shapes)) console.log(`   ${k}: ${n}`)
console.log(`   people whose corrected lifetime total is itself negative: ${negSums}`)
console.log(`\nstatus moves (${moveList.length}):`)
for (const [k, n] of Object.entries(moves)) console.log(`   ${k}: ${n}`)
for (const m of moveList) console.log(`     ${m.name} (${m.loc}): ${m.move}  [${m.before} → ${m.after}]`)
console.log(`\nsample (first 10):`)
for (const c of changes.slice(0, 10)) console.log(`   ${locSlug[c.l.location_uuid]} ${c.l.name}: ${c.before} → ${c.after}`)

const report = {
  mode: EXECUTE ? 'execute' : 'dry-run',
  at: nowIso(),
  changeCount: changes.length,
  shapes, statusMoves: moves, moveList,
  changes: changes.map(c => ({ lead_id: c.l.id, slug: locSlug[c.l.location_uuid] || 'unknown', before: c.before, after: c.after })),
  errors: [],
}

if (EXECUTE) {
  console.log('\nexecuting…')
  const before = await sideEffectSnapshot(changedIds)
  let done = 0
  const perSlug = {}
  for (const c of report.changes) {
    try {
      const rows = await sb(`leads?id=eq.${c.lead_id}&${guard(c.before)}`, { method: 'PATCH', body: JSON.stringify({ paid_amount: c.after }), headers: { Prefer: 'return=representation' } })
      if (!rows?.length) { report.errors.push(`${c.lead_id}: paid_amount changed since the plan was read — skipped`); continue }
      done++; perSlug[c.slug] = (perSlug[c.slug] || 0) + 1
    } catch (err) { report.errors.push(`${c.lead_id}: ${err.message}`); console.error(`  ✗ ${c.lead_id}: ${err.message}`) }
  }
  for (const [slug, n] of Object.entries(perSlug)) {
    await sb('sync_log', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ location_id: slug, direction: 'inbound', entity_type: 'client', status: 'success', message: `[lead:repair] paid_amount recomputed as the sum of paid invoices on ${n} people (repair-lead-paid-totals)` }) })
  }
  console.log(`updated ${done}/${report.changes.length}`)
  assertNoDrift(before, await sideEffectSnapshot(changedIds))
}

const outPath = `repair-lead-paid-totals.report.${EXECUTE ? 'run' : 'dryrun'}.json`
writeFileSync(outPath, JSON.stringify(report, null, 2))
console.log(`\nreport written: ${outPath}${EXECUTE ? `  (undo: node scripts/repair-lead-paid-totals.mjs --undo ${outPath})` : ''}`)
