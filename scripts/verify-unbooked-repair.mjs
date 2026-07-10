// ═══════════════════════════════════════════════════════════════════════════
// Independent verification of repair-unbooked-jobs.mjs --execute.
//
// Usage:  node scripts/verify-unbooked-repair.mjs [--report <path>] [--env <path>]
//
// READ-ONLY (no --refresh: verification must not rotate tokens; a lapsed
// token fails the affected checks loudly instead). Reads the run report
// and re-checks every claim with FRESH queries — nothing trusted from the
// run's own in-memory state:
//   1. every job flip: jobs.status === mapped AND the CURRENT raw Jobber
//      jobStatus still maps to that same value
//   2. every engagement move: stored stage === target AND a fresh
//      backfill-mode re-derivation over fresh children agrees (no drift)
//   3. every lead move: stored stage === target AND a fresh full-history
//      re-derivation agrees
//   4. untouched rows really untouched (still status='unknown')
//   5. side-effect counters match the run's after-snapshot
//   6. sync_log breadcrumbs exist: per flip / engagement move / lead move
// Exit 0 = all checks pass; any failure prints ✗ and exits 1.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const arg = k => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : null }

const env = Object.fromEntries(
  readFileSync(arg('--env') || '.env.local', 'utf8')
    .split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] })
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const report = JSON.parse(readFileSync(arg('--report') || 'repair-unbooked-jobs.report.run.json', 'utf8'))
if (report.mode !== 'execute') { console.error('report is not an execute run'); process.exit(1) }

const JOBBER_URL = 'https://api.getjobber.com/api/graphql'
const JOBBER_VERSION = '2025-04-16'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const encodeJobberId = (type, numeric) =>
  Buffer.from(`gid://Jobber/${type}/${numeric}`, 'utf8').toString('base64')
async function jobberQuery(token, query, variables) {
  const res = await fetch(JOBBER_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-JOBBER-GRAPHQL-VERSION': JOBBER_VERSION },
    body: JSON.stringify({ query, variables }),
  })
  const result = await res.json()
  if (result?.errors?.some(e => e.extensions?.code === 'THROTTLED')) { await sleep(15000); return jobberQuery(token, query, variables) }
  return result
}

// Sync with JOB_STATUS in lib/jobber-import.ts.
const JOB_STATUS = {
  ACTIVE: 'in_progress', COMPLETED: 'completed',
  REQUIRES_INVOICING: 'completed', LATE: 'late',
  TODAY: 'today', UPCOMING: 'upcoming', ARCHIVED: 'archived',
  UNSCHEDULED: 'unscheduled',
  ACTION_REQUIRED: 'action_required', ON_HOLD: 'on_hold',
  EXPIRING_WITHIN_30_DAYS: 'in_progress',
}
const NURTURING_AGE_MS = 30 * 24 * 60 * 60 * 1000
const ts = v => (v ? new Date(v).getTime() : 0)
const jobDone = j => !!j.completed_at || (j.status || '').toLowerCase().includes('complet')
const jobUnbooked = j => !jobDone(j) && ['unscheduled', 'action_required', 'on_hold'].includes((j.status || '').toLowerCase())

function projectLeadStage({ email, phone, clientCreatedAt, requests, quotes, jobs, invoices }, nowMs) {
  const aged = t => nowMs - t > NURTURING_AGE_MS
  const hasActivity = requests.length > 0 || quotes.length > 0 || jobs.length > 0 || invoices.length > 0
  if (!email && !phone && !hasActivity) return 'New'
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

function deriveEngagementStageBackfill({ sr, quotes, jobs, invoices }, nowMs) {
  const invoicePaid = i => i.status === 'paid'
  const quoteActivity = q => Math.max(ts(q.approved_at), ts(q.sent_at), ts(q.created_at))
  const bookedJobs = jobs.filter(j => !jobUnbooked(j))
  const unbookedJobs = jobs.filter(jobUnbooked)
  if (bookedJobs.length > 0) {
    if (bookedJobs.some(j => !jobDone(j))) return 'Job in Progress'
    if (invoices.length > 0 && invoices.every(invoicePaid)) return 'Closed Won'
    return 'Final Processing'
  }
  if (quotes.length > 0 || unbookedJobs.length > 0) {
    const last = Math.max(...quotes.map(quoteActivity), ...unbookedJobs.map(j => ts(j.created_at)))
    return (nowMs - last > NURTURING_AGE_MS) ? 'Closed Lost' : 'Estimate'
  }
  if (sr) {
    const at = ts(sr.requested_at) || ts(sr.created_at)
    return (nowMs - at > NURTURING_AGE_MS) ? 'Closed Lost' : 'Request'
  }
  return 'Request'
}

const NOW = Date.now()
let pass = 0, fail = 0
const ok = (cond, label) => {
  if (cond) { pass++ } else { fail++; console.error(`  ✗ ${label}`) }
}

// tokens per location (no refresh — verification must not rotate)
const tokens = {}
async function tokenFor(slug) {
  if (slug in tokens) return tokens[slug]
  const { data: loc } = await sb.from('locations')
    .select('jobber_access_token, token_expiry').eq('location_id', slug).maybeSingle()
  let t = loc?.jobber_access_token ?? null
  if (t) {
    const test = await jobberQuery(t, '{ account { id } }')
    if (!test?.data?.account?.id) t = null
  }
  tokens[slug] = t
  return t
}

console.log(`verify-unbooked-repair — report ${report.ranAt}\n`)

// ── 1. job flips ─────────────────────────────────────────────────────────────
console.log(`[1] job flips (${report.jobFlips.length})`)
for (const f of report.jobFlips) {
  const { data: j } = await sb.from('jobs').select('status').eq('id', f.job_id).maybeSingle()
  ok(j?.status === f.to, `job ${f.jobber_job_id}: db status '${j?.status}' ≠ '${f.to}'`)
  const token = await tokenFor(f.loc)
  if (!token) { ok(false, `job ${f.jobber_job_id}: no valid token for ${f.loc} — raw status unverified`); continue }
  const res = await jobberQuery(token, `query($id: EncodedId!) { job(id: $id) { jobStatus } }`, { id: encodeJobberId('Job', f.jobber_job_id) })
  const raw = res?.data?.job?.jobStatus || 'NOT_FOUND'
  ok(JOB_STATUS[raw.toUpperCase()] === f.to, `job ${f.jobber_job_id}: live raw '${raw}' no longer maps to '${f.to}'`)
  await sleep(200)
}

// ── 2. engagement moves ──────────────────────────────────────────────────────
console.log(`[2] engagement moves (${report.engagementMoves.length})`)
for (const m of report.engagementMoves) {
  const [{ data: eng }, srRes, qRes, jRes, iRes] = await Promise.all([
    sb.from('engagements').select('stage, closed_reason').eq('id', m.engagement_id).maybeSingle(),
    sb.from('service_requests').select('requested_at, created_at').eq('engagement_id', m.engagement_id).limit(1),
    sb.from('quotes').select('status, sent_at, approved_at, created_at').eq('engagement_id', m.engagement_id),
    sb.from('jobs').select('status, completed_at, created_at').eq('engagement_id', m.engagement_id),
    sb.from('invoices').select('status, paid_at, created_at').eq('engagement_id', m.engagement_id),
  ])
  ok(eng?.stage === m.to, `engagement ${m.engagement_id}: stage '${eng?.stage}' ≠ '${m.to}'`)
  if (m.closed_reason) ok(eng?.closed_reason === m.closed_reason, `engagement ${m.engagement_id}: closed_reason '${eng?.closed_reason}' ≠ '${m.closed_reason}'`)
  const derived = deriveEngagementStageBackfill({
    sr: srRes.data?.[0] ?? null, quotes: qRes.data ?? [], jobs: jRes.data ?? [], invoices: iRes.data ?? [],
  }, NOW)
  ok(derived === m.to, `engagement ${m.engagement_id}: fresh re-derivation '${derived}' ≠ stored '${m.to}' (drift)`)
}

// ── 3. lead moves ────────────────────────────────────────────────────────────
console.log(`[3] lead stage moves (${report.stageMoves.length})`)
for (const m of report.stageMoves) {
  const [{ data: lead }, sr, q, jb, inv] = await Promise.all([
    sb.from('leads').select('stage, email, phone, created_at').eq('id', m.lead_id).maybeSingle(),
    sb.from('service_requests').select('requested_at, created_at').eq('lead_id', m.lead_id),
    sb.from('quotes').select('created_at').eq('lead_id', m.lead_id),
    sb.from('jobs').select('status, completed_at, scheduled_start, created_at').eq('lead_id', m.lead_id),
    sb.from('invoices').select('status, paid_at, created_at').eq('lead_id', m.lead_id),
  ])
  ok(lead?.stage === m.to, `lead ${m.name}: stage '${lead?.stage}' ≠ '${m.to}'`)
  const derived = projectLeadStage({
    email: lead?.email, phone: lead?.phone, clientCreatedAt: lead?.created_at,
    requests: sr.data ?? [], quotes: q.data ?? [], jobs: jb.data ?? [], invoices: inv.data ?? [],
  }, NOW)
  ok(derived === m.to, `lead ${m.name}: fresh re-derivation '${derived}' ≠ stored '${m.to}' (drift)`)
}

// ── 4. untouched rows ────────────────────────────────────────────────────────
console.log(`[4] untouched rows (${report.untouched.length})`)
for (const u of report.untouched) {
  const { data: j } = await sb.from('jobs').select('status').eq('id', u.job_id).maybeSingle()
  ok(j?.status === 'unknown', `untouched job ${u.jobber_job_id}: status '${j?.status}' ≠ 'unknown'`)
}

// ── 5. side-effect counters ──────────────────────────────────────────────────
console.log('[5] side-effect counters')
const c = async (q) => (await q).count
const now = {
  scheduled_stage_emails: await c(sb.from('scheduled_stage_emails').select('id', { count: 'exact', head: true })),
  lead_drip_progress:     await c(sb.from('lead_drip_progress').select('id', { count: 'exact', head: true })),
  welcome_scheduled:      await c(sb.from('leads').select('id', { count: 'exact', head: true }).not('welcome_email_scheduled_at', 'is', null)),
  welcome_sent:           await c(sb.from('leads').select('id', { count: 'exact', head: true }).not('welcome_email_sent_at', 'is', null)),
}
for (const k of Object.keys(report.countersAfter)) {
  ok(now[k] === report.countersAfter[k], `counter ${k}: ${now[k]} ≠ run-after ${report.countersAfter[k]} (moved since run — investigate independently)`)
}

// ── 6. breadcrumbs ───────────────────────────────────────────────────────────
console.log('[6] sync_log breadcrumbs')
const since = report.ranAt
const { data: crumbs } = await sb.from('sync_log')
  .select('entity_type, entity_id, message')
  .gte('created_at', since)
  .ilike('message', '%follow-up to faf0133%')
const kinds = { job: 0, engagement: 0, client: 0 }
for (const r of crumbs ?? []) kinds[r.entity_type] = (kinds[r.entity_type] ?? 0) + 1
ok(kinds.job === report.jobFlips.length, `job breadcrumbs ${kinds.job} ≠ flips ${report.jobFlips.length}`)
ok(kinds.engagement === report.engagementMoves.length, `engagement breadcrumbs ${kinds.engagement} ≠ moves ${report.engagementMoves.length}`)
ok(kinds.client === report.stageMoves.length, `lead breadcrumbs ${kinds.client} ≠ moves ${report.stageMoves.length}`)
ok(!(crumbs ?? []).some(r => / topic=|^topic=/.test(r.message)), 'a repair breadcrumb carries a topic= token (must not impersonate webhooks)')

console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} checks passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
