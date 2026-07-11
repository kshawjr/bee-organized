// ═══════════════════════════════════════════════════════════════════════════
// Backfill: populate assessments.duration_minutes from Jobber's
// Assessment.duration for rows the pre-fix import left at the fake default 60.
//
// Root cause (fixed forward in lib/jobber-import.ts @ 6ba1029): the
// REQUESTS_QUERY / SINGLE_REQUEST_QUERY assessment selection never fetched
// `duration`, and upsertAssessment never set the column, so every import +
// webhook left duration_minutes at the DB column default (60) regardless of
// the real Jobber state. Verified live: 1356/1356 rows are exactly 60, while
// real Jobber durations span 30–840 min across 21 distinct values (60 is only
// the modal value). Any hive read of duration_minutes saw a fake uniform 60.
//
// This script, for each row still holding the fake default (duration_minutes
// = 60), reads the duration LIVE from the record it hangs off:
//     request(id: jobber_request_id) { assessment { id duration } }
// and, where Jobber reports a real duration that DIFFERS from 60, flips the
// row to match — mirroring the forward fix EXACTLY (duration_minutes =
// assessment.duration, minutes, no derivation):
//     duration is a number != 60 → duration_minutes = that value
//     duration == 60             → no change (already correct, fake or real)
//     duration null / not a number → no change (Jobber has no duration; ~8%
//                                    of assessments have no scheduled end)
//
// A currently-60 row is indistinguishable fake-vs-real, but that's harmless:
// if the real duration is also 60 the DB is already correct, so we only WRITE
// where the live value genuinely differs. Resolvability is confirmed per-row
// against LIVE Jobber, never invented:
//   · no jobber_request_id                       → UNRESOLVABLE (never linked)
//   · request not found (deleted)                → UNRESOLVABLE
//   · request live but assessment null (deleted) → UNRESOLVABLE
//   · assessment.duration null / non-number      → resolvable, no change
//   · assessment.duration is a number            → resolvable
//
// Usage:  node scripts/backfill-assessment-duration.mjs [--execute] [--refresh] [--env <path>]
//   Dry-run by default: reports resolvable count, how many rows flip
//   60→real, the value spread of the new durations, and a sample. --execute
//   writes with a drift guard (only rows STILL duration_minutes=60) + one
//   sync_log breadcrumb per flip, then independently verifies the
//   non-60-count delta. --refresh allows an expired Jobber token refresh
//   (rotates the locations token columns — same authorized side effect as the
//   sibling repair scripts).
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const arg = k => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : null }
const flag = k => process.argv.includes(k)
const EXECUTE = flag('--execute')
const FAKE_DEFAULT = 60 // the DB column default every pre-fix row holds

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

// Mirror lib/jobber-import.ts encodeJobberId.
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

const REQUEST_Q = `query($id: EncodedId!) { request(id: $id) { id assessment { id duration } } }`

// ── 1. gather all rows still holding the fake default (paged past the 1000 cap)─
// Candidates are rows left at duration_minutes = 60 (the DB default the pre-fix
// import never overwrote). Rows the forward fix already corrected to a real
// value != 60 are not candidates (already fixed); a forward-fix write of a
// real 60 stays a candidate and no-ops here.
async function fetchCandidates() {
  const rows = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from('assessments')
      .select('id, engagement_id, lead_id, service_request_id, location_id, jobber_request_id, duration_minutes')
      .eq('duration_minutes', FAKE_DEFAULT)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`fetch candidate assessments: ${error.message}`)
    rows.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return rows
}

// Snapshot for the independent verify: rows whose duration_minutes is NOT the
// fake default. A correct backfill raises this by exactly `written`.
async function nonDefaultCount() {
  const { count, error } = await sb
    .from('assessments').select('*', { count: 'exact', head: true }).neq('duration_minutes', FAKE_DEFAULT)
  if (error) throw new Error(`non-default count: ${error.message}`)
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
  willFlip: 0,               // live duration is a real number != 60 — planned change
  liveSixty: 0,              // live duration == 60 — already correct, no write
  liveNullDuration: 0,       // assessment present but duration null/non-number — no change
  written: 0,
  valueSpread: {},           // new-duration value → count, across planned flips
  flips: [],                 // planned flips (full)
  sample: [],                // first 20 flips, for the dry-run STOP report
  unresolvableRows: [],
  errors: [],
}

const candidates = await fetchCandidates()
report.candidates = candidates.length
console.log(`candidate assessments (duration_minutes=${FAKE_DEFAULT}): ${candidates.length}`)

const nonDefaultBefore = await nonDefaultCount()
console.log(`assessments with duration_minutes != ${FAKE_DEFAULT}: ${nonDefaultBefore}`)

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

// ── 2. resolve each row's duration LIVE ──────────────────────────────────────
for (const a of candidates) {
  const base = {
    assessment_id: a.id,
    engagement_id: a.engagement_id,
    location_id: a.location_id,
    jobber_request_id: a.jobber_request_id,
    current: a.duration_minutes,
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
    await sleep(120) // gentle on Jobber rate limits — every live read
    if (r?.errors?.length) {
      report.errors.push(`assessment ${a.id}: gql ${JSON.stringify(r.errors).slice(0, 160)}`)
      report.unresolvableRows.push({ ...base, reason: `gql error: ${r.errors[0]?.message || 'unknown'}` })
      report.unresolvable++
      continue
    }
    const appt = r?.data?.request?.assessment || null
    if (!appt) {
      // request deleted, or assessment deleted off a live request — never guessed.
      report.unresolvable++
      report.unresolvableRows.push({
        ...base,
        reason: !r?.data?.request
          ? 'request not found in Jobber (deleted)'
          : 'request live but has no assessment (assessment deleted in Jobber)',
      })
      continue
    }
    report.resolvable++
    if (typeof appt.duration !== 'number') {
      // Jobber has no duration for this assessment (~8% — no scheduled end).
      // Mirror the forward-fix guard: leave the default untouched.
      report.liveNullDuration++
      continue
    }
    if (appt.duration === FAKE_DEFAULT) {
      // Real value coincides with the default — DB already correct, no write.
      report.liveSixty++
      continue
    }
    // Real duration that differs from the fake default → flip.
    report.willFlip++
    report.valueSpread[appt.duration] = (report.valueSpread[appt.duration] || 0) + 1
    const flip = { ...base, target_duration_minutes: appt.duration }
    report.flips.push(flip)
    if (report.sample.length < 20) report.sample.push(flip)
  } catch (err) {
    report.errors.push(`assessment ${a.id}: ${err.message}`)
    report.unresolvableRows.push({ ...base, reason: `fetch threw: ${err.message}` })
    report.unresolvable++
  }
}

console.log(`resolvable (duration read live): ${report.resolvable}`)
console.log(`  → flip ${FAKE_DEFAULT}→real: ${report.willFlip}`)
console.log(`  → live duration == ${FAKE_DEFAULT} (already correct): ${report.liveSixty}`)
console.log(`  → live duration null/non-number (no change): ${report.liveNullDuration}`)
console.log(`unresolvable (deleted/no-request): ${report.unresolvable}`)
console.log(`no jobber_request_id: ${report.noRequestId}`)
console.log(`no valid token: ${report.noToken}`)
if (report.errors.length) console.log(`errors: ${report.errors.length}`)
console.log(`\nnew-duration value spread (planned flips): ${JSON.stringify(report.valueSpread)}`)
if (report.sample.length) {
  console.log(`\nsample flips (first ${report.sample.length}):`)
  for (const s of report.sample) {
    console.log(`  assessment ${s.assessment_id} (loc ${s.location_id}, req ${s.jobber_request_id}) duration_minutes ${s.current} → ${s.target_duration_minutes}`)
  }
}

// ── 3. write (only under --execute) ──────────────────────────────────────────
if (EXECUTE) {
  for (const row of report.flips) {
    try {
      // Drift guard: only flip rows STILL at the fake default — a concurrent
      // import/webhook (now fixed forward) may already have written the real
      // value.
      const { data: updated, error } = await sb
        .from('assessments')
        .update({ duration_minutes: row.target_duration_minutes, updated_at: nowIso() })
        .eq('id', row.assessment_id)
        .eq('duration_minutes', FAKE_DEFAULT)
        .select('id')
      if (error) throw new Error(error.message)
      if (!updated?.length) {
        report.errors.push(`assessment ${row.assessment_id}: no longer at default — skipped (drift)`)
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
          message: `[assessment:duration-backfill] duration_minutes ${row.current}→${row.target_duration_minutes} (read live from request ${row.jobber_request_id}; approved run)`,
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

  // ── 4. verify: non-default count rose by exactly `written` ─────────────────
  const nonDefaultAfter = await nonDefaultCount()
  report.nonDefaultBefore = nonDefaultBefore
  report.nonDefaultAfter = nonDefaultAfter
  const expected = nonDefaultBefore + report.written
  if (nonDefaultAfter === expected) {
    console.log(`✓ verify: non-default count ${nonDefaultBefore} → ${nonDefaultAfter} (rose by ${report.written})`)
  } else {
    console.error(`✗ verify: non-default count ${nonDefaultAfter}, expected ${expected} — investigate`)
    report.errors.push(`verify mismatch: nonDefaultAfter=${nonDefaultAfter} expected=${expected}`)
  }
}

report.finishedAt = nowIso()
const outPath = `backfill-assessment-duration.report${EXECUTE ? '.run' : '.dryrun'}.json`
writeFileSync(outPath, JSON.stringify(report, null, 2))
console.log(`\nreport written: ${outPath}`)
