// ═══════════════════════════════════════════════════════════════════════════
// Repair: unscheduled-jobs stage repair (approved run, 2026-07-10).
//
// Usage:  node scripts/repair-unscheduled-jobs.mjs [--execute] [--refresh] [--env <path>]
//
// Follow-up to a8b7e62 (UNSCHEDULED job-status mapping). For every job
// stored as status='unknown' whose CURRENT raw Jobber jobStatus is
// unscheduled (re-confirmed live at run time — never trusted from an old
// report):
//   1. jobs.status 'unknown' → 'unscheduled'  (conditional on =unknown)
//   2. the lead's stage re-derived over its FULL local history (DB-shaped
//      port of determineLeadStage, lib/jobber-import.ts) and written only
//      when it changed AND the stored stage still matches what this run
//      read (drift guard) — direct write, deliberately bypassing drip
//      side-effects: this is silent bookkeeping, not funnel movement
//   3. sync_log breadcrumb per job flip and per lead stage move (no
//      topic= token — repair rows must not impersonate webhook events on
//      the observability dashboard)
//
// Jobs whose raw status is anything else (action_required etc.) are
// UNTOUCHED — separate decision, separate run.
//
// Side-effect counters (scheduled_stage_emails rows, lead_drip_progress
// rows, leads welcome-scheduled/sent) are snapshotted before and after;
// any drift fails the run loudly.
//
// Dry-run by default: --execute writes. --refresh allows an expired
// Jobber token refresh (rotates locations-row token columns — same
// authorized side effect as scan-unscheduled-unknown.mjs).
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const arg = k => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : null }
const flag = k => process.argv.includes(k)
const EXECUTE = flag('--execute')

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

const JOBBER_URL = 'https://api.getjobber.com/api/graphql'
const JOBBER_VERSION = '2025-04-16'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const nowIso = () => new Date().toISOString()

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

const encodeJobberId = (type, numeric) =>
  Buffer.from(`gid://Jobber/${type}/${numeric}`, 'utf8').toString('base64')

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
  // MUST NOT be swallowed: Jobber rotates refresh tokens.
  const { error } = await sb.from('locations').update({
    jobber_access_token: tokens.access_token,
    jobber_refresh_token: tokens.refresh_token,
    token_expiry: expiryMs,
    token_expiry_display: new Date(expiryMs).toISOString().slice(0, 19),
    last_sync_status: `Token refreshed: ${new Date().toISOString().slice(0, 19)}`,
    updated_at: nowIso(),
  }).eq('location_id', location.location_id)
  if (error) throw new Error(`token rotation write failed: ${error.message}`)
  console.log(`  [token] refreshed + rotated for ${location.location_id}`)
  return tokens.access_token
}

const JOB_Q = `query($id: EncodedId!) { job(id: $id) { id jobStatus startAt completedAt createdAt } }`

// ── DB-shaped port of determineLeadStage (sync with lib/jobber-import.ts,
//    identical to scan-unscheduled-unknown.mjs) ─────────────────────────────
const NURTURING_AGE_MS = 30 * 24 * 60 * 60 * 1000
const ts = v => (v ? new Date(v).getTime() : 0)
function projectLeadStage({ email, phone, clientCreatedAt, requests, quotes, jobs, invoices }, nowMs) {
  const aged = t => nowMs - t > NURTURING_AGE_MS
  const hasActivity = requests.length > 0 || quotes.length > 0 || jobs.length > 0 || invoices.length > 0
  if (!email && !phone && !hasActivity) return 'New'
  const jobDone = j => !!j.completed_at || (j.status || '').toLowerCase().includes('complet')
  const jobUnbooked = j => !jobDone(j) && (j.status || '').toLowerCase() === 'unscheduled'
  if (jobs.some(j => !jobDone(j) && !jobUnbooked(j))) return 'Job in Progress'
  const isPaid = i => (i.status || '').toLowerCase() === 'paid'
  const lastRequest = Math.max(0, ...requests.map(r => ts(r.requested_at) || ts(r.created_at)))
  const lastQuote   = Math.max(0, ...quotes.map(q => ts(q.created_at)), ...jobs.filter(jobUnbooked).map(j => ts(j.created_at)))
  const lastJob     = Math.max(0, ...jobs.filter(j => !jobUnbooked(j)).map(j => Math.max(ts(j.completed_at), ts(j.scheduled_start), ts(j.created_at))))
  const lastPaid    = Math.max(0, ...invoices.filter(isPaid).map(i => ts(i.paid_at) || ts(i.created_at)))
  const lastUnpaid  = Math.max(0, ...invoices.filter(i => !isPaid(i)).map(i => ts(i.created_at)))
  const head = Math.max(lastRequest, lastQuote, lastJob, lastPaid, lastUnpaid)
  if (head > 0) {
    if (lastRequest === head && lastRequest > lastQuote && lastRequest > lastJob && lastRequest > lastPaid && lastRequest > lastUnpaid) {
      return aged(lastRequest) ? 'Nurturing' : 'New'
    }
    if (lastQuote === head && lastQuote > lastJob && lastQuote > lastPaid && lastQuote > lastUnpaid) {
      return aged(lastQuote) ? 'Nurturing' : 'Estimate Sent'
    }
    if (lastPaid === head && lastPaid >= lastUnpaid) return 'Closed Won'
    return 'Final Processing'
  }
  const created = ts(clientCreatedAt)
  return created && !aged(created) ? 'New' : 'Nurturing'
}

// ── side-effect counters ────────────────────────────────────────────────────
async function counters() {
  const c = async (q) => {
    const { count, error } = await q
    if (error) throw new Error(`counter read failed: ${error.message}`)
    return count
  }
  return {
    scheduled_stage_emails: await c(sb.from('scheduled_stage_emails').select('id', { count: 'exact', head: true })),
    lead_drip_progress:     await c(sb.from('lead_drip_progress').select('id', { count: 'exact', head: true })),
    welcome_scheduled:      await c(sb.from('leads').select('id', { count: 'exact', head: true }).not('welcome_email_scheduled_at', 'is', null)),
    welcome_sent:           await c(sb.from('leads').select('id', { count: 'exact', head: true }).not('welcome_email_sent_at', 'is', null)),
  }
}

console.log(`repair-unscheduled-jobs — ${EXECUTE ? '⚠ EXECUTE (writes to prod)' : 'DRY RUN (no writes)'}\n`)

const before = await counters()
console.log('side-effect counters (before):', JSON.stringify(before))

// ── 1. re-confirm raw status live ───────────────────────────────────────────

const { data: unknownJobs, error: jErr } = await sb
  .from('jobs')
  .select('id, jobber_job_id, lead_id, location_id, status, completed_at, scheduled_start, created_at')
  .eq('status', 'unknown')
if (jErr) { console.error('jobs read failed:', jErr.message); process.exit(1) }
console.log(`\nstatus='unknown' jobs: ${unknownJobs.length}`)

const byLoc = {}
for (const j of unknownJobs) (byLoc[j.location_id] ||= []).push(j)

const confirmed = []   // raw unscheduled, will repair
const skipped = []     // other raw statuses, untouched
for (const [slug, jobs] of Object.entries(byLoc)) {
  const { data: location } = await sb.from('locations')
    .select('location_id, jobber_access_token, jobber_refresh_token, token_expiry')
    .eq('location_id', slug).maybeSingle()
  const token = location ? await getValidToken(location) : null
  if (!token) {
    console.log(`⚠ ${slug}: no valid Jobber token — ${jobs.length} job(s) skipped (nothing written)`)
    for (const j of jobs) skipped.push({ ...j, raw: 'NO_TOKEN' })
    continue
  }
  for (const j of jobs) {
    const res = await jobberQuery(token, JOB_Q, { id: encodeJobberId('Job', j.jobber_job_id) })
    const raw = res?.data?.job?.jobStatus || 'NOT_FOUND'
    if (raw.toLowerCase() === 'unscheduled') confirmed.push({ ...j, raw })
    else skipped.push({ ...j, raw })
    await sleep(250)
  }
}
console.log(`raw-unscheduled (repairing): ${confirmed.length}; other raw statuses (untouched): ${skipped.length}`)
for (const s of skipped) console.log(`  untouched: job ${s.jobber_job_id} @${s.location_id} raw=${s.raw}`)

// ── 2. per-lead plan: flip job status in the projection, re-derive ──────────

const leadIds = [...new Set(confirmed.map(j => j.lead_id).filter(Boolean))]
const plan = []
for (const leadId of leadIds) {
  const [{ data: lead }, sr, q, jb, inv] = await Promise.all([
    sb.from('leads').select('id, name, stage, client_status, email, phone, created_at, location_id, location_uuid').eq('id', leadId).maybeSingle(),
    sb.from('service_requests').select('requested_at, created_at').eq('lead_id', leadId),
    sb.from('quotes').select('created_at').eq('lead_id', leadId),
    sb.from('jobs').select('id, status, completed_at, scheduled_start, created_at').eq('lead_id', leadId),
    sb.from('invoices').select('status, paid_at, created_at').eq('lead_id', leadId),
  ])
  if (!lead) { console.log(`  ⚠ lead ${leadId} not found — its job flip still applies, stage skipped`); continue }
  const confirmedIds = new Set(confirmed.map(c => c.id))
  const jobs = (jb.data ?? []).map(j => confirmedIds.has(j.id) ? { ...j, status: 'unscheduled' } : j)
  const projected = projectLeadStage({
    email: lead.email, phone: lead.phone, clientCreatedAt: lead.created_at,
    requests: sr.data ?? [], quotes: q.data ?? [], jobs, invoices: inv.data ?? [],
  }, Date.now())
  plan.push({ lead, from: lead.stage, to: projected, moves: projected !== lead.stage })
  console.log(`  ${projected !== lead.stage ? '→' : '='} ${lead.name} @${lead.location_id}  ${lead.stage}${projected !== lead.stage ? ` → ${projected}` : ' (unchanged)'}`)
}

const report = {
  ranAt: nowIso(),
  mode: EXECUTE ? 'execute' : 'dry-run',
  countersBefore: before,
  jobFlips: confirmed.map(c => ({ job_id: c.id, jobber_job_id: c.jobber_job_id, lead_id: c.lead_id, loc: c.location_id, raw: c.raw })),
  untouched: skipped.map(s => ({ job_id: s.id, jobber_job_id: s.jobber_job_id, loc: s.location_id, raw: s.raw })),
  stageMoves: plan.map(p => ({ lead_id: p.lead.id, name: p.lead.name, loc: p.lead.location_id, from: p.from, to: p.to, moves: p.moves })),
  errors: [],
}

// ── 3. execute ──────────────────────────────────────────────────────────────

if (EXECUTE) {
  console.log('\nexecuting…')
  let jobsDone = 0
  for (const c of confirmed) {
    try {
      const { data: rows, error } = await sb.from('jobs')
        .update({ status: 'unscheduled', jobber_synced_at: nowIso(), updated_at: nowIso() })
        .eq('id', c.id).eq('status', 'unknown')   // drift guard
        .select('id')
      if (error) throw new Error(error.message)
      if (!rows?.length) { report.errors.push(`job ${c.id}: status no longer 'unknown' — skipped`); continue }
      const { error: crumbErr } = await sb.from('sync_log').insert({
        location_id: c.location_id, direction: 'inbound', entity_type: 'job',
        entity_id: c.lead_id, jobber_record_id: c.jobber_job_id, status: 'success',
        message: `[job:repair] status unknown → unscheduled (raw Jobber jobStatus re-confirmed live; approved unscheduled-jobs repair, follow-up to a8b7e62)`,
      })
      if (crumbErr) report.errors.push(`job ${c.id} breadcrumb: ${crumbErr.message} (flip committed)`)
      jobsDone++
    } catch (err) {
      report.errors.push(`job ${c.id}: ${err.message}`)
      console.error(`  ✗ job ${c.id}: ${err.message}`)
    }
  }
  console.log(`job status flips: ${jobsDone}/${confirmed.length}`)

  let leadsDone = 0
  for (const p of plan.filter(p => p.moves)) {
    try {
      const { data: rows, error } = await sb.from('leads')
        .update({ stage: p.to, updated_at: nowIso() })
        .eq('id', p.lead.id).eq('stage', p.from)   // drift guard
        .select('id')
      if (error) throw new Error(error.message)
      if (!rows?.length) { report.errors.push(`lead ${p.lead.id}: stage no longer '${p.from}' — skipped`); continue }
      // entity_type 'client': sync_log_entity_type_check doesn't allow
      // 'lead' until the entity_type extend migration runs in the SQL
      // editor; leads ARE the client records (CLIENT_* webhook rows use
      // the same pairing of entity_type 'client' + lead uuid).
      const { error: crumbErr } = await sb.from('sync_log').insert({
        location_id: p.lead.location_id, direction: 'inbound', entity_type: 'client',
        entity_id: p.lead.id, status: 'success',
        message: `[lead:repair] stage ${p.from} → ${p.to} (full-history re-derivation after unscheduled job-status fix; silent repair, no drip side-effects; approved run, follow-up to a8b7e62)`,
      })
      if (crumbErr) report.errors.push(`lead ${p.lead.id} breadcrumb: ${crumbErr.message} (stage move committed)`)
      leadsDone++
    } catch (err) {
      report.errors.push(`lead ${p.lead.id}: ${err.message}`)
      console.error(`  ✗ lead ${p.lead.id}: ${err.message}`)
    }
  }
  console.log(`lead stage moves: ${leadsDone}/${plan.filter(p => p.moves).length}`)
}

// ── 4. counters after — must be unchanged ───────────────────────────────────

const after = await counters()
console.log('\nside-effect counters (after): ', JSON.stringify(after))
report.countersAfter = after
const drifted = Object.keys(before).filter(k => before[k] !== after[k])
if (drifted.length) {
  console.error(`✗ SIDE-EFFECT COUNTER DRIFT: ${drifted.join(', ')} — investigate before trusting this run`)
  report.errors.push(`counter drift: ${drifted.join(', ')}`)
} else {
  console.log('✓ side-effect counters unchanged')
}

const outPath = `repair-unscheduled-jobs.report${EXECUTE ? '.run' : '.dryrun'}.json`
writeFileSync(outPath, JSON.stringify(report, null, 2))
console.log(`\nreport written: ${outPath}`)
if (report.errors.length) { console.error(`completed with ${report.errors.length} error(s)`); process.exit(1) }
