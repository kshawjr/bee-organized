// ═══════════════════════════════════════════════════════════════════════════
// Per-client/job forensic trace — "jobs not moving" investigation.
// ClickUp: 868kax0tg
//
// Usage:  node scripts/trace-job.mjs --name "Andrea Quinn" [--loc loc_palmbeach]
//    or:  node scripts/trace-job.mjs --lead <lead_uuid>
//    or:  node scripts/trace-job.mjs --jobber-job <numeric jobber job id>
// Flags:  --env <path>     env file (default .env.local — run from repo root)
//         --no-jobber      skip the Jobber-side comparison entirely
//         --refresh        allow an expired Jobber token to be refreshed
//
// Reports, for one lead:
//   1. Stored lead state (stage, client_status, jobber ids, event stamps)
//   2. Engagements + child records (SR/quote/job/invoice rows), each
//      engagement's stored stage vs derived stage (drift flagged)
//   3. stage_change touchpoints — who moved it, when, from→to
//   4. sync_log trail — every webhook received + its outcome
//   5. Jobber's CURRENT state for each linked record, side by side with
//      the stored row (status mismatches flagged)
//
// READ-ONLY: zero writes to Supabase data and zero writes to Jobber. The
// one exception is opt-in: --refresh lets getValidToken refresh an expired
// access token, which rotates the locations-row token columns (same
// authorized side effect as scan-requestless-gap.mjs). Without --refresh,
// an expired token just skips section 5 with a note.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const arg = k => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : null }
const flag = k => process.argv.includes(k)

const env = Object.fromEntries(
  readFileSync(arg('--env') || '.env.local', 'utf8')
    .split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] })
)
if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('missing supabase env — run from repo root or pass --env <path>')
  process.exit(1)
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

const name = arg('--name'), loc = arg('--loc'), leadArg = arg('--lead'), jj = arg('--jobber-job')
if (!name && !leadArg && !jj) {
  console.error('need --name "<client name>" | --lead <uuid> | --jobber-job <id>')
  process.exit(1)
}

// ── 1. resolve the lead ─────────────────────────────────────────────────────

let lead = null
if (leadArg) {
  ({ data: lead } = await sb.from('leads').select('*').eq('id', leadArg).maybeSingle())
} else if (jj) {
  const { data: jobRow } = await sb.from('jobs').select('lead_id').eq('jobber_job_id', jj).maybeSingle()
  if (jobRow) ({ data: lead } = await sb.from('leads').select('*').eq('id', jobRow.lead_id).maybeSingle())
  if (!lead) ({ data: lead } = await sb.from('leads').select('*').eq('jobber_job_id', jj).maybeSingle())
} else {
  let q = sb.from('leads').select('*').ilike('name', `%${name}%`)
  if (loc) q = q.eq('location_id', loc)
  const { data: matches } = await q.limit(5)
  if ((matches?.length ?? 0) > 1) {
    console.log('multiple matches — narrow with --loc or use --lead:')
    for (const m of matches) console.log(`  ${m.id}  ${m.name} @${m.location_id}`)
    process.exit(1)
  }
  lead = matches?.[0] ?? null
}
if (!lead) { console.log('no lead found'); process.exit(1) }

console.log(`LEAD ${lead.id} — ${lead.name} @${lead.location_id}`)
console.log(`  lead.stage=${lead.stage}  client_status=${lead.client_status ?? '—'}`)
console.log(`  jobber ids: client=${lead.jobber_client_id} request=${lead.jobber_request_id} quote=${lead.jobber_quote_id} job=${lead.jobber_job_id} invoice=${lead.jobber_invoice_id}`)
console.log(`  event stamps: request=${lead.request_created_at} quote_sent=${lead.quote_sent_at} quote_approved=${lead.quote_approved_at} job_created=${lead.job_created_at} job_completed=${lead.job_completed_at} invoice_paid=${lead.invoice_paid_at}`)

// ── 2. engagements + children ───────────────────────────────────────────────

const { data: engs } = await sb.from('engagements').select('*').eq('client_id', lead.id).order('created_at')
const RANK = { 'Request': 0, 'Estimate': 1, 'Job in Progress': 2, 'Final Processing': 3, 'Closed Won': 4, 'Closed Lost': 4 }
const jobDone = j => !!j.completed_at || (j.status || '').toLowerCase().includes('complet')
function derive({ quotes, jobs, invoices }) {
  if (jobs.length > 0) {
    if (jobs.some(j => !jobDone(j))) return 'Job in Progress'
    if (invoices.length > 0 && invoices.every(i => i.status === 'paid')) return 'Closed Won'
    return 'Final Processing'
  }
  if (quotes.length > 0) return 'Estimate'
  return 'Request'
}

// typed jobber-id → stored-row maps, so section 5 can compare per record
const stored = { Request: new Map(), Quote: new Map(), Job: new Map(), Invoice: new Map() }
const track = (type, jobberId, row) => { if (jobberId != null) stored[type].set(String(jobberId), row) }

for (const e of engs ?? []) {
  const [q, j, i, s] = await Promise.all([
    sb.from('quotes').select('*').eq('engagement_id', e.id),
    sb.from('jobs').select('*').eq('engagement_id', e.id),
    sb.from('invoices').select('*').eq('engagement_id', e.id),
    sb.from('service_requests').select('*').eq('engagement_id', e.id),
  ])
  const kids = { quotes: q.data ?? [], jobs: j.data ?? [], invoices: i.data ?? [] }
  const d = derive(kids)
  const drift = (RANK[d] ?? 0) > (RANK[e.stage] ?? 0) ? '  ⚠️ DRIFT (derived ahead of stored)' : ''
  console.log(`\nENGAGEMENT ${e.id} "${e.title}"`)
  console.log(`  stored=${e.stage} (entered ${e.stage_entered_at})  derived=${d}${drift}  closed_reason=${e.closed_reason ?? '—'}  founded_by=${e.founded_by}`)
  for (const r of s.data ?? [])   { console.log(`  SR      ${r.id}  jobber=${r.jobber_request_id}  requested=${r.requested_at}`); track('Request', r.jobber_request_id, r) }
  for (const r of kids.quotes)    { console.log(`  QUOTE   ${r.id}  jobber=${r.jobber_quote_id}  status=${r.status}  sent=${r.sent_at}  approved=${r.approved_at}`); track('Quote', r.jobber_quote_id, r) }
  for (const r of kids.jobs)      { console.log(`  JOB     ${r.id}  jobber=${r.jobber_job_id}  status=${r.status}  sched=${r.scheduled_start}  completed=${r.completed_at}`); track('Job', r.jobber_job_id, r) }
  for (const r of kids.invoices)  { console.log(`  INVOICE ${r.id}  jobber=${r.jobber_invoice_id}  status=${r.status}  total=${r.total}  paid=${r.paid_amount}  paid_at=${r.paid_at}`); track('Invoice', r.jobber_invoice_id, r) }
}
// lead-level pointers may reference records with no child row yet — trace those too
track('Request', lead.jobber_request_id, null)
track('Quote', lead.jobber_quote_id, null)
track('Job', lead.jobber_job_id, null)
track('Invoice', lead.jobber_invoice_id, null)

// ── 3. stage_change touchpoints (manual = user_id set; drift-recovery = null)

const { data: tps } = await sb.from('touchpoints').select('id, kind, label, user_id, engagement_id, occurred_at')
  .eq('lead_id', lead.id).eq('kind', 'stage_change').order('occurred_at')
console.log(`\nSTAGE_CHANGE TOUCHPOINTS (${tps?.length ?? 0}):`)
for (const t of tps ?? []) console.log(`  ${t.occurred_at}  ${t.label}  ${t.user_id ? `by user ${t.user_id}` : '(automated drift recovery)'}  eng=${t.engagement_id ?? '—'}`)

// ── 4. sync_log: every webhook + engagement event touching this lead ────────

const engIds = (engs ?? []).map(e => e.id)
const allJobberIds = [...Object.values(stored).flatMap(m => [...m.keys()])].filter(x => x && x !== 'null')
const ors = [
  `entity_id.eq.${lead.id}`,
  ...engIds.map(id => `entity_id.eq.${id}`),
  ...allJobberIds.map(x => `jobber_record_id.eq.${x}`),
]
const { data: logs } = await sb.from('sync_log').select('created_at, direction, entity_type, status, jobber_record_id, message')
  .or(ors.join(',')).order('created_at')
// plus message-embedded lead references (engagement founding notes etc.)
const { data: logs2 } = await sb.from('sync_log').select('created_at, direction, entity_type, status, jobber_record_id, message')
  .ilike('message', `%${lead.id}%`).order('created_at')
const seen = new Set(), all = []
for (const r of [...(logs ?? []), ...(logs2 ?? [])]) {
  const k = r.created_at + r.message
  if (!seen.has(k)) { seen.add(k); all.push(r) }
}
all.sort((a, b) => a.created_at.localeCompare(b.created_at))
console.log(`\nSYNC_LOG TRAIL (${all.length}):`)
for (const r of all) console.log(`  ${r.created_at}  ${r.status === 'error' ? '❌' : '✓'} [${r.entity_type}/${r.direction}] ${r.message.slice(0, 160)}`)

// ── 5. Jobber's current state, compared to stored rows ──────────────────────

if (flag('--no-jobber')) {
  console.log('\nJOBBER COMPARISON: skipped (--no-jobber)')
  process.exit(0)
}

const JOBBER_URL = 'https://api.getjobber.com/api/graphql'
const JOBBER_VERSION = '2025-04-16'
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function jobberQuery(token, query, variables) {
  const res = await fetch(JOBBER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-JOBBER-GRAPHQL-VERSION': JOBBER_VERSION,
    },
    body: JSON.stringify({ query, variables }),
  })
  const result = await res.json()
  if (result?.errors?.some(e => e.extensions?.code === 'THROTTLED')) {
    await sleep(15000)
    return jobberQuery(token, query, variables)
  }
  return result
}

// same normalization as lib/jobber-webhook-handlers.ts encodeJobberId —
// stored ids are bare numeric; Jobber wants the base64 global id
const encodeJobberId = (type, numeric) =>
  Buffer.from(`gid://Jobber/${type}/${numeric}`, 'utf8').toString('base64')

// Token handling ports getValidJobberToken (lib/jobber.ts), but refresh is
// gated behind --refresh because the rotation is a locations-row write.
async function getValidToken(location) {
  const expiry = location.token_expiry ? parseInt(location.token_expiry) : 0
  if (expiry && Date.now() < expiry - 5 * 60 * 1000) return location.jobber_access_token
  const test = await jobberQuery(location.jobber_access_token, '{ account { id } }')
  if (test?.data?.account?.id) return location.jobber_access_token
  if (!flag('--refresh')) return null
  const res = await fetch('https://api.getjobber.com/api/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: env.JOBBER_CLIENT_ID,
      client_secret: env.JOBBER_CLIENT_SECRET,
      refresh_token: location.jobber_refresh_token,
    }),
  })
  const raw = await res.text()
  let tokens = null
  try { tokens = JSON.parse(raw) } catch {}
  if (!res.ok || !tokens?.access_token) {
    console.log(`  token refresh failed (${res.status}): ${raw.slice(0, 200)}`)
    return null
  }
  const expiryMs = Date.now() + 55 * 60 * 1000
  // MUST NOT be swallowed: Jobber rotates refresh tokens — losing this write
  // would orphan the new refresh token and break the location's connection.
  const { error } = await sb.from('locations').update({
    jobber_access_token: tokens.access_token,
    jobber_refresh_token: tokens.refresh_token,
    token_expiry: expiryMs,
    token_expiry_display: new Date(expiryMs).toISOString().slice(0, 19),
    last_sync_status: `Token refreshed: ${new Date().toISOString().slice(0, 19)}`,
    updated_at: new Date().toISOString(),
  }).eq('location_id', location.location_id)
  if (error) throw new Error(`token rotation write failed: ${error.message}`)
  console.log(`  [token] refreshed + rotated for ${location.location_id}`)
  return tokens.access_token
}

// single-record shapes mirror lib/jobber-import.ts SINGLE_*_QUERY (status
// fields only — this is a comparison, not an import)
const JOBBER_QUERIES = {
  Request: `query($id: EncodedId!) { request(id: $id) { id createdAt jobberWebUri } }`,
  Quote:   `query($id: EncodedId!) { quote(id: $id) { id createdAt quoteStatus jobberWebUri amounts { total } } }`,
  Job:     `query($id: EncodedId!) { job(id: $id) { id createdAt jobStatus startAt completedAt total jobberWebUri } }`,
  Invoice: `query($id: EncodedId!) { invoice(id: $id) { id createdAt invoiceStatus jobberWebUri amounts { total } } }`,
}
const ROOT = { Request: 'request', Quote: 'quote', Job: 'job', Invoice: 'invoice' }

const { data: location } = await sb.from('locations')
  .select('location_id, jobber_access_token, jobber_refresh_token, token_expiry')
  .eq('location_id', lead.location_id).maybeSingle()

console.log(`\nJOBBER CURRENT STATE (location ${lead.location_id}):`)
if (!location?.jobber_access_token) {
  console.log('  no Jobber connection for this location — comparison skipped')
  process.exit(0)
}
const token = await getValidToken(location)
if (!token) {
  console.log('  access token expired — comparison skipped (re-run with --refresh to rotate it, or let the app refresh it on next sync)')
  process.exit(0)
}

for (const type of ['Request', 'Quote', 'Job', 'Invoice']) {
  for (const [jobberId, row] of stored[type]) {
    const res = await jobberQuery(token, JOBBER_QUERIES[type], { id: encodeJobberId(type, jobberId) })
    const node = res?.data?.[ROOT[type]]
    if (!node) {
      console.log(`  ${type.toUpperCase().padEnd(7)} ${jobberId}  ⚠️ NOT FOUND in Jobber (deleted?)${res?.errors ? ` errors=${JSON.stringify(res.errors).slice(0, 120)}` : ''}`)
      continue
    }
    const dbNote = row ? '' : '  ⚠️ lead-level pointer only — NO child row in our DB'
    if (type === 'Job') {
      const jobberDone = !!node.completedAt
      const dbDone = row ? jobDone(row) : null
      const flagStr = row && jobberDone !== dbDone ? '  ⚠️ COMPLETION MISMATCH' : ''
      console.log(`  JOB     ${jobberId}  jobber: status=${node.jobStatus} completed=${node.completedAt ?? '—'}  |  db: status=${row?.status ?? '—'} completed=${row?.completed_at ?? '—'}${flagStr}${dbNote}`)
    } else if (type === 'Invoice') {
      const jobberPaid = (node.invoiceStatus || '').toUpperCase() === 'PAID'
      const dbPaid = row ? row.status === 'paid' : null
      const flagStr = row && jobberPaid !== dbPaid ? '  ⚠️ PAID-STATUS MISMATCH' : ''
      console.log(`  INVOICE ${jobberId}  jobber: status=${node.invoiceStatus} total=${node.amounts?.total ?? '—'}  |  db: status=${row?.status ?? '—'} paid=${row?.paid_amount ?? '—'}${flagStr}${dbNote}`)
    } else if (type === 'Quote') {
      console.log(`  QUOTE   ${jobberId}  jobber: status=${node.quoteStatus}  |  db: status=${row?.status ?? '—'} approved=${row?.approved_at ?? '—'}${dbNote}`)
    } else {
      console.log(`  REQUEST ${jobberId}  jobber: created=${node.createdAt}  |  db: requested=${row?.requested_at ?? '—'}${dbNote}`)
    }
    if (node.jobberWebUri) console.log(`          ${node.jobberWebUri}`)
  }
}
