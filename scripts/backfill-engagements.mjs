// ═══════════════════════════════════════════════════════════════════════════
// HIVE Phase 1 — Step 2: engagement backfill
// (docs/hive-phase1-engagements.md §5 / §9 step 2)
//
// Usage:
//   node scripts/backfill-engagements.mjs [envfile] [--execute] [--report path]
//
// DRY-RUN BY DEFAULT — zero writes unless --execute is passed. The dry run
// prints per-stage/per-location counts, samples, and anomalies, and writes a
// JSON report for review.
//
// Grouping: hub-and-spoke on service_request_id. Every SR founds one
// engagement (founded_by='request'); quotes/jobs attach via their
// service_request_id; invoices attach via their job. Orphans found
// implicitly (founded_by='quote'|'job') with a logged note.
//
// Idempotent: children with engagement_id already set are skipped; an SR
// whose engagement_id is set is the marker that its engagement exists (its
// still-unattached children get attached on re-run). Before executing, the
// script aborts if unreferenced engagements exist (crashed-run debris).
//
// Silent bookkeeping only: no nurture sequences, no nurture_started_at.
// touchpoints stay engagement_id=null (historical touchpoints are
// client-level).
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync } from 'fs'

// ── args / env ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const EXECUTE = args.includes('--execute')
const reportIdx = args.indexOf('--report')
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--report')
const envPath = positional[0] || '.env.local'
const reportPath = reportIdx >= 0
  ? args[reportIdx + 1]
  : `backfill-engagements-report.${EXECUTE ? 'run' : 'dryrun'}.json`

const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]
    })
)
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL
const KEY = env.SUPABASE_SERVICE_ROLE_KEY
if (!URL_ || !KEY) { console.error('missing supabase env in ' + envPath); process.exit(1) }
const H = { apikey: KEY, authorization: `Bearer ${KEY}` }

const THIRTY_D = 30 * 24 * 60 * 60 * 1000 // NURTURING_AGE_MS
const NOW = Date.now()
const NOW_ISO = new Date(NOW).toISOString()
const ts = v => (v ? new Date(v).getTime() : 0)

// ── fetch helpers ───────────────────────────────────────────────────────────

async function fetchAll(table, select, extra = '') {
  const out = []
  const page = 1000
  for (let from = 0; ; from += page) {
    const r = await fetch(`${URL_}/rest/v1/${table}?select=${select}&order=id.asc${extra}`, {
      headers: { ...H, range: `${from}-${from + page - 1}` },
    })
    if (!r.ok) throw new Error(`${table}: HTTP ${r.status} ${await r.text()}`)
    const rows = await r.json()
    out.push(...rows)
    if (rows.length < page) break
  }
  return out
}

async function post(table, body) {
  const r = await fetch(`${URL_}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...H, 'content-type': 'application/json', prefer: 'return=representation' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`POST ${table}: HTTP ${r.status} ${await r.text()}`)
  return r.json()
}

async function patch(table, filter, body) {
  const r = await fetch(`${URL_}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: { ...H, 'content-type': 'application/json', prefer: 'return=minimal' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`PATCH ${table}?${filter}: HTTP ${r.status} ${await r.text()}`)
}

async function pool(items, worker, size = 8) {
  let i = 0
  const errors = []
  await Promise.all(Array.from({ length: size }, async () => {
    while (i < items.length) {
      const item = items[i++]
      try { await worker(item) } catch (e) { errors.push({ item, error: String(e) }) }
    }
  }))
  return errors
}

// ── load ────────────────────────────────────────────────────────────────────

console.error(`mode: ${EXECUTE ? 'EXECUTE (writes!)' : 'dry-run (no writes)'}`)
console.error('loading tables…')

const [leads, srs, quotes, jobs, invoices, locations, existingEngagements] = await Promise.all([
  fetchAll('leads', 'id,location_uuid,location_id,name'),
  fetchAll('service_requests', 'id,lead_id,engagement_id,requested_at,created_at'),
  fetchAll('quotes', 'id,lead_id,service_request_id,engagement_id,status,sent_at,approved_at,created_at,total'),
  fetchAll('jobs', 'id,lead_id,service_request_id,engagement_id,status,title,completed_at,scheduled_start,created_at,total'),
  fetchAll('invoices', 'id,lead_id,job_id,service_request_id,engagement_id,status,total,paid_amount,balance_owing,paid_at,issued_at,created_at'),
  fetchAll('locations', 'id,location_id,name'),
  fetchAll('engagements', 'id'),
])
console.error(`loaded: ${leads.length} leads, ${srs.length} SRs, ${quotes.length} quotes, ${jobs.length} jobs, ${invoices.length} invoices, ${existingEngagements.length} existing engagements`)

const leadById = new Map(leads.map(l => [l.id, l]))
const locNameByUuid = new Map(locations.map(l => [l.id, l.name || l.location_id]))
const jobById = new Map(jobs.map(j => [j.id, j]))

const groupBy = (rows, key) => {
  const m = new Map()
  for (const r of rows) {
    const k = r[key]
    if (!k) continue
    if (!m.has(k)) m.set(k, [])
    m.get(k).push(r)
  }
  return m
}
const quotesBySr = groupBy(quotes, 'service_request_id')
const jobsBySr = groupBy(jobs, 'service_request_id')
const invoicesByJob = groupBy(invoices, 'job_id')

// ── stage derivation (447be62 re-expressed per engagement) ──────────────────

const jobDone = j => !!j.completed_at || (j.status || '').toLowerCase().includes('complet')
const invoicePaid = i => i.status === 'paid'
const quoteActivity = q => Math.max(ts(q.approved_at), ts(q.sent_at), ts(q.created_at))
const srActivity = s => ts(s.requested_at) || ts(s.created_at)

function deriveStage({ sr, eQuotes, eJobs, eInvoices }) {
  // Jobs present: work happened.
  if (eJobs.length > 0) {
    if (eJobs.some(j => !jobDone(j))) return { stage: 'Job in Progress' }
    // All jobs done.
    if (eInvoices.length > 0 && eInvoices.every(invoicePaid)) {
      const lastPaidAt = Math.max(0, ...eInvoices.map(i => ts(i.paid_at)))
      return {
        stage: 'Closed Won',
        closed_reason: 'won',
        closed_at: lastPaidAt
          ? new Date(lastPaidAt).toISOString()
          : NOW_ISO, // anomaly logged by caller when paid_at missing
        _noPaidAt: !lastPaidAt,
      }
    }
    // Complete + owing, or complete + never invoiced: money loose end.
    return { stage: 'Final Processing' }
  }
  // Quotes present, no jobs.
  if (eQuotes.length > 0) {
    const last = Math.max(...eQuotes.map(quoteActivity))
    if (NOW - last > THIRTY_D) {
      // Ruling A (decision 14): an unanswered old estimate is not a live
      // deal — close; client joins the nurture pool at the client level.
      return { stage: 'Closed Lost', closed_reason: 'stale_on_import', closed_at: NOW_ISO }
    }
    return { stage: 'Estimate' }
  }
  // Request-only.
  if (sr) {
    const t = srActivity(sr)
    if (!t || NOW - t > THIRTY_D) {
      return { stage: 'Closed Lost', closed_reason: 'stale_on_import', closed_at: NOW_ISO }
    }
    return { stage: 'Request' }
  }
  return { stage: 'Request', _noFoundingRecord: true }
}

const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const fallbackTitle = t => {
  const d = t ? new Date(t) : new Date(NOW)
  return `Engagement – ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

// ── plan ────────────────────────────────────────────────────────────────────

const anomalies = []
const implicitFoundings = []
const plans = []          // engagements to create
const attachOnly = []     // children to attach to pre-existing engagements
const claimedQuotes = new Set(), claimedJobs = new Set(), claimedInvoices = new Set()

function planEngagement({ foundedBy, sr, foundingRecord, leadId, eQuotes, eJobs, eInvoices }) {
  const lead = leadById.get(leadId)
  if (!lead) {
    anomalies.push({ kind: 'missing_lead', foundedBy, recordId: (sr ?? foundingRecord).id, leadId })
    return
  }
  if (!lead.location_uuid) {
    // location_uuid sourced from leads.location_uuid ONLY — never via slug.
    // The locations FK on engagements would reject garbage loudly anyway.
    anomalies.push({ kind: 'missing_location_uuid', foundedBy, recordId: (sr ?? foundingRecord).id, leadId, leadName: lead.name })
    return
  }
  const derived = deriveStage({ sr, eQuotes, eJobs, eInvoices })
  if (derived._noPaidAt) anomalies.push({ kind: 'closed_won_no_paid_at', srId: sr?.id, leadName: lead.name })

  const foundingTime = sr ? srActivity(sr) : ts(foundingRecord.created_at)
  const jobTitle = eJobs.find(j => j.title && j.title.trim())?.title?.trim()
  const num = v => (v == null ? 0 : Number(v) || 0)
  const totalInvoiced = eInvoices.reduce((s, i) => s + num(i.total), 0)
  const totalPaid = eInvoices.reduce((s, i) => s + num(i.paid_amount), 0)
  const balanceOwing = eInvoices.reduce(
    (s, i) => s + (i.balance_owing != null ? num(i.balance_owing) : num(i.total) - num(i.paid_amount)), 0)

  // Last activity across the chain — used for stage_entered_at so the
  // record reads historically sane (flagged in review notes).
  const lastActivity = Math.max(
    foundingTime,
    ...eQuotes.map(quoteActivity),
    ...eJobs.map(j => Math.max(ts(j.completed_at), ts(j.scheduled_start), ts(j.created_at))),
    ...eInvoices.map(i => Math.max(ts(i.paid_at), ts(i.issued_at), ts(i.created_at))),
  )

  plans.push({
    row: {
      client_id: leadId,
      location_uuid: lead.location_uuid,
      stage: derived.stage,
      founded_by: foundedBy,
      title: jobTitle || fallbackTitle(foundingTime),
      stage_entered_at: lastActivity ? new Date(lastActivity).toISOString() : NOW_ISO,
      closed_at: derived.closed_at ?? null,
      closed_reason: derived.closed_reason ?? null,
      closed_note: derived.closed_reason === 'stale_on_import'
        ? 'Closed automatically at backfill: no activity within 30 days (Ruling A for quote-only).'
        : null,
      total_invoiced: totalInvoiced,
      total_paid: totalPaid,
      balance_owing: balanceOwing,
      created_at: foundingTime ? new Date(foundingTime).toISOString() : NOW_ISO,
      updated_at: NOW_ISO,
    },
    srId: sr?.id ?? null,
    quoteIds: eQuotes.filter(q => !q.engagement_id).map(q => q.id),
    jobIds: eJobs.filter(j => !j.engagement_id).map(j => j.id),
    invoiceIds: eInvoices.filter(i => !i.engagement_id).map(i => i.id),
    locationName: locNameByUuid.get(lead.location_uuid) ?? lead.location_id,
    leadName: lead.name,
  })
  if (foundedBy !== 'request') {
    implicitFoundings.push({
      foundedBy, recordId: foundingRecord.id, leadId, leadName: lead.name,
      stage: derived.stage,
      note: `implicit founding: orphan ${foundedBy} ${foundingRecord.id} had no service_request`,
    })
  }
}

// 1. Every service_request founds (or already founded) one engagement.
for (const sr of srs) {
  const eQuotes = quotesBySr.get(sr.id) ?? []
  const eJobs = jobsBySr.get(sr.id) ?? []
  const eInvoices = eJobs.flatMap(j => invoicesByJob.get(j.id) ?? [])
  eQuotes.forEach(q => claimedQuotes.add(q.id))
  eJobs.forEach(j => claimedJobs.add(j.id))
  eInvoices.forEach(i => claimedInvoices.add(i.id))

  if (sr.engagement_id) {
    // Already founded (idempotent re-run) — attach any unattached children.
    const q = eQuotes.filter(x => !x.engagement_id).map(x => x.id)
    const j = eJobs.filter(x => !x.engagement_id).map(x => x.id)
    const i = eInvoices.filter(x => !x.engagement_id).map(x => x.id)
    if (q.length || j.length || i.length) {
      attachOnly.push({ engagementId: sr.engagement_id, quoteIds: q, jobIds: j, invoiceIds: i })
    }
    continue
  }
  planEngagement({ foundedBy: 'request', sr, foundingRecord: sr, leadId: sr.lead_id, eQuotes, eJobs, eInvoices })
}

// 2. Orphan quotes (no SR) — implicit founding. Currently zero in prod.
for (const q of quotes) {
  if (q.service_request_id || q.engagement_id || claimedQuotes.has(q.id)) continue
  planEngagement({ foundedBy: 'quote', sr: null, foundingRecord: q, leadId: q.lead_id, eQuotes: [q], eJobs: [], eInvoices: [] })
}

// 3. Orphan jobs (no SR) — implicit founding, bringing their invoices.
for (const j of jobs) {
  if (j.service_request_id || j.engagement_id || claimedJobs.has(j.id)) continue
  const eInvoices = (invoicesByJob.get(j.id) ?? []).filter(i => !claimedInvoices.has(i.id))
  eInvoices.forEach(i => claimedInvoices.add(i.id))
  planEngagement({ foundedBy: 'job', sr: null, foundingRecord: j, leadId: j.lead_id, eQuotes: [], eJobs: [j], eInvoices })
}

// 4. Fully orphaned invoices (no job, or job unresolvable): cannot found —
//    founded_by has no 'invoice' value by design. Log and leave unattached.
for (const i of invoices) {
  if (i.engagement_id || claimedInvoices.has(i.id)) continue
  if (i.job_id && jobById.has(i.job_id)) continue // claimed via its job path
  anomalies.push({ kind: 'orphan_invoice_unattachable', invoiceId: i.id, leadId: i.lead_id })
}

// ── report ──────────────────────────────────────────────────────────────────

const byLocStage = {}
const byStage = {}
const byFoundedBy = {}
for (const p of plans) {
  const loc = p.locationName ?? 'UNKNOWN'
  byLocStage[loc] ??= {}
  byLocStage[loc][p.row.stage] = (byLocStage[loc][p.row.stage] ?? 0) + 1
  byStage[p.row.stage] = (byStage[p.row.stage] ?? 0) + 1
  byFoundedBy[p.row.founded_by] = (byFoundedBy[p.row.founded_by] ?? 0) + 1
}
const samples = {}
for (const p of plans) {
  samples[p.row.stage] ??= []
  if (samples[p.row.stage].length < 3) {
    samples[p.row.stage].push({
      lead: p.leadName, location: p.locationName, title: p.row.title,
      founded_by: p.row.founded_by, closed_reason: p.row.closed_reason,
      total_invoiced: p.row.total_invoiced, total_paid: p.row.total_paid,
      balance_owing: p.row.balance_owing,
      children: { quotes: p.quoteIds.length, jobs: p.jobIds.length, invoices: p.invoiceIds.length },
    })
  }
}

const report = {
  mode: EXECUTE ? 'execute' : 'dry-run',
  generated_at: NOW_ISO,
  totals: {
    engagements_planned: plans.length,
    attach_only_engagements: attachOnly.length,
    existing_engagements: existingEngagements.length,
    children_to_attach: {
      service_requests: plans.filter(p => p.srId).length,
      quotes: plans.reduce((s, p) => s + p.quoteIds.length, 0) + attachOnly.reduce((s, a) => s + a.quoteIds.length, 0),
      jobs: plans.reduce((s, p) => s + p.jobIds.length, 0) + attachOnly.reduce((s, a) => s + a.jobIds.length, 0),
      invoices: plans.reduce((s, p) => s + p.invoiceIds.length, 0) + attachOnly.reduce((s, a) => s + a.invoiceIds.length, 0),
    },
  },
  counts_by_stage: byStage,
  counts_by_location_and_stage: byLocStage,
  counts_by_founded_by: byFoundedBy,
  implicit_foundings: implicitFoundings,
  anomalies,
  samples_per_stage: samples,
}

console.log('\n== engagement backfill plan ==')
console.log(JSON.stringify({ ...report, samples_per_stage: undefined, implicit_foundings: implicitFoundings.length, anomalies: anomalies.length }, null, 2))
console.log(`\nanomalies: ${anomalies.length}, implicit foundings: ${implicitFoundings.length} (full detail in report)`)
writeFileSync(reportPath, JSON.stringify(report, null, 2))
console.log(`report written: ${reportPath}`)

if (!EXECUTE) {
  console.log('\nDRY RUN — no writes performed. Re-run with --execute after review.')
  process.exit(0)
}

// ── execute ─────────────────────────────────────────────────────────────────

// Safety: unreferenced engagements = debris from a crashed run; a blind
// re-insert would duplicate. Abort for manual inspection.
if (existingEngagements.length > 0) {
  const referenced = new Set([
    ...srs.map(s => s.engagement_id),
    ...quotes.map(q => q.engagement_id),
    ...jobs.map(j => j.engagement_id),
    ...invoices.map(i => i.engagement_id),
  ].filter(Boolean))
  const orphaned = existingEngagements.filter(e => !referenced.has(e.id))
  if (orphaned.length > 0) {
    console.error(`ABORT: ${orphaned.length} engagements exist that no child references (crashed prior run?). Inspect before re-running:`)
    console.error(orphaned.slice(0, 20).map(e => e.id).join('\n'))
    process.exit(2)
  }
}

console.log(`\nEXECUTING: creating ${plans.length} engagements, attaching children…`)
let created = 0
const writeErrors = await pool(plans, async (p) => {
  const [row] = await post('engagements', p.row)
  const eid = row.id
  // SR first — it is the idempotency marker for this engagement.
  if (p.srId) await patch('service_requests', `id=eq.${p.srId}&engagement_id=is.null`, { engagement_id: eid })
  for (const [table, ids] of [['quotes', p.quoteIds], ['jobs', p.jobIds], ['invoices', p.invoiceIds]]) {
    for (let c = 0; c < ids.length; c += 100) {
      const chunk = ids.slice(c, c + 100)
      await patch(table, `id=in.(${chunk.join(',')})&engagement_id=is.null`, { engagement_id: eid })
    }
  }
  created++
  if (created % 100 === 0) console.log(`  ${created}/${plans.length} engagements created`)
})

const attachErrors = await pool(attachOnly, async (a) => {
  for (const [table, ids] of [['quotes', a.quoteIds], ['jobs', a.jobIds], ['invoices', a.invoiceIds]]) {
    for (let c = 0; c < ids.length; c += 100) {
      const chunk = ids.slice(c, c + 100)
      await patch(table, `id=in.(${chunk.join(',')})&engagement_id=is.null`, { engagement_id: a.engagementId })
    }
  }
})

console.log(`\nDONE: ${created}/${plans.length} engagements created, ${attachOnly.length} attach-only processed`)
if (writeErrors.length || attachErrors.length) {
  console.error(`WRITE ERRORS: ${writeErrors.length + attachErrors.length} — re-run is safe (idempotent); details:`)
  for (const e of [...writeErrors, ...attachErrors].slice(0, 20)) console.error(`  ${e.error}`)
  writeFileSync(reportPath.replace(/\.json$/, '.errors.json'), JSON.stringify({ writeErrors, attachErrors }, null, 2))
  process.exit(3)
}
