// ═══════════════════════════════════════════════════════════════════════════
// Repair: paid work the import closed as Lost ("action required" jobs)
// (2026-09-27 — companion to the deriveEngagementStage rule change in
// lib/engagements.ts: invoiceMoneyIn / jobVisitsRanOut)
//
// Usage:  node scripts/repair-paid-work-closed-lost.mjs                 (dry run)
//         node scripts/repair-paid-work-closed-lost.mjs --execute       (writes)
//         node scripts/repair-paid-work-closed-lost.mjs --undo <report.run.json>
//         [--env <path>]   default .env.local
//
// WHAT IT FLIPS. Every engagement at Closed Lost with closed_reason
// 'stale_on_import' (machine stamps only — human closes carry other reasons
// and are never read for writing) that the IN-APP stale-Lost recovery would
// now flip to Closed Won. The decision is lib/paid-work-repair.ts
// planStaleLostRecovery, which calls the app's own deriveEngagementStage —
// loaded through ts-alias-hook, no copy of the rule lives here.
//
// THE FLIP mirrors the in-app recovery and repair-stale-won-paid.mjs:
//   stage 'Closed Won' · closed_reason 'won' · closed_at = last paid date ·
//   closed_note null · stage_entered_at / updated_at = now
// plus a system stage_change touchpoint (user_id null — nobody clicked
// anything) and a sync_log breadcrumb per flip.
//
// WHAT IT DOES NOT DO. No route is called, so nothing a human close fires
// runs here: no close-won wizard, no review request, no confetti, no drip
// start or stop, no Jobber write, no email. Mailchimp is untouched (its sync
// is manual and website-source only). The run snapshots every affected
// person's drip / scheduled-email / notification rows before and after and
// fails loudly if any count moved.
//
// REVERSIBLE. The run report records every row's before-values; --undo puts
// each flipped row back exactly, guarded so it only reverts a row still in
// the state this script left it.
//
// Idempotent: a flipped row no longer matches (closed_reason becomes 'won').
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

// ── env first: lib/supabase-service builds its client at module load ──────
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
const { planStaleLostRecovery, hasMoneyIn } = await import(pathToFileURL(ROOT + '/lib/paid-work-repair.ts').href)

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
    const page = await sb(`${base}${base.includes('?') ? '&' : '?'}offset=${from}&limit=1000`)
    out.push(...page); if (page.length < 1000) break
  }
  return out
}
async function sbIn(table, select, col, ids) {
  const out = []
  for (let i = 0; i < ids.length; i += 150) {
    const chunk = ids.slice(i, i + 150)
    out.push(...await sbAll(`${table}?select=${select}&${col}=in.(${chunk.join(',')})`))
  }
  return out
}
const nowIso = () => new Date().toISOString()
const money = n => `$${Math.round(n).toLocaleString('en-US')}`

// Per-person side-effect counters: anything that would mean an email or a
// drip moved. Compared before/after an execute or undo.
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
    console.error(`✗ SIDE-EFFECT COUNTER DRIFT on the affected people: ${drifted.map(k => `${k} ${before[k]}→${after[k]}`).join(', ')} — investigate`)
    process.exitCode = 2
  } else {
    console.log(`side-effect counters unchanged on the affected people: ${JSON.stringify(after)}`)
  }
}

// ── undo ────────────────────────────────────────────────────────────────────
if (UNDO) {
  const run = JSON.parse(readFileSync(UNDO, 'utf8'))
  if (run.mode !== 'execute') { console.error('--undo takes a report from an --execute run'); process.exit(1) }
  const flips = run.flips || []
  console.log(`UNDO ${flips.length} flips from ${UNDO}`)
  const leadIds = [...new Set(flips.map(f => f.client_id))]
  const before = await sideEffectSnapshot(leadIds)
  let reverted = 0
  for (const f of flips) {
    const stamp = nowIso()
    // Only a row still exactly as the run left it goes back.
    const rows = await sb(
      `engagements?id=eq.${f.id}&stage=eq.Closed%20Won&closed_reason=eq.won&closed_at=eq.${encodeURIComponent(f.after.closed_at)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ stage: 'Closed Lost', closed_reason: 'stale_on_import', closed_at: f.before.closed_at, closed_note: f.before.closed_note, stage_entered_at: f.before.stage_entered_at, updated_at: stamp }),
        headers: { Prefer: 'return=representation' },
      },
    )
    if (rows?.length) {
      reverted++
      await sb('touchpoints', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ lead_id: f.client_id, location_uuid: f.location_uuid, engagement_id: f.id, kind: 'stage_change', label: 'Stage: Closed Won → Closed Lost', occurred_at: stamp }) })
      await sb('sync_log', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ location_id: f.slug, direction: 'inbound', entity_type: 'engagement', entity_id: f.id, status: 'success', message: '[engagement:repair-undo] paid-work Won → stale_on_import Lost (undo of repair-paid-work-closed-lost)' }) })
    } else {
      console.log(`  skipped ${f.id}: no longer in the state the run left it`)
    }
  }
  console.log(`reverted ${reverted}/${flips.length}`)
  assertNoDrift(before, await sideEffectSnapshot(leadIds))
  process.exit()
}

console.log(`repair-paid-work-closed-lost — ${EXECUTE ? '⚠ EXECUTE (writes to prod)' : 'DRY RUN (no writes)'}\n`)

// ── load scope + children ───────────────────────────────────────────────────
const locations = await sbAll('locations?select=id,name,location_id')
const locName = Object.fromEntries(locations.map(l => [l.id, l.name]))
const locSlug = Object.fromEntries(locations.map(l => [l.id, l.location_id]))

const staleLost = await sbAll(
  'engagements?stage=eq.Closed%20Lost&closed_reason=eq.stale_on_import' +
  '&select=id,client_id,location_uuid,stage,closed_reason,closed_at,closed_note,stage_entered_at,total_paid')
const ids = staleLost.map(e => e.id)
const [srs, quotes, jobs, invoices] = await Promise.all([
  sbIn('service_requests', 'engagement_id,requested_at,created_at', 'engagement_id', ids),
  sbIn('quotes', 'engagement_id,status,sent_at,approved_at,created_at', 'engagement_id', ids),
  sbIn('jobs', 'engagement_id,status,completed_at,scheduled_start,created_at', 'engagement_id', ids),
  sbIn('invoices', 'engagement_id,status,total,paid_amount,balance_owing,paid_at,issued_at,created_at', 'engagement_id', ids),
])
const by = rows => { const m = {}; for (const r of rows) (m[r.engagement_id] ||= []).push(r); return m }
const srBy = by(srs), qBy = by(quotes), jBy = by(jobs), iBy = by(invoices)

// ── classify with the app's own rule ────────────────────────────────────────
const flips = []
const held = {}
for (const e of staleLost) {
  const children = { sr: (srBy[e.id] || [])[0] || null, quotes: qBy[e.id] || [], jobs: jBy[e.id] || [], invoices: iBy[e.id] || [] }
  const v = planStaleLostRecovery(e, children)
  if (v.kind === 'flip') {
    const paid = children.invoices.reduce((s, i) => s + (Number(i.paid_amount) || 0), 0)
    const actionRequired = children.jobs.some(j => !j.completed_at && ['action_required', 'on_hold'].includes((j.status || '').toLowerCase()))
    flips.push({ e, paid, actionRequired, closedAt: v.closedAt })
  } else if (hasMoneyIn(children)) {
    // Only held rows WITH money in are interesting — the thousands of
    // genuinely stale requests are the rule working, not a hold.
    ;(held[v.why] ||= []).push({ id: e.id, client_id: e.client_id, loc: locName[e.location_uuid], derived: v.derived })
  }
}

// ── people-side projection (the app's status order: no contact, Active,
//    Client, Past client, Nurturing — website enquiries flagged separately) ──
const clientIds = [...new Set(flips.map(f => f.e.client_id))]
const leads = await sbIn('leads', 'id,name,email,phone,paid_amount,import_source,is_junk,location_uuid', 'id', clientIds)
const leadEngs = await sbIn('engagements', 'id,client_id,stage', 'client_id', clientIds)
// A website-form resubmission makes a person an enquiry again; moving a
// close's date can change whether that enquiry reads as answered. Listed so
// the Inbox can be checked after a run (expected: none).
const resubRows = (await sbIn('touchpoints', 'lead_id,label', 'lead_id', clientIds)).filter(t => t.label === 'Webform resubmission')
const resubLeads = new Set(resubRows.map(t => t.lead_id))
const flipIds = new Set(flips.map(f => f.e.id))
function status(l, afterFlip) {
  if (!(l.email || '').trim() && !(l.phone || '').trim()) return 'No contact'
  const engs = leadEngs.filter(x => x.client_id === l.id).map(x => ({ ...x, stage: afterFlip && flipIds.has(x.id) ? 'Closed Won' : x.stage }))
  if (engs.some(x => x.stage !== 'Closed Won' && x.stage !== 'Closed Lost')) return 'Active'
  if (engs.some(x => x.stage === 'Closed Won')) return 'Client'
  if ((Number(l.paid_amount) || 0) > 0) return 'Past client'
  return 'Nurturing'
}
const moves = {}
const moveList = []
for (const l of leads) {
  if (l.is_junk === true) continue
  const b = status(l, false), a = status(l, true)
  if (b !== a) { const k = `${b} → ${a}`; moves[k] = (moves[k] || 0) + 1; moveList.push({ lead_id: l.id, name: l.name, loc: locName[l.location_uuid], move: k }) }
}
const websiteLeads = leads.filter(l => l.import_source === 'manual').length

// ── report ──────────────────────────────────────────────────────────────────
const perLoc = {}
for (const f of flips) { const s = (perLoc[locName[f.e.location_uuid] || '?'] ||= { flips: 0, people: new Set(), dollars: 0 }); s.flips++; s.people.add(f.e.client_id); s.dollars += f.paid }
const total = flips.reduce((s, f) => s + f.paid, 0)
console.log(`stale-on-import Closed Lost engagements scanned: ${staleLost.length}`)
console.log(`→ WOULD FLIP to Closed Won: ${flips.length} engagements · ${clientIds.length} people · ${money(total)} paid`)
console.log(`   of which have an "action required" / on-hold job: ${flips.filter(f => f.actionRequired).length}`)
console.log(`   of which were already recoverable under the old rule: ${flips.filter(f => !f.actionRequired).length}`)
for (const [n, s] of Object.entries(perLoc).sort((a, b) => b[1].flips - a[1].flips)) console.log(`     ${n}: ${s.flips} engagements, ${s.people.size} people, ${money(s.dollars)}`)
console.log(`\nheld (money in, but the rule does not make them Won — left exactly as they are):`)
for (const [why, rows] of Object.entries(held)) console.log(`   ${why}: ${rows.length}`)
console.log(`\npeople-side status moves (${moveList.length} people):`)
for (const [k, n] of Object.entries(moves)) console.log(`   ${k}: ${n}`)
console.log(`   website (non-import) people among them: ${websiteLeads}`)
console.log(`   people with a website-form resubmission on record (check the Inbox after): ${resubLeads.size}`)
console.log(`\nsample (first 10):`)
for (const f of flips.slice(0, 10)) {
  const l = leads.find(x => x.id === f.e.client_id)
  console.log(`   ${locSlug[f.e.location_uuid]} ${l?.name || f.e.client_id}: Closed Lost → Closed Won · closed_at ${f.e.closed_at} → ${f.closedAt} · ${money(f.paid)}`)
}

const report = {
  mode: EXECUTE ? 'execute' : 'dry-run',
  at: nowIso(),
  scanned: staleLost.length,
  flipCount: flips.length,
  people: clientIds.length,
  dollars: Math.round(total),
  perLocation: Object.fromEntries(Object.entries(perLoc).map(([k, s]) => [k, { flips: s.flips, people: s.people.size, dollars: Math.round(s.dollars) }])),
  held,
  statusMoves: moves,
  moveList,
  resubmissionLeads: [...resubLeads],
  flips: flips.map(f => ({
    id: f.e.id, client_id: f.e.client_id, location_uuid: f.e.location_uuid, slug: locSlug[f.e.location_uuid] || 'unknown', paid: Math.round(f.paid * 100) / 100,
    before: { stage: 'Closed Lost', closed_reason: 'stale_on_import', closed_at: f.e.closed_at, closed_note: f.e.closed_note, stage_entered_at: f.e.stage_entered_at },
    after: { stage: 'Closed Won', closed_reason: 'won', closed_at: f.closedAt, closed_note: null },
  })),
  errors: [],
}

// ── execute ─────────────────────────────────────────────────────────────────
if (EXECUTE) {
  console.log('\nexecuting…')
  const before = await sideEffectSnapshot(clientIds)
  let done = 0
  for (const f of report.flips) {
    try {
      const stamp = nowIso()
      // Guarded: id + stage + closed_reason — cannot touch a row that is
      // not this exact machine stale-Lost engagement.
      const rows = await sb(`engagements?id=eq.${f.id}&stage=eq.Closed%20Lost&closed_reason=eq.stale_on_import`, {
        method: 'PATCH',
        body: JSON.stringify({ stage: 'Closed Won', closed_reason: 'won', closed_at: f.after.closed_at, closed_note: null, stage_entered_at: stamp, updated_at: stamp }),
        headers: { Prefer: 'return=representation' },
      })
      if (!rows?.length) { report.errors.push(`${f.id}: changed since the plan was read — skipped`); continue }
      try {
        await sb('touchpoints', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ lead_id: f.client_id, location_uuid: f.location_uuid, engagement_id: f.id, kind: 'stage_change', label: 'Stage: Closed Lost → Closed Won', occurred_at: stamp }) })
        await sb('sync_log', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ location_id: f.slug, direction: 'inbound', entity_type: 'engagement', entity_id: f.id, status: 'success', message: `[engagement:repair] stale_on_import Lost → Won (paid work on an action-required job; $${f.paid}); closed_at ${f.after.closed_at}` }) })
      } catch (err) { console.error(`  audit-trail write failed for ${f.id} (flip committed): ${err.message}`) }
      done++
    } catch (err) { report.errors.push(`${f.id}: ${err.message}`); console.error(`  ✗ ${f.id}: ${err.message}`) }
  }
  console.log(`flipped ${done}/${report.flips.length}`)
  assertNoDrift(before, await sideEffectSnapshot(clientIds))
}

const outPath = `repair-paid-work-closed-lost.report.${EXECUTE ? 'run' : 'dryrun'}.json`
writeFileSync(outPath, JSON.stringify(report, null, 2))
console.log(`\nreport written: ${outPath}${EXECUTE ? `  (undo: node scripts/repair-paid-work-closed-lost.mjs --undo ${outPath})` : ''}`)
