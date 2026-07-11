// ═══════════════════════════════════════════════════════════════════════════
// Backfill: populate assessments.status / completed_at from Jobber's
// Assessment.isComplete / completedAt for rows the pre-fix import left as
// status:'scheduled', completed_at:null.
//
// Root cause (fixed forward in lib/jobber-import.ts @ a1cd157): the
// REQUESTS_QUERY / SINGLE_REQUEST_QUERY assessment selection never fetched
// isComplete/completedAt, so every import + webhook wrote status:'scheduled',
// completed_at:null regardless of the real Jobber state. completed_at is the
// load-bearing done-signal every hive derivation keys off (!a.completed_at).
//
// This script, for each still-incomplete assessment (status <> 'completed'),
// reads the completion state LIVE from the record it hangs off:
//     request(id: jobber_request_id) { assessment { id isComplete completedAt } }
// and, where Jobber reports the assessment complete, flips the row to match
// the forward fix EXACTLY:
//     isComplete:true  → status:'completed', completed_at: completedAt || null
//     isComplete:false → no change (DB is already 'scheduled'/null)
//
// Jobber's model is binary — a cancelled assessment is deleted, so a live
// request either still has its assessment (with a real isComplete Boolean) or
// has none. Resolvability is confirmed per-row against LIVE Jobber, never
// invented:
//   · no jobber_request_id                       → UNRESOLVABLE (never linked)
//   · request not found (deleted)                → UNRESOLVABLE
//   · request live but assessment null (deleted) → UNRESOLVABLE
//   · request.assessment.isComplete present      → resolvable
//
// Usage:  node scripts/backfill-assessment-completion.mjs [--execute] [--refresh] [--env <path>]
//   Dry-run by default: reports resolvable count, how many rows flip
//   scheduled→completed, and a sample. --execute writes with a drift guard
//   (only rows STILL status<>'completed') + one sync_log breadcrumb per flip,
//   then independently verifies the completed-count delta. --refresh allows an
//   expired Jobber token refresh (rotates the locations token columns — same
//   authorized side effect as the sibling repair scripts).
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

// Mirror lib/jobber-import.ts extractJobberId / encodeJobberId.
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

// ── 1. gather all not-yet-completed assessments (paged past the 1000-row cap) ─
// Candidates are rows the pre-fix import left as status<>'completed'. Rows
// already 'completed' need no work (and re-running must not double-count).
async function fetchCandidates() {
  const rows = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from('assessments')
      .select('id, engagement_id, lead_id, service_request_id, location_id, jobber_request_id, status, completed_at')
      .neq('status', 'completed')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`fetch candidate assessments: ${error.message}`)
    rows.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return rows
}

// Completed-count snapshot for the independent verify (delta == written).
async function completedCount() {
  const { count, error } = await sb
    .from('assessments').select('*', { count: 'exact', head: true }).eq('status', 'completed')
  if (error) throw new Error(`completed count: ${error.message}`)
  return count
}

const report = {
  mode: EXECUTE ? 'execute' : 'dry-run',
  startedAt: nowIso(),
  candidates: 0,
  resolvable: 0,
  unresolvable: 0,
  noRequestId: 0,
  noToken: 0,
  willFlipToCompleted: 0,   // Jobber isComplete:true — planned scheduled→completed
  flipWithTimestamp: 0,     // of those, how many carry a real completedAt
  flipTimestampless: 0,     // isComplete:true but completedAt null (status only)
  liveIncomplete: 0,        // Jobber isComplete:false — already correct, no write
  written: 0,
  flips: [],                // planned flips (full)
  sample: [],               // first 20 flips, for the dry-run STOP report
  unresolvableRows: [],
  errors: [],
}

const candidates = await fetchCandidates()
report.candidates = candidates.length
console.log(`candidate assessments (status<>'completed'): ${candidates.length}`)

const completedBefore = await completedCount()
console.log(`assessments already status='completed': ${completedBefore}`)

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

// ── 2. resolve each row's completion state LIVE ──────────────────────────────
for (const a of candidates) {
  const base = {
    assessment_id: a.id,
    engagement_id: a.engagement_id,
    location_id: a.location_id,
    jobber_request_id: a.jobber_request_id,
    status: a.status,
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
    const appt = r?.data?.request?.assessment || null
    if (!appt || typeof appt.isComplete !== 'boolean') {
      // request deleted, assessment deleted off a live request, or a payload
      // with no real isComplete Boolean — never guessed.
      report.unresolvable++
      report.unresolvableRows.push({
        ...base,
        reason: !r?.data?.request
          ? 'request not found in Jobber (deleted)'
          : !r.data.request.assessment
            ? 'request live but has no assessment (assessment deleted in Jobber)'
            : 'assessment present but isComplete is not a boolean',
      })
      continue
    }
    report.resolvable++
    if (appt.isComplete) {
      // Mirror the forward fix EXACTLY: completed_at = completedAt || null.
      const completedAt = appt.completedAt || null
      report.willFlipToCompleted++
      if (completedAt) report.flipWithTimestamp++
      else report.flipTimestampless++
      const flip = { ...base, target_completed_at: completedAt }
      report.flips.push(flip)
      if (report.sample.length < 20) report.sample.push(flip)
    } else {
      // DB is already 'scheduled'/null from the bug — nothing to write.
      report.liveIncomplete++
    }
    await sleep(120) // gentle on Jobber rate limits
  } catch (err) {
    report.errors.push(`assessment ${a.id}: ${err.message}`)
    report.unresolvableRows.push({ ...base, reason: `fetch threw: ${err.message}` })
    report.unresolvable++
  }
}

console.log(`resolvable (completion read live): ${report.resolvable}`)
console.log(`  → flip scheduled→completed: ${report.willFlipToCompleted} (with completedAt: ${report.flipWithTimestamp}, timestampless: ${report.flipTimestampless})`)
console.log(`  → live-incomplete, no change: ${report.liveIncomplete}`)
console.log(`unresolvable (deleted/no-request/no-boolean): ${report.unresolvable}`)
console.log(`no jobber_request_id: ${report.noRequestId}`)
console.log(`no valid token: ${report.noToken}`)
if (report.errors.length) console.log(`errors: ${report.errors.length}`)
if (report.sample.length) {
  console.log(`\nsample flips (first ${report.sample.length}):`)
  for (const s of report.sample) {
    console.log(`  assessment ${s.assessment_id} (loc ${s.location_id}, req ${s.jobber_request_id}) status '${s.status}' → 'completed', completed_at=${s.target_completed_at ?? 'null'}`)
  }
}

// ── 3. write (only under --execute) ──────────────────────────────────────────
if (EXECUTE) {
  for (const row of report.flips) {
    try {
      // Drift guard: only flip rows STILL status<>'completed' — a concurrent
      // import/webhook (now fixed forward) may already have completed it.
      const { data: updated, error } = await sb
        .from('assessments')
        .update({ status: 'completed', completed_at: row.target_completed_at, updated_at: nowIso() })
        .eq('id', row.assessment_id)
        .neq('status', 'completed')
        .select('id')
      if (error) throw new Error(error.message)
      if (!updated?.length) {
        report.errors.push(`assessment ${row.assessment_id}: already completed — skipped (drift)`)
        continue
      }
      // Breadcrumb: entity_type 'engagement' (sync_log CHECK has no
      // 'assessment'; assessments hang off engagements). Rows without an
      // engagement still get the write, just no breadcrumb.
      if (row.engagement_id) {
        const { error: crumbErr } = await sb.from('sync_log').insert({
          location_id: row.location_id,
          direction: 'inbound',
          entity_type: 'engagement',
          entity_id: row.engagement_id,
          status: 'success',
          message: `[assessment:completion-backfill] status '${row.status}'→'completed', completed_at=${row.target_completed_at ?? 'null'} (read live from request ${row.jobber_request_id}; approved run)`,
        })
        if (crumbErr) report.errors.push(`assessment ${row.assessment_id} breadcrumb: ${crumbErr.message} (write committed)`)
      }
      report.written++
    } catch (err) {
      report.errors.push(`assessment ${row.assessment_id} write: ${err.message}`)
      console.error(`  ✗ assessment ${row.assessment_id}: ${err.message}`)
    }
  }
  console.log(`\nwrites committed: ${report.written}/${report.flips.length}`)

  // ── 4. verify: completed-count rose by exactly `written` ───────────────────
  const completedAfter = await completedCount()
  report.completedBefore = completedBefore
  report.completedAfter = completedAfter
  const expected = completedBefore + report.written
  if (completedAfter === expected) {
    console.log(`✓ verify: completed count ${completedBefore} → ${completedAfter} (rose by ${report.written})`)
  } else {
    console.error(`✗ verify: completed count ${completedAfter}, expected ${expected} — investigate`)
    report.errors.push(`verify mismatch: completedAfter=${completedAfter} expected=${expected}`)
  }
}

report.finishedAt = nowIso()
const outPath = `backfill-assessment-completion.report${EXECUTE ? '.run' : '.dryrun'}.json`
writeFileSync(outPath, JSON.stringify(report, null, 2))
console.log(`\nreport written: ${outPath}`)
