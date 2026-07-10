// ═══════════════════════════════════════════════════════════════════════════
// Scan: jobs stored as status='unknown' — how many are Jobber-side
// UNSCHEDULED, and what would their leads' stages become under the fixed
// derivation (UNSCHEDULED mapped + quote-lane semantics, 2026-07-10)?
//
// Usage:  node scripts/scan-unscheduled-unknown.mjs [--refresh] [--env <path>]
//
// REPORT-ONLY: zero writes to jobs/leads/engagements. Stage repairs are a
// separate approved run. The one opt-in side effect is --refresh, which
// lets an expired Jobber access token be refreshed (rotates the
// locations-row token columns — same authorized side effect as
// trace-job.mjs / scan-requestless-gap.mjs).
//
// For every lead touched by a raw-UNSCHEDULED 'unknown' job, the
// projection re-runs the lead classifier over the lead's FULL local
// history (DB-shaped port of determineLeadStage, lib/jobber-import.ts),
// with each scanned job's status corrected to its raw Jobber value.
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

const encodeJobberId = (type, numeric) =>
  Buffer.from(`gid://Jobber/${type}/${numeric}`, 'utf8').toString('base64')

// Token handling ports getValidJobberToken (lib/jobber.ts); refresh gated
// behind --refresh because the rotation is a locations-row write.
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

const JOB_Q = `query($id: EncodedId!) { job(id: $id) { id jobStatus startAt completedAt createdAt total } }`

// Sync with JOB_STATUS in lib/jobber-import.ts — projections substitute
// the MAPPED value so the done/unbooked checks read the same strings the
// app writes.
const JOB_STATUS = {
  ACTIVE: 'in_progress', COMPLETED: 'completed',
  REQUIRES_INVOICING: 'completed', LATE: 'late',
  TODAY: 'today', UPCOMING: 'upcoming', ARCHIVED: 'archived',
  UNSCHEDULED: 'unscheduled',
}

// ── DB-shaped port of determineLeadStage (lib/jobber-import.ts) ────────────
// Field mapping: jobs.status/completed_at/scheduled_start/created_at;
// invoices.status ('paid'); quotes.created_at; SRs requested_at||created_at.
const NURTURING_AGE_MS = 30 * 24 * 60 * 60 * 1000
const ts = v => (v ? new Date(v).getTime() : 0)
function projectLeadStage({ email, phone, clientCreatedAt, requests, quotes, jobs, invoices }, nowMs) {
  const aged = t => nowMs - t > NURTURING_AGE_MS
  const hasActivity = requests.length > 0 || quotes.length > 0 || jobs.length > 0 || invoices.length > 0
  if (!email && !phone && !hasActivity) return 'New (junk)'
  const jobDone = j => !!j.completed_at || (j.status || '').toLowerCase().includes('complet')
  // Sync with lib/jobber-import.ts (unbooked-statuses decision).
  const jobUnbooked = j => !jobDone(j) && ['unscheduled', 'action_required', 'on_hold'].includes((j.status || '').toLowerCase())
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

// ── 1. all status='unknown' jobs ────────────────────────────────────────────

const { data: unknownJobs, error: jErr } = await sb
  .from('jobs')
  .select('id, jobber_job_id, lead_id, location_id, engagement_id, status, completed_at, scheduled_start, created_at, total')
  .eq('status', 'unknown')
if (jErr) { console.error('jobs read failed:', jErr.message); process.exit(1) }

console.log(`SCAN unscheduled-unknown — ${new Date().toISOString()}`)
console.log(`status='unknown' jobs: ${unknownJobs.length}\n`)
if (!unknownJobs.length) process.exit(0)

// ── 2. raw Jobber status per job, per location ──────────────────────────────

const byLoc = {}
for (const j of unknownJobs) (byLoc[j.location_id] ||= []).push(j)

const rawByJobId = new Map()   // jobs.id → raw jobStatus (or 'NOT_FOUND'/'NO_TOKEN')
for (const [slug, jobs] of Object.entries(byLoc)) {
  const { data: location } = await sb.from('locations')
    .select('location_id, name, jobber_access_token, jobber_refresh_token, token_expiry')
    .eq('location_id', slug).maybeSingle()
  const token = location ? await getValidToken(location) : null
  if (!token) {
    console.log(`⚠ ${slug}: no valid Jobber token${flag('--refresh') ? '' : ' (re-run with --refresh?)'} — ${jobs.length} job(s) unresolved`)
    for (const j of jobs) rawByJobId.set(j.id, 'NO_TOKEN')
    continue
  }
  for (const j of jobs) {
    const res = await jobberQuery(token, JOB_Q, { id: encodeJobberId('Job', j.jobber_job_id) })
    const node = res?.data?.job
    rawByJobId.set(j.id, node ? (node.jobStatus || 'NULL_STATUS') : 'NOT_FOUND')
    await sleep(250) // stay far from the throttle
  }
}

const buckets = {}
for (const j of unknownJobs) {
  const raw = rawByJobId.get(j.id)
  ;(buckets[raw] ||= []).push(j)
}
console.log('raw Jobber status breakdown of the unknown jobs:')
for (const [raw, list] of Object.entries(buckets).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${raw.padEnd(20)} ${list.length}`)
}

const unscheduled = Object.entries(buckets)
  .filter(([raw]) => raw.toLowerCase() === 'unscheduled')
  .flatMap(([, list]) => list)
console.log(`\nraw-UNSCHEDULED jobs: ${unscheduled.length}`)
if (!unscheduled.length) process.exit(0)

// ── 3. project each affected lead's stage under the fixed derivation ────────

const leadIds = [...new Set(unscheduled.map(j => j.lead_id).filter(Boolean))]
console.log(`affected leads: ${leadIds.length}\n`)

let wouldMove = 0
for (const leadId of leadIds) {
  const [{ data: lead }, sr, q, jb, inv] = await Promise.all([
    sb.from('leads').select('id, name, stage, client_status, email, phone, created_at, location_id').eq('id', leadId).maybeSingle(),
    sb.from('service_requests').select('requested_at, created_at').eq('lead_id', leadId),
    sb.from('quotes').select('created_at').eq('lead_id', leadId),
    sb.from('jobs').select('id, status, completed_at, scheduled_start, created_at').eq('lead_id', leadId),
    sb.from('invoices').select('status, paid_at, created_at').eq('lead_id', leadId),
  ])
  if (!lead) { console.log(`  lead ${leadId}: not found (orphaned job rows?)`); continue }
  // correct every job this scan resolved to its MAPPED raw Jobber status
  const jobs = (jb.data ?? []).map(j => {
    const raw = rawByJobId.get(j.id)
    if (!raw || ['NOT_FOUND', 'NO_TOKEN', 'NULL_STATUS'].includes(raw)) return j
    return { ...j, status: JOB_STATUS[raw.toUpperCase()] ?? 'unknown' }
  })
  const projected = projectLeadStage({
    email: lead.email, phone: lead.phone, clientCreatedAt: lead.created_at,
    requests: sr.data ?? [], quotes: q.data ?? [], jobs, invoices: inv.data ?? [],
  }, Date.now())
  const moved = projected !== lead.stage
  if (moved) wouldMove++
  console.log(`  ${moved ? '→' : '='} ${lead.name} @${lead.location_id}  stage: ${lead.stage} ${moved ? `→ ${projected}` : '(unchanged)'}  client_status=${lead.client_status ?? '—'}`)
}

console.log(`\nSummary: ${unscheduled.length} raw-UNSCHEDULED 'unknown' job(s) across ${leadIds.length} lead(s); ${wouldMove} lead stage(s) would change under the fixed derivation.`)
console.log('REPORT-ONLY — no repairs applied. Stage repairs are a separate approved run.')
