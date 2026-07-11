// ═══════════════════════════════════════════════════════════════════════════
// Backfill: capture Jobber assessment COMPLETION state (status/completed_at)
// on existing rows — and, defensively, any still-null jobber_assessment_id.
//
// Root cause (fixed forward in lib/jobber-import.ts, a1cd157): the
// import/webhook GraphQL selections fetched `assessment { startAt }` without
// isComplete/completedAt, and upsertAssessment hardcoded status:'scheduled',
// completed_at:null. Every assessment row therefore records a scheduled/null
// completion regardless of the real Jobber state (e.g. appointment 2123185874
// is isComplete:true, completedAt 2026-04-09, but its row is scheduled/null).
//
// This is the SAME shape as the appointment-id fix (78f1ba8) and was meant to
// fold into that sweep so each row is read from Jobber ONCE. By the time this
// ran, that appointment-id backfill had already executed — all rows carry a
// jobber_assessment_id — so this pass is now primarily the completion sweep,
// with the appointment-id write kept as a self-healing no-op safety net.
//
// For each target row, one live read of the record it hangs off:
//     request(id: jobber_request_id) { assessment { id isComplete completedAt } }
// and a guarded write:
//   · isComplete:true  → status:'completed', completed_at:completedAt
//                        (only when the row's completed_at is STILL null — a
//                        concurrent webmook may already have set it)
//   · isComplete:false → already scheduled/null in the DB → NO write (skipped)
//   · jobber_assessment_id still null → filled from assessment.id (numeric,
//     matching every sibling jobber_*_id column) under its own null guard
// completed_at is the load-bearing done-signal every hive derivation keys off
// (!a.completed_at); status is the display string. Non-lossy: Jobber's model
// is binary (a cancelled assessment is deleted → the request has no
// assessment, classified UNRESOLVABLE below).
//
// Resolvability is confirmed per-row against LIVE Jobber, never invented:
//   · request not found (deleted) OR request.assessment null (assessment
//     deleted in Jobber) → UNRESOLVABLE, reported separately, left untouched.
//   · request.assessment present → resolvable; completion/id planned + written.
//
// Usage:  node scripts/backfill-assessment-appointment-ids.mjs [--execute] [--refresh] [--env <path>]
//   Dry-run by default: reports resolvable count, how many rows would flip
//   scheduled→completed (with a sample), and appointment-id fills. --execute
//   writes with per-field drift guards + one sync_log breadcrumb per write.
//   --refresh allows an expired Jobber token refresh (rotates locations-row
//   token columns — same authorized side effect as the other repair scripts).
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

// Mirror lib/jobber-import.ts extractJobberId: numeric passes through;
// base64 gid decodes to the trailing numeric.
const extractJobberId = globalId => {
  if (!globalId) return null
  if (/^\d+$/.test(globalId)) return globalId
  try {
    const decoded = Buffer.from(globalId, 'base64').toString('utf8')
    const m = decoded.match(/\/(\d+)$/)
    return m ? m[1] : null
  } catch { return null }
}
const encodeJobberId = (type, numeric) =>
  Buffer.from(`gid://Jobber/${type}/${numeric}`, 'utf8').toString('base64')

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

const REQUEST_Q = `query($id: EncodedId!) { request(id: $id) { id assessment { id isComplete completedAt } } }`

// ── 1. gather all rows needing a backfill (paged past the 1000-row cap) ──────
// Target = missing completion (completed_at null while Jobber may say complete)
// OR still-null appointment id. In current prod that's every row with
// completed_at null; the .or keeps the appointment-id safety net alive for any
// row that ever lands id-less again.
async function fetchTargets() {
  const rows = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from('assessments')
      .select('id, engagement_id, lead_id, service_request_id, location_id, jobber_request_id, status, completed_at, jobber_assessment_id')
      .or('completed_at.is.null,jobber_assessment_id.is.null')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`fetch target assessments: ${error.message}`)
    rows.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return rows
}

const report = {
  mode: EXECUTE ? 'execute' : 'dry-run',
  startedAt: nowIso(),
  totalTargets: 0,
  resolvable: 0,        // request.assessment present live
  unresolvable: 0,      // request/assessment deleted in Jobber
  noRequestId: 0,
  noToken: 0,
  // completion breakdown of resolvable rows
  wouldComplete: 0,     // isComplete:true & row completed_at still null → flip
  incompleteNoop: 0,    // isComplete:false → already scheduled/null, no write
  apptIdFill: 0,        // jobber_assessment_id was null & got filled (safety net)
  written: 0,           // rows that received at least one column write
  completed: 0,         // rows flipped scheduled→completed
  apptIdsWritten: 0,    // appointment ids filled
  rows: [],             // planned writes (with the diff)
  sampleFlips: [],      // first N scheduled→completed for eyeballing
  unresolvableRows: [],
  errors: [],
}

const targets = await fetchTargets()
report.totalTargets = targets.length
console.log(`target rows (completion or appt-id missing): ${targets.length}`)

// locations map (one token per location)
const { data: locs, error: locErr } = await sb
  .from('locations')
  .select('location_id, jobber_access_token, jobber_refresh_token, token_expiry')
if (locErr) throw new Error(`locations: ${locErr.message}`)
const locById = new Map((locs || []).map(l => [l.location_id, l]))
const tokenCache = new Map()
async function tokenFor(locationId) {
  if (tokenCache.has(locationId)) return tokenCache.get(locationId)
  const loc = locById.get(locationId)
  const tok = loc ? await getValidToken(loc) : null
  tokenCache.set(locationId, tok)
  return tok
}

// ── 2. resolve each row's completion (+ appt id) LIVE ────────────────────────
const SAMPLE_CAP = 25
for (const a of targets) {
  const base = {
    assessment_id: a.id,
    engagement_id: a.engagement_id,
    location_id: a.location_id,
    jobber_request_id: a.jobber_request_id,
    status: a.status,
    had_appt_id: a.jobber_assessment_id != null,
    had_completed_at: a.completed_at != null,
  }
  if (!a.jobber_request_id) {
    report.noRequestId++
    report.unresolvableRows.push({ ...base, reason: 'no jobber_request_id (never linked to a Jobber request)' })
    continue
  }
  const token = await tokenFor(a.location_id)
  if (!token) {
    report.noToken++
    report.unresolvableRows.push({ ...base, reason: 'no valid Jobber token for location (re-run with --refresh)' })
    continue
  }
  try {
    const r = await jobberQuery(token, REQUEST_Q, { id: encodeJobberId('Request', a.jobber_request_id) })
    if (r?.errors?.length) {
      report.errors.push(`assessment ${a.id}: gql ${JSON.stringify(r.errors).slice(0, 160)}`)
      report.unresolvableRows.push({ ...base, reason: `gql error: ${r.errors[0]?.message || 'unknown'}` })
      report.unresolvable++
      continue
    }
    const assess = r?.data?.request?.assessment || null
    if (!assess?.id) {
      // request deleted, or assessment deleted off a still-live request.
      report.unresolvable++
      report.unresolvableRows.push({
        ...base,
        reason: r?.data?.request
          ? 'request live but has no assessment (assessment deleted in Jobber)'
          : 'request not found in Jobber (deleted)',
      })
      continue
    }
    report.resolvable++
    await sleep(120) // gentle on Jobber rate limits

    // Build the planned column diff. Mirrors upsertAssessment's mapping:
    //   isComplete:true → status:'completed', completed_at:completedAt
    //   isComplete:false → already scheduled/null → no write
    //   appt id still null → fill it (self-healing safety net)
    const update = {}
    const isComplete = assess.isComplete
    const numeric = extractJobberId(assess.id)
    if (!a.jobber_assessment_id && numeric) {
      update.jobber_assessment_id = numeric
      report.apptIdFill++
    }
    if (isComplete === true && a.completed_at == null) {
      update.status = 'completed'
      update.completed_at = assess.completedAt || null
      report.wouldComplete++
      if (report.sampleFlips.length < SAMPLE_CAP) {
        report.sampleFlips.push({
          assessment_id: a.id,
          engagement_id: a.engagement_id,
          from: `${a.status}/null`,
          to: `completed/${assess.completedAt || 'null'}`,
        })
      }
    } else if (isComplete === false) {
      report.incompleteNoop++
    }

    if (Object.keys(update).length === 0) continue // nothing to write for this row
    report.rows.push({ ...base, update, live_isComplete: isComplete, live_completedAt: assess.completedAt || null })
  } catch (err) {
    report.errors.push(`assessment ${a.id}: ${err.message}`)
    report.unresolvableRows.push({ ...base, reason: `fetch threw: ${err.message}` })
    report.unresolvable++
  }
}

console.log(`resolvable (assessment live in Jobber): ${report.resolvable}`)
console.log(`  → would flip scheduled→completed: ${report.wouldComplete}`)
console.log(`  → incomplete (already scheduled/null, no write): ${report.incompleteNoop}`)
console.log(`  → appointment-id fills (safety net): ${report.apptIdFill}`)
console.log(`rows with a planned write: ${report.rows.length}`)
console.log(`unresolvable (deleted in Jobber): ${report.unresolvable}`)
console.log(`no jobber_request_id: ${report.noRequestId}`)
console.log(`no valid token: ${report.noToken}`)
if (report.errors.length) console.log(`errors: ${report.errors.length}`)
if (report.sampleFlips.length) {
  console.log(`\nsample scheduled→completed (first ${report.sampleFlips.length}):`)
  for (const f of report.sampleFlips) console.log(`  ${f.assessment_id.slice(0, 8)}…  ${f.from} → ${f.to}`)
}

// ── 3. write (only under --execute) ──────────────────────────────────────────
if (EXECUTE) {
  for (const row of report.rows) {
    try {
      // Per-field drift guard: never clobber a value a concurrent
      // import/webhook may already have set with the live fix.
      //   · completion write → guard on completed_at STILL null
      //   · appt-id-only write → guard on jobber_assessment_id STILL null
      // A row setting completion is guarded on completed_at (the event that
      // matters); any appt-id it also carries rides along under that guard.
      const settingCompletion = 'completed_at' in row.update
      let q = sb
        .from('assessments')
        .update({ ...row.update, updated_at: nowIso() })
        .eq('id', row.assessment_id)
      q = settingCompletion ? q.is('completed_at', null) : q.is('jobber_assessment_id', null)
      const { data: updated, error } = await q.select('id')
      if (error) throw new Error(error.message)
      if (!updated?.length) {
        report.errors.push(`assessment ${row.assessment_id}: guard tripped — skipped (already set by live sync)`)
        continue
      }
      // Breadcrumb: entity_type 'engagement' (sync_log CHECK has no
      // 'assessment'; assessments hang off engagements). Rows without an
      // engagement still get the write, just no breadcrumb.
      if (row.engagement_id) {
        const parts = []
        if (settingCompletion) parts.push(`status→completed, completed_at→${row.update.completed_at || 'null'}`)
        if ('jobber_assessment_id' in row.update) parts.push(`jobber_assessment_id→${row.update.jobber_assessment_id}`)
        const { error: crumbErr } = await sb.from('sync_log').insert({
          location_id: row.location_id,
          direction: 'inbound',
          entity_type: 'engagement',
          entity_id: row.engagement_id,
          status: 'success',
          message: `[assessment:backfill] ${parts.join('; ')} (read live from request ${row.jobber_request_id}: isComplete=${row.live_isComplete}; approved run)`,
        })
        if (crumbErr) report.errors.push(`assessment ${row.assessment_id} breadcrumb: ${crumbErr.message} (write committed)`)
      }
      if (settingCompletion) report.completed++
      if ('jobber_assessment_id' in row.update) report.apptIdsWritten++
      report.written++
    } catch (err) {
      report.errors.push(`assessment ${row.assessment_id} write: ${err.message}`)
      console.error(`  ✗ assessment ${row.assessment_id}: ${err.message}`)
    }
  }
  console.log(`\nwrites committed: ${report.written}/${report.rows.length} (completed: ${report.completed}, appt-ids: ${report.apptIdsWritten})`)

  // ── 4. verify: completion landed; read live counts rather than assume ──────
  const { count: afterNullCompleted } = await sb
    .from('assessments').select('*', { count: 'exact', head: true }).is('completed_at', null)
  const { count: afterCompleted } = await sb
    .from('assessments').select('*', { count: 'exact', head: true }).eq('status', 'completed')
  report.completedAtNullAfter = afterNullCompleted
  report.statusCompletedAfter = afterCompleted
  // Independent check: exactly `report.completed` rows now carry status
  // 'completed' beyond whatever pre-existed (pre-existed = 0 in this prod, but
  // read it rather than assume).
  if (afterCompleted >= report.completed) {
    console.log(`✓ verify: status='completed' rows now ${afterCompleted} (≥ ${report.completed} written); completed_at-null now ${afterNullCompleted}`)
  } else {
    console.error(`✗ verify: status='completed'=${afterCompleted} < written ${report.completed} — investigate`)
    report.errors.push(`verify mismatch: statusCompleted=${afterCompleted} < written=${report.completed}`)
  }
  // Appointment-id null count (should be 0 / only ever drop).
  const { count: afterApptNull } = await sb
    .from('assessments').select('*', { count: 'exact', head: true }).is('jobber_assessment_id', null)
  report.apptIdNullAfter = afterApptNull
  console.log(`  jobber_assessment_id-null now: ${afterApptNull}`)
}

report.finishedAt = nowIso()
const outPath = `backfill-assessment-appointment-ids.report${EXECUTE ? '.run' : '.dryrun'}.json`
writeFileSync(outPath, JSON.stringify(report, null, 2))
console.log(`\nreport written: ${outPath}`)
