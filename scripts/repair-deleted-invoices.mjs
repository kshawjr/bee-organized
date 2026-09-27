// ═══════════════════════════════════════════════════════════════════════════
// Repair: invoices deleted in Jobber are marked deleted in Bee Hub
// (2026-09-27 — companion to handleInvoiceDestroy + invoiceDeleted.js)
//
// Usage:  node scripts/repair-deleted-invoices.mjs                 (dry run)
//         node scripts/repair-deleted-invoices.mjs --execute       (writes)
//         node scripts/repair-deleted-invoices.mjs --undo <report.run.json>
//         [--refresh]           allow the app's normal token renewal
//         [--ids <uuid,uuid>]   also consider these invoice rows
//         [--env <path>]        default .env.local
//
// THE DEFECT. Jobber told us about every one of these deletions
// (INVOICE_DESTROY, in sync_log) and the handler only cleared a link on the
// person, leaving the invoice unpaid at its full balance: 13 deleted unpaid
// invoices showing $26,008 owed, and 2 deleted PAID ones. The handler now
// marks the row; this does it once for the rows already stored.
//
// CANDIDATES: every invoice row not already deleted whose Jobber id appears
// in an INVOICE_DESTROY sync_log event (the id is decoded from the event),
// plus any --ids. EACH IS RE-CHECKED IN JOBBER AT RUN TIME: only an invoice
// Jobber answers "no such invoice" for, with no error, is marked. Anything
// Jobber still has, or that can't be read, is reported and left alone.
//
// TOKENS: a stored token is used only while valid and never renewed; a
// location without one is skipped and listed. --refresh lets it use the
// app's normal renewal (lib/jobber.ts jobberGraphQL) — Kevin's call.
//
// WHAT IT WRITES — money only, never stage:
//   invoices     deletedInvoicePatch (components/hive/shared/invoiceDeleted.js
//                — the same function the webhook uses): status 'deleted',
//                balance_owing 0; an UNPAID invoice also drops paid_amount.
//                A PAID invoice keeps paid_amount / total / paid_at — Kevin's
//                ruling (Laura Wood $370, Carol Sullivan $180): the client did
//                pay, so the collected money stays. That exception lives in
//                deletedInvoicePatch and is pinned by beta-deleted-invoices.
//   engagements  total_invoiced / total_paid / balance_owing via
//                rollUpInvoiceMoney (deleted left out; paid-then-deleted
//                keeps its money). stage is never written; every affected
//                engagement's stage is snapshotted before and after.
//   leads        paid_amount / balance_owing via sumPaidInvoices /
//                sumBalanceOwing (same rules).
// Closed deals are NOT reopened, re-closed or re-labelled: an owing-override
// Won stays Won with its reason; its balance simply stops showing.
//
// REVERSIBLE: --undo puts every invoice, engagement and person back from the
// run report, guarded on the values the run wrote.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { installTsResolver } from './ts-alias-hook.mjs'

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const val = (k, d = null) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : d }
const EXECUTE = argv.includes('--execute')
const REFRESH = argv.includes('--refresh')
const UNDO = val('--undo')
const EXTRA_IDS = (val('--ids') || '').split(',').map(s => s.trim()).filter(Boolean)

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
const imp = await import(pathToFileURL(ROOT + '/lib/jobber-import.ts').href)
const { rollUpInvoiceMoney } = await import(pathToFileURL(ROOT + '/lib/engagements.ts').href)
const { sumPaidInvoices, sumBalanceOwing } = await import(pathToFileURL(ROOT + '/lib/lead-paid-total.ts').href)
const del = await import(pathToFileURL(ROOT + '/components/hive/shared/invoiceDeleted.js').href)
const fp = await import(pathToFileURL(ROOT + '/components/hive/shared/finalProcessing.js').href)

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
  for (let i = 0; i < ids.length; i += 150) out.push(...await sbAll(`${table}?select=${select}&${col}=in.(${ids.slice(i, i + 150).map(encodeURIComponent).join(',')})`))
  return out
}
const nowIso = () => new Date().toISOString()
const num = v => (v == null ? null : Number(v))
const same = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.005)
const eqGuard = (col, v) => (v == null ? `${col}=is.null` : `${col}=eq.${v}`)
const money = n => `$${(Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function sideEffectSnapshot(leadIds, engIds) {
  const count = async (table) => (await sbIn(table, 'id', 'lead_id', leadIds)).length
  const stages = Object.fromEntries((await sbIn('engagements', 'id,stage,closed_reason', 'id', engIds)).map(e => [e.id, `${e.stage}|${e.closed_reason ?? ''}`]))
  return {
    counters: {
      lead_drip_progress: await count('lead_drip_progress'),
      scheduled_stage_emails: await count('scheduled_stage_emails'),
      notification_log: await count('notification_log'),
    },
    stages,
  }
}
function assertNoDrift(before, after) {
  const drifted = Object.keys(before.counters).filter(k => before.counters[k] !== after.counters[k])
  const moved = Object.keys(before.stages).filter(id => before.stages[id] !== after.stages[id])
  if (drifted.length || moved.length) {
    if (drifted.length) console.error(`✗ SIDE-EFFECT COUNTER DRIFT: ${drifted.map(k => `${k} ${before.counters[k]}→${after.counters[k]}`).join(', ')}`)
    if (moved.length) console.error(`✗ ENGAGEMENT STAGE/CLOSE MOVED on ${moved.length} — this repair must never move one`)
    process.exitCode = 2
  } else {
    console.log(`side effects unchanged: ${JSON.stringify(after.counters)} · no engagement stage or close moved (${Object.keys(after.stages).length} checked)`)
  }
}

const INV_COLS = 'id,jobber_invoice_id,location_id,lead_id,engagement_id,status,total,paid_amount,balance_owing,paid_at'

// ── undo ────────────────────────────────────────────────────────────────────
if (UNDO) {
  const run = JSON.parse(readFileSync(UNDO, 'utf8'))
  if (run.mode !== 'execute') { console.error('--undo takes a report from an --execute run'); process.exit(1) }
  const leadIds = run.leads.map(l => l.id), engIds = run.engagements.map(e => e.id)
  const before = await sideEffectSnapshot(leadIds, engIds)
  const n = { invoices: 0, engagements: 0, leads: 0 }
  for (const c of run.invoices) {
    const r = await sb(`invoices?id=eq.${c.id}&status=eq.deleted`, { method: 'PATCH', body: JSON.stringify(c.before), headers: { Prefer: 'return=representation' } })
    if (r?.length) n.invoices++; else console.log(`  skipped invoice ${c.id}: no longer as the run left it`)
  }
  for (const c of run.engagements) {
    const r = await sb(`engagements?id=eq.${c.id}&${eqGuard('balance_owing', c.after.balance_owing)}`, { method: 'PATCH', body: JSON.stringify(c.before), headers: { Prefer: 'return=representation' } })
    if (r?.length) n.engagements++; else console.log(`  skipped engagement ${c.id}: changed since the run`)
  }
  for (const c of run.leads) {
    const r = await sb(`leads?id=eq.${c.id}&${eqGuard('balance_owing', c.after.balance_owing)}`, { method: 'PATCH', body: JSON.stringify(c.before), headers: { Prefer: 'return=representation' } })
    if (r?.length) n.leads++; else console.log(`  skipped person ${c.id}: changed since the run`)
  }
  console.log(`reverted invoices ${n.invoices}/${run.invoices.length} · engagements ${n.engagements}/${run.engagements.length} · people ${n.leads}/${run.leads.length}`)
  assertNoDrift(before, await sideEffectSnapshot(leadIds, engIds))
  process.exit()
}

console.log(`repair-deleted-invoices — ${EXECUTE ? '⚠ EXECUTE (writes to prod)' : 'DRY RUN (no writes)'} · tokens: ${REFRESH ? 'renew when needed (--refresh)' : 'valid-only, never renewed'}\n`)

// ── candidates: INVOICE_DESTROY events + --ids ──────────────────────────────
const events = await sbAll(`sync_log?select=message,location_id,created_at&message=like.topic%3DINVOICE_DESTROY*`)
const destroyed = new Map() // jobber id → first event
for (const e of events) {
  const item = (e.message.match(/item=([A-Za-z0-9+/=]+)/) || [])[1]
  const jid = item ? imp.extractJobberId(item) : null
  if (jid && !destroyed.has(jid)) destroyed.set(jid, e)
}
let candidates = destroyed.size ? await sbIn('invoices', INV_COLS, 'jobber_invoice_id', [...destroyed.keys()]) : []
if (EXTRA_IDS.length) candidates.push(...await sbIn('invoices', INV_COLS, 'id', EXTRA_IDS))
candidates = [...new Map(candidates.filter(i => !del.isDeletedInvoice(i)).map(i => [i.id, i])).values()]

// ── re-check each in Jobber, now ─────────────────────────────────────────────
const slugs = [...new Set(candidates.map(i => i.location_id))]
const locs = await sbIn('locations', 'location_id,jobber_access_token,token_expiry', 'location_id', slugs)
const locBySlug = Object.fromEntries(locs.map(l => [l.location_id, l]))
const fresh = l => l && parseInt(l.token_expiry || '', 10) > Date.now() + 5 * 60 * 1000
const Q = `query($id:EncodedId!){invoice(id:$id){id invoiceStatus}}`
const jobber = REFRESH ? await import(pathToFileURL(ROOT + '/lib/jobber.ts').href) : null
async function ask(slug, jid) {
  const id = imp.encodeJobberId('Invoice', jid)
  if (REFRESH) return jobber.jobberGraphQL(slug, Q, { id })
  const res = await fetch('https://api.getjobber.com/api/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${locBySlug[slug].jobber_access_token}`, 'Content-Type': 'application/json', 'X-JOBBER-GRAPHQL-VERSION': '2025-04-16' },
    body: JSON.stringify({ query: Q, variables: { id } }),
  })
  if (res.status === 401) return { errors: [{ message: '401 — token not accepted (not renewed)' }] }
  return res.json()
}
const confirmed = [], stillInJobber = [], unreadable = [], skipped = {}
for (const inv of candidates) {
  if (!REFRESH && !fresh(locBySlug[inv.location_id])) { skipped[inv.location_id] = (skipped[inv.location_id] || 0) + 1; continue }
  let r
  try { r = await ask(inv.location_id, inv.jobber_invoice_id) } catch (e) { r = { errors: [{ message: e.message }] } }
  await sleep(300)
  if (r?.errors?.length) unreadable.push({ id: inv.id, slug: inv.location_id, error: r.errors[0].message })
  else if (r?.data?.invoice) stillInJobber.push({ id: inv.id, slug: inv.location_id, jobberStatus: r.data.invoice.invoiceStatus })
  else confirmed.push(inv)   // "OK, no such invoice" — deleted in Jobber
}

// ── plan + project (money only) ─────────────────────────────────────────────
const plan = confirmed.map(inv => ({ inv, patch: del.deletedInvoicePatch(inv) }))
const patchById = Object.fromEntries(plan.map(p => [p.inv.id, p.patch]))
const engIds = [...new Set(plan.map(p => p.inv.engagement_id).filter(Boolean))]
const leadIds = [...new Set(plan.map(p => p.inv.lead_id).filter(Boolean))]
const engRows = await sbIn('engagements', 'id,client_id,stage,closed_reason,total_invoiced,total_paid,balance_owing', 'id', engIds)
const engInv = await sbIn('invoices', INV_COLS, 'engagement_id', engIds)
const leadRows = await sbIn('leads', 'id,name,paid_amount,balance_owing', 'id', leadIds)
const leadInv = await sbIn('invoices', INV_COLS, 'lead_id', leadIds)
const byKey = (rows, k) => { const m = {}; for (const r of rows) (m[r[k]] ||= []).push(r); return m }
const invByEng = byKey(engInv, 'engagement_id'), invByLead = byKey(leadInv, 'lead_id')
const projected = i => (patchById[i.id] ? { ...i, ...patchById[i.id] } : i)
const nameOf = Object.fromEntries(leadRows.map(l => [l.id, l.name]))
const MONEY = ['total_invoiced', 'total_paid', 'balance_owing']

const engagementChanges = [], dealLines = []
for (const e of engRows) {
  const beforeInv = invByEng[e.id] || [], afterInv = beforeInv.map(projected)
  const before = Object.fromEntries(MONEY.map(k => [k, num(e[k])]))
  const after = rollUpInvoiceMoney(afterInv)
  if (MONEY.some(k => !same(before[k], after[k]))) engagementChanges.push({ id: e.id, before, after })
  dealLines.push({
    id: e.id, who: nameOf[e.client_id] || e.client_id, stage: e.stage, closed_reason: e.closed_reason,
    owedBefore: fp.owedOnInvoices(beforeInv), owedAfter: fp.owedOnInvoices(afterInv),
    fpBefore: fp.finalProcessingCase(e, beforeInv), fpAfter: fp.finalProcessingCase(e, afterInv),
    collectedBefore: before.total_paid, collectedAfter: after.total_paid,
  })
}
const leadChanges = []
for (const l of leadRows) {
  const afterInv = (invByLead[l.id] || []).map(projected)
  const before = { paid_amount: num(l.paid_amount), balance_owing: num(l.balance_owing) }
  const after = { paid_amount: sumPaidInvoices(afterInv), balance_owing: sumBalanceOwing(afterInv) }
  if (!same(before.paid_amount, after.paid_amount) || !same(before.balance_owing, after.balance_owing)) leadChanges.push({ id: l.id, name: l.name, before, after })
}

// ── report ──────────────────────────────────────────────────────────────────
const unpaid = plan.filter(p => p.inv.status !== 'paid'), paid = plan.filter(p => p.inv.status === 'paid')
const phantom = unpaid.reduce((s, p) => s + (Number(p.inv.balance_owing) || 0), 0)
console.log(`INVOICE_DESTROY events: ${destroyed.size} · candidate rows still live in Bee Hub: ${candidates.length}`)
console.log(`   confirmed deleted in Jobber just now: ${confirmed.length} · still in Jobber (left alone): ${stillInJobber.length} · unreadable: ${unreadable.length} · skipped (no valid token): ${Object.values(skipped).reduce((a, b) => a + b, 0)}`)
if (Object.keys(skipped).length) console.log(`   skipped: ${Object.entries(skipped).map(([k, v]) => `${k} (${v})`).join(', ')}`)
for (const s of stillInJobber) console.log(`   STILL IN JOBBER: ${s.slug} ${s.id} (${s.jobberStatus}) — not marked`)
for (const u of unreadable) console.log(`   unreadable: ${u.slug} ${u.id} — ${u.error}`)
console.log(`\n→ UNPAID invoices to mark deleted: ${unpaid.length} · phantom debt off the screens: ${money(phantom)}`)
for (const p of unpaid) console.log(`   ${p.inv.location_id} ${nameOf[p.inv.lead_id] || p.inv.lead_id}: #${p.inv.jobber_invoice_id} owing ${money(p.inv.balance_owing)} → $0.00`)
console.log(`→ PAID invoices to mark deleted, KEEPING their collected money: ${paid.length}`)
for (const p of paid) console.log(`   ${p.inv.location_id} ${nameOf[p.inv.lead_id] || p.inv.lead_id}: #${p.inv.jobber_invoice_id} ${money(p.inv.paid_amount)} collected — stays collected`)

const ready = dealLines.filter(d => d.fpBefore === 'owing' && (d.fpAfter === 'paid' || d.fpAfter === 'never_invoiced'))
console.log(`\n→ Final Processing deals that become Mark-won-ready: ${ready.length}`)
for (const d of ready) console.log(`   ${d.who}: owed ${money(d.owedBefore)} → ${money(d.owedAfter)} · ${d.fpBefore} → ${d.fpAfter}`)
const less = dealLines.filter(d => d.owedAfter > 0 && d.owedAfter < d.owedBefore)
console.log(`→ deals still owed, but less: ${less.length}`)
for (const d of less) console.log(`   ${d.who} (${d.stage}): ${money(d.owedBefore)} → ${money(d.owedAfter)}`)
const closed = dealLines.filter(d => (d.stage === 'Closed Won' || d.stage === 'Closed Lost') && d.owedBefore > 0)
console.log(`→ CLOSED deals whose phantom balance disappears (left closed exactly as they are): ${closed.length}`)
for (const d of closed) console.log(`   ${d.who}: ${d.stage}${d.closed_reason ? ` / ${d.closed_reason}` : ''} · showed ${money(d.owedBefore)} → ${money(d.owedAfter)}`)
const openOther = dealLines.filter(d => d.stage !== 'Final Processing' && d.stage !== 'Closed Won' && d.stage !== 'Closed Lost' && d.owedBefore > d.owedAfter)
for (const d of openOther) console.log(`   (open, ${d.stage}) ${d.who}: ${money(d.owedBefore)} → ${money(d.owedAfter)}`)
const collectedMoved = dealLines.filter(d => !same(d.collectedBefore, d.collectedAfter))
console.log(`→ deals whose COLLECTED money changes: ${collectedMoved.length}${collectedMoved.length ? ' ⚠ ' + collectedMoved.map(d => `${d.who} ${money(d.collectedBefore)} → ${money(d.collectedAfter)}`).join('; ') : ' (the paid ones keep theirs)'}`)
console.log(`→ engagement money rows that change: ${engagementChanges.length} · people: ${leadChanges.length}`)

const report = {
  mode: EXECUTE ? 'execute' : 'dry-run', at: nowIso(), refresh: REFRESH,
  destroyEvents: destroyed.size, candidates: candidates.length, skipped, stillInJobber, unreadable,
  phantomDebt: Math.round(phantom * 100) / 100, dealLines,
  invoices: plan.map(p => ({ id: p.inv.id, slug: p.inv.location_id, jobber_invoice_id: p.inv.jobber_invoice_id,
    before: { status: p.inv.status, balance_owing: num(p.inv.balance_owing), paid_amount: num(p.inv.paid_amount) }, after: p.patch })),
  engagements: engagementChanges,
  leads: leadChanges.map(l => ({ id: l.id, before: l.before, after: l.after })),
  errors: [],
}

// ── execute ─────────────────────────────────────────────────────────────────
if (EXECUTE) {
  console.log('\nexecuting…')
  const snapLeads = leadIds, snapEngs = engRows.map(e => e.id)
  const before = await sideEffectSnapshot(snapLeads, snapEngs)
  const written = { invoices: 0, engagements: 0, leads: 0 }
  for (const c of report.invoices) {
    try {
      const r = await sb(`invoices?id=eq.${c.id}&status=eq.${encodeURIComponent(c.before.status)}&${eqGuard('balance_owing', c.before.balance_owing)}`,
        { method: 'PATCH', body: JSON.stringify({ ...c.after, updated_at: nowIso() }), headers: { Prefer: 'return=representation' } })
      if (r?.length) written.invoices++; else report.errors.push(`invoice ${c.id}: changed since the plan was read — skipped`)
    } catch (e) { report.errors.push(`invoice ${c.id}: ${e.message}`) }
  }
  // Recomputed from the invoices AS NOW STORED, so a skipped invoice can't
  // leave a total wrong. Money columns only — stage is not in any body.
  const nowEng = byKey(await sbIn('invoices', INV_COLS, 'engagement_id', engIds), 'engagement_id')
  for (const c of report.engagements) {
    c.after = rollUpInvoiceMoney(nowEng[c.id] || [])
    try {
      const r = await sb(`engagements?id=eq.${c.id}&${eqGuard('balance_owing', c.before.balance_owing)}`,
        { method: 'PATCH', body: JSON.stringify({ ...c.after, updated_at: nowIso() }), headers: { Prefer: 'return=representation' } })
      if (r?.length) written.engagements++; else report.errors.push(`engagement ${c.id}: changed since the plan was read — skipped`)
    } catch (e) { report.errors.push(`engagement ${c.id}: ${e.message}`) }
  }
  const nowLead = byKey(await sbIn('invoices', INV_COLS, 'lead_id', leadIds), 'lead_id')
  for (const c of report.leads) {
    c.after = { paid_amount: sumPaidInvoices(nowLead[c.id] || []), balance_owing: sumBalanceOwing(nowLead[c.id] || []) }
    try {
      const r = await sb(`leads?id=eq.${c.id}&${eqGuard('balance_owing', c.before.balance_owing)}`,
        { method: 'PATCH', body: JSON.stringify(c.after), headers: { Prefer: 'return=representation' } })
      if (r?.length) written.leads++; else report.errors.push(`person ${c.id}: changed since the plan was read — skipped`)
    } catch (e) { report.errors.push(`person ${c.id}: ${e.message}`) }
  }
  const perSlug = {}
  for (const c of report.invoices) perSlug[c.slug] = (perSlug[c.slug] || 0) + 1
  for (const [slug, n] of Object.entries(perSlug)) {
    await sb('sync_log', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ location_id: slug, direction: 'inbound', entity_type: 'invoice', status: 'success', message: `[invoice:repair] ${n} invoice(s) deleted in Jobber marked deleted (repair-deleted-invoices)` }) })
  }
  console.log(`written: invoices ${written.invoices}/${report.invoices.length} · engagements ${written.engagements}/${report.engagements.length} · people ${written.leads}/${report.leads.length}${report.errors.length ? ` · ${report.errors.length} skipped/errors` : ''}`)
  assertNoDrift(before, await sideEffectSnapshot(snapLeads, snapEngs))
}

const outPath = `repair-deleted-invoices.report.${EXECUTE ? 'run' : 'dryrun'}.json`
writeFileSync(outPath, JSON.stringify(report, null, 2))
console.log(`\nreport written: ${outPath}${EXECUTE ? `  (undo: node scripts/repair-deleted-invoices.mjs --undo ${outPath})` : ''}`)
