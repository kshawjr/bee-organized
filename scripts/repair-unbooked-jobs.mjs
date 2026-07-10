// ═══════════════════════════════════════════════════════════════════════════
// Repair: re-file stored-unknown jobs under the exhaustive status map
// (follow-up to faf0133 unbooked-family mapping; rails from
// repair-unscheduled-jobs.mjs, the executed 2026-07-10 unscheduled run).
//
// Usage:  node scripts/repair-unbooked-jobs.mjs [--execute] [--refresh] [--env <path>]
//
// For every job stored as status='unknown', the CURRENT raw Jobber
// jobStatus is re-confirmed live (never trusted from an old report):
//   1. jobs.status 'unknown' → JOB_STATUS[raw] (conditional on =unknown).
//      Rows whose raw status is still unmapped / NOT_FOUND / NO_TOKEN are
//      UNTOUCHED and reported.
//   2. each engagement containing a flipped job is re-derived in BACKFILL
//      mode (port of lib/engagements.ts deriveEngagementStage) over its
//      full children with the flip projected. Moves are planned only for
//      engagements stored in an OPEN stage — stored-closed rows are never
//      reopened or rewritten (human closes are sacred; machine
//      stale-closes are a separate decision). A stored 'Closed Won'
//      projecting to anything else is FLAGGED and held out (stale-Won
//      lesson: every Won→not-Won move needs individual justification).
//   3. each affected lead's stage is re-derived over its FULL local
//      history (DB-shaped port of determineLeadStage) and written only
//      when it changed AND the stored stage still matches what this run
//      read (drift guard) — direct write, deliberately bypassing drip
//      side-effects: silent bookkeeping, not funnel movement. Lead
//      Won→not-Won moves are likewise flagged and held out.
//   4. sync_log breadcrumbs per write: jobs → entity_type 'job' (lead
//      uuid + jobber_record_id), engagements → 'engagement' (engagement
//      uuid), leads → 'client' (lead uuid; the entity_type CHECK lacks
//      'lead'). NO topic= token — repair rows must not impersonate
//      webhook events on the observability dashboard.
//
// Side-effect counters (scheduled_stage_emails, lead_drip_progress,
// leads welcome-scheduled/sent) are snapshotted before and after; any
// drift fails the run loudly.
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

// Sync with JOB_STATUS in lib/jobber-import.ts (exhaustive over the
// live-introspected JobStatusTypeEnum, faf0133).
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
// Sync with lib/jobber-import.ts isUnbookedJobStatus.
const jobUnbooked = j => !jobDone(j) && ['unscheduled', 'action_required', 'on_hold'].includes((j.status || '').toLowerCase())

// ── DB-shaped port of determineLeadStage (sync with lib/jobber-import.ts,
//    identical to repair-unscheduled-jobs.mjs) ──────────────────────────────
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

// ── backfill-mode port of deriveEngagementStage (sync with
//    lib/engagements.ts; quotes/unbooked-jobs lane per Ruling A) ────────────
function deriveEngagementStageBackfill({ sr, quotes, jobs, invoices }, nowMs) {
  const invoicePaid = i => i.status === 'paid'
  const quoteActivity = q => Math.max(ts(q.approved_at), ts(q.sent_at), ts(q.created_at))
  const bookedJobs = jobs.filter(j => !jobUnbooked(j))
  const unbookedJobs = jobs.filter(jobUnbooked)
  if (bookedJobs.length > 0) {
    if (bookedJobs.some(j => !jobDone(j))) return { stage: 'Job in Progress' }
    if (invoices.length > 0 && invoices.every(invoicePaid)) {
      const lastPaidAt = Math.max(0, ...invoices.map(i => ts(i.paid_at)))
      return { stage: 'Closed Won', closed_reason: 'won', closed_at: new Date(lastPaidAt || nowMs).toISOString() }
    }
    return { stage: 'Final Processing' }
  }
  if (quotes.length > 0 || unbookedJobs.length > 0) {
    const last = Math.max(...quotes.map(quoteActivity), ...unbookedJobs.map(j => ts(j.created_at)))
    if (nowMs - last > NURTURING_AGE_MS) {
      return { stage: 'Closed Lost', closed_reason: 'stale_on_import', closed_at: new Date(nowMs).toISOString() }
    }
    return { stage: 'Estimate' }
  }
  if (sr) {
    const at = ts(sr.requested_at) || ts(sr.created_at)
    if (nowMs - at > NURTURING_AGE_MS) {
      return { stage: 'Closed Lost', closed_reason: 'stale_on_import', closed_at: new Date(nowMs).toISOString() }
    }
    return { stage: 'Request' }
  }
  return { stage: 'Request' }
}

// Canonical open stages per components/hive/shared/stageRank.js
// (Closed Won / Closed Lost are the only terminal values).
const OPEN_ENGAGEMENT_STAGES = new Set(['Request', 'Estimate', 'Job in Progress', 'Final Processing'])

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

console.log(`repair-unbooked-jobs — ${EXECUTE ? '⚠ EXECUTE (writes to prod)' : 'DRY RUN (no writes)'}\n`)

const NOW = Date.now()
const before = await counters()
console.log('side-effect counters (before):', JSON.stringify(before))

// ── 1. re-confirm raw status live, classify under the exhaustive map ────────

const { data: unknownJobs, error: jErr } = await sb
  .from('jobs')
  .select('id, jobber_job_id, lead_id, engagement_id, location_id, status, completed_at, scheduled_start, created_at')
  .eq('status', 'unknown')
if (jErr) { console.error('jobs read failed:', jErr.message); process.exit(1) }
console.log(`\nstatus='unknown' jobs: ${unknownJobs.length}`)

const byLoc = {}
for (const j of unknownJobs) (byLoc[j.location_id] ||= []).push(j)

const flips = []      // mapped raw status — will re-file
const skipped = []    // NOT_FOUND / NO_TOKEN / still-unmapped raw — untouched
for (const [slug, jobs] of Object.entries(byLoc)) {
  const { data: location } = await sb.from('locations')
    .select('location_id, jobber_access_token, jobber_refresh_token, token_expiry')
    .eq('location_id', slug).maybeSingle()
  const token = location ? await getValidToken(location) : null
  if (!token) {
    console.log(`⚠ ${slug}: no valid Jobber token — ${jobs.length} job(s) skipped (nothing written)`)
    for (const j of jobs) skipped.push({ ...j, raw: 'NO_TOKEN', reason: 'no token' })
    continue
  }
  for (const j of jobs) {
    const res = await jobberQuery(token, JOB_Q, { id: encodeJobberId('Job', j.jobber_job_id) })
    const jobber = res?.data?.job
    const raw = jobber?.jobStatus || 'NOT_FOUND'
    const mapped = JOB_STATUS[raw.toUpperCase()]
    if (!mapped) {
      skipped.push({ ...j, raw, reason: raw === 'NOT_FOUND' ? 'job gone from Jobber' : 'raw status still unmapped' })
    } else {
      // completedAt from the live read wins over the label downstream —
      // carry it into the projection (never written here; jobs.completed_at
      // is webhook/import-owned).
      flips.push({ ...j, raw, mapped, live_completed_at: jobber?.completedAt || null })
    }
    await sleep(250)
  }
}
console.log(`re-filing (mapped raw status): ${flips.length}; untouched: ${skipped.length}`)
for (const s of skipped) console.log(`  untouched: job ${s.jobber_job_id} @${s.location_id} raw=${s.raw} (${s.reason})`)

const flipById = new Map(flips.map(f => [f.id, f]))
const projectStatus = j => flipById.has(j.id) ? { ...j, status: flipById.get(j.id).mapped } : j

// ── 2. engagement plan: re-derive (backfill mode) with flips projected ──────

const engIds = [...new Set(flips.map(f => f.engagement_id).filter(Boolean))]
const engPlans = []       // stored open, derived differs → move
const engFlagged = []     // Won→not-Won or stored-closed drift → REPORT ONLY
for (const engId of engIds) {
  const [{ data: eng }, srRes, qRes, jRes, iRes] = await Promise.all([
    sb.from('engagements').select('id, client_id, title, stage, closed_reason, location_uuid').eq('id', engId).maybeSingle(),
    sb.from('service_requests').select('requested_at, created_at').eq('engagement_id', engId).limit(1),
    sb.from('quotes').select('status, sent_at, approved_at, created_at').eq('engagement_id', engId),
    sb.from('jobs').select('id, status, completed_at, scheduled_start, created_at').eq('engagement_id', engId),
    sb.from('invoices').select('status, paid_at, created_at').eq('engagement_id', engId),
  ])
  if (!eng) { console.log(`  ⚠ engagement ${engId} not found — job flip still applies`); continue }
  const derived = deriveEngagementStageBackfill({
    sr: srRes.data?.[0] ?? null,
    quotes: qRes.data ?? [],
    jobs: (jRes.data ?? []).map(projectStatus),
    invoices: iRes.data ?? [],
  }, NOW)
  const entry = { eng, derived, from: eng.stage, to: derived.stage, moves: derived.stage !== eng.stage }
  if (!entry.moves) { engPlans.push(entry); continue }
  if (eng.stage === 'Closed Won') {
    engFlagged.push({ ...entry, why: 'Won→not-Won requires individual justification (stale-Won lesson)' })
  } else if (!OPEN_ENGAGEMENT_STAGES.has(eng.stage)) {
    engFlagged.push({ ...entry, why: `stored-closed row (closed_reason=${eng.closed_reason ?? '—'}) — never reopened/rewritten by this repair` })
  } else {
    engPlans.push(entry)
  }
}

// ── 3. lead plan: full-history re-derivation with flips projected ───────────

const leadIds = [...new Set(flips.map(f => f.lead_id).filter(Boolean))]
const leadPlans = []
const leadFlagged = []
const leadById = new Map()
for (const leadId of leadIds) {
  const [{ data: lead }, sr, q, jb, inv] = await Promise.all([
    sb.from('leads').select('id, name, stage, client_status, email, phone, created_at, location_id').eq('id', leadId).maybeSingle(),
    sb.from('service_requests').select('requested_at, created_at').eq('lead_id', leadId),
    sb.from('quotes').select('created_at').eq('lead_id', leadId),
    sb.from('jobs').select('id, status, completed_at, scheduled_start, created_at').eq('lead_id', leadId),
    sb.from('invoices').select('status, paid_at, created_at').eq('lead_id', leadId),
  ])
  if (!lead) { console.log(`  ⚠ lead ${leadId} not found — its job flip still applies, stage skipped`); continue }
  leadById.set(leadId, lead)
  const projected = projectLeadStage({
    email: lead.email, phone: lead.phone, clientCreatedAt: lead.created_at,
    requests: sr.data ?? [], quotes: q.data ?? [],
    jobs: (jb.data ?? []).map(projectStatus), invoices: inv.data ?? [],
  }, NOW)
  const entry = { lead, from: lead.stage, to: projected, moves: projected !== lead.stage }
  if (entry.moves && lead.stage === 'Closed Won') {
    leadFlagged.push({ ...entry, why: 'Won→not-Won requires individual justification (stale-Won lesson)' })
  } else {
    leadPlans.push(entry)
  }
}

// ── 4. impact table (one row per re-filed job) ──────────────────────────────

console.log('\nIMPACT TABLE (per job):')
console.log('client | loc | job (jobber id, created) | raw status → jobs.status | engagement stored→derived | lead stage today→projected')
for (const f of flips) {
  const lead = leadById.get(f.lead_id)
  const ep = [...engPlans, ...engFlagged].find(e => e.eng.id === f.engagement_id)
  const lp = [...leadPlans, ...leadFlagged].find(p => p.lead.id === f.lead_id)
  const engCol = ep ? `${ep.from}${ep.moves ? ` → ${ep.to}` : ' (=)'}${engFlagged.includes(ep) ? ' ⚑HELD' : ''}` : '(no engagement)'
  const leadCol = lp ? `${lp.from}${lp.moves ? ` → ${lp.to}` : ' (=)'}${leadFlagged.includes(lp) ? ' ⚑HELD' : ''}` : '(no lead)'
  console.log(`  ${lead?.name ?? f.lead_id} | ${f.location_id} | ${f.jobber_job_id} ${String(f.created_at).slice(0, 10)} | ${f.raw} → ${f.mapped} | ${engCol} | ${leadCol}`)
}
if (engFlagged.length || leadFlagged.length) {
  console.log('\n⚑ FLAGGED (held out of execution, individual justification required):')
  for (const e of engFlagged) console.log(`  engagement ${e.eng.id} "${e.eng.title}" ${e.from} → ${e.to} — ${e.why}`)
  for (const l of leadFlagged) console.log(`  lead ${l.lead.id} ${l.lead.name} ${l.from} → ${l.to} — ${l.why}`)
}

const report = {
  ranAt: nowIso(),
  mode: EXECUTE ? 'execute' : 'dry-run',
  countersBefore: before,
  jobFlips: flips.map(f => ({ job_id: f.id, jobber_job_id: f.jobber_job_id, lead_id: f.lead_id, engagement_id: f.engagement_id, loc: f.location_id, raw: f.raw, to: f.mapped })),
  untouched: skipped.map(s => ({ job_id: s.id, jobber_job_id: s.jobber_job_id, loc: s.location_id, raw: s.raw, reason: s.reason })),
  engagementMoves: engPlans.filter(e => e.moves).map(e => ({ engagement_id: e.eng.id, title: e.eng.title, client_id: e.eng.client_id, from: e.from, to: e.to, closed_reason: e.derived.closed_reason ?? null })),
  engagementFlagged: engFlagged.map(e => ({ engagement_id: e.eng.id, title: e.eng.title, from: e.from, to: e.to, why: e.why })),
  stageMoves: leadPlans.filter(p => p.moves).map(p => ({ lead_id: p.lead.id, name: p.lead.name, loc: p.lead.location_id, from: p.from, to: p.to })),
  leadsFlagged: leadFlagged.map(p => ({ lead_id: p.lead.id, name: p.lead.name, from: p.from, to: p.to, why: p.why })),
  errors: [],
}

// ── 5. execute ──────────────────────────────────────────────────────────────

if (EXECUTE) {
  console.log('\nexecuting…')
  let jobsDone = 0
  for (const f of flips) {
    try {
      const { data: rows, error } = await sb.from('jobs')
        .update({ status: f.mapped, jobber_synced_at: nowIso(), updated_at: nowIso() })
        .eq('id', f.id).eq('status', 'unknown')   // drift guard
        .select('id')
      if (error) throw new Error(error.message)
      if (!rows?.length) { report.errors.push(`job ${f.id}: status no longer 'unknown' — skipped`); continue }
      const { error: crumbErr } = await sb.from('sync_log').insert({
        location_id: f.location_id, direction: 'inbound', entity_type: 'job',
        entity_id: f.lead_id, jobber_record_id: f.jobber_job_id, status: 'success',
        message: `[job:repair] status unknown → ${f.mapped} (raw Jobber jobStatus ${f.raw} re-confirmed live; approved unbooked-jobs re-file, follow-up to faf0133)`,
      })
      if (crumbErr) report.errors.push(`job ${f.id} breadcrumb: ${crumbErr.message} (flip committed)`)
      jobsDone++
    } catch (err) {
      report.errors.push(`job ${f.id}: ${err.message}`)
      console.error(`  ✗ job ${f.id}: ${err.message}`)
    }
  }
  console.log(`job status flips: ${jobsDone}/${flips.length}`)

  let engsDone = 0
  const engMoves = engPlans.filter(e => e.moves)
  for (const e of engMoves) {
    try {
      const patch = {
        stage: e.derived.stage,
        stage_entered_at: nowIso(),
        updated_at: nowIso(),
      }
      if (e.derived.closed_reason) patch.closed_reason = e.derived.closed_reason
      if (e.derived.closed_at) patch.closed_at = e.derived.closed_at
      if (e.derived.closed_reason === 'stale_on_import') {
        patch.closed_note = 'Closed automatically at import: no activity within 30 days (Ruling A for quote-only).'
      }
      const { data: rows, error } = await sb.from('engagements')
        .update(patch)
        .eq('id', e.eng.id).eq('stage', e.from)   // drift guard
        .select('id')
      if (error) throw new Error(error.message)
      if (!rows?.length) { report.errors.push(`engagement ${e.eng.id}: stage no longer '${e.from}' — skipped`); continue }
      const { error: crumbErr } = await sb.from('sync_log').insert({
        location_id: leadById.get(e.eng.client_id)?.location_id ?? flips.find(f => f.engagement_id === e.eng.id)?.location_id ?? null,
        direction: 'inbound', entity_type: 'engagement',
        entity_id: e.eng.id, status: 'success',
        message: `[engagement:repair] stage ${e.from} → ${e.to} (backfill re-derivation after unbooked job-status re-file; approved run, follow-up to faf0133)`,
      })
      if (crumbErr) report.errors.push(`engagement ${e.eng.id} breadcrumb: ${crumbErr.message} (move committed)`)
      engsDone++
    } catch (err) {
      report.errors.push(`engagement ${e.eng.id}: ${err.message}`)
      console.error(`  ✗ engagement ${e.eng.id}: ${err.message}`)
    }
  }
  console.log(`engagement stage moves: ${engsDone}/${engMoves.length}`)

  let leadsDone = 0
  const leadMoves = leadPlans.filter(p => p.moves)
  for (const p of leadMoves) {
    try {
      const { data: rows, error } = await sb.from('leads')
        .update({ stage: p.to, updated_at: nowIso() })
        .eq('id', p.lead.id).eq('stage', p.from)   // drift guard
        .select('id')
      if (error) throw new Error(error.message)
      if (!rows?.length) { report.errors.push(`lead ${p.lead.id}: stage no longer '${p.from}' — skipped`); continue }
      // entity_type 'client': sync_log_entity_type_check doesn't allow
      // 'lead'; leads ARE the client records (CLIENT_* webhook rows use
      // the same pairing of entity_type 'client' + lead uuid).
      const { error: crumbErr } = await sb.from('sync_log').insert({
        location_id: p.lead.location_id, direction: 'inbound', entity_type: 'client',
        entity_id: p.lead.id, status: 'success',
        message: `[lead:repair] stage ${p.from} → ${p.to} (full-history re-derivation after unbooked job-status re-file; silent repair, no drip side-effects; approved run, follow-up to faf0133)`,
      })
      if (crumbErr) report.errors.push(`lead ${p.lead.id} breadcrumb: ${crumbErr.message} (stage move committed)`)
      leadsDone++
    } catch (err) {
      report.errors.push(`lead ${p.lead.id}: ${err.message}`)
      console.error(`  ✗ lead ${p.lead.id}: ${err.message}`)
    }
  }
  console.log(`lead stage moves: ${leadsDone}/${leadMoves.length}`)
}

// ── 6. counters after — must be unchanged ───────────────────────────────────

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

const outPath = `repair-unbooked-jobs.report${EXECUTE ? '.run' : '.dryrun'}.json`
writeFileSync(outPath, JSON.stringify(report, null, 2))
console.log(`\nreport written: ${outPath}`)
if (report.errors.length) { console.error(`completed with ${report.errors.length} error(s)`); process.exit(1) }
