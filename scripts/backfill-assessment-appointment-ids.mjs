// ═══════════════════════════════════════════════════════════════════════════
// Backfill: populate assessments.jobber_assessment_id (the Jobber
// appointment id) for rows that landed null.
//
// Root cause (fixed forward in lib/jobber-import.ts): the import/webhook
// GraphQL selections fetched `assessment { startAt }` without `id`, and
// upsertAssessment never set jobber_assessment_id. Every assessment row
// therefore has a null appointment id, so the engagement-assignee sync
// reports assessment=none (appointmentEditAssignment has no target).
//
// This script, for each assessment with null jobber_assessment_id, fetches
// the appointment id LIVE from the record it hangs off:
//     request(id: jobber_request_id) { assessment { id } }
// and writes extractJobberId(assessment.id) (numeric, matching every
// sibling jobber_*_id column and how jobber_job_id is fed to Jobber's
// EncodedId! args in the assignee sync).
//
// Resolvability is confirmed per-row against LIVE Jobber, never invented:
//   · request not found (deleted) OR request.assessment null (assessment
//     deleted in Jobber) → UNRESOLVABLE, reported separately, left null.
//   · request.assessment.id present → resolvable, planned/written.
//
// Usage:  node scripts/backfill-assessment-appointment-ids.mjs [--execute] [--refresh] [--env <path>]
//   Dry-run by default: reports per row (engagement, location, resolvable
//   yes/no, id). --execute writes with a drift guard (only rows still
//   null) + one sync_log breadcrumb per write. --refresh allows an expired
//   Jobber token refresh (rotates locations-row token columns — same
//   authorized side effect as the other repair scripts).
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

const REQUEST_Q = `query($id: EncodedId!) { request(id: $id) { id assessment { id } } }`

// ── 1. gather all null-id assessments (paged past the 1000-row cap) ──────────
async function fetchAllNull() {
  const rows = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from('assessments')
      .select('id, engagement_id, lead_id, service_request_id, location_id, jobber_request_id, status')
      .is('jobber_assessment_id', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`fetch null assessments: ${error.message}`)
    rows.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return rows
}

const report = {
  mode: EXECUTE ? 'execute' : 'dry-run',
  startedAt: nowIso(),
  totalNull: 0,
  resolvable: 0,
  unresolvable: 0,
  noRequestId: 0,
  noToken: 0,
  written: 0,
  rows: [],
  unresolvableRows: [],
  errors: [],
}

const nulls = await fetchAllNull()
report.totalNull = nulls.length
console.log(`null jobber_assessment_id rows: ${nulls.length}`)

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

// ── 2. resolve each row's appointment id LIVE ────────────────────────────────
for (const a of nulls) {
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
    const apptGlobal = r?.data?.request?.assessment?.id || null
    if (!apptGlobal) {
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
    const numeric = extractJobberId(apptGlobal)
    if (!numeric) {
      report.unresolvable++
      report.unresolvableRows.push({ ...base, reason: `could not extract numeric from ${apptGlobal}` })
      continue
    }
    report.resolvable++
    report.rows.push({ ...base, resolved_jobber_assessment_id: numeric })
    await sleep(120) // gentle on Jobber rate limits
  } catch (err) {
    report.errors.push(`assessment ${a.id}: ${err.message}`)
    report.unresolvableRows.push({ ...base, reason: `fetch threw: ${err.message}` })
    report.unresolvable++
  }
}

console.log(`resolvable (id found live): ${report.resolvable}`)
console.log(`unresolvable (deleted in Jobber): ${report.unresolvable}`)
console.log(`no jobber_request_id: ${report.noRequestId}`)
console.log(`no valid token: ${report.noToken}`)
if (report.errors.length) console.log(`errors: ${report.errors.length}`)

// ── 3. write (only under --execute) ──────────────────────────────────────────
if (EXECUTE) {
  for (const row of report.rows) {
    try {
      // Drift guard: only write rows STILL null — a concurrent
      // import/webhook may already have populated it with the fix live.
      const { data: updated, error } = await sb
        .from('assessments')
        .update({ jobber_assessment_id: row.resolved_jobber_assessment_id, updated_at: nowIso() })
        .eq('id', row.assessment_id)
        .is('jobber_assessment_id', null)
        .select('id')
      if (error) throw new Error(error.message)
      if (!updated?.length) {
        report.errors.push(`assessment ${row.assessment_id}: no longer null — skipped (already populated)`)
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
          message: `[assessment:backfill] jobber_assessment_id null → ${row.resolved_jobber_assessment_id} (appointment id fetched live from request ${row.jobber_request_id}; unblocks engagement-assignee sync; approved run)`,
        })
        if (crumbErr) report.errors.push(`assessment ${row.assessment_id} breadcrumb: ${crumbErr.message} (write committed)`)
      }
      report.written++
    } catch (err) {
      report.errors.push(`assessment ${row.assessment_id} write: ${err.message}`)
      console.error(`  ✗ assessment ${row.assessment_id}: ${err.message}`)
    }
  }
  console.log(`\nwrites committed: ${report.written}/${report.rows.length}`)

  // ── 4. verify: null-count dropped by exactly `written` ─────────────────────
  const { count: afterNull } = await sb
    .from('assessments').select('*', { count: 'exact', head: true }).is('jobber_assessment_id', null)
  report.nullAfter = afterNull
  const expected = report.totalNull - report.written
  if (afterNull === expected) {
    console.log(`✓ verify: null count ${report.totalNull} → ${afterNull} (dropped by ${report.written})`)
  } else {
    console.error(`✗ verify: null count ${afterNull}, expected ${expected} — investigate`)
    report.errors.push(`verify mismatch: nullAfter=${afterNull} expected=${expected}`)
  }
}

report.finishedAt = nowIso()
const outPath = `backfill-assessment-appointment-ids.report${EXECUTE ? '.run' : '.dryrun'}.json`
writeFileSync(outPath, JSON.stringify(report, null, 2))
console.log(`\nreport written: ${outPath}`)
