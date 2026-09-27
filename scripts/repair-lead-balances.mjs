// ═══════════════════════════════════════════════════════════════════════════
// Repair: leads.balance_owing = the sum of what every invoice still owes
// (2026-09-27 — companion to lib/lead-paid-total.ts sumBalanceOwing; same
// shape as repair-lead-paid-totals.mjs, which ran the same day)
//
// Usage:  node scripts/repair-lead-balances.mjs                 (dry run)
//         node scripts/repair-lead-balances.mjs --execute       (writes)
//         node scripts/repair-lead-balances.mjs --undo <report.run.json>
//         [--env <path>]   default .env.local
//
// THE DEFECT. The INVOICE webhook OVERWROTE leads.balance_owing with the
// invoice in hand — 0 on a paid event, that invoice's total otherwise — and
// the import only ever wrote it on paid invoices (as 0). So a second open
// invoice hid the first, and people whose only open invoices came in through
// the import never had a balance at all. Both writers now recompute the sum;
// this puts every existing row right once.
//
// THE NUMBER comes from lib/lead-paid-total.ts sumBalanceOwing — the same
// function the webhook and the import now call, and the engagement roll-up's
// own formula — loaded through ts-alias-hook, so the repair cannot disagree
// with the writers. The report also checks each corrected figure against the
// sum of the person's engagement balances.
//
// WHAT IT CHANGES FOR OWNERS: nothing on screen. No surface reads
// leads.balance_owing — Final Processing, the owing override, the close
// gates, the profile and the overview all read invoice / engagement
// balances. This makes the stored column true for SQL, reports and any
// future reader. It cannot move anyone's status.
//
// WHAT IT WRITES. leads.balance_owing only, and only where it differs from
// the sum by more than a cent. Each write is guarded on the value this run
// read, so a row the webhook updated in between is skipped, not clobbered. No
// route, no drip, no email, no Jobber write; the only trigger on leads bumps
// updated_at. One sync_log summary row per location.
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
const { sumBalanceOwing } = await import(pathToFileURL(ROOT + '/lib/lead-paid-total.ts').href)

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
const guard = v => (v == null ? 'balance_owing=is.null' : `balance_owing=eq.${v}`)

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
    const rows = await sb(`leads?id=eq.${c.lead_id}&${guard(c.after)}`, { method: 'PATCH', body: JSON.stringify({ balance_owing: c.before }), headers: { Prefer: 'return=representation' } })
    if (rows?.length) reverted++
    else console.log(`  skipped ${c.lead_id}: balance_owing changed since the run`)
  }
  console.log(`reverted ${reverted}/${run.changes.length}`)
  assertNoDrift(before, await sideEffectSnapshot(leadIds))
  process.exit()
}

console.log(`repair-lead-balances — ${EXECUTE ? '⚠ EXECUTE (writes to prod)' : 'DRY RUN (no writes)'}\n`)

const locations = await sbAll('locations?select=id,name,location_id')
const locName = Object.fromEntries(locations.map(l => [l.id, l.name]))
const locSlug = Object.fromEntries(locations.map(l => [l.id, l.location_id]))

const invoices = await sbAll('invoices?select=id,lead_id,status,total,paid_amount,balance_owing&lead_id=not.is.null')
const invBy = {}
for (const i of invoices) (invBy[i.lead_id] ||= []).push(i)
// Every lead that has an invoice, or a stored balance with no invoice behind it.
const stored = await sbAll('leads?select=id,name,balance_owing,is_junk,location_uuid&balance_owing=not.is.null')
const storedIds = new Set(stored.map(s => s.id))
const invLeadIds = Object.keys(invBy).filter(id => !storedIds.has(id))
const leads = [...stored, ...await sbIn('leads', 'id,name,balance_owing,is_junk,location_uuid', 'id', invLeadIds)]

const changes = []
for (const l of leads) {
  const before = num(l.balance_owing)
  const after = sumBalanceOwing(invBy[l.id] || [])
  if (!same(before, after)) changes.push({ l, before, after })
}

// ── cross-check against the engagement roll-up (what the screens show) ────
const changedIds = changes.map(c => c.l.id)
const engs = await sbIn('engagements', 'client_id,balance_owing', 'client_id', changedIds)
const engSum = {}
for (const e of engs) engSum[e.client_id] = (engSum[e.client_id] || 0) + (Number(e.balance_owing) || 0)
const disagree = changes.filter(c => !same(Math.round((engSum[c.l.id] || 0) * 100) / 100, c.after ?? 0))

// ── shapes ──────────────────────────────────────────────────────────────────
const shape = c => {
  if (c.after == null) return 'stored balance but no invoice → cleared'
  if (c.before == null) return 'never filled in → set to the sum'
  if (c.before < c.after) return 'too low (one invoice hid another) → sum'
  return 'too high → sum'
}
const shapes = {}
for (const c of changes) shapes[shape(c)] = (shapes[shape(c)] || 0) + 1
const stored$ = changes.reduce((s, c) => s + (c.before || 0), 0)
const actual$ = changes.reduce((s, c) => s + (c.after || 0), 0)
const negAfter = changes.filter(c => (c.after ?? 0) < 0)

console.log(`leads read: ${leads.length} · invoices read: ${invoices.length}`)
console.log(`→ WOULD CHANGE balance_owing on ${changes.length} people`)
for (const [k, n] of Object.entries(shapes)) console.log(`   ${k}: ${n}`)
console.log(`   stored on these people: $${stored$.toFixed(2)} → corrected: $${actual$.toFixed(2)} (difference $${(actual$ - stored$).toFixed(2)})`)
console.log(`   corrected balance below zero (an unpaid credit note): ${negAfter.length}`)
console.log(`   corrected figure disagrees with the person's engagement balances: ${disagree.length}`)
console.log(`\nstatus moves: none possible — no screen or status reads leads.balance_owing`)
console.log(`\nall changes:`)
for (const c of changes) console.log(`   ${locSlug[c.l.location_uuid]} ${c.l.name}: ${c.before} → ${c.after}`)

const report = {
  mode: EXECUTE ? 'execute' : 'dry-run',
  at: nowIso(),
  changeCount: changes.length,
  shapes, storedTotal: Math.round(stored$ * 100) / 100, correctedTotal: Math.round(actual$ * 100) / 100,
  disagreeWithEngagements: disagree.map(c => c.l.id),
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
      const rows = await sb(`leads?id=eq.${c.lead_id}&${guard(c.before)}`, { method: 'PATCH', body: JSON.stringify({ balance_owing: c.after }), headers: { Prefer: 'return=representation' } })
      if (!rows?.length) { report.errors.push(`${c.lead_id}: balance_owing changed since the plan was read — skipped`); continue }
      done++; perSlug[c.slug] = (perSlug[c.slug] || 0) + 1
    } catch (err) { report.errors.push(`${c.lead_id}: ${err.message}`); console.error(`  ✗ ${c.lead_id}: ${err.message}`) }
  }
  for (const [slug, n] of Object.entries(perSlug)) {
    await sb('sync_log', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ location_id: slug, direction: 'inbound', entity_type: 'client', status: 'success', message: `[lead:repair] balance_owing recomputed as the sum of every invoice's balance on ${n} people (repair-lead-balances)` }) })
  }
  console.log(`updated ${done}/${report.changes.length}`)
  assertNoDrift(before, await sideEffectSnapshot(changedIds))
}

const outPath = `repair-lead-balances.report.${EXECUTE ? 'run' : 'dryrun'}.json`
writeFileSync(outPath, JSON.stringify(report, null, 2))
console.log(`\nreport written: ${outPath}${EXECUTE ? `  (undo: node scripts/repair-lead-balances.mjs --undo ${outPath})` : ''}`)
