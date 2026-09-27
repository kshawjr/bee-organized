// ═══════════════════════════════════════════════════════════════════════════
// Repair: unpaid invoices carry Jobber's REAL balance, not their full total
// (2026-09-27 — companion to lib/jobber-import.ts invoiceMoneyFromJobber)
//
// Usage:  node scripts/repair-invoice-balances.mjs                 (dry run)
//         node scripts/repair-invoice-balances.mjs --execute       (writes)
//         node scripts/repair-invoice-balances.mjs --undo <report.run.json>
//         [--refresh]           allow the app's normal token renewal
//         [--location <slug>]   one location only
//         [--env <path>]        default .env.local
//
// THE DEFECT. Every unpaid invoice was stored as owing its FULL total — the
// import never asked Jobber what had come in, and the live update asked and
// ignored the answer. Jobber's amounts.invoiceBalance already accounts for
// deposits, part payments, voided invoices and bad-debt write-offs. The code
// now reads it on every new save; this reads it once for the invoices
// already stored (~110 unpaid, ~30 locations).
//
// TOKENS. Asking Jobber needs each location's access token. By DEFAULT this
// uses a stored token only while it is still valid and never renews one —
// a location without a valid token is SKIPPED and listed. --refresh lets
// it go through lib/jobber.ts jobberGraphQL, the app's normal path, which
// renews an expired token the way any page load would. That rotates the
// location's stored tokens, so it is Kevin's call when to allow it.
//
// WHAT IT WRITES — money only, never stage:
//   invoices     paid_amount (what came in) + balance_owing (what is owed),
//                from invoiceMoneyFromJobber — the same function saves use.
//                Guarded on the values this run read. An invoice whose
//                STATUS differs in Jobber (paid there, unpaid here) is
//                reported and left alone: status moves stage, and that is
//                the webhook's job, not a money repair's.
//   engagements  total_invoiced / total_paid / balance_owing via
//                rollUpInvoiceMoney (lib/engagements.ts, the one formula),
//                plus written_off_amount on deals already written off (if
//                that column exists yet). stage is never written — the run
//                snapshots every affected engagement's stage before and
//                after and fails loudly if one moved.
//   leads        paid_amount / balance_owing via sumPaidInvoices /
//                sumBalanceOwing (lib/lead-paid-total.ts).
// No route, no drip, no email, no Jobber write. Drip / scheduled-email /
// notification rows on the affected people are counted before and after.
//
// THE REPORT answers Kevin's question: which deals go from "owed" to
// "settled" once the balances are right, and which of those were WRITTEN
// OFF in Jobber versus genuinely PAID (deposit / payment) or VOIDED — on
// Final Processing, on owing-override Won closes, and anywhere else.
//
// REVERSIBLE. --undo restores every invoice, engagement and lead value from
// the run report, guarded on the values the run wrote.
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
const ONLY = val('--location')

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
const wo = await import(pathToFileURL(ROOT + '/components/hive/shared/writtenOff.js').href)
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
  for (let i = 0; i < ids.length; i += 150) out.push(...await sbAll(`${table}?select=${select}&${col}=in.(${ids.slice(i, i + 150).join(',')})`))
  return out
}
const nowIso = () => new Date().toISOString()
const num = v => (v == null ? null : Number(v))
const same = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.005)
const eqGuard = (col, v) => (v == null ? `${col}=is.null` : `${col}=eq.${v}`)
const money = n => `$${(Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`

async function sideEffectSnapshot(leadIds, engIds) {
  const count = async (table) => (await sbIn(table, 'id', 'lead_id', leadIds)).length
  const stages = Object.fromEntries((await sbIn('engagements', 'id,stage', 'id', engIds)).map(e => [e.id, e.stage]))
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
    if (moved.length) console.error(`✗ ENGAGEMENT STAGE MOVED on ${moved.length}: ${moved.slice(0, 5).map(id => `${id} ${before.stages[id]}→${after.stages[id]}`).join(', ')} — this repair must never move a stage`)
    process.exitCode = 2
  } else {
    console.log(`side effects unchanged: ${JSON.stringify(after.counters)} · no engagement stage moved (${Object.keys(after.stages).length} checked)`)
  }
}

// written_off_amount only exists once migrations/engagements_written_off_amount.sql has run.
let hasWrittenOffColumn = true
try { await sb('engagements?select=written_off_amount&limit=1') } catch { hasWrittenOffColumn = false }
const ENG_MONEY_COLS = ['total_invoiced', 'total_paid', 'balance_owing', ...(hasWrittenOffColumn ? ['written_off_amount'] : [])]

// ── undo ────────────────────────────────────────────────────────────────────
if (UNDO) {
  const run = JSON.parse(readFileSync(UNDO, 'utf8'))
  if (run.mode !== 'execute') { console.error('--undo takes a report from an --execute run'); process.exit(1) }
  const leadIds = run.leads.map(l => l.id), engIds = run.engagements.map(e => e.id)
  const before = await sideEffectSnapshot(leadIds, engIds)
  let n = { invoices: 0, engagements: 0, leads: 0 }
  for (const c of run.invoices) {
    const r = await sb(`invoices?id=eq.${c.id}&${eqGuard('paid_amount', c.after.paid_amount)}&${eqGuard('balance_owing', c.after.balance_owing)}`,
      { method: 'PATCH', body: JSON.stringify(c.before), headers: { Prefer: 'return=representation' } })
    if (r?.length) n.invoices++; else console.log(`  skipped invoice ${c.id}: changed since the run`)
  }
  for (const c of run.engagements) {
    const r = await sb(`engagements?id=eq.${c.id}&${eqGuard('balance_owing', c.after.balance_owing)}`,
      { method: 'PATCH', body: JSON.stringify(c.before), headers: { Prefer: 'return=representation' } })
    if (r?.length) n.engagements++; else console.log(`  skipped engagement ${c.id}: changed since the run`)
  }
  for (const c of run.leads) {
    const r = await sb(`leads?id=eq.${c.id}&${eqGuard('balance_owing', c.after.balance_owing)}`,
      { method: 'PATCH', body: JSON.stringify(c.before), headers: { Prefer: 'return=representation' } })
    if (r?.length) n.leads++; else console.log(`  skipped lead ${c.id}: changed since the run`)
  }
  console.log(`reverted invoices ${n.invoices}/${run.invoices.length} · engagements ${n.engagements}/${run.engagements.length} · leads ${n.leads}/${run.leads.length}`)
  assertNoDrift(before, await sideEffectSnapshot(leadIds, engIds))
  process.exit()
}

console.log(`repair-invoice-balances — ${EXECUTE ? '⚠ EXECUTE (writes to prod)' : 'DRY RUN (no writes)'} · tokens: ${REFRESH ? 'renew when needed (--refresh)' : 'valid-only, never renewed'}${ONLY ? ` · ${ONLY} only` : ''}\n`)
if (!hasWrittenOffColumn) console.log('note: engagements.written_off_amount does not exist yet — written-off amounts are not recomputed on this run\n')

// ── load: every unpaid invoice ──────────────────────────────────────────────
let unpaid = await sbAll(`invoices?select=id,jobber_invoice_id,location_id,lead_id,engagement_id,status,total,paid_amount,balance_owing&status=neq.paid${ONLY ? `&location_id=eq.${ONLY}` : ''}`)
const slugs = [...new Set(unpaid.map(i => i.location_id))]
const locs = await sbIn('locations', 'location_id,name,jobber_access_token,token_expiry', 'location_id', slugs)
const locBySlug = Object.fromEntries(locs.map(l => [l.location_id, l]))
const fresh = l => l && parseInt(l.token_expiry || '', 10) > Date.now() + 5 * 60 * 1000

const INVOICE_AMOUNTS = `query($id:EncodedId!){invoice(id:$id){invoiceStatus amounts{total paymentsTotal depositAmount invoiceBalance}}}`
const jobber = REFRESH ? await import(pathToFileURL(ROOT + '/lib/jobber.ts').href) : null
async function askJobber(slug, jobberInvoiceId) {
  const id = imp.encodeJobberId('Invoice', jobberInvoiceId)
  if (REFRESH) return jobber.jobberGraphQL(slug, INVOICE_AMOUNTS, { id })
  const res = await fetch('https://api.getjobber.com/api/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${locBySlug[slug].jobber_access_token}`, 'Content-Type': 'application/json', 'X-JOBBER-GRAPHQL-VERSION': '2025-04-16' },
    body: JSON.stringify({ query: INVOICE_AMOUNTS, variables: { id } }),
  })
  if (res.status === 401) return { errors: [{ message: '401 — token not accepted (not renewed)' }] }
  return res.json()
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

const skippedLocations = {}
const statusMismatch = []
const unreadable = []
const invoiceChanges = []
const jobberNow = {}
for (const inv of unpaid) {
  const loc = locBySlug[inv.location_id]
  if (!REFRESH && !fresh(loc)) { skippedLocations[inv.location_id] = (skippedLocations[inv.location_id] || 0) + 1; continue }
  let r
  try { r = await askJobber(inv.location_id, inv.jobber_invoice_id) } catch (e) { r = { errors: [{ message: e.message }] } }
  await sleep(300)
  const j = r?.data?.invoice
  if (!j) { unreadable.push({ id: inv.id, slug: inv.location_id, error: r?.errors?.[0]?.message || 'not found' }); continue }
  jobberNow[inv.id] = j
  const jobberStatus = String(j.invoiceStatus || '').toUpperCase()
  const ourStatus = inv.status
  const jobberSaysPaid = jobberStatus === 'PAID'
  if (jobberSaysPaid) { statusMismatch.push({ id: inv.id, slug: inv.location_id, ours: ourStatus, jobber: j.invoiceStatus }); continue }
  const next = imp.invoiceMoneyFromJobber({ invoiceStatus: j.invoiceStatus, amounts: j.amounts })
  const before = { paid_amount: num(inv.paid_amount), balance_owing: num(inv.balance_owing) }
  if (!same(before.paid_amount, next.paid_amount) || !same(before.balance_owing, next.balance_owing)) {
    invoiceChanges.push({ inv, before, after: next, jobber: j })
  }
}

// ── project engagements + leads (money only) ────────────────────────────────
const changedById = Object.fromEntries(invoiceChanges.map(c => [c.inv.id, c.after]))
const engIds = [...new Set(invoiceChanges.map(c => c.inv.engagement_id).filter(Boolean))]
const leadIds = [...new Set(invoiceChanges.map(c => c.inv.lead_id).filter(Boolean))]
const engRows = await sbIn('engagements', `id,client_id,location_uuid,stage,closed_reason,${ENG_MONEY_COLS.join(',')}`, 'id', engIds)
const engInvoices = await sbIn('invoices', 'id,engagement_id,status,total,paid_amount,balance_owing', 'engagement_id', engIds)
const leadRows = await sbIn('leads', 'id,name,paid_amount,balance_owing', 'id', leadIds)
const leadInvoices = await sbIn('invoices', 'id,lead_id,status,total,paid_amount,balance_owing', 'lead_id', leadIds)
const projected = i => (changedById[i.id] ? { ...i, ...changedById[i.id] } : i)
const byKey = (rows, k) => { const m = {}; for (const r of rows) (m[r[k]] ||= []).push(r); return m }
const invByEng = byKey(engInvoices, 'engagement_id'), invByLead = byKey(leadInvoices, 'lead_id')

const engagementChanges = []
const outcomes = []
for (const e of engRows) {
  const beforeInv = invByEng[e.id] || []
  const afterInv = beforeInv.map(projected)
  const before = Object.fromEntries(ENG_MONEY_COLS.map(k => [k, num(e[k])]))
  const after = { ...rollUpInvoiceMoney(afterInv) }
  if (hasWrittenOffColumn) after.written_off_amount = wo.isWrittenOff(e) ? wo.writtenOffAmountFromInvoices(afterInv) : before.written_off_amount
  if (ENG_MONEY_COLS.some(k => !same(before[k], after[k]))) engagementChanges.push({ id: e.id, client_id: e.client_id, before, after })

  // Kevin's question: owed → settled, and why.
  const owedBefore = fp.owedOnInvoices(beforeInv), owedAfter = fp.owedOnInvoices(afterInv)
  const why = afterInv.some(i => i.status === 'bad_debt') ? 'written off in Jobber (bad debt)'
    : afterInv.some(i => i.status !== 'paid' && Number(i.balance_owing) === 0 && Number(i.paid_amount) === 0) ? 'voided in Jobber'
    : 'paid (deposit / payments)'
  const where = e.stage === 'Final Processing' ? 'Final Processing'
    : e.stage === 'Closed Won' && e.closed_reason === 'won_balance_owing' ? 'owing override (closed Won)'
    : e.stage
  outcomes.push({
    id: e.id, client_id: e.client_id, where, why,
    owedBefore: Math.round(owedBefore * 100) / 100, owedAfter: Math.round(owedAfter * 100) / 100,
    settled: owedBefore > 0 && owedAfter <= 0,
    fpCaseBefore: fp.finalProcessingCase(e, beforeInv), fpCaseAfter: fp.finalProcessingCase(e, afterInv),
  })
}
const leadChanges = []
for (const l of leadRows) {
  const afterInv = (invByLead[l.id] || []).map(projected)
  const before = { paid_amount: num(l.paid_amount), balance_owing: num(l.balance_owing) }
  const after = { paid_amount: sumPaidInvoices(afterInv), balance_owing: sumBalanceOwing(afterInv) }
  if (!same(before.paid_amount, after.paid_amount) || !same(before.balance_owing, after.balance_owing)) leadChanges.push({ id: l.id, name: l.name, before, after })
}
const nameOf = Object.fromEntries(leadRows.map(l => [l.id, l.name]))

// ── report ──────────────────────────────────────────────────────────────────
const storedOwed = invoiceChanges.reduce((s, c) => s + (c.before.balance_owing || 0), 0)
const realOwed = invoiceChanges.reduce((s, c) => s + (c.after.balance_owing || 0), 0)
console.log(`unpaid invoices: ${unpaid.length} · asked Jobber: ${Object.keys(jobberNow).length} · skipped (no valid token): ${Object.values(skippedLocations).reduce((a, b) => a + b, 0)} at ${Object.keys(skippedLocations).length} locations`)
if (Object.keys(skippedLocations).length) console.log(`   skipped: ${Object.entries(skippedLocations).map(([k, v]) => `${k} (${v})`).join(', ')}`)
if (unreadable.length) console.log(`   could not read: ${unreadable.length} — ${unreadable.slice(0, 5).map(u => `${u.slug} ${u.error}`).join('; ')}`)
if (statusMismatch.length) console.log(`   PAID in Jobber but unpaid here (left alone — status is the webhook's job): ${statusMismatch.length}`)
const balanceMoves = invoiceChanges.filter(c => !same(c.before.balance_owing, c.after.balance_owing))
const receivedOnly = invoiceChanges.length - balanceMoves.length
console.log(`\n→ invoices that WOULD CHANGE: ${invoiceChanges.length} · shown owing ${money(storedOwed)} → Jobber says ${money(realOwed)} (${money(storedOwed - realOwed)} not actually owed)`)
console.log(`   balance changes: ${balanceMoves.length} · only "received" recorded (owing unchanged, received $0 instead of blank): ${receivedOnly}`)
for (const c of balanceMoves) {
  const j = c.jobber.amounts
  console.log(`   ${c.inv.location_id} ${nameOf[c.inv.lead_id] || c.inv.lead_id}: owing ${money(c.before.balance_owing)} → ${money(c.after.balance_owing)} · received ${money(c.after.paid_amount)} (payments ${money(j.paymentsTotal)} + deposit ${money(j.depositAmount)}) · Jobber ${c.jobber.invoiceStatus}${c.inv.engagement_id ? '' : ' · on no deal'}`)
}
const settled = outcomes.filter(o => o.settled)
console.log(`\n→ deals that go from OWED to SETTLED: ${settled.length}`)
const group = {}
for (const o of settled) (group[`${o.where} · ${o.why}`] ||= []).push(o)
for (const [k, rows] of Object.entries(group)) {
  console.log(`   ${k}: ${rows.length}`)
  for (const o of rows) console.log(`      ${nameOf[o.client_id] || o.client_id}: ${money(o.owedBefore)} → ${money(o.owedAfter)}${o.fpCaseBefore ? ` · Final Processing ${o.fpCaseBefore} → ${o.fpCaseAfter}` : ''}`)
}
const lessOwed = outcomes.filter(o => !o.settled && o.owedAfter < o.owedBefore)
console.log(`→ deals still owed, but LESS: ${lessOwed.length}`)
for (const o of lessOwed) console.log(`      ${o.where} · ${nameOf[o.client_id] || o.client_id}: ${money(o.owedBefore)} → ${money(o.owedAfter)} (${o.why})`)
console.log(`→ engagement money rows that would change: ${engagementChanges.length} · people: ${leadChanges.length}`)

const report = {
  mode: EXECUTE ? 'execute' : 'dry-run', at: nowIso(), refresh: REFRESH, location: ONLY,
  unpaidInvoices: unpaid.length, askedJobber: Object.keys(jobberNow).length,
  skippedLocations, unreadable, statusMismatch,
  shownOwing: Math.round(storedOwed * 100) / 100, jobberOwing: Math.round(realOwed * 100) / 100,
  outcomes,
  invoices: invoiceChanges.map(c => ({ id: c.inv.id, slug: c.inv.location_id, before: c.before, after: c.after, jobber: c.jobber })),
  engagements: engagementChanges,
  leads: leadChanges.map(l => ({ id: l.id, before: l.before, after: l.after })),
  errors: [],
}

// ── execute ─────────────────────────────────────────────────────────────────
if (EXECUTE) {
  console.log('\nexecuting…')
  const snapLeads = leadChanges.map(l => l.id), snapEngs = engRows.map(e => e.id)
  const before = await sideEffectSnapshot(snapLeads, snapEngs)
  const written = { invoices: 0, engagements: 0, leads: 0 }
  for (const c of report.invoices) {
    try {
      const r = await sb(`invoices?id=eq.${c.id}&status=neq.paid&${eqGuard('paid_amount', c.before.paid_amount)}&${eqGuard('balance_owing', c.before.balance_owing)}`,
        { method: 'PATCH', body: JSON.stringify({ ...c.after, updated_at: nowIso() }), headers: { Prefer: 'return=representation' } })
      if (r?.length) written.invoices++; else report.errors.push(`invoice ${c.id}: changed since the plan was read — skipped`)
    } catch (e) { report.errors.push(`invoice ${c.id}: ${e.message}`) }
  }
  // Engagements and people are recomputed from the invoices AS NOW STORED,
  // not from the projection, so a skipped invoice can't leave a total wrong.
  const nowEngInv = byKey(await sbIn('invoices', 'id,engagement_id,status,total,paid_amount,balance_owing', 'engagement_id', engIds), 'engagement_id')
  const engById = Object.fromEntries(engRows.map(e => [e.id, e]))
  for (const c of report.engagements) {
    const inv = nowEngInv[c.id] || []
    const patch = { ...rollUpInvoiceMoney(inv) }
    if (hasWrittenOffColumn && wo.isWrittenOff(engById[c.id])) patch.written_off_amount = wo.writtenOffAmountFromInvoices(inv)
    c.after = { ...c.after, ...patch }
    try {
      // money columns only — stage is not in this body and never will be
      const r = await sb(`engagements?id=eq.${c.id}&${eqGuard('balance_owing', c.before.balance_owing)}`,
        { method: 'PATCH', body: JSON.stringify({ ...patch, updated_at: nowIso() }), headers: { Prefer: 'return=representation' } })
      if (r?.length) written.engagements++; else report.errors.push(`engagement ${c.id}: changed since the plan was read — skipped`)
    } catch (e) { report.errors.push(`engagement ${c.id}: ${e.message}`) }
  }
  const nowLeadInv = byKey(await sbIn('invoices', 'id,lead_id,status,total,paid_amount,balance_owing', 'lead_id', leadIds), 'lead_id')
  for (const c of report.leads) {
    const inv = nowLeadInv[c.id] || []
    c.after = { paid_amount: sumPaidInvoices(inv), balance_owing: sumBalanceOwing(inv) }
    try {
      const r = await sb(`leads?id=eq.${c.id}&${eqGuard('balance_owing', c.before.balance_owing)}`,
        { method: 'PATCH', body: JSON.stringify(c.after), headers: { Prefer: 'return=representation' } })
      if (r?.length) written.leads++; else report.errors.push(`lead ${c.id}: changed since the plan was read — skipped`)
    } catch (e) { report.errors.push(`lead ${c.id}: ${e.message}`) }
  }
  const perSlug = {}
  for (const c of report.invoices) perSlug[c.slug] = (perSlug[c.slug] || 0) + 1
  for (const [slug, n] of Object.entries(perSlug)) {
    await sb('sync_log', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ location_id: slug, direction: 'inbound', entity_type: 'invoice', status: 'success', message: `[invoice:repair] ${n} unpaid invoice(s) set to Jobber's real balance (repair-invoice-balances)` }) })
  }
  console.log(`written: invoices ${written.invoices}/${report.invoices.length} · engagements ${written.engagements}/${report.engagements.length} · people ${written.leads}/${report.leads.length}${report.errors.length ? ` · ${report.errors.length} skipped/errors` : ''}`)
  assertNoDrift(before, await sideEffectSnapshot(snapLeads, snapEngs))
}

const outPath = `repair-invoice-balances.report.${EXECUTE ? 'run' : 'dryrun'}.json`
writeFileSync(outPath, JSON.stringify(report, null, 2))
console.log(`\nreport written: ${outPath}${EXECUTE ? `  (undo: node scripts/repair-invoice-balances.mjs --undo ${outPath})` : ''}`)
